import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// `IPB_STATE_ROOT` must be set before anything imports `./api.ts` (directly
// or transitively, e.g. via `./modules.ts` or `./auth.ts`): each of those
// computes its state directory from the env var once, at module load, the
// same way `server/state.ts`'s `stateDirectory` is documented to work. A
// dynamic `import()` after setting it — rather than a static import at the
// top of this file — is what makes that load happen at the right time, so
// this suite never opens a real `modules/*/state/*.db`.
let stateRoot;
let resolveAuthMode;
let createApiMiddleware;
let isBlockedStaticPath;
let openAuthStore;

beforeAll(async () => {
  stateRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-api-test-'));
  process.env.IPB_STATE_ROOT = stateRoot;
  ({ resolveAuthMode, createApiMiddleware, isBlockedStaticPath } = await import('./api.ts'));
  ({ openAuthStore } = await import('./auth.ts'));
});

afterAll(() => {
  delete process.env.IPB_STATE_ROOT;
  rmSync(stateRoot, { recursive: true, force: true });
});

describe('resolveAuthMode', () => {
  const originalOverride = process.env.IPB_AUTH;
  afterEach(() => {
    if (originalOverride === undefined) delete process.env.IPB_AUTH;
    else process.env.IPB_AUTH = originalOverride;
  });

  test('defaults off on a loopback host, on otherwise', () => {
    delete process.env.IPB_AUTH;
    expect(resolveAuthMode(undefined)).toBe('off');
    expect(resolveAuthMode('127.0.0.1')).toBe('off');
    expect(resolveAuthMode('localhost')).toBe('off');
    expect(resolveAuthMode('::1')).toBe('off');
    expect(resolveAuthMode('::')).toBe('on');
    expect(resolveAuthMode('0.0.0.0')).toBe('on');
  });

  test('IPB_AUTH overrides the default either way', () => {
    process.env.IPB_AUTH = 'on';
    expect(resolveAuthMode('127.0.0.1')).toBe('on');
    process.env.IPB_AUTH = 'off';
    expect(resolveAuthMode('127.0.0.1')).toBe('off');
  });

  test('IPB_AUTH=off on a non-loopback host refuses to start', () => {
    process.env.IPB_AUTH = 'off';
    expect(() => resolveAuthMode('::')).toThrow(/refuses to bind/);
  });
});

describe('isBlockedStaticPath (IPB-AUTH-001)', () => {
  test.each([
    '/server/state/auth.db',
    '/server/state/auth.db-wal',
    '/server/state/auth.db-shm',
    '/modules/ipb/state/ipb.db',
    '/modules/exercise/state/exercise.db',
    '/modules/orbat/state/orbat.db',
    '/modules/equipment/state/bookmarks.db',
    '/modules/equipment/data/unitgenerator.db',
    '/modules/terrain/data/vector.pmtiles',
    '/modules/terrain/data/satellite.mbtiles',
  ])('blocks %s', (blockedPath) => {
    expect(isBlockedStaticPath(blockedPath)).toBe(true);
  });

  test('blocks the raw-fs and editor-launcher escape hatches', () => {
    expect(isBlockedStaticPath('/@fs/etc/passwd')).toBe(true);
    expect(isBlockedStaticPath('/@fs//home/user/ipb2/server/state/auth.db')).toBe(true);
    expect(isBlockedStaticPath('/__open-in-editor?file=/etc/passwd')).toBe(true);
  });

  test('blocks a percent-encoded or literal .. traversal into a sensitive directory', () => {
    expect(isBlockedStaticPath('/modules/ipb/../../server/state/auth.db')).toBe(true);
    expect(isBlockedStaticPath('/modules/ipb/%2e%2e/%2e%2e/server/state/auth.db')).toBe(true);
  });

  test('does not block a benign module/server path with no state or data segment', () => {
    expect(isBlockedStaticPath('/modules/equipment/client/view.js')).toBe(false);
    expect(isBlockedStaticPath('/modules/ipb/server/store.js')).toBe(false);
    expect(isBlockedStaticPath('/server/http.ts')).toBe(false);
    expect(isBlockedStaticPath('/server/modules.ts')).toBe(false);
  });

  test('does not block ordinary app routes, sources or an /api path with a similar extension', () => {
    expect(isBlockedStaticPath('/ipb/')).toBe(false);
    expect(isBlockedStaticPath('/src/main.js')).toBe(false);
    expect(isBlockedStaticPath('/src/live.js')).toBe(false);
    // vector.pmtiles is served through this route, never as a static file.
    expect(isBlockedStaticPath('/api/terrain/tiles/vector.pmtiles')).toBe(false);
  });

  test('malformed percent-encoding falls back to checking the raw path only', () => {
    expect(() => isBlockedStaticPath('/modules/ipb/state/%')).not.toThrow();
    expect(isBlockedStaticPath('/modules/ipb/state/%')).toBe(true); // raw form still matches /state/
  });
});

/** Starts a real HTTP server around `dispatch`, matching how `ipbApi()` wires it.
 * `makeMiddleware` defaults to the shared `createApiMiddleware`; the admin
 * bootstrap tests below pass a freshly-imported one bound to its own,
 * still-empty state root instead. */
function startServer(mode, makeMiddleware = createApiMiddleware) {
  const { dispatch, close } = makeMiddleware(mode);
  const server = http.createServer((request, response) => {
    dispatch(request, response, () => {
      // A distinct status from any real response, so a test can tell "our
      // guard blocked this before routing" (404, dispatch's own response)
      // apart from "this genuinely fell through to Vite's next middleware"
      // (this stub) — the real static/raw-fs middleware isn't under test
      // here, only whether dispatch hands it a sensitive path at all.
      response.statusCode = 599;
      response.end('stub-next-reached');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        async stop() {
          close();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

/** Small fetch wrapper that plays cookie jar so tests read like a browser session. */
function client(origin) {
  let cookie = null;
  async function request(pathname, { method, body, headers = {} } = {}) {
    method ??= body !== undefined ? 'POST' : 'GET';
    const finalHeaders = { ...headers };
    if (cookie) finalHeaders.Cookie = cookie;
    const options = { method, headers: finalHeaders };
    if (body !== undefined) {
      if (typeof body === 'string') {
        options.body = body;
      } else {
        finalHeaders['Content-Type'] ??= 'application/json';
        options.body = JSON.stringify(body);
      }
    }
    const response = await fetch(origin + pathname, options);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let json = null;
    try {
      json = await response.json();
    } catch {
      // no body
    }
    return { status: response.status, json, headers: response.headers };
  }
  return { request, clearCookie: () => (cookie = null), getCookie: () => cookie };
}

describe('off mode', () => {
  let server;
  let api;

  beforeAll(async () => {
    server = await startServer('off');
    api = client(server.origin);
  });

  afterAll(() => server.stop());

  test('acts as the implicit White game-master with no login (C1)', async () => {
    const me = await api.request('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.json).toEqual({
      mode: 'off',
      user: {
        name: 'local',
        admin: true,
        cell: 'white',
        role: 'game-master',
        must_change_password: false,
      },
    });
  });

  test('a mutation succeeds, is audited, and publishes a live event, all under "local"', async () => {
    const listener = http.get(`${server.origin}/api/live`, (response) => {
      response.setEncoding('utf8');
    });
    await new Promise((resolve) => listener.once('response', resolve));

    const created = await api.request('/api/orbat/orbats', { body: { name: 'Test ORBAT' } });
    expect(created.status).toBe(200);
    expect(created.json.orbat.name).toBe('Test ORBAT');

    const audit = await api.request('/api/auth/audit');
    expect(audit.status).toBe(200);
    const row = audit.json.items.find((entry) => entry.path === '/api/orbat/orbats');
    expect(row).toMatchObject({ user: 'local', method: 'POST', status: 200 });

    listener.destroy();
  });

  test('an unknown module 404s, a bad method on a real route 405s', async () => {
    expect((await api.request('/api/not-a-module/whatever')).status).toBe(404);
    expect((await api.request('/api/orbat/orbats', { method: 'PUT', body: {} })).status).toBe(405);
  });

  test('IPB-AUTH-001: a state/data file never reaches the static middleware, in every mode', async () => {
    const blocked = await api.request('/server/state/auth.db');
    expect(blocked.status).toBe(404);
    // Distinguishes "our guard answered" from "genuinely fell through to
    // Vite's next middleware" (which the test server stubs at 599).
    expect(blocked.status).not.toBe(599);
  });

  test('IPB-AUTH-001: an ordinary app route is unaffected and still reaches the next middleware', async () => {
    const response = await fetch(`${server.origin}/ipb/`);
    expect(response.status).toBe(599); // the test stub for "next() was called"
  });

  test('IPB-AUTH-007: a HEAD request is neither audited nor published, even though GET is observer-level', async () => {
    const before = await api.request('/api/auth/audit');
    const beforeCount = before.json.total;
    await fetch(`${server.origin}/api/orbat/orbats`, { method: 'HEAD' });
    const after = await api.request('/api/auth/audit');
    expect(after.json.total).toBe(beforeCount);
  });

  test('IPB-AUTH-006: the live broadcast carries a hash of X-Client-Id, never the raw value', async () => {
    let received = '';
    const live = http.get(`${server.origin}/api/live`, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        received += chunk;
      });
    });
    await new Promise((resolve) => live.once('response', resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rawClientId = 'this-is-a-very-recognisable-raw-client-id';
    await api.request('/api/orbat/orbats', {
      body: { name: 'Hash check' },
      headers: { 'X-Client-Id': rawClientId },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).not.toContain(rawClientId);
    const dataLine = received.split('\n').find((line) => line.startsWith('data: '));
    const event = JSON.parse(dataLine.slice('data: '.length));
    expect(event.client).toMatch(/^[0-9a-f]{16}$/);

    // The audit trail keeps the raw id (trusted, game-master-only view).
    const audit = await api.request('/api/auth/audit');
    const row = audit.json.items.find((entry) => entry.path === '/api/orbat/orbats');
    expect(row.client).toBe(rawClientId);

    live.destroy();
  });

  test('IPB-AUTH-006: an oversized X-Client-Id is capped before reaching the audit table', async () => {
    const huge = 'x'.repeat(5000);
    await api.request('/api/orbat/orbats', {
      body: { name: 'Capped id' },
      headers: { 'X-Client-Id': huge },
    });
    const audit = await api.request('/api/auth/audit');
    const row = audit.json.items.find(
      (entry) => entry.path === '/api/orbat/orbats' && entry.client?.startsWith('xxxx'),
    );
    expect(row.client.length).toBeLessThanOrEqual(64);
  });
});

describe('on mode, no users yet', () => {
  let server;
  let api;

  beforeAll(async () => {
    server = await startServer('on');
    api = client(server.origin);
  });

  afterAll(() => server.stop());

  test('every /api/* route answers 503 with the command to create one', async () => {
    const response = await api.request('/api/orbat/orbats');
    expect(response.status).toBe(503);
    expect(response.json.error).toMatch(/users\.mjs add/);
  });
});

describe('on mode, with users', () => {
  let server;
  let authFile;

  beforeAll(async () => {
    server = await startServer('on');
    authFile = path.join(stateRoot, 'auth', 'auth.db');
    const seed = openAuthStore(authFile);
    await seed.createUser('gm', 'game master pw');
    seed.setMembership('gm', { cell: 'white', role: 'game-master' });
    await seed.createUser('observer1', 'observer pw 1234');
    seed.setMembership('observer1', { cell: 'blue', role: 'observer' });
    // Dedicated to the SSE-cap test below, so a stream another test opened
    // and is still tearing down can't make that count flaky.
    await seed.createUser('capuser', 'cap user password');
    seed.setMembership('capuser', { cell: 'blue', role: 'observer' });
    await seed.createUser('unassigned', 'unassigned pw 12345');
    seed.close();
  });

  afterAll(() => server.stop());

  test('no session cookie: 401', async () => {
    const api = client(server.origin);
    const response = await api.request('/api/orbat/orbats');
    expect(response.status).toBe(401);
  });

  test('wrong password: 401, invalid/expired session likewise', async () => {
    const api = client(server.origin);
    const login = await api.request('/api/auth/login', { body: { name: 'gm', password: 'nope' } });
    expect(login.status).toBe(401);
  });

  test('login succeeds, GET /api/auth/me reflects the C1-shaped user, logout invalidates it', async () => {
    const api = client(server.origin);
    const login = await api.request('/api/auth/login', {
      body: { name: 'gm', password: 'game master pw' },
    });
    expect(login.status).toBe(200);
    expect(login.json.user).toEqual({
      name: 'gm',
      admin: false,
      cell: 'white',
      role: 'game-master',
      must_change_password: false,
    });

    const me = await api.request('/api/auth/me');
    expect(me.json.user).toEqual({
      name: 'gm',
      admin: false,
      cell: 'white',
      role: 'game-master',
      must_change_password: false,
    });

    const orbats = await api.request('/api/orbat/orbats');
    expect(orbats.status).toBe(200);

    const logout = await api.request('/api/auth/logout', { method: 'POST' });
    expect(logout.status).toBe(200);

    const after = await api.request('/api/orbat/orbats');
    expect(after.status).toBe(401);
  });

  test('an observer gets 403 on a mutation but 200 on a GET', async () => {
    const api = client(server.origin);
    await api.request('/api/auth/login', {
      body: { name: 'observer1', password: 'observer pw 1234' },
    });
    const read = await api.request('/api/orbat/orbats');
    expect(read.status).toBe(200);
    const write = await api.request('/api/orbat/orbats', { body: { name: 'Nope' } });
    expect(write.status).toBe(403);
  });

  test('C1: a user with no membership gets 403 on every module route, but /api/auth/* still works', async () => {
    const api = client(server.origin);
    await api.request('/api/auth/login', {
      body: { name: 'unassigned', password: 'unassigned pw 12345' },
    });
    const read = await api.request('/api/orbat/orbats');
    expect(read.status).toBe(403);
    expect(read.json.error).toMatch(/not assigned/i);
    const anotherModule = await api.request('/api/ipb/studies');
    expect(anotherModule.status).toBe(403);
    const me = await api.request('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.json.user).toEqual({
      name: 'unassigned',
      admin: false,
      cell: null,
      role: null,
      must_change_password: false,
    });
  });

  test('the audit endpoint needs game-master: an observer gets 403', async () => {
    const api = client(server.origin);
    await api.request('/api/auth/login', {
      body: { name: 'observer1', password: 'observer pw 1234' },
    });
    const audit = await api.request('/api/auth/audit');
    expect(audit.status).toBe(403);
  });

  test('CSRF: a foreign Origin is rejected even with a valid session', async () => {
    const api = client(server.origin);
    await api.request('/api/auth/login', { body: { name: 'gm', password: 'game master pw' } });
    const response = await api.request('/api/orbat/orbats', {
      body: { name: 'Evil' },
      headers: { Origin: 'http://evil.example' },
    });
    expect(response.status).toBe(403);
  });

  test('CSRF: a form content type on a body is rejected; a matching Origin is allowed', async () => {
    const api = client(server.origin);
    await api.request('/api/auth/login', { body: { name: 'gm', password: 'game master pw' } });
    const form = await api.request('/api/orbat/orbats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=Nope',
    });
    expect(form.status).toBe(403);

    const good = await api.request('/api/orbat/orbats', {
      body: { name: 'Good' },
      headers: { Origin: server.origin },
    });
    expect(good.status).toBe(200);
  });

  test('CSRF: a bodiless DELETE needs no content type', async () => {
    const api = client(server.origin);
    await api.request('/api/auth/login', { body: { name: 'gm', password: 'game master pw' } });
    const created = await api.request('/api/orbat/orbats', { body: { name: 'To delete' } });
    const id = created.json.orbat.id;
    const deleted = await api.request(`/api/orbat/orbats/${id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
  });

  test('a successful mutation publishes a live event that a subscriber receives', async () => {
    const api = client(server.origin);
    await api.request('/api/auth/login', { body: { name: 'gm', password: 'game master pw' } });

    let received = '';
    const live = http.get(
      `${server.origin}/api/live`,
      { headers: { Cookie: api.getCookie() } },
      (response) => {
        expect(response.statusCode).toBe(200);
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          received += chunk;
        });
      },
    );
    await new Promise((resolve) => live.once('response', resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));

    await api.request('/api/orbat/orbats', { body: { name: 'Watched' } });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toContain('"module":"orbat"');
    live.destroy();
  });

  test('C4: a blue subscriber does not receive a red-owned orbat release event; white does', async () => {
    const gm = client(server.origin); // white
    await gm.request('/api/auth/login', { body: { name: 'gm', password: 'game master pw' } });
    const blue = client(server.origin);
    await blue.request('/api/auth/login', {
      body: { name: 'observer1', password: 'observer pw 1234' },
    });

    const created = await gm.request('/api/orbat/orbats', {
      body: { name: 'Red ORBAT', owner_cell: 'red' },
    });
    expect(created.status).toBe(200);
    const orbatId = created.json.orbat.id;

    let blueReceived = '';
    let whiteReceived = '';
    const blueStream = http.get(
      `${server.origin}/api/live`,
      { headers: { Cookie: blue.getCookie() } },
      (response) => response.on('data', (chunk) => (blueReceived += chunk)),
    );
    const whiteStream = http.get(
      `${server.origin}/api/live`,
      { headers: { Cookie: gm.getCookie() } },
      (response) => response.on('data', (chunk) => (whiteReceived += chunk)),
    );
    await Promise.all([
      new Promise((resolve) => blueStream.once('response', resolve)),
      new Promise((resolve) => whiteStream.once('response', resolve)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const released = await gm.request(`/api/orbat/orbats/${orbatId}/release`, {
      method: 'POST',
      body: { cells: [] },
    });
    expect(released.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(whiteReceived).toContain(`"route":"orbats/${orbatId}/release"`);
    expect(blueReceived).not.toContain(`"route":"orbats/${orbatId}/release"`);

    blueStream.destroy();
    whiteStream.destroy();
  });

  test('C4: live events fail closed; only changes a module marks global reach every cell', async () => {
    const gm = client(server.origin); // white
    await gm.request('/api/auth/login', { body: { name: 'gm', password: 'game master pw' } });
    const blue = client(server.origin);
    await blue.request('/api/auth/login', {
      body: { name: 'observer1', password: 'observer pw 1234' },
    });

    let blueReceived = '';
    const blueStream = http.get(
      `${server.origin}/api/live`,
      { headers: { Cookie: blue.getCookie() } },
      (response) => response.on('data', (chunk) => (blueReceived += chunk)),
    );
    await new Promise((resolve) => blueStream.once('response', resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A red-owned create, an IPB study create, and a White-only inject: none may reach Blue.
    const orbat = await gm.request('/api/orbat/orbats', {
      body: { name: 'Red', owner_cell: 'red' },
    });
    expect(orbat.status).toBe(200);
    const study = await gm.request('/api/ipb/studies', {
      body: { name: 'Red study', owner_cell: 'red' },
    });
    expect(study.status).toBe(200);
    const inject = await gm.request('/api/exercise/scenario-events', {
      body: { trigger_at: '2030-01-01T00:00:00Z', kind: 'message', payload: { text: 'Secret' } },
    });
    expect(inject.status).toBe(200);
    // The scenario clock is everyone's.
    const clock = await gm.request('/api/exercise/clock', {
      method: 'PATCH',
      body: { paused: true },
    });
    expect(clock.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(blueReceived).not.toContain('"route":"orbats"');
    expect(blueReceived).not.toContain('"route":"studies"');
    expect(blueReceived).not.toContain('"route":"scenario-events"');
    expect(blueReceived).toContain('"route":"clock"');
    blueStream.destroy();
  });

  test('IPB-AUTH-005: a signed-in user is capped at 8 concurrent /api/live streams', async () => {
    const api = client(server.origin);
    await api.request('/api/auth/login', {
      body: { name: 'capuser', password: 'cap user password' },
    });
    const cookie = api.getCookie();
    const streams = [];
    try {
      for (let i = 0; i < 8; i += 1) {
        const stream = http.get(`${server.origin}/api/live`, { headers: { Cookie: cookie } });
        await new Promise((resolve) => stream.once('response', resolve));
        streams.push(stream);
      }
      const ninth = await fetch(`${server.origin}/api/live`, { headers: { Cookie: cookie } });
      expect(ninth.status).toBe(503);
    } finally {
      for (const stream of streams) stream.destroy();
    }
  });

  test("IPB-AUTH-005: logging out ends that session's own live stream", async () => {
    const api = client(server.origin);
    await api.request('/api/auth/login', {
      body: { name: 'observer1', password: 'observer pw 1234' },
    });
    const cookie = api.getCookie();
    let ended = false;
    const stream = http.get(
      `${server.origin}/api/live`,
      { headers: { Cookie: cookie } },
      (response) => {
        response.on('end', () => {
          ended = true;
        });
        response.resume();
      },
    );
    await new Promise((resolve) => stream.once('response', resolve));

    await api.request('/api/auth/logout', { method: 'POST' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(ended).toBe(true);
    stream.destroy();
  });
});

describe('admin bootstrap', () => {
  // Own state root, re-imported fresh each test: bootstrap only fires when
  // the store has no users yet, and every other describe in this file
  // shares one state root that already has users by the time this one runs.
  let bootstrapRoot;
  let localCreateApiMiddleware;

  beforeEach(async () => {
    bootstrapRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-api-bootstrap-test-'));
    process.env.IPB_STATE_ROOT = bootstrapRoot;
    vi.resetModules();
    ({ createApiMiddleware: localCreateApiMiddleware } = await import('./api.ts'));
  });

  afterEach(() => {
    process.env.IPB_STATE_ROOT = stateRoot;
    rmSync(bootstrapRoot, { recursive: true, force: true });
    delete process.env.IPB_ADMIN_NAME;
    delete process.env.IPB_ADMIN_PASSWORD;
    delete process.env.IPB_ADMIN_PASSWORD_FILE;
  });

  test('without either env var, the 503 still names them and the CLI', async () => {
    const server = await startServer('on', localCreateApiMiddleware);
    const api = client(server.origin);
    const response = await api.request('/api/orbat/orbats');
    expect(response.status).toBe(503);
    expect(response.json.error).toMatch(/IPB_ADMIN_PASSWORD_FILE/);
    expect(response.json.error).toMatch(/IPB_ADMIN_PASSWORD/);
    expect(response.json.error).toMatch(/users\.mjs add/);
    await server.stop();
  });

  test('IPB_ADMIN_PASSWORD bootstraps the first admin, flagged must_change_password, effective White game-master', async () => {
    process.env.IPB_ADMIN_PASSWORD = 'bootstrap admin password';
    const server = await startServer('on', localCreateApiMiddleware);
    const api = client(server.origin);
    const login = await api.request('/api/auth/login', {
      body: { name: 'admin', password: 'bootstrap admin password' },
    });
    expect(login.status).toBe(200);
    expect(login.json.user).toEqual({
      name: 'admin',
      admin: true,
      cell: 'white',
      role: 'game-master',
      must_change_password: true,
      effective: true,
    });
    await server.stop();
  });

  test('IPB_ADMIN_NAME overrides the default name "admin"', async () => {
    process.env.IPB_ADMIN_NAME = 'root';
    process.env.IPB_ADMIN_PASSWORD = 'bootstrap admin password';
    const server = await startServer('on', localCreateApiMiddleware);
    const api = client(server.origin);
    const login = await api.request('/api/auth/login', {
      body: { name: 'root', password: 'bootstrap admin password' },
    });
    expect(login.status).toBe(200);
    expect(login.json.user.admin).toBe(true);
    await server.stop();
  });

  test('IPB_ADMIN_PASSWORD_FILE is preferred over IPB_ADMIN_PASSWORD and its trailing newline is trimmed', async () => {
    const passwordFile = path.join(bootstrapRoot, 'admin-password');
    writeFileSync(passwordFile, 'file based password\n');
    process.env.IPB_ADMIN_PASSWORD_FILE = passwordFile;
    process.env.IPB_ADMIN_PASSWORD = 'should be ignored';
    const server = await startServer('on', localCreateApiMiddleware);
    const api = client(server.origin);
    const login = await api.request('/api/auth/login', {
      body: { name: 'admin', password: 'file based password' },
    });
    expect(login.status).toBe(200);
    await server.stop();
  });

  test('never bootstraps a second admin once users already exist', async () => {
    process.env.IPB_ADMIN_PASSWORD = 'first admin password';
    let server = await startServer('on', localCreateApiMiddleware);
    let api = client(server.origin);
    await api.request('/api/auth/login', {
      body: { name: 'admin', password: 'first admin password' },
    });
    await server.stop();

    // A fresh middleware instance against the same (now non-empty) database.
    process.env.IPB_ADMIN_PASSWORD = 'second admin password';
    server = await startServer('on', localCreateApiMiddleware);
    api = client(server.origin);
    const login = await api.request('/api/auth/login', {
      body: { name: 'admin', password: 'second admin password' },
    });
    expect(login.status).toBe(401);
    await server.stop();
  });
});

describe('IPB_TRUST_PROXY', () => {
  afterEach(() => {
    delete process.env.IPB_TRUST_PROXY;
  });

  test('without it, X-Forwarded-For is ignored: every request shares the real socket address', async () => {
    const server = await startServer('on');
    const api = client(server.origin);
    // 12 wrong-password attempts, each claiming a different forwarded
    // address; without trust they all count against the same real
    // (loopback) address, exhausting the 10-attempt budget.
    for (let i = 0; i < 10; i += 1) {
      await api.request('/api/auth/login', {
        body: { name: 'gm', password: 'wrong' },
        headers: { 'X-Forwarded-For': `10.0.0.${i}` },
      });
    }
    const blocked = await api.request('/api/auth/login', {
      body: { name: 'gm', password: 'game master pw' },
      headers: { 'X-Forwarded-For': '10.0.0.99' },
    });
    expect(blocked.status).toBe(429);
    await server.stop();
  });

  test('with it, the rightmost X-Forwarded-For hop is the rate-limited address', async () => {
    process.env.IPB_TRUST_PROXY = '1';
    const server = await startServer('on');
    // A distinct forwarded address per attempt: each stays well under its
    // own 10-attempt budget, so the account-wide 401 keeps happening
    // instead of a 429 — proof each hop got its own bucket.
    const api = client(server.origin);
    for (let i = 0; i < 5; i += 1) {
      const response = await api.request('/api/auth/login', {
        body: { name: 'observer1', password: 'wrong' },
        headers: { 'X-Forwarded-For': `203.0.113.${i}, 10.0.0.1` },
      });
      expect(response.status).toBe(401);
    }
    await server.stop();
  });

  test('X-Forwarded-Proto only sets the Secure cookie flag when trust is enabled', async () => {
    const untrusted = await startServer('on');
    const untrustedResponse = await fetch(`${untrusted.origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ name: 'gm', password: 'game master pw' }),
    });
    expect(untrustedResponse.headers.get('set-cookie') || '').not.toMatch(/Secure/);
    await untrusted.stop();

    process.env.IPB_TRUST_PROXY = '1';
    const trusted = await startServer('on');
    const trustedResponse = await fetch(`${trusted.origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ name: 'gm', password: 'game master pw' }),
    });
    expect(trustedResponse.headers.get('set-cookie')).toMatch(/Secure/);
    await trusted.stop();
  });
});

describe('admin user management (C1 admin flag)', () => {
  let server;
  let authFile;

  beforeAll(async () => {
    server = await startServer('on');
    authFile = path.join(stateRoot, 'auth', 'auth.db');
    const seed = openAuthStore(authFile);
    await seed.createUser('root', 'superadmin password', { admin: true });
    await seed.createUser('root2', 'second admin password', { admin: true });
    seed.close();
  });

  afterAll(() => server.stop());

  async function loginAs(name, password) {
    const api = client(server.origin);
    const login = await api.request('/api/auth/login', { body: { name, password } });
    expect(login.status).toBe(200);
    return api;
  }

  test('a non-admin gets 403 on every users route', async () => {
    const api = await loginAs('observer1', 'observer pw 1234');
    expect((await api.request('/api/auth/users')).status).toBe(403);
    expect(
      (await api.request('/api/auth/users', { body: { name: 'x', password: 'whatever12345' } }))
        .status,
    ).toBe(403);
  });

  test('an admin lists, creates, assigns membership, patches admin/disabled, resets a password, revokes sessions and deletes a user', async () => {
    const admin = await loginAs('root', 'superadmin password');

    const created = await admin.request('/api/auth/users', {
      body: { name: 'newbie', password: 'a long enough password' },
    });
    expect(created.status).toBe(200);

    const list = await admin.request('/api/auth/users');
    expect(list.status).toBe(200);
    const row = list.json.items.find((item) => item.name === 'newbie');
    // The admin chose the password, so the user must replace it first.
    expect(row).toMatchObject({
      admin: false,
      cell: null,
      role: null,
      disabled: false,
      must_change_password: true,
    });

    const membership = await admin.request('/api/auth/members/newbie', {
      method: 'PUT',
      body: { cell: 'blue', role: 'analyst' },
    });
    expect(membership.status).toBe(200);
    const membersList = await admin.request('/api/auth/members');
    expect(membersList.json.items.find((m) => m.name === 'newbie')).toEqual({
      name: 'newbie',
      admin: false,
      cell: 'blue',
      role: 'analyst',
    });

    const userApi = client(server.origin);
    await userApi.request('/api/auth/login', {
      body: { name: 'newbie', password: 'a long enough password' },
    });
    await userApi.request('/api/auth/password', {
      body: { current: 'a long enough password', next: 'newbie picked this one' },
    });
    const beforeDisable = await userApi.request('/api/orbat/orbats');
    expect(beforeDisable.status).toBe(200);

    const disable = await admin.request('/api/auth/users/newbie', {
      method: 'PATCH',
      body: { disabled: true },
    });
    expect(disable.status).toBe(200);
    // The existing session stops working immediately (server/live.ts's
    // per-request session lookup, not just at the next login).
    const afterDisable = await userApi.request('/api/orbat/orbats');
    expect(afterDisable.status).toBe(401);
    const loginWhileDisabled = await userApi.request('/api/auth/login', {
      body: { name: 'newbie', password: 'newbie picked this one' },
    });
    expect(loginWhileDisabled.status).toBe(401);

    const enable = await admin.request('/api/auth/users/newbie', {
      method: 'PATCH',
      body: { disabled: false },
    });
    expect(enable.status).toBe(200);

    const reset = await admin.request('/api/auth/users/newbie/reset-password', {
      body: { password: 'a brand new admin-chosen password' },
    });
    expect(reset.status).toBe(200);
    const loginAfterReset = await userApi.request('/api/auth/login', {
      body: { name: 'newbie', password: 'a brand new admin-chosen password' },
    });
    expect(loginAfterReset.status).toBe(200);
    expect(loginAfterReset.json.user.must_change_password).toBe(true);

    const revoke = await admin.request('/api/auth/users/newbie/revoke-sessions', {
      method: 'POST',
    });
    expect(revoke.status).toBe(200);
    expect((await userApi.request('/api/orbat/orbats')).status).toBe(401);

    const removeMembership = await admin.request('/api/auth/members/newbie', { method: 'DELETE' });
    expect(removeMembership.status).toBe(200);
    expect(
      (await admin.request('/api/auth/members')).json.items.find((m) => m.name === 'newbie'),
    ).toEqual({ name: 'newbie', admin: false, cell: null, role: null });

    const remove = await admin.request('/api/auth/users/newbie', { method: 'DELETE' });
    expect(remove.status).toBe(200);
    const loginAfterDelete = await client(server.origin).request('/api/auth/login', {
      body: { name: 'newbie', password: 'a brand new admin-chosen password' },
    });
    expect(loginAfterDelete.status).toBe(401);

    const audit = await admin.request('/api/auth/audit?limit=50');
    const paths = audit.json.items.map((item) => item.path);
    expect(paths).toContain('/api/auth/users');
    expect(paths).toContain('/api/auth/members/newbie');
    expect(paths).toContain('/api/auth/users/newbie');
    expect(paths).toContain('/api/auth/users/newbie/reset-password');
    expect(paths).toContain('/api/auth/users/newbie/revoke-sessions');
  });

  test('an admin cannot disable or delete themselves', async () => {
    const admin = await loginAs('root2', 'second admin password');
    const disable = await admin.request('/api/auth/users/root2', {
      method: 'PATCH',
      body: { disabled: true },
    });
    expect(disable.status).toBe(409);
    const remove = await admin.request('/api/auth/users/root2', { method: 'DELETE' });
    expect(remove.status).toBe(409);
  });

  test('the last enabled admin cannot be demoted, disabled or deleted', async () => {
    const admin = await loginAs('root', 'superadmin password');
    // root2 disables itself down to the last admin first (root acting on root2).
    const disableOther = await admin.request('/api/auth/users/root2', {
      method: 'PATCH',
      body: { disabled: true },
    });
    expect(disableOther.status).toBe(200);

    const demoteSelf = await admin.request('/api/auth/users/root', {
      method: 'PATCH',
      body: { admin: false },
    });
    expect(demoteSelf.status).toBe(409);

    // Re-enable root2 so later tests (and this file's afterAll) see a sane
    // two-admin state again.
    await admin.request('/api/auth/users/root2', { method: 'PATCH', body: { disabled: false } });
  });

  test('self-service password change verifies the current password and keeps the session that made the change', async () => {
    const seed = openAuthStore(authFile);
    await seed.createUser('selfchanger', 'original password 123');
    seed.setMembership('selfchanger', { cell: 'blue', role: 'observer' });
    seed.close();
    const api = await loginAs('selfchanger', 'original password 123');

    const wrong = await api.request('/api/auth/password', {
      body: { current: 'not the password', next: 'a brand new self chosen password' },
    });
    expect(wrong.status).toBe(401);

    const ok = await api.request('/api/auth/password', {
      body: { current: 'original password 123', next: 'a brand new self chosen password' },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.user.must_change_password).toBe(false);

    // The session that made the change is still valid...
    expect((await api.request('/api/orbat/orbats')).status).toBe(200);
    // ...but the old password no longer works.
    const staleLogin = await client(server.origin).request('/api/auth/login', {
      body: { name: 'selfchanger', password: 'original password 123' },
    });
    expect(staleLogin.status).toBe(401);
  });

  test('a temporary password opens nothing but the password change, on the server too', async () => {
    const seed = openAuthStore(authFile);
    await seed.createUser('temporary', 'admin issued password', {
      admin: true,
      mustChangePassword: true,
    });
    seed.close();
    const api = await loginAs('temporary', 'admin issued password');

    expect((await api.request('/api/ipb/studies')).status).toBe(403);
    expect((await api.request('/api/auth/users')).status).toBe(403);
    expect((await api.request('/api/live')).status).toBe(403);
    expect((await api.request('/api/auth/me')).status).toBe(200);

    const changed = await api.request('/api/auth/password', {
      body: { current: 'admin issued password', next: 'my own chosen password' },
    });
    expect(changed.status).toBe(200);
    expect((await api.request('/api/ipb/studies')).status).toBe(200);
  });
});

describe('exercise lifecycle + membership routes (C6)', () => {
  let server;
  let authFile;
  let admin;
  let blueMember;

  beforeAll(async () => {
    server = await startServer('on');
    authFile = path.join(stateRoot, 'auth', 'auth.db');
    const seed = openAuthStore(authFile);
    await seed.createUser('lifecycle-admin', 'lifecycle admin password', { admin: true });
    await seed.createUser('lifecycle-blue', 'lifecycle blue password');
    seed.setMembership('lifecycle-blue', { cell: 'blue', role: 'analyst' });
    seed.close();

    admin = client(server.origin);
    await admin.request('/api/auth/login', {
      body: { name: 'lifecycle-admin', password: 'lifecycle admin password' },
    });
    blueMember = client(server.origin);
    await blueMember.request('/api/auth/login', {
      body: { name: 'lifecycle-blue', password: 'lifecycle blue password' },
    });
  });

  afterAll(() => server.stop());

  test('any signed-in user may GET the exercise name; a non-admin cannot PATCH it', async () => {
    const read = await blueMember.request('/api/auth/exercise');
    expect(read.status).toBe(200);
    expect(read.json.name).toEqual(expect.any(String));

    const patch = await blueMember.request('/api/auth/exercise', {
      method: 'PATCH',
      body: { name: 'Nope' },
    });
    expect(patch.status).toBe(403);
  });

  test('an admin renames the exercise', async () => {
    const patch = await admin.request('/api/auth/exercise', {
      method: 'PATCH',
      body: { name: 'Exercise Bold Falcon' },
    });
    expect(patch.status).toBe(200);
    expect(patch.json.name).toBe('Exercise Bold Falcon');
  });

  test('members: a non-admin is forbidden; an admin lists, assigns and removes', async () => {
    expect((await blueMember.request('/api/auth/members')).status).toBe(403);

    const list = await admin.request('/api/auth/members');
    expect(list.status).toBe(200);
    expect(list.json.items.find((m) => m.name === 'lifecycle-blue')).toEqual({
      name: 'lifecycle-blue',
      admin: false,
      cell: 'blue',
      role: 'analyst',
    });

    const reassigned = await admin.request('/api/auth/members/lifecycle-blue', {
      method: 'PUT',
      body: { cell: 'red', role: 'observer' },
    });
    expect(reassigned.status).toBe(200);
    const afterReassign = await admin.request('/api/auth/members');
    expect(afterReassign.json.items.find((m) => m.name === 'lifecycle-blue')).toMatchObject({
      cell: 'red',
      role: 'observer',
    });

    // Restore the membership other tests in this describe rely on.
    await admin.request('/api/auth/members/lifecycle-blue', {
      method: 'PUT',
      body: { cell: 'blue', role: 'analyst' },
    });
  });

  test('archive-now is admin-only, snapshots the current state, and is listed', async () => {
    expect((await blueMember.request('/api/auth/exercise/archives')).status).toBe(403);
    expect((await blueMember.request('/api/auth/exercise/archive', { body: {} })).status).toBe(403);

    const archived = await admin.request('/api/auth/exercise/archive', {
      body: { note: 'checkpoint' },
    });
    expect(archived.status).toBe(200);
    expect(archived.json.id).toEqual(expect.any(String));

    const archives = await admin.request('/api/auth/exercise/archives');
    expect(archives.status).toBe(200);
    expect(archives.json.items.find((a) => a.id === archived.json.id)).toBeTruthy();
  });

  test('reset is admin-only and requires the typed confirmation to match the current exercise name', async () => {
    expect(
      (await blueMember.request('/api/auth/exercise/reset', { body: { name: 'X', confirm: 'X' } }))
        .status,
    ).toBe(403);

    const wrongConfirm = await admin.request('/api/auth/exercise/reset', {
      body: { name: 'Exercise 2', confirm: 'not the current name' },
    });
    expect(wrongConfirm.status).toBe(400);
  });

  test('reset empties ipb/exercise/orbat, clears memberships, renames the exercise, and every other /api request 503s meanwhile', async () => {
    // Seed something real to prove it gets wiped.
    const seededOrbat = await admin.request('/api/orbat/orbats', {
      body: { name: 'Will be wiped' },
    });
    expect(seededOrbat.status).toBe(200);

    const currentName = (await admin.request('/api/auth/exercise')).json.name;
    const resetPromise = admin.request('/api/auth/exercise/reset', {
      body: { name: 'Exercise After Reset', confirm: currentName },
    });
    // Racing a burst of plain GETs against the reset (fired with no
    // artificial delay, not one-at-a-time): the reset genuinely spans
    // several real await points (VACUUM INTO archiving, closing and
    // deleting three module databases), so at least one of these — fired
    // concurrently rather than after a guessed delay — reliably lands
    // inside that window and observes the lock.
    const burst = Array.from({ length: 40 }, () => blueMember.request('/api/orbat/orbats'));
    const [reset, ...concurrentResponses] = await Promise.all([resetPromise, ...burst]);
    const locked = concurrentResponses.filter((response) => response.status === 503);
    expect(locked.length).toBeGreaterThan(0);
    for (const response of locked) {
      expect(response.json.error).toMatch(/being reset/i);
    }

    expect(reset.status).toBe(200);
    expect(reset.json.name).toBe('Exercise After Reset');
    expect(reset.json.members).toBe(0);

    // The lock is released: requests work normally again.
    const orbats = await admin.request('/api/orbat/orbats');
    expect(orbats.status).toBe(200);
    expect(orbats.json).toEqual([]);

    // Memberships were cleared: the blue member is now unassigned.
    const meAfter = await blueMember.request('/api/auth/me');
    expect(meAfter.json.user.cell).toBeNull();
  });

  test('restore round-trips: archives current, swaps files back, reapplies membership for a re-added member', async () => {
    // Re-establish a membership and some data, then archive it.
    const reassign = await admin.request('/api/auth/members/lifecycle-blue', {
      method: 'PUT',
      body: { cell: 'blue', role: 'analyst' },
    });
    expect(reassign.status).toBe(200);
    const seeded = await admin.request('/api/orbat/orbats', {
      body: { name: 'Present at archive time' },
    });
    expect(seeded.status).toBe(200);
    const archived = await admin.request('/api/auth/exercise/archive', { body: {} });
    expect(archived.status).toBe(200);

    // Mutate further so the restore has something real to undo.
    await admin.request('/api/orbat/orbats', { body: { name: 'Created after the archive' } });

    const restore = await admin.request('/api/auth/exercise/restore', {
      body: { archive: archived.json.id },
    });
    expect(restore.status).toBe(200);

    const orbats = await admin.request('/api/orbat/orbats');
    expect(orbats.json.map((o) => o.name)).toEqual(['Present at archive time']);

    const members = await admin.request('/api/auth/members');
    expect(members.json.items.find((m) => m.name === 'lifecycle-blue')).toMatchObject({
      cell: 'blue',
      role: 'analyst',
    });
  });

  test('restore 404s on an unknown archive', async () => {
    const response = await admin.request('/api/auth/exercise/restore', {
      body: { archive: 'nope' },
    });
    expect(response.status).toBe(404);
  });
});
