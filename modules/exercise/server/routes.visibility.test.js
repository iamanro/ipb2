/**
 * Phase 1 cell visibility (docs/phase1-access.md C3/C4), route level: the
 * HTTP-layer wiring `routes.js` adds on top of the store-level rules
 * already proven exhaustively in `visibility.test.js` — `request.liveCells`
 * lifted off a mutation's result (and stripped from the JSON response), and
 * the same 403/404/visibility behaviour reachable through `handle()`
 * instead of calling the store directly. Mirrors `routes.test.js`'s harness,
 * extended with a body-bearing `call()` for POST/PATCH routes.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { HttpError } from '../../../server/http.js';

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

/** `body` (when given) is read by the real `readJson` off a Readable, same
 * as a genuine HTTP request — so POST/PATCH routes exercise their actual
 * body-parsing path, not a stub. */
async function call(method, route, { user, body } = {}) {
  const { res, json } = fakeResponse();
  const request = body !== undefined ? Readable.from([Buffer.from(JSON.stringify(body))]) : {};
  request.method = method;
  request.user = user;
  request.headers = { 'content-type': 'application/json' };
  const url = new URL(`http://localhost/api/exercise/${route}`);
  try {
    await routes.default.handle({ route, url, request, response: res });
    return { status: res.statusCode, json: json(), request };
  } catch (error) {
    // `routes.js`'s `handle()` throws `HttpError` and lets its caller
    // (`server/api.js`'s `dispatch`) turn it into a response — this
    // harness calls `handle()` directly (no `dispatch`), so it does that
    // conversion itself, the same way, to exercise the real 403/404 paths.
    if (error instanceof HttpError) return { status: error.status, json: { error: error.message }, request };
    throw error;
  }
}

const WHITE = { name: 'white-op', admin: true, cell: 'white', role: 'game-master' };
const BLUE_ANALYST = { name: 'blue-analyst', cell: 'blue', role: 'analyst' };
const BLUE_OBSERVER = { name: 'blue-observer', cell: 'blue', role: 'observer' };
const RED_ANALYST = { name: 'red-analyst', cell: 'red', role: 'analyst' };

beforeAll(async () => {
  stateRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-exercise-routes-visibility-test-'));
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-exercise-routes-visibility-data-test-'));
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
  // Same database/regions file routes.js's own `handle()` opens (both
  // derived from the same env vars), so writing through this second handle
  // and reading through `handle()` see the same rows.
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

describe('GET routes: a Blue caller never receives a Red-owned row', () => {
  test('requirements/reports/tracks/rfis lists exclude a Red-owned row for Blue, include it for Red/White', async () => {
    const requirement = store.createRequirement(RED_ANALYST, { kind: 'PIR', text: 'Route-level Red PIR' });
    const report = store.createReport(RED_ANALYST, { text: 'Route-level Red report', reliability: 'A', credibility: 1 });
    const track = store.createTrack(RED_ANALYST, {
      sidc: '10031000141211000000',
      lon: 1,
      lat: 1,
      observed_at: '2026-01-01T00:00:00.000Z',
    });
    const rfi = store.createRfi(RED_ANALYST, { question: 'Route-level Red RFI' });

    const blueRequirements = await call('GET', 'requirements', { user: BLUE_ANALYST });
    expect(blueRequirements.json.some((r) => r.id === requirement.id)).toBe(false);
    const redRequirements = await call('GET', 'requirements', { user: RED_ANALYST });
    expect(redRequirements.json.some((r) => r.id === requirement.id)).toBe(true);

    const blueReports = await call('GET', 'reports', { user: BLUE_ANALYST });
    expect(blueReports.json.some((r) => r.id === report.id)).toBe(false);
    const whiteReports = await call('GET', 'reports', { user: WHITE });
    expect(whiteReports.json.some((r) => r.id === report.id)).toBe(true);

    const blueTracks = await call('GET', 'tracks', { user: BLUE_ANALYST });
    expect(blueTracks.json.some((t) => t.id === track.id)).toBe(false);

    const blueRfis = await call('GET', 'rfis', { user: BLUE_ANALYST });
    expect(blueRfis.json.some((r) => r.id === rfi.id)).toBe(false);
    const redRfis = await call('GET', 'rfis', { user: RED_ANALYST });
    expect(redRfis.json.some((r) => r.id === rfi.id)).toBe(true);
  });
});

describe('request.liveCells (C4): routes.js lifts it off the store result and strips it from the JSON response', () => {
  test('POST create sets request.liveCells to the new item\'s owner cell', async () => {
    const created = await call('POST', 'requirements', {
      user: RED_ANALYST,
      body: { kind: 'PIR', text: 'liveCells create test' },
    });
    expect(created.status).toBe(200);
    expect(created.request.liveCells).toEqual(['red']);
    expect(created.json).not.toHaveProperty('liveCells');
    expect(created.json.owner_cell).toBe('red');
  });

  test('POST release sets request.liveCells to the owner plus every released cell', async () => {
    const requirement = store.createRequirement(WHITE, { kind: 'PIR', text: 'liveCells release test' });
    const released = await call('POST', `requirements/${requirement.id}/release`, {
      user: WHITE,
      body: { cells: ['blue'] },
    });
    expect(released.status).toBe(200);
    expect(released.request.liveCells).toEqual(['white', 'blue']);
    expect(released.json).not.toHaveProperty('liveCells');
    expect(released.json.releasable_to).toEqual(['blue']);
  });

  test('PATCH owner-reassign sets request.liveCells to the new owner alone', async () => {
    const requirement = store.createRequirement(BLUE_ANALYST, { kind: 'PIR', text: 'liveCells reassign test' });
    const reassigned = await call('PATCH', `requirements/${requirement.id}`, {
      user: WHITE,
      body: { owner_cell: 'red' },
    });
    expect(reassigned.status).toBe(200);
    expect(reassigned.request.liveCells).toEqual(['red']);
    expect(reassigned.json.owner_cell).toBe('red');
  });
});

describe('release/reassign authorization at the route layer', () => {
  test('a non-owner-cell release is a 403, once the item is visible to the caller', async () => {
    const requirement = store.createRequirement(RED_ANALYST, { kind: 'PIR', text: 'route release 403 test' });
    await call('POST', `requirements/${requirement.id}/release`, { user: RED_ANALYST, body: { cells: ['blue'] } });
    const blueTriesRelease = await call('POST', `requirements/${requirement.id}/release`, {
      user: BLUE_ANALYST,
      body: { cells: ['white'] },
    });
    expect(blueTriesRelease.status).toBe(403);
  });

  test('an analyst of the owning cell may release; an observer of the owning cell may not', async () => {
    const analystOwned = store.createRequirement(BLUE_ANALYST, { kind: 'PIR', text: 'route release analyst test' });
    const analystRelease = await call('POST', `requirements/${analystOwned.id}/release`, {
      user: BLUE_ANALYST,
      body: { cells: ['red'] },
    });
    expect(analystRelease.status).toBe(200);

    const observerOwned = store.createRequirement(BLUE_ANALYST, { kind: 'PIR', text: 'route release observer test' });
    const observerRelease = await call('POST', `requirements/${observerOwned.id}/release`, {
      user: BLUE_OBSERVER,
      body: { cells: ['red'] },
    });
    expect(observerRelease.status).toBe(403);
  });

  test('PATCH owner_cell by a non-White member is a 403, by White is a 200 that changes the owner', async () => {
    const requirement = store.createRequirement(BLUE_ANALYST, { kind: 'PIR', text: 'route reassign 403 test' });
    const blueTries = await call('PATCH', `requirements/${requirement.id}`, {
      user: BLUE_ANALYST,
      body: { owner_cell: 'red' },
    });
    expect(blueTries.status).toBe(403);

    const whiteReassigns = await call('PATCH', `requirements/${requirement.id}`, {
      user: WHITE,
      body: { owner_cell: 'red' },
    });
    expect(whiteReassigns.status).toBe(200);
    expect(whiteReassigns.json.owner_cell).toBe('red');

    const blueAfter = await call('GET', 'requirements', { user: BLUE_ANALYST });
    expect(blueAfter.json.some((r) => r.id === requirement.id)).toBe(false);
    const redAfter = await call('GET', 'requirements', { user: RED_ANALYST });
    expect(redAfter.json.some((r) => r.id === requirement.id)).toBe(true);
  });
});
