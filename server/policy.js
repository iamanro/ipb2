/**
 * Phase 1 cell/role policy (C2, docs/phase1-access.md). Pure, no I/O: every
 * function here takes plain data in and returns plain data or throws
 * `HttpError` — no database handle, no request/response. `server/api.js`
 * and every module's routes/store call into this instead of re-deriving
 * visibility or release rules of their own.
 *
 * `ROLES`/`roleAtLeast` moved here from `server/access.js` (which now
 * imports and re-exports them) so this file is the single place both the
 * role hierarchy and the cell rules live.
 */
import { HttpError } from './http.js';

/** The three cells an exercise splits into. Order matters nowhere except
 * display; `normalizeRelease` sorts alphabetically regardless. */
export const CELLS = ['white', 'blue', 'red'];

export const ROLES = ['observer', 'analyst', 'collection-manager', 'game-master', 'admin'];

function rank(role) {
  const index = ROLES.indexOf(role);
  if (index === -1) throw new Error(`Unknown role: ${role}`);
  return index;
}

/** True when `role` outranks or equals `required` in the hierarchy above. */
export function roleAtLeast(role, required) {
  return rank(role) >= rank(required);
}

/** White sees and controls everything, cell-blind — and so does an admin,
 * whether or not they hold a membership of their own (their `admin` flag
 * always wins here; only their *role*, gating actions, follows a real
 * membership when they have one). */
export function isWhite(user) {
  return Boolean(user?.admin) || user?.cell === 'white';
}

/** `releasable_to` as stored can be a JSON array already (a JS caller that
 * parsed a row) or the raw JSON text SQLite handed back — normalise either
 * to an array, defensively empty for anything else (missing column, NULL,
 * malformed text). */
function releasableArray(releasableTo) {
  if (Array.isArray(releasableTo)) return releasableTo;
  if (typeof releasableTo === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(releasableTo);
    } catch {
      return [];
    }
    return Array.isArray(parsed) ? parsed : [];
  }
  return [];
}

/** `item = { owner_cell, releasable_to }`. White/admin see everything; a
 * cell member sees their own cell's items and anything released to them. A
 * user with no cell (a non-admin, non-member — 403'd upstream in practice,
 * but this stays correct standalone) sees nothing cell-owned. */
export function canSee(user, item) {
  if (isWhite(user)) return true;
  if (!user?.cell) return false;
  if (item.owner_cell === user.cell) return true;
  return releasableArray(item.releasable_to).includes(user.cell);
}

/**
 * A WHERE fragment for a table with `owner_cell`/`releasable_to` columns
 * (`releasable_to` a JSON array of cells, as stored). `alias`, given,
 * prefixes both column references (`alias.owner_cell`, ...) for a joined
 * query. White/admin get an unconditional `1=1`; a cell member gets an
 * owner-or-released check; a user with no cell gets an unconditional
 * `0=1` (matches `canSee`'s "sees nothing" for the same case).
 */
export function visibilitySql(user, { alias } = {}) {
  if (isWhite(user)) return { sql: '1=1', params: [] };
  if (!user?.cell) return { sql: '0=1', params: [] };
  const prefix = alias ? `${alias}.` : '';
  const sql =
    `(${prefix}owner_cell = ? OR EXISTS (` +
    `SELECT 1 FROM json_each(${prefix}releasable_to) WHERE json_each.value = ?))`;
  return { sql, params: [user.cell, user.cell] };
}

/**
 * The `owner_cell` a new item gets. White (incl. admin) may request any
 * cell and defaults to white when none is given; anyone else is forced to
 * their own cell — 400 if they ask for a different one, 403 if they have
 * no cell to create anything under.
 */
export function ownerCellForCreate(user, requested) {
  if (isWhite(user)) {
    const cell = requested ?? 'white';
    if (!CELLS.includes(cell)) throw new HttpError(400, `Unknown cell: ${cell}`);
    return cell;
  }
  if (!user?.cell) throw new HttpError(403, 'You are not assigned to a cell.');
  if (requested !== undefined && requested !== null && requested !== user.cell) {
    throw new HttpError(400, `You may only create items owned by your own cell (${user.cell}).`);
  }
  return user.cell;
}

/**
 * Release grants READ access only. Changing a cell-owned item (or any child
 * row under it) takes White (incl. admin) or membership of the owning cell;
 * the route's role requirement (server/access.js) applies on top. A visible
 * but not editable item answers 403 (it's already visible, so no 404).
 */
export function canEdit(user, item) {
  return isWhite(user) || (Boolean(user?.cell) && user.cell === item.owner_cell);
}

/** Throws 403 unless `canEdit(user, item)`. */
export function assertCanEdit(user, item) {
  if (!canEdit(user, item)) {
    throw new HttpError(403, `Released to your cell for reading only; the ${item.owner_cell} cell owns it.`);
  }
}

/** White (incl. admin), or an `analyst`-or-above member of the owning
 * cell, may release an item (or reassign its owner). */
export function canRelease(user, item) {
  if (isWhite(user)) return true;
  if (!user?.cell || user.cell !== item.owner_cell) return false;
  return roleAtLeast(user.role, 'analyst');
}

/** Validates and normalises a release list: drops the owner cell and
 * duplicates, sorts, 400s on anything not a real cell. */
export function normalizeRelease(cells, owner) {
  if (!Array.isArray(cells)) throw new HttpError(400, 'cells must be an array.');
  const set = new Set();
  for (const cell of cells) {
    if (!CELLS.includes(cell)) throw new HttpError(400, `Unknown cell: ${cell}`);
    if (cell === owner) continue;
    set.add(cell);
  }
  return [...set].sort();
}

/** The cells a live event about `item` should reach: its owner plus
 * whoever it's released to (server/live.js also always delivers to White). */
export function liveCellsFor(item) {
  return [item.owner_cell, ...releasableArray(item.releasable_to)];
}

/**
 * C4: what a module handler sets `request.liveCells` to for a change every
 * cell may hear about (the scenario clock, scenario geography, shared
 * bookmarks). Live events fail closed: a mutation that sets neither this
 * nor a cell list is announced to White only.
 */
export const LIVE_ALL = 'all';

/** The `cells` a live event is published with: undefined = everyone. */
export function publishedCells(liveCells) {
  if (liveCells === LIVE_ALL) return undefined;
  return Array.isArray(liveCells) ? liveCells : ['white'];
}
