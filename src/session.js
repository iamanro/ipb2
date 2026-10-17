/**
 * The client's view of who is signed in (C1/C5). `loadSession()` calls `GET
 * /api/auth/me` once at startup; `server/policy.ts`/`server/api.ts` are
 * still the only real gate — `can()`/`isWhite()` here only hide or disable
 * controls a role or cell can't use, the server enforces regardless of
 * what the client shows.
 *
 * `user` is `{ name, admin, cell, role, must_change_password }` (C1) — or,
 * in `off` mode, the fixed local operator (`admin: true, cell: 'white',
 * role: 'game-master'`).
 *
 * Mirrors `server/policy.ts`'s `ROLES`/`roleAtLeast`: duplicated, not
 * imported, because that file pulls in `node:sqlite` and has no business
 * in a browser bundle.
 */
const ROLES = ['observer', 'analyst', 'collection-manager', 'game-master', 'admin'];

function roleAtLeast(role, required) {
  return ROLES.indexOf(role) >= ROLES.indexOf(required);
}

const CELL_LABELS = { white: 'White', blue: 'Blue', red: 'Red' };

let mode = 'off';
let user = null;

/** `{ mode, user }` from the server. Call once before routing. */
export async function loadSession() {
  const response = await fetch('/api/auth/me');
  const payload = await response.json().catch(() => ({ mode: 'off', user: null }));
  mode = payload.mode === 'on' ? 'on' : 'off';
  user = payload.user ?? null;
  return { mode, user };
}

export function sessionMode() {
  return mode;
}

export function currentUser() {
  return user;
}

/** True when the signed-in user (their exercise membership role — an
 * admin without one already carries the effective `game-master` C1 gives
 * them) may act at `role`. `off` mode's implicit operator always may;
 * an `on`-mode admin always may too, whatever their membership role, the
 * same way `server/policy.ts`'s cell rules always let an admin through. */
export function can(role) {
  if (mode === 'off') return true;
  if (!user) return false;
  if (user.admin) return true;
  return roleAtLeast(user.role, role);
}

/** True for White (or an admin, cell-blind by definition) — mirrors
 * `server/policy.ts`'s `isWhite`. */
export function isWhite() {
  if (mode === 'off') return true;
  if (!user) return false;
  return Boolean(user.admin) || user.cell === 'white';
}

/** A display label for a cell (`'white' | 'blue' | 'red'`); the cell
 * itself, capitalised, for anything unrecognised rather than blank. */
export function cellLabel(cell) {
  if (CELL_LABELS[cell]) return CELL_LABELS[cell];
  if (typeof cell === 'string' && cell) return cell[0].toUpperCase() + cell.slice(1);
  return '—';
}

const unauthorizedListeners = new Set();

/** The shell registers here once, to show the login screen again on a 401. */
export function onUnauthorized(listener) {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/**
 * Called by a module's own request helper when a response comes back 401
 * (session missing or expired) — never from a global `fetch` wrapper, which
 * this app deliberately doesn't have. Clears the cached user and tells the
 * shell to show the login screen again.
 */
export function handleUnauthorized() {
  if (mode !== 'on' || !user) return;
  user = null;
  for (const listener of unauthorizedListeners) listener();
}
