import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// Same pattern as `server/api.test.js`: `IPB_STATE_ROOT`/`IPB_DATA_ROOT` are
// read once, at module load, by `stateDirectory`/`dataDirectory` — set
// before the dynamic import, so this suite never touches the real
// `modules/exercise/state/exercise.db`.
let stateRoot;
let dataRoot;
let routes;
let openStore;
let store;

function fakeResponse() {
  let body;
  return {
    res: {
      statusCode: 200,
      setHeader() {},
      writeHead(status) {
        this.statusCode = status;
      },
      end(text) {
        body = text;
      },
    },
    json: () => JSON.parse(body),
  };
}

async function call(method, route, { user } = {}) {
  const { res, json } = fakeResponse();
  const request = { method, user, headers: {} };
  const url = new URL(`http://localhost/api/exercise/${route}`);
  await routes.default.handle({ route, url, request, response: res });
  return { status: res.statusCode, json: json() };
}

beforeAll(async () => {
  stateRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-exercise-routes-test-'));
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-exercise-routes-data-test-'));
  process.env.IPB_STATE_ROOT = stateRoot;
  process.env.IPB_DATA_ROOT = dataRoot;
  const dataModuleDir = path.join(dataRoot, 'exercise');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dataModuleDir, { recursive: true });
  writeFileSync(
    path.join(dataModuleDir, 'regions.json'),
    JSON.stringify({ type: 'FeatureCollection', features: [] }),
  );
  routes = await import('./routes.js');
  ({ openStore } = await import('./store.js'));
  // The exact same database/regions file routes.js's own `handle()` opens
  // (both derived from the same env vars), so writing through this second
  // handle and reading through `handle()` see the same rows.
  store = openStore(path.join(stateRoot, 'exercise', 'exercise.db'), {
    regionsFile: path.join(dataModuleDir, 'regions.json'),
  });
});

afterAll(() => {
  store.close();
  routes.default.close();
  delete process.env.IPB_STATE_ROOT;
  delete process.env.IPB_DATA_ROOT;
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('activity hides inject scheduling from anyone below game-master', () => {
  test('a scenario:schedule activity row is stripped for a non-game-master, kept for a game-master', async () => {
    const gm = { name: 'gm', admin: true, cell: 'white', role: 'game-master' };
    const observer = { name: 'obs', cell: 'white', role: 'observer' };

    store.createRequirement(gm, { kind: 'PIR', text: 'Ordinary activity, White-owned' });
    store.createScenarioEvent({
      trigger_at: new Date(Date.now() + 3600000).toISOString(),
      kind: 'message',
      payload: { text: 'Top secret inject text nobody but the GM should see' },
    });

    const asGm = await call('GET', 'activity', { user: gm });
    expect(asGm.status).toBe(200);
    const gmActions = asGm.json.map((row) => row.action);
    expect(gmActions).toContain('scenario:schedule');

    const asObserver = await call('GET', 'activity', { user: observer });
    expect(asObserver.status).toBe(200);
    expect(asObserver.json.some((row) => row.action.startsWith('scenario:'))).toBe(false);
    // Ordinary (non-scenario), White-visible activity is unaffected.
    expect(asObserver.json.some((row) => row.action === 'requirement:create')).toBe(
      gmActions.includes('requirement:create'),
    );
  });

  test('a request with no user attached defaults to the safe (filtered) side, not the permissive one', async () => {
    const response = await call('GET', 'activity', { user: undefined });
    expect(response.status).toBe(200);
    expect(response.json.some((row) => row.action.startsWith('scenario:'))).toBe(false);
  });
});
