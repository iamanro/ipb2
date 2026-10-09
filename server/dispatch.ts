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
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import { HttpError, isJsonObject, sendJson, type Json } from './http.ts';
import type { LiveEvent } from './live.ts';
import type { Actor, OwnedItem } from './policy.ts';
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
} from './policy.ts';
import { transact, type Row } from './state.ts';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const VERBS = new Set(['see', 'change', 'create', 'list', 'none']);
const REACHES = new Set(['everyone', 'white', 'handler']);
const ANNOUNCE: unique symbol = Symbol('announce');
const DEFAULT_BODY_LIMIT = 1 << 20;

/** A row of a cell-owned item table: it always carries these columns. */
export type ItemRow = Row & {
  id: number;
  owner_cell: string;
  releasable_to: string | null;
  revision?: number;
};

/** True when `row` has the columns every cell-owned item table carries. */
export function isItemRow(row: Row | null | undefined): row is ItemRow {
  return (
    row != null &&
    typeof row.id === 'number' &&
    typeof row.owner_cell === 'string' &&
    (row.releasable_to === null || typeof row.releasable_to === 'string')
  );
}

// A route that declares `item`/`part` (or verb 'create') always gets it; these
// say so to the checker, and fail loudly if a route table ever disagrees.
export function requireItem(item: ItemRow | undefined): ItemRow {
  if (!item) throw new Error('This route resolved no item; it must declare one.');
  return item;
}
export function requirePart(part: Row | undefined): Row {
  if (!part) throw new Error('This route resolved no part; it must declare one.');
  return part;
}
export function requireOwner(owner: Owner | undefined): Owner {
  if (!owner) throw new Error("Only a 'create' route gets an owner.");
  return owner;
}

/** What a handler composes access with: bound to the requester, never exposing them. */
export type Access = {
  white: boolean;
  cell: string | null;
  see(kind: string, id: number): Row;
  canEdit(itemRow: OwnedItem): boolean;
  visible(kind: string, options?: { alias?: string }): { sql: string; params: string[] };
};
/** The ownership a 'create' route must store on its new item. */
export type Owner = { owner_cell: string; releasable_to: string[] };
export type HandlerContext = {
  item: ItemRow | undefined;
  part: Row | undefined;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Json;
  owner: Owner | undefined;
  access: Access;
  actorName: string | undefined;
  request: IncomingMessage | null;
  response: ServerResponse | null;
};
/** A 'handler'-reach route's result: the body, and the cells that hear about it. */
export type Announcement = { [ANNOUNCE]: true; value: Json; cells: string[] };
/** A handler's JSON body, or undefined when it sent the response itself. */
export type HandlerResult = Json | Announcement | undefined;

/** One route a module declares (see the module doc above for each field). */
export type RouteSpec = {
  method: string;
  path: string | RegExp;
  verb: 'see' | 'change' | 'create' | 'list' | 'none';
  item?: string;
  part?: string;
  role?: string;
  reach?: 'everyone' | 'white' | 'handler';
  changes?: boolean;
  bodyLimit?: number;
  handler: (context: HandlerContext) => HandlerResult | Promise<HandlerResult>;
};
export type OwnershipChange = {
  kind: string;
  action: 'release' | 'reassign';
  before: ItemRow;
  after: ItemRow;
  actorName: string | undefined;
};
export type ItemSpec = {
  table: string;
  path?: string;
  label: string;
  /** The table has a `revision` column that release/reassign must match and bump. */
  revision?: boolean;
  shape(row: ItemRow, context: { access: Access }): Json;
  onOwnership?(change: OwnershipChange): void;
};
export type PartSpec = { table: string; item: string; column: string; label: string };
export type ModuleSpec = {
  id: string;
  close?(): void;
  database?: () => DatabaseSync;
  items?: Record<string, ItemSpec>;
  parts?: Record<string, PartSpec>;
  routes?: RouteSpec[];
  connect?(server: { runAs: RunAs }): void;
};
export type RunAs = (actor: Actor, method: string, route: string, body?: Json) => Promise<Json>;

/** A declared route, or one of the generated release/reassign routes (no handler). */
type CompiledRoute = (
  | RouteSpec
  | (Omit<RouteSpec, 'verb' | 'handler'> & { verb: 'release' | 'reassign'; handler?: undefined })
) & { match: (path: string) => Record<string, string> | null };
type CompiledModule = {
  module: ModuleSpec;
  items: Record<string, ItemSpec>;
  parts: Record<string, PartSpec>;
  routes: CompiledRoute[];
};

function isAnnouncement(result: HandlerResult): result is Announcement {
  return typeof result === 'object' && result !== null && ANNOUNCE in result;
}

/** What a `reach: 'handler'` route returns: the body, and the cells that hear about it. */
export function announce(value: Json, cells: string[]): Announcement {
  if (!Array.isArray(cells) || cells.some((cell) => !CELLS.includes(cell))) {
    throw new Error(`announce: cells must be a list of ${CELLS.join('/')}.`);
  }
  return { [ANNOUNCE]: true, value, cells };
}

/** The actor for changes the server makes on its own (inject firing): counts as White. */
export const EXERCISE_CONTROL: Actor = Object.freeze({
  name: 'scenario clock',
  admin: false,
  cell: 'white',
  role: 'game-master',
});

function compilePath(path: string | RegExp): (route: string) => Record<string, string> | null {
  if (path instanceof RegExp)
    return (route) => path.exec(route)?.groups ?? (path.test(route) ? {} : null);
  const segments = path.split('/');
  return (route) => {
    const parts = route.split('/');
    if (parts.length !== segments.length) return null;
    const params: Record<string, string> = {};
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

function integerId(text: string | undefined, label: string) {
  if (!/^\d+$/.test(text ?? '')) throw new HttpError(404, `${label} ${text} not found.`);
  return Number(text);
}

function requireRevision(label: string, item: ItemRow, body: Json) {
  const revision = isJsonObject(body) ? body.revision : undefined;
  if (typeof revision !== 'number' || !Number.isInteger(revision))
    throw new HttpError(400, `${label} revision is required.`);
  if (revision !== item.revision) {
    throw new HttpError(409, `${label} ${item.id} changed; reload latest before saving.`, {
      code: 'stale_revision',
      current_revision: item.revision,
    });
  }
}

/** Reads a JSON body, or null when there is none (a bodiless POST/DELETE). */
async function readBody(request: IncomingMessage | null, limit: number): Promise<Json> {
  if (!request) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'The request body is too large.');
    chunks.push(chunk);
  }
  if (!size) return null;
  try {
    const parsed: Json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed;
  } catch {
    throw new HttpError(400, 'The body is not valid JSON.');
  }
}

/** Validates a module's declaration once, at dispatcher creation, so a typo fails at startup. */
function compileModule(module: ModuleSpec): CompiledModule {
  const items = module.items ?? {};
  const parts = module.parts ?? {};
  for (const [kind, part] of Object.entries(parts)) {
    if (!items[part.item])
      throw new Error(`${module.id}: part "${kind}" names unknown item "${part.item}".`);
    if (!part.table || !part.column)
      throw new Error(`${module.id}: part "${kind}" needs table and column.`);
  }
  const routes: CompiledRoute[] = [];
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
    if (['see', 'change', 'create'].includes(route.verb) && !(route.item && items[route.item])) {
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

export type AuditEntry = {
  user: string | undefined;
  method: string;
  path: string;
  status: number;
  client: string | null;
};

export function createDispatcher(
  modules: ModuleSpec[],
  {
    publish = () => {},
    audit = () => {},
  }: { publish?: (event: LiveEvent) => void; audit?: (entry: AuditEntry) => void } = {},
) {
  const compiled = new Map(modules.map((module) => [module.id, compileModule(module)]));

  function database(entry: CompiledModule): DatabaseSync {
    if (!entry.module.database) throw new Error(`${entry.module.id}: items need database().`);
    return entry.module.database();
  }

  function fetchRow(entry: CompiledModule, table: string, id: SQLOutputValue): Row | null {
    if (id instanceof Uint8Array) return null;
    return database(entry).prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) ?? null;
  }

  /** The access capability a handler gets: bound to the requester, never exposing them. */
  function accessFor(entry: CompiledModule, actor: Actor): Access {
    return {
      white: isWhite(actor),
      cell: actor?.cell ?? null,
      /** A row of any item or part kind the requester can see, or 404. */
      see(kind: string, id: number) {
        const part = entry.parts[kind];
        const itemKind = part ? part.item : kind;
        const spec = entry.items[itemKind];
        if (!spec) throw new Error(`${entry.module.id}: unknown kind "${kind}".`);
        const label = (part ?? spec).label;
        const row = fetchRow(entry, (part ?? spec).table, id);
        const item = row && (part ? fetchRow(entry, spec.table, row[part.column]) : row);
        if (!row || !isItemRow(item) || !canSee(actor, item))
          throw new HttpError(404, `${label} ${id} not found.`);
        return row;
      },
      /** Whether the requester may change this item row (for per-row flags in a response). */
      canEdit: (itemRow: OwnedItem) => canEdit(actor, itemRow),
      /** The WHERE condition limiting an item kind's list to what the requester can see. */
      visible(kind: string, options?: { alias?: string }) {
        if (!entry.items[kind])
          throw new Error(`${entry.module.id}: visible() needs an item kind, got "${kind}".`);
        return visibilitySql(actor, options);
      },
    };
  }

  function resolveItem(
    entry: CompiledModule,
    route: CompiledRoute,
    params: Record<string, string>,
    actor: Actor,
  ): { item: ItemRow; part: Row | undefined } {
    const { spec } = routeItem(entry, route);
    const id = integerId(params.item, spec.label);
    const item = fetchRow(entry, spec.table, id);
    if (!isItemRow(item) || !canSee(actor, item))
      throw new HttpError(404, `${spec.label} ${id} not found.`);
    let part: Row | undefined;
    if (route.part) {
      const partSpec = entry.parts[route.part];
      const partId = integerId(params.part, partSpec.label);
      const row = fetchRow(entry, partSpec.table, partId);
      if (!row || row[partSpec.column] !== id)
        throw new HttpError(404, `${partSpec.label} ${partId} not found.`);
      part = row;
    }
    return { item, part };
  }

  /** The item kind a route names and its spec; compileModule guaranteed both exist. */
  function routeItem(
    entry: CompiledModule,
    route: CompiledRoute,
  ): { kind: string; spec: ItemSpec } {
    const kind = route.item;
    const spec = kind ? entry.items[kind] : undefined;
    if (!kind || !spec)
      throw new Error(`${entry.module.id}: ${route.method} ${route.path} has no item.`);
    return { kind, spec };
  }

  function ownershipChange(
    entry: CompiledModule,
    route: CompiledRoute & { verb: 'release' | 'reassign' },
    item: ItemRow,
    actor: Actor,
    body: Json,
    actorName: string | undefined,
  ): { value: Json; cells: string[] } {
    const { kind, spec } = routeItem(entry, route);
    const before = item;
    let ownerCell = item.owner_cell;
    let releasable: string[];
    const fields = isJsonObject(body) ? body : {};
    if (route.verb === 'release') {
      if (!canRelease(actor, item))
        throw new HttpError(403, `You may not release this ${spec.label}.`);
      if (spec.revision) requireRevision(spec.label, item, body);
      releasable = normalizeRelease(fields.cells, ownerCell);
    } else {
      if (!isWhite(actor)) throw new HttpError(403, `Only White may reassign this ${spec.label}.`);
      if (spec.revision) requireRevision(spec.label, item, body);
      const requested = fields.owner_cell;
      if (typeof requested !== 'string' || !CELLS.includes(requested))
        throw new HttpError(400, `Unknown cell: ${JSON.stringify(requested)}`);
      ownerCell = requested;
      releasable = normalizeRelease(liveCellsFor(item).slice(1), ownerCell);
    }
    const db = database(entry);
    const after = transact(db, () => {
      const bumpRevision = spec.revision ? ', revision = revision + 1' : '';
      db.prepare(
        `UPDATE ${spec.table} SET owner_cell = ?, releasable_to = ?${bumpRevision} WHERE id = ?`,
      ).run(ownerCell, JSON.stringify(releasable), item.id);
      const row = fetchRow(entry, spec.table, item.id);
      if (!isItemRow(row)) throw new Error(`${spec.table} ${item.id} vanished mid-update.`);
      spec.onOwnership?.({ kind, action: route.verb, before, after: row, actorName });
      return row;
    });
    const cells = [...new Set([...liveCellsFor(before), ...liveCellsFor(after)])];
    return { value: spec.shape(after, { access: accessFor(entry, actor) }), cells };
  }

  /**
   * Runs one request. `route` is the path after `/api/<moduleId>/`. `request`
   * and `response` may be null for an internal call (see `runAs`), in which
   * case `body` is given directly and the value is returned, not sent.
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
  }: {
    moduleId: string;
    method: string;
    route: string;
    url?: URL;
    actor: Actor;
    request?: IncomingMessage | null;
    response?: ServerResponse | null;
    body?: Json;
  }): Promise<{ value: Json; changes: boolean; cells: string[] | null | undefined }> {
    const entry = compiled.get(moduleId);
    if (!entry) throw new HttpError(404, 'Unknown module.');
    let route: CompiledRoute | null = null;
    let params: Record<string, string> | null = null;
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
      route.item && route.verb !== 'create'
        ? resolveItem(entry, route, params ?? {}, actor)
        : { item: undefined, part: undefined };
    if (route.verb === 'change' && item && !canEdit(actor, item)) {
      throw new HttpError(
        403,
        `Released to your cell for reading only; the ${item.owner_cell} cell owns it.`,
      );
    }

    const body: Json =
      givenBody !== undefined
        ? givenBody
        : MUTATION_METHODS.has(method)
          ? await readBody(request, route.bodyLimit ?? DEFAULT_BODY_LIMIT)
          : null;
    const actorName = actor.name;

    let value: Json;
    let cells: string[] | undefined;
    if (route.verb === 'release' || route.verb === 'reassign') {
      if (!item) throw new Error(`${moduleId}: ${method} ${route.path} resolved no item.`);
      ({ value, cells } = ownershipChange(entry, route, item, actor, body, actorName));
    } else {
      let owner: Owner | undefined;
      const fields = isJsonObject(body) ? body : {};
      if (route.verb === 'create') {
        const ownerCell = ownerCellForCreate(actor, fields.owner_cell ?? undefined);
        const requested = fields.releasable_to ?? [];
        if (
          Array.isArray(requested) &&
          requested.length &&
          !canRelease(actor, { owner_cell: ownerCell })
        ) {
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
      const result = await route.handler({
        item,
        part,
        params: params ?? {},
        query,
        body,
        owner,
        access: accessFor(entry, actor),
        actorName,
        request,
        response,
      });
      if (route.reach === 'handler') {
        if (!isAnnouncement(result))
          throw new Error(
            `${moduleId}: ${method} ${route.path} must return announce(value, cells).`,
          );
        ({ value, cells } = result);
      } else if (isAnnouncement(result)) {
        throw new Error(
          `${moduleId}: ${method} ${route.path} returned announce() without reach: 'handler'.`,
        );
      } else {
        value = result ?? null;
      }
      if (
        route.verb === 'create' &&
        owner &&
        isJsonObject(value) &&
        'owner_cell' in value &&
        value.owner_cell !== owner.owner_cell
      ) {
        throw new Error(
          `${moduleId}: ${method} ${route.path} stored owner_cell ${JSON.stringify(value.owner_cell)}, not "${owner.owner_cell}".`,
        );
      }
    }

    const changes = MUTATION_METHODS.has(method) && route.changes !== false;
    let audience: string[] | null | undefined = null;
    if (changes) {
      const everyone = route.verb === 'none' && route.reach === 'everyone';
      audience = everyone ? undefined : (cells ?? ['white']);
    }
    return { value, changes, cells: audience };
  }

  /** The HTTP entry point, called by server/api.ts after authentication. */
  async function handle({
    moduleId,
    route,
    url,
    request,
    response,
    actor,
    client,
    rawClient,
  }: {
    moduleId: string;
    route: string;
    url: URL;
    request: IncomingMessage;
    response: ServerResponse;
    actor: Actor;
    client: string | null;
    rawClient: string | null;
  }) {
    const method = request.method ?? 'GET';
    const result = await run({
      moduleId,
      method,
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
          method,
          route,
          client,
          user: actor.name,
          at: new Date().toISOString(),
          ...(result.cells ? { cells: result.cells } : {}),
        });
        audit({
          user: actor.name,
          method,
          path: url.pathname,
          status: response.statusCode,
          client: rawClient,
        });
      };
      if (response.writableEnded) finish();
      else response.once('finish', finish);
    }
    if (!response.writableEnded && !response.headersSent) sendJson(response, result.value);
  }

  /** Runs a route as `actor` without HTTP (server-originated changes), announcing it like any change. */
  async function runAs(
    actor: Actor,
    moduleId: string,
    method: string,
    route: string,
    body: Json = null,
  ): Promise<Json> {
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
