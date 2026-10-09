// @ts-check
/**
 * Item-scoped requests (docs/adr/0002-item-scoped-requests.md): the one
 * place a request's cell access is decided. A module declares its
 * cell-owned items, their parts, and a route table; for every request the
 * dispatcher matches the route, checks the member's role, resolves the item
 * named in the URL (404 if the member can't see it, 403 if the route changes
 * it and the member's cell doesn't own it), runs the handler with that item,
 * and announces the change to exactly the item's cells. Handlers never see
 * the user; the only access they compose themselves is a list's visibility
 * condition (`access.visible`), and reads of other items (`access.see`).
 *
 * Module shape:
 *
 *   {
 *     id, close(),
 *     database: () => DatabaseSync,                  // lazy; needed when `items` exist
 *     items: { <kind>: { table, path, label, shape(row, ctx), onOwnership?(change) } },
 *     parts: { <kind>: { table, item: <item kind>, column, label } },
 *     routes: [{ method, path, verb, item?, part?, role?, reach?, changes?, bodyLimit?, handler }],
 *   }
 *
 * `path` is a string with `:name` segments (`:item`, `:part` are integer ids)
 * or a RegExp whose named groups become `params`. `verb`:
 *   - 'see'    — item (and part) must be visible;
 *   - 'change' — also editable by the member's cell;
 *   - 'create' — creates items of `item` kind; the handler gets `owner`
 *                ({ owner_cell, releasable_to }) and must store exactly it;
 *   - 'list'   — no item; lists use `access.visible`;
 *   - 'none'   — not about cell-owned items (clock, geography, tiles).
 * A 'none' route that changes something is announced to `reach`: 'everyone'
 * or 'white' (the default), or 'handler' for the one kind of change whose
 * readers only the handler knows (firing an inject: the report or message it
 * creates goes to the inject's chosen cells), where the handler returns
 * `announce(value, cells)`; `changes: false` marks a read made with POST
 * (not announced, not audited). `role` defaults to observer for GET/HEAD and
 * analyst otherwise.
 *
 * For every item kind with a `path`, two routes are generated: POST
 * `<path>/:item/release {cells}` and PATCH `<path>/:item/owner {owner_cell}`,
 * answered with `shape(row)`; `onOwnership` runs inside their transaction
 * (for an activity row) and must not open one of its own.
 *
 * Handler context: { item, part, params, query, body, owner, access,
 * actorName, request, response }. `access` carries `white`, `cell`, `see`,
 * `canEdit` and `visible`. A handler returns the JSON body, or sends
 * the response itself and returns undefined.
 *
 * A module that changes things on its own (the scenario clock firing
 * injects) gets `connect({ runAs })` once: `runAs(actor, method, route,
 * body)` runs one of its routes without HTTP, announced like any other.
 */
import { HttpError, sendJson } from './http.js';
import {
  canEdit,
  canRelease,
  canSee,
  CELLS,
  isWhite,
  liveCellsFor,
  normalizeRelease,
  ownerCellForCreate,
  roleAtLeast,
  visibilitySql,
} from './policy.js';
import { transact } from './state.js';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const VERBS = new Set(['see', 'change', 'create', 'list', 'none']);
const REACHES = new Set(['everyone', 'white', 'handler']);
const ANNOUNCE = Symbol('announce');
const DEFAULT_BODY_LIMIT = 1 << 20;

/**
 * One route a module declares (see the module doc above for each field).
 * @typedef {{
 *   method: string,
 *   path: string | RegExp,
 *   verb: string,
 *   item?: string,
 *   part?: string,
 *   role?: string,
 *   reach?: string,
 *   changes?: boolean,
 *   bodyLimit?: number,
 *   handler?: (context: any) => unknown,
 * }} RouteSpec
 * @typedef {RouteSpec & { match: (path: string) => Record<string, string> | null }} CompiledRoute
 * @typedef {import('./policy.js').Actor} Actor
 */

/** What a `reach: 'handler'` route returns: the body, and the cells that hear about it. */
export function announce(value, cells) {
  if (!Array.isArray(cells) || cells.some((cell) => !CELLS.includes(cell))) {
    throw new Error(`announce: cells must be a list of ${CELLS.join('/')}.`);
  }
  return { [ANNOUNCE]: true, value, cells };
}

/** The actor for changes the server makes on its own (inject firing): counts as White. */
export const EXERCISE_CONTROL = Object.freeze({
  name: 'scenario clock',
  admin: false,
  cell: 'white',
  role: 'game-master',
});

/**
 * @param {string | RegExp} path
 * @returns {(route: string) => Record<string, string> | null}
 */
function compilePath(path) {
  if (path instanceof RegExp)
    return (route) => path.exec(route)?.groups ?? (path.test(route) ? {} : null);
  const segments = path.split('/');
  return (route) => {
    const parts = route.split('/');
    if (parts.length !== segments.length) return null;
    const params = {};
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment.startsWith(':')) {
        if (!parts[index]) return null;
        params[segment.slice(1)] = decodeURIComponent(parts[index]);
      } else if (segment !== parts[index]) {
        return null;
      }
    }
    return params;
  };
}

function integerId(text, label) {
  if (!/^\d+$/.test(text ?? '')) throw new HttpError(404, `${label} ${text} not found.`);
  return Number(text);
}

function requireRevision(label, item, body) {
  if (!Number.isInteger(body?.revision)) throw new HttpError(400, `${label} revision is required.`);
  if (body.revision !== item.revision) {
    throw new HttpError(409, `${label} ${item.id} changed; reload latest before saving.`, {
      code: 'stale_revision',
      current_revision: item.revision,
    });
  }
}

/** Reads a JSON body, or null when there is none (a bodiless POST/DELETE). */
async function readBody(request, limit) {
  if (!request) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'The request body is too large.');
    chunks.push(chunk);
  }
  if (!size) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not valid JSON.');
  }
}

/** Validates a module's declaration once, at dispatcher creation, so a typo fails at startup. */
function compileModule(module) {
  const items = module.items ?? {};
  const parts = module.parts ?? {};
  for (const [kind, part] of Object.entries(parts)) {
    if (!items[part.item])
      throw new Error(`${module.id}: part "${kind}" names unknown item "${part.item}".`);
    if (!part.table || !part.column)
      throw new Error(`${module.id}: part "${kind}" needs table and column.`);
  }
  /** @type {CompiledRoute[]} */
  const routes = [];
  for (const route of module.routes ?? []) {
    if (!VERBS.has(route.verb))
      throw new Error(`${module.id}: ${route.method} ${route.path} has no valid verb.`);
    if (route.verb === 'see' && route.method !== 'GET' && route.method !== 'HEAD') {
      throw new Error(
        `${module.id}: ${route.method} ${route.path}: a change can't be declared 'see'.`,
      );
    }
    if (
      typeof route.path === 'string' &&
      /(^|\/):(item|part)(\/|$)/.test(route.path) &&
      !route.item
    ) {
      throw new Error(
        `${module.id}: ${route.method} ${route.path} names an item in its path but declares no item kind.`,
      );
    }
    if (['see', 'change', 'create'].includes(route.verb) && !items[route.item]) {
      throw new Error(
        `${module.id}: ${route.method} ${route.path} names unknown item "${route.item}".`,
      );
    }
    if (route.part && parts[route.part]?.item !== route.item) {
      throw new Error(
        `${module.id}: ${route.method} ${route.path}: part "${route.part}" is not a part of "${route.item}".`,
      );
    }
    if (route.reach && !REACHES.has(route.reach))
      throw new Error(`${module.id}: unknown reach "${route.reach}".`);
    if (route.reach && route.verb !== 'none')
      throw new Error(
        `${module.id}: ${route.method} ${route.path}: reach is only for 'none' routes.`,
      );
    routes.push({ ...route, match: compilePath(route.path) });
  }
  for (const [kind, item] of Object.entries(items)) {
    if (!item.path) continue;
    routes.push(
      {
        method: 'POST',
        path: `${item.path}/:item/release`,
        verb: 'release',
        item: kind,
        match: compilePath(`${item.path}/:item/release`),
      },
      {
        method: 'PATCH',
        path: `${item.path}/:item/owner`,
        verb: 'reassign',
        item: kind,
        match: compilePath(`${item.path}/:item/owner`),
      },
    );
  }
  return { module, items, parts, routes };
}

/**
 * @param {any[]} modules
 * @param {{ publish?: (event: object) => void, audit?: (entry: object) => void }} [options]
 */
export function createDispatcher(modules, { publish = () => {}, audit = () => {} } = {}) {
  const compiled = new Map(modules.map((module) => [module.id, compileModule(module)]));

  function fetchRow(entry, table, id) {
    return entry.module.database().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) ?? null;
  }

  /** The access capability a handler gets: bound to the requester, never exposing them. */
  function accessFor(entry, actor) {
    return {
      white: isWhite(actor),
      cell: actor?.cell ?? null,
      /** A row of any item or part kind the requester can see, or 404. */
      see(kind, id) {
        const part = entry.parts[kind];
        const itemKind = part ? part.item : kind;
        const spec = entry.items[itemKind];
        if (!spec) throw new Error(`${entry.module.id}: unknown kind "${kind}".`);
        const label = (part ?? spec).label;
        const row = fetchRow(entry, (part ?? spec).table, id);
        const item = row && (part ? fetchRow(entry, spec.table, row[part.column]) : row);
        if (!item || !canSee(actor, item)) throw new HttpError(404, `${label} ${id} not found.`);
        return row;
      },
      /** Whether the requester may change this item row (for per-row flags in a response). */
      canEdit: (itemRow) => canEdit(actor, itemRow),
      /** The WHERE condition limiting an item kind's list to what the requester can see. */
      visible(kind, options) {
        if (!entry.items[kind])
          throw new Error(`${entry.module.id}: visible() needs an item kind, got "${kind}".`);
        return visibilitySql(actor, options);
      },
    };
  }

  function resolveItem(entry, route, params, actor) {
    const spec = entry.items[route.item];
    const id = integerId(params.item, spec.label);
    const item = fetchRow(entry, spec.table, id);
    if (!item || !canSee(actor, item)) throw new HttpError(404, `${spec.label} ${id} not found.`);
    let part = null;
    if (route.part) {
      const partSpec = entry.parts[route.part];
      const partId = integerId(params.part, partSpec.label);
      part = fetchRow(entry, partSpec.table, partId);
      if (!part || part[partSpec.column] !== id)
        throw new HttpError(404, `${partSpec.label} ${partId} not found.`);
    }
    return { item, part };
  }

  function ownershipChange(entry, route, item, actor, body, actorName) {
    const spec = entry.items[route.item];
    const before = item;
    let ownerCell = item.owner_cell;
    let releasable;
    if (route.verb === 'release') {
      if (!canRelease(actor, item))
        throw new HttpError(403, `You may not release this ${spec.label}.`);
      if (spec.revision) requireRevision(spec.label, item, body);
      releasable = normalizeRelease(body?.cells, ownerCell);
    } else {
      if (!isWhite(actor)) throw new HttpError(403, `Only White may reassign this ${spec.label}.`);
      if (spec.revision) requireRevision(spec.label, item, body);
      ownerCell = body?.owner_cell;
      if (!CELLS.includes(ownerCell)) throw new HttpError(400, `Unknown cell: ${ownerCell}`);
      releasable = normalizeRelease(liveCellsFor(item).slice(1), ownerCell);
    }
    const database = entry.module.database();
    const after = transact(database, () => {
      const bumpRevision = spec.revision ? ', revision = revision + 1' : '';
      database
        .prepare(
          `UPDATE ${spec.table} SET owner_cell = ?, releasable_to = ?${bumpRevision} WHERE id = ?`,
        )
        .run(ownerCell, JSON.stringify(releasable), item.id);
      const row = fetchRow(entry, spec.table, item.id);
      spec.onOwnership?.({ kind: route.item, action: route.verb, before, after: row, actorName });
      return row;
    });
    const cells = [...new Set([...liveCellsFor(before), ...liveCellsFor(after)])];
    return { value: spec.shape(after, { access: accessFor(entry, actor) }), cells };
  }

  /**
   * Runs one request. `route` is the path after `/api/<moduleId>/`. `request`
   * and `response` may be null for an internal call (see `runAs`), in which
   * case `body` is given directly and the value is returned, not sent.
   *
   * @param {{
   *   moduleId: string,
   *   method: string,
   *   route: string,
   *   url?: URL,
   *   actor: Actor,
   *   request?: import('node:http').IncomingMessage | null,
   *   response?: import('node:http').ServerResponse | null,
   *   body?: unknown,
   * }} options
   */
  async function run({
    moduleId,
    method,
    route: path,
    url,
    actor,
    request = null,
    response = null,
    body: givenBody,
  }) {
    const entry = compiled.get(moduleId);
    if (!entry) throw new HttpError(404, 'Unknown module.');
    /** @type {CompiledRoute | null} */
    let route = null;
    /** @type {Record<string, string> | null} */
    let params = null;
    let pathMatched = false;
    for (const candidate of entry.routes) {
      const found = candidate.match(path);
      if (!found) continue;
      pathMatched = true;
      if (candidate.method !== method && !(method === 'HEAD' && candidate.method === 'GET'))
        continue;
      route = candidate;
      params = found;
      break;
    }
    if (!route)
      throw new HttpError(
        pathMatched ? 405 : 404,
        pathMatched ? 'Method not allowed.' : 'Unknown API route.',
      );

    const required = route.role ?? (method === 'GET' || method === 'HEAD' ? 'observer' : 'analyst');
    if (!roleAtLeast(actor.role, required)) {
      throw new HttpError(403, `This action needs the ${required} role.`);
    }

    const { item, part } =
      route.item && route.verb !== 'create' ? resolveItem(entry, route, params, actor) : {};
    if (route.verb === 'change' && !canEdit(actor, item)) {
      throw new HttpError(
        403,
        `Released to your cell for reading only; the ${item.owner_cell} cell owns it.`,
      );
    }

    const body =
      givenBody !== undefined
        ? givenBody
        : MUTATION_METHODS.has(method)
          ? await readBody(request, route.bodyLimit ?? DEFAULT_BODY_LIMIT)
          : null;
    const actorName = actor.name;

    let value;
    let cells;
    if (route.verb === 'release' || route.verb === 'reassign') {
      ({ value, cells } = ownershipChange(entry, route, item, actor, body, actorName));
    } else {
      let owner;
      if (route.verb === 'create') {
        const ownerCell = ownerCellForCreate(actor, body?.owner_cell ?? undefined);
        const requested = body?.releasable_to ?? [];
        if (requested.length && !canRelease(actor, { owner_cell: ownerCell })) {
          const label = route.item ? entry.items[route.item]?.label : null;
          throw new HttpError(403, `You may not release this ${label ?? 'item'}.`);
        }
        owner = { owner_cell: ownerCell, releasable_to: normalizeRelease(requested, ownerCell) };
        cells = liveCellsFor(owner);
      } else if (item) {
        cells = liveCellsFor(item);
      }
      const query = url?.searchParams ?? new URLSearchParams();
      // Only the generated release/reassign routes lack a handler, and they returned above.
      if (!route.handler) throw new Error(`${moduleId}: ${method} ${path} has no handler.`);
      value = await route.handler({
        item,
        part,
        params,
        query,
        body,
        owner,
        access: accessFor(entry, actor),
        actorName,
        request,
        response,
      });
      if (route.reach === 'handler') {
        if (!value?.[ANNOUNCE])
          throw new Error(
            `${moduleId}: ${method} ${route.path} must return announce(value, cells).`,
          );
        ({ value, cells } = value);
      } else if (value?.[ANNOUNCE]) {
        throw new Error(
          `${moduleId}: ${method} ${route.path} returned announce() without reach: 'handler'.`,
        );
      }
      if (
        route.verb === 'create' &&
        value &&
        typeof value === 'object' &&
        'owner_cell' in value &&
        value.owner_cell !== owner.owner_cell
      ) {
        throw new Error(
          `${moduleId}: ${method} ${route.path} stored owner_cell "${value.owner_cell}", not "${owner.owner_cell}".`,
        );
      }
    }

    const changes = MUTATION_METHODS.has(method) && route.changes !== false;
    let audience = null;
    if (changes) {
      const everyone = route.verb === 'none' && route.reach === 'everyone';
      audience = everyone ? undefined : (cells ?? ['white']);
    }
    return { value, changes, cells: audience };
  }

  /** The HTTP entry point, called by server/api.js after authentication. */
  async function handle({ moduleId, route, url, request, response, actor, client, rawClient }) {
    const result = await run({
      moduleId,
      method: request.method,
      route,
      url,
      actor,
      request,
      response,
    });
    if (result.changes) {
      const finish = () => {
        if (response.statusCode >= 400) return;
        publish({
          module: moduleId,
          method: request.method,
          route,
          client,
          user: actor.name,
          at: new Date().toISOString(),
          ...(result.cells ? { cells: result.cells } : {}),
        });
        audit({
          user: actor.name,
          method: request.method,
          path: url.pathname,
          status: response.statusCode,
          client: rawClient,
        });
      };
      if (response.writableEnded) finish();
      else response.once('finish', finish);
    }
    if (!response.writableEnded && !response.headersSent) sendJson(response, result.value ?? null);
  }

  /** Runs a route as `actor` without HTTP (server-originated changes), announcing it like any change. */
  async function runAs(actor, moduleId, method, route, body = null) {
    const result = await run({ moduleId, method, route, actor, body });
    if (result.changes) {
      publish({
        module: moduleId,
        method,
        route,
        client: null,
        user: actor.name,
        at: new Date().toISOString(),
        ...(result.cells ? { cells: result.cells } : {}),
      });
    }
    return result.value;
  }

  /** Every route of every module, for generated sweep tests. */
  function describe() {
    return [...compiled.values()].flatMap((entry) =>
      entry.routes.map(({ method, path, verb, item, part, role }) => ({
        module: entry.module.id,
        method,
        path,
        verb,
        item,
        part,
        role,
      })),
    );
  }

  for (const module of modules) {
    module.connect?.({
      runAs: (actor, method, route, body) => runAs(actor, module.id, method, route, body),
    });
  }

  return { handle, runAs, describe };
}
