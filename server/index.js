#!/usr/bin/env node
/**
 * Standalone production server: the connect-style `/api/*` middleware from
 * `./api.js` in front of the static `dist/` build, as one plain
 * `node:http` server — no Vite at runtime. Built by `npm run build`, run by
 * `npm start` (or the Docker image's `CMD`).
 *
 * Config is env-only (no flags), so the same image works from `compose.yaml`
 * or a bare `node server/index.js`:
 *
 *   IPB_HOST              bind address, default 127.0.0.1
 *   IPB_PORT              bind port, default 8000
 *   IPB_DATA_ROOT         read-only reference data root (see state.js)
 *   IPB_STATE_ROOT        writable state root (see state.js)
 *   IPB_AUTH              'on' | 'off', overrides the loopback default
 *   IPB_TRUST_PROXY       '1' behind a reverse proxy (see ./api.js)
 *   IPB_ADMIN_NAME             first-admin bootstrap (see ./api.js)
 *   IPB_ADMIN_PASSWORD_FILE
 *   IPB_ADMIN_PASSWORD
 *
 * `createRequestListener` and `createHealthzHandler` are exported for
 * `index.test.js`, which points them at a throwaway `dist/`/state/data tree
 * instead of the real one; `main()` (real paths, real `listen`) only runs
 * when this file is executed directly, not when it's imported.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createApiMiddleware, isBlockedStaticPath, resolveAuthMode } from './api.js';
import { dataDirectory, stateDirectory } from './state.js';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(SERVER_DIR, '..');

const MIME_TYPES = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  }),
);

export function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

/**
 * Serves the Vite build out of `distDir`: hashed `/assets/*` files get a
 * one-year immutable cache; everything else (in particular `index.html`) is
 * revalidated on every use, since it names the current asset hashes. A
 * request outside `distDir` — a `..` segment, an encoded slash, a symlink
 * escape — never resolves to a path outside it (checked against the
 * resolved, decoded path, not the raw URL). A path with no file extension
 * that isn't a real file falls back to `index.html`: the shell owns
 * client-side routing for `/`, `/ipb/`, `/exercise/`, `/orbat/`,
 * `/equipment/`, … (`src/main.js`'s `route()`), the same way `vp
 * dev`/`vp preview` behave.
 */
export function createStaticHandler(distDir) {
  const indexHtml = path.join(distDir, 'index.html');
  const assetsDir = path.join(distDir, 'assets') + path.sep;

  return function serveStatic(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    if (!existsSync(indexHtml)) return false;

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400).end('Bad request.');
      return true;
    }
    const normalized = path.posix.normalize(pathname);
    const relative = normalized.replace(/^\/+/, '');
    const resolved = path.resolve(distDir, relative);
    if (resolved !== distDir && !resolved.startsWith(distDir + path.sep)) {
      response.writeHead(403).end('Forbidden.');
      return true;
    }

    let filePath = resolved;
    let stats = statSync(filePath, { throwIfNoEntry: false });
    if (!stats || stats.isDirectory()) {
      if (path.extname(normalized)) return false; // a missing real asset is a 404, not a page
      filePath = indexHtml;
      stats = statSync(filePath, { throwIfNoEntry: false });
      if (!stats) return false;
    }

    const immutable = filePath.startsWith(assetsDir);
    response.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Content-Length': stats.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (request.method === 'HEAD') {
      response.end();
      return true;
    }
    createReadStream(filePath).pipe(response);
    return true;
  };
}

/**
 * `GET /healthz` (no auth): 200 once the process is up, the state root is
 * writable, and every module's reference data is reachable — reports which
 * files are present rather than failing hard, since a fresh deployment may
 * still be missing the optional DMR4G detail or ortho imagery.
 */
export function createHealthzHandler({ projectRoot }) {
  return async function handleHealthz(response) {
    const checks = { state: false, data: {} };
    try {
      const root = stateDirectory('healthz', path.join(projectRoot, 'server', 'state'));
      await mkdir(root, { recursive: true });
      const tmp = await mkdtemp(path.join(root, '.healthz-'));
      await rm(tmp, { recursive: true, force: true });
      checks.state = true;
    } catch (error) {
      checks.state = false;
      checks.stateError = error.message;
    }

    const terrainRoot = dataDirectory('terrain', path.join(projectRoot, 'modules', 'terrain', 'data'));
    const equipmentRoot = dataDirectory('equipment', path.join(projectRoot, 'modules', 'equipment', 'data'));
    const exerciseRoot = dataDirectory('exercise', path.join(projectRoot, 'modules', 'exercise', 'data'));

    const terrainFiles = {
      'terrain.db': path.join(terrainRoot, 'terrain.db'),
      'terrain-dmr4g.db': path.join(terrainRoot, 'terrain-dmr4g.db'),
      'vector.pmtiles': path.join(terrainRoot, 'vector.pmtiles'),
      'satellite.mbtiles': path.join(terrainRoot, 'satellite.mbtiles'),
      'ortho.mbtiles': path.join(terrainRoot, 'ortho.mbtiles'),
    };
    checks.data.terrain = Object.fromEntries(
      Object.entries(terrainFiles).map(([name, file]) => [name, existsSync(file)]),
    );

    if (checks.data.terrain['terrain.db']) {
      try {
        const database = new DatabaseSync(terrainFiles['terrain.db'], { readOnly: true });
        try {
          database.prepare('SELECT key, value FROM meta LIMIT 1').get();
          checks.data.terrainMetaOk = true;
        } finally {
          database.close();
        }
      } catch (error) {
        checks.data.terrainMetaOk = false;
        checks.data.terrainMetaError = error.message;
      }
    } else {
      checks.data.terrainMetaOk = false;
    }

    checks.data.equipment = {
      'unitgenerator.db': existsSync(path.join(equipmentRoot, 'unitgenerator.db')),
      images: existsSync(path.join(equipmentRoot, 'images')),
    };
    checks.data.exercise = {
      'regions.json': existsSync(path.join(exerciseRoot, 'regions.json')),
    };

    const ok = checks.state && checks.data.terrainMetaOk;
    const body = JSON.stringify({ ok, ...checks });
    response.writeHead(ok ? 200 : 503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    response.end(body);
  };
}

/**
 * Wires the API middleware, `/healthz`, and the static/SPA handler into one
 * `(request, response)` listener. `distDir`/`projectRoot` are parameters
 * (not read from module-level constants) so `index.test.js` can point them
 * at a throwaway tree without touching the real `dist/` or `modules/*`.
 */
export function createRequestListener({ distDir, projectRoot, mode }) {
  const { dispatch, close } = createApiMiddleware(mode);
  const serveStatic = createStaticHandler(distDir);
  const handleHealthz = createHealthzHandler({ projectRoot });

  function listener(request, response) {
    if (request.url === '/healthz') {
      handleHealthz(response).catch((error) => {
        if (!response.headersSent) response.writeHead(500);
        response.end(JSON.stringify({ ok: false, error: error.message }));
      });
      return;
    }
    dispatch(request, response, () => {
      if (isBlockedStaticPath(request.url)) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
        return;
      }
      if (!serveStatic(request, response)) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
      }
    });
  }
  return { listener, close };
}

async function main() {
  const host = process.env.IPB_HOST || '127.0.0.1';
  const port = Number(process.env.IPB_PORT) || 8000;
  const mode = resolveAuthMode(host);
  const { listener, close } = createRequestListener({
    distDir: path.join(PROJECT_ROOT, 'dist'),
    projectRoot: PROJECT_ROOT,
    mode,
  });

  const server = http.createServer(listener);
  server.on('error', (error) => {
    console.error('[ipb] server error:', error);
    process.exitCode = 1;
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ipb] ${signal} received, shutting down…`);
    const timeout = setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => clearTimeout(timeout));
    close();
    // Let in-flight connections drain; `server.close` alone waits for them.
    await new Promise((resolve) => server.once('close', resolve));
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  console.log(`[ipb] listening on http://${host}:${port} (auth ${mode}, ${os.hostname()})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('[ipb] failed to start:', error);
    process.exit(1);
  });
}
