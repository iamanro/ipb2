/**
 * User, membership and exercise-lifecycle administration (C1/C6, admin
 * flag). Server-only surface: everything it needs already lives under
 * `/api/auth/*` (`server/api.js`'s `handleAuthRoute`), so unlike every
 * other module this one has no `server/routes.js` of its own — a plain
 * HTTP module registered in `server/modules.js` would only add an unused,
 * unreachable second path to the same `openAuthStore()`.
 */
export default {
  id: 'admin',
  title: 'Admin',
  summary: 'Users, memberships, the exercise and the audit trail',
  load: () => import('./client/view.js'),
  // Hidden from the nav for anyone who isn't a signed-in admin (`off` mode
  // has no users to manage at all) — the server enforces the real gate
  // regardless of what the nav shows (`server/api.js`'s `admin`-flag check
  // on every `/api/auth/users*`, `/api/auth/members*` and
  // `/api/auth/exercise*` route).
  visible: (user, mode) => mode === 'on' && Boolean(user?.admin),
};
