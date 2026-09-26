// Self-hosted faces: the app runs offline, and system stacks differ per OS.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans-condensed/500.css';
import '@fontsource/ibm-plex-sans-condensed/600.css';
import '@fontsource/ibm-plex-sans-condensed/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './shell.css';

import { renderChangePasswordScreen } from './changePassword.js';
import { renderLoginScreen } from './login.js';
import { modules } from './modules.js';
import { subscribe } from './live.js';
import { renderCellBadge } from './release.js';
import { currentUser, handleUnauthorized, loadSession, onUnauthorized, sessionMode } from './session.js';

const nav = document.querySelector('#module-nav');
const root = document.querySelector('#module-root');
const status = document.querySelector('#masthead-status');
const userChip = document.querySelector('#user-chip');

const byId = new Map(modules.map((module) => [module.id, module]));
let active = null;
let unmount = null;
let routeToken = 0;
/** The current exercise's name (C6): fetched alongside the session, shown
 * in the masthead user chip. `null` until the first fetch resolves (or if
 * it fails — a slow/offline tick simply leaves the chip's exercise name
 * blank rather than blocking the shell). */
let exerciseName = null;

/** `GET /api/auth/exercise` — any signed-in user (and `off` mode's fixed
 * operator) may read the name. Called at startup and whenever the chip is
 * re-rendered after a sign-in, so a rename between sessions is picked up. */
async function refreshExerciseName() {
  try {
    const response = await fetch('/api/auth/exercise');
    if (!response.ok) return;
    const payload = await response.json();
    exerciseName = payload.name ?? null;
  } catch {
    // Offline or mid-restart: keep whatever name was last known.
  }
}

function modulePath(module) {
  return `/${module.id}/`;
}

function requestedModule() {
  const id = window.location.pathname.split('/')[1];
  return byId.get(id) || null;
}

/** Modules with a `visible(user, mode)` predicate (currently just `admin`)
 * are omitted from the nav when it returns false — the server enforces the
 * actual gate regardless (`/api/auth/users/*` needs the admin role, checked
 * in `server/api.js`), this only avoids advertising a link a role can't use. */
function visibleModules() {
  return modules.filter((module) => !module.visible || module.visible(currentUser(), sessionMode()));
}

function renderNav() {
  nav.replaceChildren(
    ...visibleModules().map((module) => {
      const link = document.createElement('a');
      link.href = modulePath(module);
      link.title = module.summary;
      link.textContent = module.title;
      if (module === active) link.setAttribute('aria-current', 'page');
      return link;
    }),
  );
}

function renderUserChip() {
  const user = currentUser();
  userChip.replaceChildren();
  if (sessionMode() !== 'on' || !user) {
    userChip.hidden = true;
    return;
  }
  userChip.hidden = false;
  const exercise = document.createElement('span');
  exercise.className = 'user-chip-exercise';
  exercise.textContent = exerciseName ?? '';
  const cell = renderCellBadge(user.cell);
  cell.classList.add('user-chip-cell');
  const name = document.createElement('span');
  name.className = 'user-chip-name';
  name.textContent = user.name;
  const role = document.createElement('span');
  role.className = 'user-chip-role';
  // A member-less admin acts as White's game-master (C1) but isn't one: say admin.
  role.textContent = user.effective ? 'admin' : (user.role ?? 'unassigned');
  const changePassword = document.createElement('button');
  changePassword.type = 'button';
  changePassword.className = 'user-chip-changepw';
  changePassword.textContent = 'Change password';
  changePassword.addEventListener('click', () => showChangePasswordScreen({ forced: false }));
  const signOut = document.createElement('button');
  signOut.type = 'button';
  signOut.className = 'user-chip-signout';
  signOut.textContent = 'Sign out';
  signOut.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    handleUnauthorized();
  });
  userChip.append(exercise, cell, name, role, changePassword, signOut);
}

/** Shown instead of a module when `IPB_AUTH=on` has no session — at startup,
 * or later, when a module's own request helper sees a 401 and calls
 * `handleUnauthorized()` (never a global `fetch` wrapper). */
function showLoginScreen() {
  unmount?.();
  unmount = null;
  active = null;
  routeToken += 1;
  nav.replaceChildren();
  status.replaceChildren();
  renderUserChip();
  root.replaceChildren();
  renderLoginScreen(root, {
    async onSuccess() {
      await loadSession();
      await refreshExerciseName();
      renderUserChip();
      route();
    },
  });
}

/** Shown full-screen (uncancellable) right after a sign-in with
 * `must_change_password` set, or on demand (cancellable) from the masthead
 * chip's "Change password" button. */
function showChangePasswordScreen({ forced }) {
  unmount?.();
  unmount = null;
  active = null;
  routeToken += 1;
  if (forced) {
    nav.replaceChildren();
    status.replaceChildren();
  }
  root.replaceChildren();
  renderChangePasswordScreen(root, {
    forced,
    async onSuccess() {
      await loadSession();
      await refreshExerciseName();
      renderUserChip();
      route();
    },
    onCancel: () => route(),
  });
}

/** Shown instead of every module for a signed-in, non-admin user with no
 * membership in the current exercise (C1) — a clear dead end (not a 401,
 * not a blank module list) pointing at the one thing that unblocks them:
 * an admin assigning them to a cell. */
function showNotAssignedScreen() {
  unmount?.();
  unmount = null;
  active = null;
  routeToken += 1;
  nav.replaceChildren();
  status.replaceChildren();
  const screen = document.createElement('div');
  screen.className = 'not-assigned-screen';
  const card = document.createElement('div');
  card.className = 'not-assigned-card';
  const title = document.createElement('h1');
  title.className = 'not-assigned-title';
  title.textContent = 'Not assigned to the current exercise';
  const message = document.createElement('p');
  message.className = 'not-assigned-message';
  message.textContent = 'Ask an admin to assign you to a cell (White, Blue or Red) before you can open a module.';
  card.append(title, message);
  screen.append(card);
  root.replaceChildren(screen);
}

onUnauthorized(() => {
  if (sessionMode() === 'on') showLoginScreen();
});

/** C6: a reset or restore swaps every module's data (and the membership
 * roster) out from under whatever's on screen — every tab reloads rather
 * than trying to reconcile in-flight state against data that no longer
 * exists. */
subscribe(
  (event) => event.module === 'auth' && event.route === 'exercise/reset',
  () => window.location.reload(),
);

async function route() {
  if (sessionMode() === 'on' && !currentUser()) {
    showLoginScreen();
    return;
  }
  if (sessionMode() === 'on' && currentUser()?.must_change_password) {
    showChangePasswordScreen({ forced: true });
    return;
  }
  if (sessionMode() === 'on' && currentUser() && !currentUser().admin && !currentUser().cell) {
    showNotAssignedScreen();
    return;
  }
  let module = requestedModule();
  if (!module) {
    module = modules[0];
    window.history.replaceState(null, '', modulePath(module));
  }
  if (module === active) return;
  const token = ++routeToken;
  unmount?.();
  unmount = null;
  status.replaceChildren();
  root.replaceChildren();
  root.dataset.module = module.id;
  active = module;
  document.title = `${module.title} · IPB`;
  renderNav();
  try {
    const { mount } = await module.load();
    if (token !== routeToken) return;
    unmount = mount({ root, status });
  } catch (error) {
    if (token !== routeToken) return;
    const message = document.createElement('div');
    message.className = 'module-error';
    message.textContent = error.message;
    root.replaceChildren(message);
  }
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link || link.origin !== window.location.origin) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  const target = link.pathname === '/' ? modules[0] : byId.get(link.pathname.split('/')[1]);
  if (!target || link.pathname !== modulePath(target)) return;
  event.preventDefault();
  if (target === active) return;
  window.history.pushState(null, '', link.href);
  route();
});
window.addEventListener('popstate', route);

async function start() {
  await loadSession();
  await refreshExerciseName();
  renderUserChip();
  if (sessionMode() === 'on' && !currentUser()) {
    showLoginScreen();
    return;
  }
  route();
}

start();
