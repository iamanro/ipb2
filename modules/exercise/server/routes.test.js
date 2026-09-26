import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { createDispatcher } from '../../../server/dispatch.js';

let stateRoot;
let dataRoot;
let routes;
let dispatcher;

const GM = { name: 'gm', admin: true, cell: 'white', role: 'game-master' };
const WHITE_OBSERVER = { name: 'wo', admin: false, cell: 'white', role: 'observer' };
const BLUE_ANALYST = { name: 'ba', admin: false, cell: 'blue', role: 'analyst' };
const BLUE_OBSERVER = { name: 'bo', admin: false, cell: 'blue', role: 'observer' };

const call = (actor, method, route, body) =>
  dispatcher.runAs(actor, 'exercise', method, route, body);

beforeAll(async () => {
  stateRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-exercise-routes-test-'));
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-exercise-routes-data-test-'));
  process.env.IPB_STATE_ROOT = stateRoot;
  process.env.IPB_DATA_ROOT = dataRoot;
  mkdirSync(path.join(dataRoot, 'exercise'), { recursive: true });
  writeFileSync(
    path.join(dataRoot, 'exercise', 'regions.json'),
    JSON.stringify({ type: 'FeatureCollection', features: [] }),
  );
  routes = (await import('./routes.js')).default;
});

afterAll(() => {
  delete process.env.IPB_STATE_ROOT;
  delete process.env.IPB_DATA_ROOT;
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
});

beforeEach(() => {
  dispatcher = createDispatcher([routes], { publish: () => {} });
});

afterEach(() => {
  routes.close();
});

describe('scenario-events: game-master only, even for a plain GET', () => {
  test('an analyst is refused; a game-master (any cell) reads the schedule', async () => {
    await expect(call(BLUE_ANALYST, 'GET', 'scenario-events')).rejects.toMatchObject({
      status: 403,
    });
    const event = await call(GM, 'POST', 'scenario-events', {
      trigger_at: new Date(Date.now() + 3_600_000).toISOString(),
      kind: 'message',
      payload: { text: 'Not due yet' },
    });
    const list = await call(GM, 'GET', 'scenario-events');
    expect(list.map((e) => e.id)).toContain(event.id);
  });
});

describe('activity: scenario scheduling is White-only, ordinary activity is not', () => {
  test('a scenario:schedule row is White-owned — visible to White (any role), never to Blue', async () => {
    await call(GM, 'POST', 'requirements', { kind: 'PIR', text: 'Ordinary activity, White-owned' });
    await call(GM, 'POST', 'scenario-events', {
      trigger_at: new Date(Date.now() + 3_600_000).toISOString(),
      kind: 'message',
      payload: { text: 'Top secret inject text nobody but White should see' },
    });

    const asGm = await call(GM, 'GET', 'activity');
    expect(asGm.map((row) => row.action)).toEqual(
      expect.arrayContaining(['scenario:schedule', 'requirement:create']),
    );

    // Same cell (White), lower role: sees it too — the activity log is
    // scoped by cell (docs/adr/0002), not by the extra role check
    // `scenario-events` itself still enforces.
    const asWhiteObserver = await call(WHITE_OBSERVER, 'GET', 'activity');
    expect(asWhiteObserver.map((row) => row.action)).toEqual(
      expect.arrayContaining(['scenario:schedule', 'requirement:create']),
    );

    const asBlue = await call(BLUE_OBSERVER, 'GET', 'activity');
    expect(asBlue.some((row) => row.action === 'scenario:schedule')).toBe(false);
  });
});

describe('collectors/taskings: collection-manager role, not just analyst', () => {
  test('an analyst is refused; a collection-manager (their own cell) may create', async () => {
    await expect(
      call(BLUE_ANALYST, 'POST', 'collectors', { name: 'UAS-1', discipline: 'UAS' }),
    ).rejects.toMatchObject({ status: 403 });
    const cm = { ...BLUE_ANALYST, role: 'collection-manager' };
    const collector = await call(cm, 'POST', 'collectors', { name: 'UAS-1', discipline: 'UAS' });
    expect(collector).toMatchObject({ name: 'UAS-1', owner_cell: 'blue' });
    // A plain GET stays at the observer default.
    await expect(call(BLUE_OBSERVER, 'GET', 'collectors')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: collector.id })]),
    );
  });
});

describe('release/reassign are generated for every releasable item kind', () => {
  test('POST .../:item/release and PATCH .../:item/owner work exactly as the dispatcher promises', async () => {
    const requirement = await call(BLUE_ANALYST, 'POST', 'requirements', {
      kind: 'PIR',
      text: 'x',
    });
    const released = await call(BLUE_ANALYST, 'POST', `requirements/${requirement.id}/release`, {
      cells: ['red'],
    });
    expect(released.releasable_to).toEqual(['red']);
    const reassigned = await call(GM, 'PATCH', `requirements/${requirement.id}/owner`, {
      owner_cell: 'red',
    });
    expect(reassigned).toMatchObject({ owner_cell: 'red', releasable_to: [] });
  });
});
