/**
 * The single source of truth for what role a request needs (C3). `api.js`
 * calls `requiredRole` after authenticating and before dispatching to a
 * module; wave-2 UIs call `can()` (via `src/session.js`) to hide or disable
 * controls a role can't use, but the server enforces regardless of what the
 * client shows.
 *
 * `admin` is now a separate global flag (`server/policy.js`, `server/auth.js`),
 * checked directly (`request.user.admin`) wherever user management or the
 * exercise lifecycle needs it, not through this per-module table. `ROLES`
 * and `roleAtLeast` live in `server/policy.js` (cell/role policy, C2) and
 * are re-exported here so every existing importer of this module keeps
 * working unchanged.
 */
export { ROLES, roleAtLeast } from './policy.js';

// Exercise routes that command the scenario itself — the clock, the event
// schedule, the roster, and the scenario/country/place library — rather than
// day-to-day analyst work against an already-running exercise.
const EXERCISE_GAME_MASTER =
  /^(clock|scenario-events|scenario-tick|scenarios|scenario-countries|scenario-places|roster)(\/|$)/;
// Collection management: tasking collectors against the ISR plan.
const EXERCISE_COLLECTION_MANAGER = /^(collectors|taskings)(\/|$)/;
// Equipment routes that search or batch-look-up the read-only reference data
// through a POST body — `cards` because a wide filter set would overflow a
// GET query string, `ranges` (C8) because a long identifier list would too —
// rather than mutate anything. They read at `observer`, like any GET.
const EQUIPMENT_READS_VIA_POST = new Set(['cards', 'ranges']);
// Terrain's one POST: elevation extremes over an AOI polygon that can outgrow a
// query string. It reads the elevation model and changes nothing.
const TERRAIN_READS_VIA_POST = new Set(['extremes']);

/**
 * `moduleId` is the `/api/<moduleId>/...` segment, `route` is the path after
 * it (no leading slash), matching what `module.handle({ route })` receives.
 */
export function requiredRole(moduleId, method, route) {
  // Scenario events carry inject text the training audience must not see
  // ahead of time (or, cancelled, at all) — gated at game-master even for a
  // plain GET, unlike every other exercise read.
  if (moduleId === 'exercise' && /^scenario-events(\/|$)/.test(route)) return 'game-master';
  if (method === 'GET' || method === 'HEAD') return 'observer';
  if (moduleId === 'equipment' && EQUIPMENT_READS_VIA_POST.has(route)) return 'observer';
  if (moduleId === 'terrain' && TERRAIN_READS_VIA_POST.has(route)) return 'observer';
  if (moduleId === 'exercise') {
    if (EXERCISE_GAME_MASTER.test(route)) return 'game-master';
    if (EXERCISE_COLLECTION_MANAGER.test(route)) return 'collection-manager';
  }
  // Unknown routes, and every mutation not named above, need `analyst`.
  return 'analyst';
}
