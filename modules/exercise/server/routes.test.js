import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { createDispatcher } from '../../../server/dispatch.ts';

let stateRoot;
let dataRoot;
let routes;
let dispatcher;

const GM = { name: 'gm', admin: true, cell: 'white', role: 'game-master' };
const WHITE_GM = { name: 'wgm', admin: false, cell: 'white', role: 'game-master' };
const WHITE_OBSERVER = { name: 'wo', admin: false, cell: 'white', role: 'observer' };
const BLUE_ANALYST = { name: 'ba', admin: false, cell: 'blue', role: 'analyst' };
const BLUE_OBSERVER = { name: 'bo', admin: false, cell: 'blue', role: 'observer' };
// The role level alone ("game-master") doesn't imply White — a training
// audience cell can have its own game-master role for its own purposes.
// Every White-only route must reject this actor even though `role:
// 'game-master'` alone would let it through.
const BLUE_GM = { name: 'bgm', admin: false, cell: 'blue', role: 'game-master' };

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
  routes = (await import('./routes.ts')).default;
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

describe('instructor clock control', () => {
  test('a Blue game-master can read but cannot advance the clock to reveal future injects', async () => {
    const frozen = await call(WHITE_GM, 'PATCH', 'clock', {
      paused: true,
      jump_to: '2026-09-27T12:00:00Z',
      rate: 1,
    });
    await expect(
      call(BLUE_GM, 'PATCH', 'clock', {
        jump_to: '2026-09-28T12:00:00Z',
        paused: false,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const seen = await call(BLUE_GM, 'GET', 'clock');
    expect(seen.now).toBe(frozen.now);
    expect(seen.paused).toBe(true);
  });
});

describe('scenario-events: game-master only, even for a plain GET', () => {
  test('an analyst is refused; a White game-master reads the schedule', async () => {
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

  test('a Blue-cell game-master is refused every scenario-events route, even though the role level alone would pass', async () => {
    await expect(call(BLUE_GM, 'GET', 'scenario-events')).rejects.toMatchObject({ status: 403 });
    await expect(
      call(BLUE_GM, 'POST', 'scenario-events', {
        trigger_at: new Date(Date.now() + 3_600_000).toISOString(),
        kind: 'message',
        payload: { text: 'x' },
      }),
    ).rejects.toMatchObject({ status: 403 });
    const event = await call(GM, 'POST', 'scenario-events', {
      trigger_at: new Date(Date.now() + 3_600_000).toISOString(),
      kind: 'message',
      payload: { text: 'x' },
    });
    await expect(
      call(BLUE_GM, 'PATCH', `scenario-events/${event.id}`, { payload: { text: 'y' } }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(call(BLUE_GM, 'POST', `scenario-events/${event.id}/cancel`)).rejects.toMatchObject(
      { status: 403 },
    );
    await expect(call(BLUE_GM, 'POST', `scenario-events/${event.id}/fire`)).rejects.toMatchObject({
      status: 403,
    });
  });

  test('editing a pending event through the route works; a fired event 409s instead', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const event = await call(GM, 'POST', 'scenario-events', {
      trigger_at: past,
      kind: 'message',
      payload: { text: 'v1' },
      delivery_mode: 'draft',
    });
    const edited = await call(GM, 'PATCH', `scenario-events/${event.id}`, {
      delivery_mode: 'scheduled',
    });
    expect(edited.delivery_mode).toBe('scheduled');
    await call(GM, 'POST', `scenario-events/${event.id}/fire`);
    await expect(
      call(GM, 'PATCH', `scenario-events/${event.id}`, { payload: { text: 'v2' } }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('instructor: story + situations, White-only including Blue game-master', () => {
  test('GET /instructor is White-only; a White observer may read, a Blue game-master (any role level) may not', async () => {
    const seen = await call(WHITE_OBSERVER, 'GET', 'instructor');
    expect(seen).toMatchObject({ situations: [] });
    expect(Array.isArray(seen.events)).toBe(true);
    await expect(call(BLUE_GM, 'GET', 'instructor')).rejects.toMatchObject({ status: 403 });
    await expect(call(BLUE_ANALYST, 'GET', 'instructor')).rejects.toMatchObject({ status: 403 });
  });

  test('editing the story and situations needs a White game-master; a White observer or Blue game-master is refused', async () => {
    await expect(
      call(WHITE_OBSERVER, 'PATCH', 'instructor/story', { title: 'x' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(call(BLUE_GM, 'PATCH', 'instructor/story', { title: 'x' })).rejects.toMatchObject({
      status: 403,
    });

    const patched = await call(WHITE_GM, 'PATCH', 'instructor/story', {
      title: 'Operation Falcon',
      objectives: 'Private objective',
    });
    expect(patched).toMatchObject({ title: 'Operation Falcon', objectives: 'Private objective' });

    await expect(
      call(BLUE_GM, 'POST', 'instructor/situations', { title: 'x' }),
    ).rejects.toMatchObject({ status: 403 });
    const situation = await call(WHITE_GM, 'POST', 'instructor/situations', {
      title: 'Ambush at the bridge',
      ground_truth: 'The convoy is a decoy.',
    });
    expect(situation).toMatchObject({ title: 'Ambush at the bridge', status: 'planned' });

    await expect(
      call(BLUE_GM, 'PATCH', `instructor/situations/${situation.id}`, { status: 'active' }),
    ).rejects.toMatchObject({ status: 403 });
    const activated = await call(WHITE_GM, 'PATCH', `instructor/situations/${situation.id}`, {
      status: 'active',
    });
    expect(activated.status).toBe('active');

    await expect(
      call(BLUE_GM, 'DELETE', `instructor/situations/${situation.id}`),
    ).rejects.toMatchObject({ status: 403 });

    const aggregate = await call(WHITE_GM, 'GET', 'instructor');
    expect(aggregate.situations).toEqual([activated]);
    expect(aggregate.story.title).toBe('Operation Falcon');
  });
});

describe('instructor activity privacy', () => {
  test('Blue cannot infer private situation titles or story changes through activity', async () => {
    await call(WHITE_GM, 'PATCH', 'instructor/story', { instructor_notes: 'Private assessment' });
    const situation = await call(WHITE_GM, 'POST', 'instructor/situations', {
      title: 'Secret second-echelon attack',
    });
    await call(WHITE_GM, 'PATCH', `instructor/situations/${situation.id}`, { status: 'active' });
    await call(WHITE_GM, 'DELETE', `instructor/situations/${situation.id}`);
    const privateAction = (entry) =>
      entry.action.startsWith('instructor:') || entry.action.startsWith('situation:');
    const white = await call(WHITE_GM, 'GET', 'activity');
    expect(white.filter(privateAction).map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        'instructor:story',
        'situation:create',
        'situation:update',
        'situation:delete',
      ]),
    );
    const blue = await call(BLUE_GM, 'GET', 'activity');
    expect(blue.filter(privateAction)).toEqual([]);
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
      revision: requirement.revision,
    });
    expect(released.releasable_to).toEqual(['red']);
    const reassigned = await call(GM, 'PATCH', `requirements/${requirement.id}/owner`, {
      owner_cell: 'red',
      revision: released.revision,
    });
    expect(reassigned).toMatchObject({ owner_cell: 'red', releasable_to: [] });
  });
});
