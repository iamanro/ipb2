/**
 * `/api/*` entry point: a Vite plugin middleware. Handles `/api/live` (SSE,
 * C2) and `/api/auth/*` (C3) directly, authenticates and authorises every
 * other `/api/<module>/...` request, then dispatches to the module registry
 * in `modules.js`. After a successful (status < 400) non-GET module request
 * it publishes a live event and writes an audit row — modules themselves
 * need no changes for either.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite-plus';

import {
  SESSION_TTL_MS,
  hashToken,
  openAuthStore,
  type AuthStore,
  type SessionUser,
} from './auth.ts';
import { createDispatcher } from './dispatch.ts';
import { createExerciseLifecycle } from './exerciseLifecycle.ts';
import {
  errorMessage,
  HttpError,
  isJsonObject,
  readJson,
  sendJson,
  type Json,
  type JsonObject,
} from './http.ts';
import {
  closeAllSubscribers,
  closeStreamsForToken,
  closeStreamsForUser,
  handleLive,
  publish,
} from './live.ts';
import { modules } from './modules.ts';
import { roleAtLeast } from './policy.ts';

const byId = new Map(modules.map((module) => [module.id, module]));

/** A request after authentication: `user` is who it runs as (null when signed out). */
export type ApiRequest = IncomingMessage & { user?: SessionUser | null };
export type AuthMode = 'on' | 'off';

/** The JSON error body for anything a handler threw (the one place errors leave as JSON). */
function errorJson(error: unknown): JsonObject {
  const body: JsonObject = { error: errorMessage(error) };
  if (error instanceof HttpError) {
    // HttpError details (e.g. a stale revision) are copied onto the error as own fields.
    for (const key of ['code', 'current_revision']) {
      const value: Json | undefined = Reflect.get(error, key);
      if (value !== undefined) body[key] = value;
    }
  }
  return body;
}

const SESSION_COOKIE = 'ipb_session';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
/** `off` mode: every request acts as this fixed local operator (C1) — White,
 * by cell and by the admin flag both, so it always sees and does everything
 * a real exercise's White game-master could. */
const LOCAL_USER: SessionUser = {
  name: 'local',
  admin: true,
  cell: 'white',
  role: 'game-master',
  must_change_password: false,
};
/** An `X-Client-Id` longer than this is truncated before it ever reaches the
 * audit table (IPB-AUTH-006); the header is meant to hold a short id, not
 * an arbitrary payload. */
const CLIENT_ID_HEADER_MAX = 64;
/** How much of the client id's hash is broadcast (IPB-AUTH-006): 64 bits of
 * a one-way hash, enough to distinguish tabs in a classroom-sized exercise
 * without handing every subscriber the reusable raw id to spoof with. */
const CLIENT_ID_HASH_LENGTH = 16;
/** The `/api/auth/*` routes a user with a temporary password may still use. */
const PASSWORD_CHANGE_ROUTES = new Set(['login', 'logout', 'me', 'password']);

function isLoopbackHost(host: string | boolean | null | undefined) {
  if (host === undefined || host === null) return true;
  // A bare `--host` (no value) resolves to boolean `true`: every interface.
  if (typeof host !== 'string') return false;
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * `off` by default on a loopback bind, `on` otherwise. `IPB_AUTH=on|off`
 * overrides either way, except `off` on a non-loopback bind, which would be
 * an open LAN: that refuses to start instead.
 */
export function resolveAuthMode(host: string | boolean | null | undefined): AuthMode {
  const loopback = isLoopbackHost(host);
  const override = process.env.IPB_AUTH;
  if (override === 'on' || override === 'off') {
    if (override === 'off' && !loopback) {
      throw new Error(
        `IPB_AUTH=off refuses to bind a non-loopback host (${JSON.stringify(host)}): set IPB_AUTH=on, or bind loopback.`,
      );
    }
    return override;
  }
  return loopback ? 'off' : 'on';
}

const SENSITIVE_ROOT_SEGMENTS = new Set(['modules', 'server']);
const SENSITIVE_DIR_SEGMENTS = new Set(['state', 'data']);
const SENSITIVE_EXTENSION = /\.(db|db-wal|db-shm|mbtiles|pmtiles)$/i;

function isSensitiveNormalizedPath(normalized: string) {
  // Every real API route is dispatched above this check and never reaches
  // it in practice; excluded here too so the predicate is correct on its
  // own, not merely by where its one caller happens to place it — e.g.
  // `/api/terrain/tiles/vector.pmtiles` shares an extension with a blocked
  // path but is a legitimate route, never a static file.
  if (normalized === '/api' || normalized.startsWith('/api/')) return false;
  if (normalized.startsWith('/@fs/')) return true;
  if (normalized.startsWith('/__open-in-editor')) return true;
  if (SENSITIVE_EXTENSION.test(normalized)) return true;
  const segments = normalized.split('/').filter(Boolean);
  return (
    SENSITIVE_ROOT_SEGMENTS.has(segments[0]) &&
    segments.slice(1).some((segment) => SENSITIVE_DIR_SEGMENTS.has(segment))
  );
}

/**
 * True for any request Vite's static/raw-fs middleware would otherwise
 * happily serve straight off disk (IPB-AUTH-001, critical): every module's
 * `state/` (working data, including `server/state/auth.db`'s password
 * hashes) and `data/` directory, any `*.db`/`*.db-wal`/`*.db-shm`/
 * `*.mbtiles`/`*.pmtiles` file, Vite's raw-filesystem escape hatch
 * (`/@fs/<abs-path>`), and its editor-launcher endpoint. Checked on both the
 * raw request path and its percent-decoded, `..`-resolved form — either one
 * reaching that middleware unmodified would serve the file, so an attacker
 * only needs one representation to work, not both. `vector.pmtiles` and
 * every reference/state database the app itself needs are already served
 * through their own `/api/<module>/...` route, never as a static file, so
 * this has no legitimate path to block.
 */
export function isBlockedStaticPath(rawUrl: string) {
  const rawPath = rawUrl.split('?')[0].split('#')[0];
  const forms = new Set([rawPath]);
  try {
    forms.add(decodeURIComponent(rawPath));
  } catch {
    // Malformed percent-encoding: the raw form above is still checked.
  }
  for (const form of forms) {
    const normalized = path.posix.normalize(form.startsWith('/') ? form : `/${form}`);
    if (isSensitiveNormalizedPath(normalized)) return true;
  }
  return false;
}

function parseCookies(header: string | undefined) {
  const jar: Record<string, string> = {};
  if (!header) return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const raw = part.slice(index + 1).trim();
    try {
      jar[key] = decodeURIComponent(raw);
    } catch {
      jar[key] = raw;
    }
  }
  return jar;
}

/** Behind a reverse proxy (Caddy/nginx terminating TLS) the socket itself is
 * always plain HTTP; only `IPB_TRUST_PROXY=1` makes `X-Forwarded-Proto`
 * count towards the `Secure` cookie flag — otherwise a client could set
 * that header itself and get a cookie sent in the clear believing it was
 * https. */
function trustProxy() {
  return process.env.IPB_TRUST_PROXY === '1';
}

function isHttps(request: IncomingMessage) {
  if ('encrypted' in request.socket && request.socket.encrypted === true) return true;
  return trustProxy() && request.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(response: ServerResponse, request: IncomingMessage, token: string) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isHttps(request)) parts.push('Secure');
  response.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(response: ServerResponse, request: IncomingMessage) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isHttps(request)) parts.push('Secure');
  response.setHeader('Set-Cookie', parts.join('; '));
}

/**
 * Without `IPB_TRUST_PROXY=1`, always the TCP peer — a client can send
 * whatever `X-Forwarded-For` it likes, so trusting it by default would let
 * the per-address rate limit (IPB-AUTH-003) and the audit trail's source be
 * spoofed by anyone. Behind Deploy's reverse proxy, the rightmost hop is the
 * one *that proxy* appended (the proxy overwrites or appends its own,
 * regardless of what the client sent before it), so it — not the leftmost,
 * client-controlled hop — is the address actually worth rate-limiting.
 */
function clientIp(request: IncomingMessage) {
  if (trustProxy()) {
    const header = request.headers['x-forwarded-for'];
    if (typeof header === 'string' && header) {
      const hops = header.split(',').map((hop) => hop.trim());
      const last = hops[hops.length - 1];
      if (last) return last;
    }
  }
  return request.socket?.remoteAddress || 'unknown';
}

/** A short, one-way stand-in for a tab's raw `X-Client-Id` (IPB-AUTH-006):
 * enough to let every tab recognise its own past events without handing
 * every subscriber a value they could resend as their own. */
function hashClientId(rawClientId: string | null) {
  if (!rawClientId) return null;
  return crypto
    .createHash('sha256')
    .update(rawClientId)
    .digest('hex')
    .slice(0, CLIENT_ID_HASH_LENGTH);
}

/** Audits an `/api/auth/*` mutation (user management, self-service password
 * change) the same way the generic module-mutation path in `dispatch` does
 * — these bypass that path entirely (handled directly in
 * `handleAuthRoute`), so each one calls this itself, right after its own
 * write succeeds. */
function auditAuthAction(
  store: AuthStore,
  request: ApiRequest,
  requestPath: string,
  status: number,
) {
  const rawClientId = headerText(request, 'x-client-id').slice(0, CLIENT_ID_HEADER_MAX) || null;
  store.audit({
    user: request.user?.name,
    method: request.method ?? 'GET',
    path: requestPath,
    status,
    client: rawClientId,
  });
}

/** C3 CSRF: a mutation needs a JSON (or empty) body, and a same-host Origin if one is sent. */
/** A request header as one string ('' when absent; repeated headers joined). */
function headerText(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}

function checkCsrf(request: IncomingMessage) {
  const { method } = request;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const length = Number(request.headers['content-length'] || 0);
  const chunked = request.headers['transfer-encoding'] !== undefined;
  if (length > 0 || chunked) {
    const type = request.headers['content-type'] || '';
    if (!/^application\/json(?:;|$)/i.test(type)) {
      throw new HttpError(403, 'A mutation body must be application/json.');
    }
  }
  const origin = request.headers.origin;
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'Origin header is not a valid URL.');
    }
    if (!request.headers.host || originHost !== request.headers.host) {
      throw new HttpError(403, 'Cross-origin request rejected.');
    }
  }
}

/**
 * Builds the dispatch middleware and its teardown for one auth `mode`
 * (`'on'` or `'off'`), independent of Vite. `ipbApi()` below is the thin
 * adapter that resolves `mode` from the dev/preview server's bound host;
 * tests call this directly against a plain `http.createServer`.
 */
/** A body's fields: a non-object body reads as having none (each route validates its own). */
function fieldsOf(body: Json): JsonObject {
  return isJsonObject(body) ? body : {};
}

export function createApiMiddleware(mode: AuthMode) {
  let authStore: AuthStore | undefined;
  function ensureAuthStore(): AuthStore {
    authStore ??= openAuthStore();
    return authStore;
  }

  const lifecycle = createExerciseLifecycle({ getAuthStore: ensureAuthStore });
  const dispatcher = createDispatcher(modules, {
    publish,
    audit: (entry) => ensureAuthStore().audit(entry),
  });

  function sessionToken(request: IncomingMessage): string | undefined {
    return parseCookies(request.headers.cookie)[SESSION_COOKIE];
  }

  const NO_USERS_MESSAGE =
    'No users yet. Set IPB_ADMIN_NAME (default "admin") and IPB_ADMIN_PASSWORD_FILE (or ' +
    'IPB_ADMIN_PASSWORD) before starting the server to bootstrap the first admin, or create ' +
    'one by hand: node server/tools/users.mjs add <name> --admin';

  /**
   * Deploy's container sets `IPB_ADMIN_PASSWORD_FILE` (preferred — a mounted
   * secret, never in the process environment where it would show up in
   * `docker inspect`/`/proc/<pid>/environ`) or `IPB_ADMIN_PASSWORD`. Runs at
   * most once per middleware instance, and only when the store still has no
   * users, so it never overwrites an admin created since. Never logs the
   * password.
   */
  let bootstrapPromise: Promise<void> | null = null;
  function ensureBootstrapped() {
    bootstrapPromise ??= (async () => {
      const store = ensureAuthStore();
      if (store.hasUsers()) return;
      const passwordFile = process.env.IPB_ADMIN_PASSWORD_FILE;
      const password = passwordFile
        ? readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '')
        : process.env.IPB_ADMIN_PASSWORD;
      if (!password) return;
      const name = process.env.IPB_ADMIN_NAME || 'admin';
      await store.createUser(name, password, { admin: true, mustChangePassword: true });
    })();
    return bootstrapPromise;
  }

  /** `request.user`: fixed in `off` mode, resolved from the session cookie in `on` mode. */
  async function authenticate(request: IncomingMessage): Promise<SessionUser | null> {
    if (mode === 'off') return LOCAL_USER;
    await ensureBootstrapped();
    const store = ensureAuthStore();
    if (!store.hasUsers()) {
      throw new HttpError(503, NO_USERS_MESSAGE);
    }
    return store.resolveSession(sessionToken(request));
  }

  async function handleAuthRoute(
    sub: string,
    { request, response, url }: { request: ApiRequest; response: ServerResponse; url: URL },
  ) {
    if (mode === 'on') await ensureBootstrapped();
    const store = ensureAuthStore();
    if (sub === 'login' && request.method === 'POST') {
      const body = fieldsOf(await readJson(request));
      const { token, user } = await store.login({
        name: body.name,
        password: body.password,
        ip: clientIp(request),
      });
      setSessionCookie(response, request, token);
      sendJson(response, { mode, user });
      return;
    }
    if (sub === 'logout' && request.method === 'POST') {
      const token = sessionToken(request);
      store.logout(token);
      // Same-process cleanup (IPB-AUTH-005): an open /api/live stream for
      // this exact session shouldn't keep receiving events after logout.
      if (token) closeStreamsForToken(hashToken(token));
      clearSessionCookie(response, request);
      sendJson(response, { mode });
      return;
    }
    if (sub === 'me' && request.method === 'GET') {
      sendJson(response, { mode, user: request.user ?? null });
      return;
    }
    if (sub === 'audit' && request.method === 'GET') {
      if (!request.user) throw new HttpError(401, 'Sign in required.');
      // An admin sees the audit trail regardless of their exercise role
      // (their action rights there follow a real membership when they have
      // one, per C1 — this system-wide view doesn't).
      if (!request.user.admin && !roleAtLeast(request.user.role, 'game-master')) {
        throw new HttpError(403, 'The audit trail needs the game-master role.');
      }
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
      const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
      sendJson(response, store.listAudit({ limit, offset }));
      return;
    }

    if (sub === 'password' && request.method === 'POST') {
      if (!request.user) throw new HttpError(401, 'Sign in required.');
      const body = fieldsOf(await readJson(request));
      if (typeof body.current !== 'string') {
        throw new HttpError(400, 'current is required.');
      }
      const token = sessionToken(request);
      await store.changePassword(request.user.name, body.current, body.next, token);
      const refreshed = store.resolveSession(token);
      request.user = refreshed;
      auditAuthAction(store, request, url.pathname, 200);
      sendJson(response, { mode, user: refreshed });
      return;
    }

    // -- admin-only user management (C1 admin flag) --------------------------
    const usersListMatch = /^users$/.exec(sub);
    const userMatch = /^users\/([^/]+)$/.exec(sub);
    const userResetMatch = /^users\/([^/]+)\/reset-password$/.exec(sub);
    const userRevokeMatch = /^users\/([^/]+)\/revoke-sessions$/.exec(sub);

    if (usersListMatch || userMatch || userResetMatch || userRevokeMatch) {
      if (!request.user) throw new HttpError(401, 'Sign in required.');
      if (!request.user.admin) {
        throw new HttpError(403, 'User management needs the admin flag.');
      }
    }

    if (usersListMatch && request.method === 'GET') {
      sendJson(response, { items: store.listUsersDetailed() });
      return;
    }
    if (usersListMatch && request.method === 'POST') {
      const body = fieldsOf(await readJson(request));
      // The admin chose this password and handed it over: the user picks their own at first sign-in.
      await store.createUser(body.name, body.password, {
        admin: Boolean(body.admin),
        mustChangePassword: true,
      });
      auditAuthAction(store, request, url.pathname, 200);
      sendJson(response, { created: true });
      return;
    }
    if (userMatch && request.method === 'PATCH') {
      const name = decodeURIComponent(userMatch[1]);
      const body = fieldsOf(await readJson(request));
      if (body.admin !== undefined) store.setAdmin(name, Boolean(body.admin));
      if (body.disabled !== undefined) {
        if (name === request.user?.name) {
          throw new HttpError(409, "You can't disable your own account.");
        }
        store.setDisabled(name, Boolean(body.disabled));
        if (body.disabled) closeStreamsForUser(name);
      }
      auditAuthAction(store, request, url.pathname, 200);
      sendJson(response, { updated: true });
      return;
    }
    if (userMatch && request.method === 'DELETE') {
      const name = decodeURIComponent(userMatch[1]);
      if (name === request.user?.name)
        throw new HttpError(409, "You can't delete your own account.");
      store.removeUser(name);
      closeStreamsForUser(name);
      auditAuthAction(store, request, url.pathname, 200);
      sendJson(response, { deleted: true });
      return;
    }
    if (userResetMatch && request.method === 'POST') {
      const name = decodeURIComponent(userResetMatch[1]);
      const body = fieldsOf(await readJson(request));
      await store.resetPassword(name, body.password);
      closeStreamsForUser(name);
      auditAuthAction(store, request, url.pathname, 200);
      sendJson(response, { reset: true });
      return;
    }
    if (userRevokeMatch && request.method === 'POST') {
      const name = decodeURIComponent(userRevokeMatch[1]);
      store.revokeSessions(name);
      closeStreamsForUser(name);
      auditAuthAction(store, request, url.pathname, 200);
      sendJson(response, { revoked: true });
      return;
    }

    // -- the current exercise + its membership roster (C6) --------------------
    const exerciseMatch = /^exercise$/.exec(sub);
    const exerciseArchivesMatch = /^exercise\/archives$/.exec(sub);
    const exerciseArchiveMatch = /^exercise\/archive$/.exec(sub);
    const exerciseResetMatch = /^exercise\/reset$/.exec(sub);
    const exerciseRestoreMatch = /^exercise\/restore$/.exec(sub);
    const membersListMatch = /^members$/.exec(sub);
    const memberMatch = /^members\/([^/]+)$/.exec(sub);

    // Any signed-in user may read the exercise's name; every other exercise
    // and membership route is admin-only.
    if (exerciseMatch && request.method === 'GET') {
      if (!request.user) throw new HttpError(401, 'Sign in required.');
      sendJson(response, lifecycle.getExercise());
      return;
    }

    const adminOnlyExerciseRoute =
      Boolean(exerciseArchivesMatch) ||
      Boolean(exerciseArchiveMatch) ||
      Boolean(exerciseResetMatch) ||
      Boolean(exerciseRestoreMatch) ||
      Boolean(membersListMatch) ||
      Boolean(memberMatch) ||
      (exerciseMatch && request.method === 'PATCH');
    if (adminOnlyExerciseRoute) {
      if (!request.user) throw new HttpError(401, 'Sign in required.');
      if (!request.user.admin) throw new HttpError(403, 'This action needs the admin flag.');
    }

    if (exerciseMatch && request.method === 'PATCH') {
      const body = fieldsOf(await readJson(request));
      const exercise = lifecycle.setExerciseName(body.name);
      auditAuthAction(store, request, url.pathname, 200);
      sendJson(response, exercise);
      return;
    }
    if (exerciseArchivesMatch && request.method === 'GET') {
      sendJson(response, { items: await lifecycle.listArchives() });
      return;
    }
    if (exerciseArchiveMatch && request.method === 'POST') {
      // `note` is optional: a bodiless (or malformed-body) request archives
      // with no note, rather than 400ing over an omitted field.
      const body = fieldsOf(await readJson(request).catch((): Json => ({})));
      const result = await lifecycle.archive({
        note: typeof body.note === 'string' ? body.note : null,
      });
      auditAuthAction(store, request, url.pathname, 200);
      sendJson(response, result);
      return;
    }
    if (exerciseResetMatch && request.method === 'POST') {
      const body = fieldsOf(await readJson(request));
      const result = await lifecycle.reset({ name: body.name, confirm: body.confirm });
      auditAuthAction(store, request, url.pathname, 200);
      sendJson(response, result);
      return;
    }
    if (exerciseRestoreMatch && request.method === 'POST') {
      const body = fieldsOf(await readJson(request));
      const result = await lifecycle.restore({ archive: body.archive });
      auditAuthAction(store, request, url.pathname, 200);
      sendJson(response, result);
      return;
    }
    if (membersListMatch && request.method === 'GET') {
      sendJson(response, { items: store.listMembers() });
      return;
    }
    if (memberMatch && request.method === 'PUT') {
      const name = decodeURIComponent(memberMatch[1]);
      const body = fieldsOf(await readJson(request));
      store.setMembership(name, { cell: body.cell, role: body.role });
      auditAuthAction(store, request, url.pathname, 200);
      sendJson(response, { updated: true });
      return;
    }
    if (memberMatch && request.method === 'DELETE') {
      const name = decodeURIComponent(memberMatch[1]);
      store.removeMembership(name);
      auditAuthAction(store, request, url.pathname, 200);
      sendJson(response, { deleted: true });
      return;
    }

    throw new HttpError(404, 'Unknown API route.');
  }

  /**
   * A user holding a temporary password (the bootstrapped admin, or one an
   * admin set) may only sign in, change it or sign out: the browser's forced
   * change screen is a courtesy, this is the rule.
   */
  function requirePasswordChanged(request: ApiRequest, authRoute: string | null = null) {
    if (!request.user?.must_change_password) return;
    if (authRoute !== null && PASSWORD_CHANGE_ROUTES.has(authRoute)) return;
    throw new HttpError(403, 'Change your temporary password before continuing.');
  }

  async function dispatch(request: ApiRequest, response: ServerResponse, next: () => void) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const isLiveStream = url.pathname === '/api/live';
    const authMatch = /^\/api\/auth\/(.*)$/.exec(url.pathname);
    const moduleMatch = authMatch ? null : /^\/api\/([^/]+)\/(.*)$/.exec(url.pathname);

    // C6: while a reset or restore is in flight, every other /api request
    // (including the initiating one's own later requests, and /api/live)
    // 503s rather than racing a module mid-swap. The request that itself
    // triggers a reset/restore passes through here (the lock isn't held
    // yet — `exerciseLifecycle.js` acquires it once inside `reset`/`restore`).
    const lockMessage = lifecycle.isLocked();
    if (lockMessage && (isLiveStream || authMatch || moduleMatch)) {
      sendJson(response, { error: lockMessage }, 503);
      return;
    }

    if (isLiveStream) {
      try {
        const user = await authenticate(request);
        request.user = user;
        // `off` mode always authenticates as LOCAL_USER, so only `on` can get here with none.
        if (!user) throw new HttpError(401, 'Sign in required.');
        requirePasswordChanged(request);
        const token = mode === 'on' ? sessionToken(request) : null;
        handleLive(request, response, {
          user: user.name,
          cell: user.cell,
          role: user.role,
          admin: user.admin,
          tokenHash: token ? hashToken(token) : null,
          // Re-resolving on every keep-alive tick (IPB-AUTH-005) is also
          // what slides the session's expiry while the tab stays open, the
          // same as any other authenticated request would. The full C1
          // shape (not just a boolean) lets `live.js` close the stream on
          // a membership change too (C4), not only on the session itself
          // going away.
          revalidate: token ? () => ensureAuthStore().resolveSession(token) ?? false : () => true,
        });
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        sendJson(response, errorJson(error), status);
      }
      return;
    }

    if (!authMatch && !moduleMatch) {
      // IPB-AUTH-001 (critical): a state/data file, or Vite's raw-fs/editor
      // escape hatches, must never reach the static middleware `next()`
      // calls into — applies in every auth mode, and only here: every real
      // `/api/<module>/...` route (e.g. `/api/terrain/tiles/vector.pmtiles`,
      // which shares an extension with a blocked path) is routed above,
      // never falls through to this branch, and needs no exemption.
      if (isBlockedStaticPath(request.url ?? '/')) {
        sendJson(response, { error: 'Not found.' }, 404);
        return;
      }
      next();
      return;
    }

    try {
      checkCsrf(request);
      request.user = await authenticate(request);

      if (authMatch) {
        requirePasswordChanged(request, authMatch[1]);
        await handleAuthRoute(authMatch[1], { request, response, url });
        return;
      }

      // Unreachable (neither match falls through above), but says so to the checker.
      if (!moduleMatch) throw new HttpError(404, 'Unknown module.');
      const moduleId = moduleMatch[1];
      const route = moduleMatch[2];
      if (!byId.has(moduleId)) throw new HttpError(404, 'Unknown module.');
      const user = request.user;
      // `off` mode always authenticates as LOCAL_USER, so only `on` can get here with none.
      if (!user) throw new HttpError(401, 'Sign in required.');
      requirePasswordChanged(request);
      // C1: a non-admin with no membership in the current exercise can't
      // use any module route (an admin, cell-blind by their flag alone,
      // always can). `/api/auth/*` is unaffected — handled above.
      if (!user.admin && !user.cell) {
        throw new HttpError(403, 'You are not assigned to the current exercise.');
      }
      // Item-scoped requests (docs/adr/0002-item-scoped-requests.md): the
      // dispatcher checks the role, resolves the item, announces and audits.
      // The raw client id is never broadcast (IPB-AUTH-006), only its hash:
      // `src/live.js` hashes its own id the same way to skip its own echo.
      const rawClientId = headerText(request, 'x-client-id').slice(0, CLIENT_ID_HEADER_MAX) || null;
      await dispatcher.handle({
        moduleId,
        route,
        url,
        request,
        response,
        actor: user,
        client: hashClientId(rawClientId),
        rawClient: rawClientId,
      });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(response, errorJson(error), status);
    }
  }

  function close() {
    for (const module of modules) module.close?.();
    authStore?.close();
    authStore = undefined;
    closeAllSubscribers();
  }

  return { dispatch, close };
}

export default function ipbApi(): Plugin {
  const attach =
    <S extends ViteDevServer | PreviewServer>(
      hostOf: (server: S) => string | boolean | undefined,
    ) =>
    (server: S) => {
      const mode = resolveAuthMode(hostOf(server));
      const { dispatch, close } = createApiMiddleware(mode);
      server.middlewares.use(dispatch);
      server.httpServer?.once('close', close);
    };
  return {
    name: 'ipb-api',
    configureServer: attach((server: ViteDevServer) => server.config.server.host),
    configurePreviewServer: attach((server: PreviewServer) => server.config.preview.host),
  };
}
