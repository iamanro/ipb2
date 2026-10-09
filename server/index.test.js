import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

// Same ordering constraint as `api.test.js`: `IPB_STATE_ROOT` has to be set
// before anything imports `./api.ts` (directly or via `./index.ts`), so a
// dynamic import after setting it is what makes that happen at the right
// time — this suite never touches a real `modules/*/state/*.db`.
let stateRoot;
let dataRoot;
let distDir;
let createRequestListener;
let server;
let baseUrl;

function writeIndexHtml() {
  writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>t</title>');
  mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  writeFileSync(path.join(distDir, 'assets', 'app-abc123.js'), 'console.log(1);');
}

function writeTerrainDb(withMeta) {
  const terrainDir = path.join(dataRoot, 'terrain');
  mkdirSync(terrainDir, { recursive: true });
  const database = new DatabaseSync(path.join(terrainDir, 'terrain.db'));
  if (withMeta) {
    database.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    database.exec("INSERT INTO meta (key, value) VALUES ('cells_per_degree', '3600')");
  } else {
    database.exec('CREATE TABLE not_meta (id INTEGER)');
  }
  database.close();
}

async function get(pathname, options) {
  const response = await fetch(new URL(pathname, baseUrl), options);
  return response;
}

beforeAll(async () => {
  stateRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-index-test-state-'));
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-index-test-data-'));
  distDir = mkdtempSync(path.join(os.tmpdir(), 'ipb-index-test-dist-'));
  process.env.IPB_STATE_ROOT = stateRoot;
  process.env.IPB_DATA_ROOT = dataRoot;
  writeIndexHtml();
  ({ createRequestListener } = await import('./index.ts'));
});

afterAll(() => {
  delete process.env.IPB_STATE_ROOT;
  delete process.env.IPB_DATA_ROOT;
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(distDir, { recursive: true, force: true });
});

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  }
});

async function startServer() {
  const { listener, close } = createRequestListener({
    distDir,
    projectRoot: path.join(distDir, '..'), // unused by static/API paths in these tests
    mode: 'off',
  });
  server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.once('close', close);
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}/`;
}

describe('static file serving', () => {
  test('serves a real hashed asset with an immutable cache header', async () => {
    await startServer();
    const response = await get('/assets/app-abc123.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  test('falls back to index.html for an extension-less client route', async () => {
    await startServer();
    const response = await get('/ipb/some/deep/route');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toContain('<title>t</title>');
  });

  test('404s a missing file that has a real extension, no SPA fallback', async () => {
    await startServer();
    const response = await get('/assets/does-not-exist.js');
    expect(response.status).toBe(404);
  });

  test('never resolves outside distDir for a traversal attempt', async () => {
    await startServer();
    const outside = path.join(distDir, '..', 'outside-marker.txt');
    writeFileSync(outside, 'should never be served');
    try {
      const response = await get('/../outside-marker.txt');
      // Either blocked outright, or (since it has no extension after
      // normalization removes the leading `..`) served as the SPA
      // fallback — either way, never the raw file contents.
      const body = await response.text();
      expect(body).not.toContain('should never be served');
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe('GET /healthz', () => {
  // `dataDirectory()` reads `IPB_DATA_ROOT` fresh on every call (see
  // `state.js`), so each test gets its own throwaway data root instead of
  // sharing one `terrain.db` across tests with different expectations.
  let originalDataRoot;
  let perTestDataRoot;

  beforeAll(() => {
    originalDataRoot = process.env.IPB_DATA_ROOT;
  });
  afterEach(() => {
    if (perTestDataRoot) rmSync(perTestDataRoot, { recursive: true, force: true });
    process.env.IPB_DATA_ROOT = originalDataRoot;
  });

  function freshDataRoot() {
    perTestDataRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-index-test-data-'));
    process.env.IPB_DATA_ROOT = perTestDataRoot;
    dataRoot = perTestDataRoot;
  }

  test('reports 503 and which files are missing when no reference data exists', async () => {
    freshDataRoot();
    await startServer();
    const response = await get('/healthz');
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.data.terrain['terrain.db']).toBe(false);
    expect(body.data.terrainMetaOk).toBe(false);
  });

  test('reports 200 once the state dir is writable and terrain.db has a meta table', async () => {
    freshDataRoot();
    writeTerrainDb(true);
    await startServer();
    const response = await get('/healthz');
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.terrain['terrain.db']).toBe(true);
    expect(body.data.terrainMetaOk).toBe(true);
  });

  test('reports terrainMetaOk false when terrain.db exists but has no meta table', async () => {
    freshDataRoot();
    writeTerrainDb(false);
    await startServer();
    const response = await get('/healthz');
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.data.terrain['terrain.db']).toBe(true);
    expect(body.data.terrainMetaOk).toBe(false);
  });
});

describe('API passthrough', () => {
  test('an /api/* request reaches the api middleware, not the static handler', async () => {
    await startServer();
    const response = await get('/api/auth/me');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.mode).toBe('off');
  });
});
