import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { createDispatcher, EXERCISE_CONTROL } from '../../../server/dispatch.js';

/**
 * Route-level domain consequences docs/adr/0002-item-scoped-requests.md
 * asks for beyond the generated sweep (server/routeSweep.js, exercised in
 * routes.sweep.test.js): evidence links as parts of the requirement they
 * support, withdrawn reports, per-viewer fulfillment, an inject reaching
 * exactly its cells, and White-only RFI answers.
 */
let stateRoot;
let dataRoot;
let routes;
let dispatcher;
let events;

const WHITE = { name: 'w', admin: false, cell: 'white', role: 'game-master' };
const BLUE = { name: 'b', admin: false, cell: 'blue', role: 'analyst' };
const RED = { name: 'r', admin: false, cell: 'red', role: 'analyst' };

const call = (actor, method, route, body) =>
  dispatcher.runAs(actor, 'exercise', method, route, body);

beforeAll(async () => {
  stateRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-exercise-domain-'));
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-exercise-domain-data-'));
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
  events = [];
  dispatcher = createDispatcher([routes], { publish: (event) => events.push(event) });
});

afterEach(() => {
  routes.close();
});

describe('evidence links are parts of the requirement they support', () => {
  test('citing a released report succeeds; citing a hidden one 404s', async () => {
    const pir = await call(BLUE, 'POST', 'requirements', { kind: 'PIR', text: 'Blue PIR' });
    const sir = await call(BLUE, 'POST', `requirements/${pir.id}/sirs`, {
      text: 'SIR A',
      revision: pir.revision,
    });

    const releasedReport = await call(RED, 'POST', 'reports', {
      text: 'released report',
      reliability: 'A',
      credibility: 1,
    });
    await call(RED, 'POST', `reports/${releasedReport.id}/release`, {
      cells: ['blue'],
      revision: releasedReport.revision,
    });
    const hiddenReport = await call(RED, 'POST', 'reports', {
      text: 'hidden report',
      reliability: 'A',
      credibility: 1,
    });

    const currentPir = await call(BLUE, 'GET', `requirements/${pir.id}`);
    const link = await call(BLUE, 'POST', `requirements/${pir.id}/evidence`, {
      report_id: releasedReport.id,
      target_kind: 'sir',
      target_id: sir.id,
      relation: 'confirms',
      revision: currentPir.revision,
    });
    expect(link).toMatchObject({
      requirement_id: pir.id,
      report_id: releasedReport.id,
      withdrawn: false,
    });

    const afterLink = await call(BLUE, 'GET', `requirements/${pir.id}`);
    await expect(
      call(BLUE, 'POST', `requirements/${pir.id}/evidence`, {
        report_id: hiddenReport.id,
        target_kind: 'sir',
        target_id: sir.id,
        relation: 'confirms',
        revision: afterLink.revision,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("Red cannot see Blue's PIR or its evidence links", async () => {
    const pir = await call(BLUE, 'POST', 'requirements', { kind: 'PIR', text: 'Blue-only PIR' });
    await expect(call(RED, 'GET', `requirements/${pir.id}`)).rejects.toMatchObject({ status: 404 });
    await expect(
      call(RED, 'POST', `requirements/${pir.id}/evidence`, {
        report_id: 1,
        target_kind: 'requirement',
        target_id: pir.id,
        relation: 'confirms',
      }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('optimistic report concurrency', () => {
  test('same report read twice: first save wins, stale and missing revisions are rejected', async () => {
    const report = await call(BLUE, 'POST', 'reports', {
      text: 'first',
      reliability: 'A',
      credibility: 1,
      occurred_at: '2026-09-28T10:00:00.000Z',
      author: 'Blue 1',
    });
    const a = await call(BLUE, 'GET', `reports/${report.id}`);
    const b = await call(BLUE, 'GET', `reports/${report.id}`);

    const saved = await call(BLUE, 'PATCH', `reports/${report.id}`, {
      revision: a.revision,
      text: 'A edit',
      occurred_at: '2026-09-28T10:05:00.000Z',
      author: 'Blue 2',
    });
    expect(saved).toMatchObject({
      text: 'A edit',
      occurred_at: '2026-09-28T10:05:00.000Z',
      author: 'Blue 2',
    });

    await expect(
      call(BLUE, 'PATCH', `reports/${report.id}`, { revision: b.revision, text: 'B stale' }),
    ).rejects.toMatchObject({ status: 409, code: 'stale_revision' });
    await expect(
      call(BLUE, 'PATCH', `reports/${report.id}`, { text: 'missing' }),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      call(BLUE, 'DELETE', `reports/${report.id}`, { revision: b.revision }),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect((await call(BLUE, 'GET', `reports/${report.id}`)).text).toBe('A edit');
  });
});

describe('withdrawn reports never count toward fulfillment', () => {
  test('deleting the cited report leaves the link, shows withdrawn, and drops fulfillment', async () => {
    const pir = await call(BLUE, 'POST', 'requirements', { kind: 'PIR', text: 'x' });
    const sir = await call(BLUE, 'POST', `requirements/${pir.id}/sirs`, {
      text: 'SIR A',
      revision: pir.revision,
    });
    const report = await call(BLUE, 'POST', 'reports', {
      text: 'evidence',
      reliability: 'A',
      credibility: 1,
    });
    const currentPir = await call(BLUE, 'GET', `requirements/${pir.id}`);
    await call(BLUE, 'POST', `requirements/${pir.id}/evidence`, {
      report_id: report.id,
      target_kind: 'sir',
      target_id: sir.id,
      relation: 'confirms',
      revision: currentPir.revision,
    });

    const before = await call(BLUE, 'GET', `requirements/${pir.id}`);
    expect(before.fulfillment).toMatchObject({ covered: 1, total: 1, state: 'fulfilled' });
    expect(before.sirs[0].links[0]).toMatchObject({ withdrawn: false });

    await call(BLUE, 'DELETE', `reports/${report.id}`, { revision: report.revision });

    const after = await call(BLUE, 'GET', `requirements/${pir.id}`);
    expect(after.sirs[0].links[0]).toMatchObject({ withdrawn: true, report: null });
    expect(after.fulfillment).toMatchObject({ covered: 0, total: 1, state: 'open' });
  });
});

describe('fulfillment is per viewer', () => {
  test('a released-to-Blue report counts for Blue; the same requirement shows unfulfilled to a Red view of the same rows', async () => {
    const pir = await call(WHITE, 'POST', 'requirements', {
      kind: 'PIR',
      text: 'x',
      owner_cell: 'blue',
    });
    await call(WHITE, 'POST', `requirements/${pir.id}/release`, {
      cells: ['red'],
      revision: pir.revision,
    });
    const releasedPir = await call(WHITE, 'GET', `requirements/${pir.id}`);
    const sir = await call(WHITE, 'POST', `requirements/${pir.id}/sirs`, {
      text: 'SIR A',
      revision: releasedPir.revision,
    });
    const report = await call(BLUE, 'POST', 'reports', {
      text: 'blue-only evidence',
      reliability: 'A',
      credibility: 1,
    });
    const currentPir = await call(BLUE, 'GET', `requirements/${pir.id}`);
    await call(BLUE, 'POST', `requirements/${pir.id}/evidence`, {
      report_id: report.id,
      target_kind: 'sir',
      target_id: sir.id,
      relation: 'confirms',
      revision: currentPir.revision,
    });

    const blueView = await call(BLUE, 'GET', `requirements/${pir.id}`);
    expect(blueView.fulfillment).toMatchObject({ covered: 1, state: 'fulfilled' });

    // Red can see the requirement (released) and the link exists, but the
    // cited report was never released to Red: it doesn't count for them.
    const redView = await call(RED, 'GET', `requirements/${pir.id}`);
    expect(redView.fulfillment).toMatchObject({ covered: 0, state: 'open' });
    expect(redView.sirs[0].links[0]).toMatchObject({ withdrawn: false, report: null });
  });
});

describe('an inject fired by the clock reaches only its cells', () => {
  test('POST scenario-events/:id/fire announces to white + release_to only', async () => {
    const event = await call(WHITE, 'POST', 'scenario-events', {
      trigger_at: new Date(Date.now() - 60_000).toISOString(),
      kind: 'report',
      payload: { text: 'Contact south of the bridge', release_to: ['red'] },
    });
    events.length = 0;
    const fired = await call(WHITE, 'POST', `scenario-events/${event.id}/fire`, {});
    expect(fired.state).toBe('fired');
    expect(events.at(-1)).toMatchObject({
      route: `scenario-events/${event.id}/fire`,
      cells: ['white', 'red'],
    });

    const redReports = await call(RED, 'GET', 'reports');
    expect(redReports.some((r) => r.text === 'Contact south of the bridge')).toBe(true);
    const blueReports = await call(BLUE, 'GET', 'reports');
    expect(blueReports.some((r) => r.text === 'Contact south of the bridge')).toBe(false);
  });

  test("the module's own ticker (connect/runAs) fires a due event as EXERCISE_CONTROL, reaching only its cells", async () => {
    // `createDispatcher` already called `routes.connect({ runAs })` when
    // `dispatcher` was built above; this simulates exactly what the
    // module's internal 5-second ticker does with it, without waiting.
    const event = await call(WHITE, 'POST', 'scenario-events', {
      trigger_at: new Date(Date.now() - 60_000).toISOString(),
      kind: 'message',
      payload: { text: 'Due inject', release_to: ['blue'] },
    });
    events.length = 0;
    await dispatcher.runAs(
      EXERCISE_CONTROL,
      'exercise',
      'POST',
      `scenario-events/${event.id}/fire`,
      null,
    );
    expect(events.at(-1)).toMatchObject({ user: 'scenario clock', cells: ['white', 'blue'] });
    const blueMessages = await call(BLUE, 'GET', 'messages');
    expect(blueMessages.some((m) => m.text === 'Due inject')).toBe(true);
    const redMessages = await call(RED, 'GET', 'messages');
    expect(redMessages.some((m) => m.text === 'Due inject')).toBe(false);
  });
});

describe('RFI answered needs White', () => {
  test('the owner cell may submit/assign/collect but not answer; White answering a Blue RFI auto-releases the answer', async () => {
    const rfi = await call(BLUE, 'POST', 'rfis', { question: 'Confirm hostile armor movement?' });
    await call(BLUE, 'POST', `rfis/${rfi.id}/transition`, { state: 'submitted' });
    await call(BLUE, 'POST', `rfis/${rfi.id}/transition`, { state: 'assigned' });
    await call(BLUE, 'POST', `rfis/${rfi.id}/transition`, { state: 'in_collection' });

    const answerReport = await call(WHITE, 'POST', 'reports', {
      text: 'Confirmed: T-72 column',
      reliability: 'A',
      credibility: 1,
    });
    await expect(
      call(BLUE, 'POST', `rfis/${rfi.id}/transition`, {
        state: 'answered',
        answer_report_id: answerReport.id,
      }),
    ).rejects.toMatchObject({
      status: 403,
    });

    const answered = await call(WHITE, 'POST', `rfis/${rfi.id}/transition`, {
      state: 'answered',
      answer_report_id: answerReport.id,
    });
    expect(answered.state).toBe('answered');

    // Blue could not see White's report until the answer released it to them.
    const blueSeesReport = await call(BLUE, 'GET', `reports/${answerReport.id}`);
    expect(blueSeesReport.releasable_to).toContain('blue');
    // Red still doesn't.
    await expect(call(RED, 'GET', `reports/${answerReport.id}`)).rejects.toMatchObject({
      status: 404,
    });
  });
});
