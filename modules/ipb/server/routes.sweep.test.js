/**
 * The generated guard (docs/adr/0002-item-scoped-requests.md,
 * `server/routeSweep.js`): every route naming a study (or one of its parts)
 * must answer 404 for a member who cannot see the study, and 403 (reads
 * excepted) for one who can see it only because it was released to their
 * cell. `IPB_STATE_ROOT` is read once, at module load, by `stateDirectory` —
 * set before the dynamic import, so this suite never touches the real
 * `modules/ipb/state/ipb.db`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, expect, test } from 'vitest';

import { createDispatcher } from '../../../server/dispatch.js';
import { sweepRoutes } from '../../../server/routeSweep.js';

const WHITE = { name: 'white-gm', admin: false, cell: 'white', role: 'game-master' };
const RED = { name: 'red-analyst', admin: false, cell: 'red', role: 'analyst' };
const BLUE = { name: 'blue-analyst', admin: false, cell: 'blue', role: 'analyst' };

let stateRoot;
let ipb;
let dispatcher;

beforeAll(async () => {
  stateRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-routes-sweep-test-'));
  process.env.IPB_STATE_ROOT = stateRoot;
  ({ default: ipb } = await import('./routes.js'));
  dispatcher = createDispatcher([ipb]);
});

afterAll(() => {
  ipb.close();
  delete process.env.IPB_STATE_ROOT;
  rmSync(stateRoot, { recursive: true, force: true });
});

const call = (actor, method, route, body) => dispatcher.runAs(actor, 'ipb', method, route, body);

const POLYGON = {
  type: 'Polygon',
  coordinates: [
    [
      [17.4, 49.6],
      [17.4, 49.7],
      [17.5, 49.7],
      [17.4, 49.6],
    ],
  ],
};

/** A Red study with one row of every study part kind, optionally released. */
async function studyWithEveryPart(releasableTo = []) {
  const study = await call(WHITE, 'POST', 'studies', {
    name: `Red study ${Math.random()}`,
    owner_cell: 'red',
  });
  if (releasableTo.length) {
    await call(RED, 'POST', `studies/${study.id}/release`, { cells: releasableTo });
  }
  const feature = await call(RED, 'POST', `studies/${study.id}/features`, {
    layer: 'aoi',
    kind: 'polygon',
    geometry: POLYGON,
  });
  const coa = await call(RED, 'POST', `studies/${study.id}/coas`, {
    name: 'MLCOA',
    kind: 'most-likely',
  });
  const threat = await call(RED, 'POST', `studies/${study.id}/threats`, { name: 'Recon element' });
  const event = await call(RED, 'POST', `studies/${study.id}/events`, {
    coa_id: coa.id,
    indicator: 'x',
  });
  const analysis = await call(RED, 'POST', `studies/${study.id}/analyses`, {
    kind: 'mobility',
    params: {},
    summary: {},
  });
  const layer = await call(RED, 'POST', `studies/${study.id}/layers`, { name: 'L1' });
  const point = await call(RED, 'POST', `studies/${study.id}/points`, {
    layer_id: layer.id,
    name: 'P1',
    lon: 1,
    lat: 1,
  });
  const phase = await call(RED, 'POST', `studies/${study.id}/phases`, {
    name: 'Prep',
    start_offset: 0,
  });
  const decisionPoint = await call(RED, 'POST', `studies/${study.id}/decision-points`, {
    name: 'DP1',
  });
  const civil = await call(RED, 'POST', `studies/${study.id}/civil-considerations`, {
    ascope: 'areas',
    pmesii: 'military',
    text: 'x',
  });
  return {
    item: study.id,
    parts: {
      features: feature.id,
      threats: threat.id,
      coas: coa.id,
      events: event.id,
      analyses: analysis.id,
      layers: layer.id,
      points: point.id,
      phases: phase.id,
      'decision-points': decisionPoint.id,
      'civil-considerations': civil.id,
    },
  };
}

test('every route naming a study holds the line for a Blue analyst', async () => {
  const hidden = await studyWithEveryPart();
  const released = await studyWithEveryPart(['blue']);

  const failures = await sweepRoutes({
    dispatcher,
    moduleId: 'ipb',
    actor: BLUE,
    fixtures: { study: { hidden, released } },
  });
  expect(failures).toEqual([]);
});

test('ordinary members open and list only their automatic cell study', async () => {
  await call(WHITE, 'POST', 'studies', { name: 'Blue preserved extra', owner_cell: 'blue' });

  const current = await call(BLUE, 'GET', 'studies/current');
  expect(current.study).toMatchObject({ owner_cell: 'blue', cell_study_cell: 'blue' });

  const list = await call(BLUE, 'GET', 'studies');
  expect(list.items).toHaveLength(1);
  expect(list.items[0]).toMatchObject({ id: current.study.id, cell_study_cell: 'blue' });
  await expect(call(BLUE, 'POST', 'studies', { name: 'extra' })).rejects.toMatchObject({
    status: 403,
  });
});

test('White opens the White automatic study by default', async () => {
  const white = await call(WHITE, 'GET', 'studies/current');
  expect(white.study).toMatchObject({ owner_cell: 'white', cell_study_cell: 'white' });
});
