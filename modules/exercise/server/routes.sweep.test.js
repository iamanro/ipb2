import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, expect, test } from 'vitest';

import { createDispatcher } from '../../../server/dispatch.js';
import { sweepRoutes } from '../../../server/routeSweep.js';

/**
 * The generated guard (docs/adr/0002-item-scoped-requests.md,
 * server/routeSweep.js): every route naming an item, called as a member of
 * another cell, 404s on a hidden item and 403s (except plain reads) on one
 * merely released to it. One Red-owned, one Red-owned-released-to-Blue
 * fixture per item kind, every part kind represented on each.
 */
let stateRoot;
let dataRoot;
let routes;
let dispatcher;

const RED_CM = { name: 'r', admin: false, cell: 'red', role: 'collection-manager' };
const BLUE_CM = { name: 'b', admin: false, cell: 'blue', role: 'collection-manager' };

const call = (actor, method, route, body) =>
  dispatcher.runAs(actor, 'exercise', method, route, body);

async function seedItem(createRoute, createBody, partMakers = {}) {
  const hiddenItem = await call(RED_CM, 'POST', createRoute, createBody);
  const releasedItem = await call(RED_CM, 'POST', createRoute, createBody);
  await call(RED_CM, 'POST', `${createRoute}/${releasedItem.id}/release`, { cells: ['blue'] });
  const parts = { hidden: {}, released: {} };
  for (const [partKind, makePart] of Object.entries(partMakers)) {
    parts.hidden[partKind] = await makePart(hiddenItem.id);
    parts.released[partKind] = await makePart(releasedItem.id);
  }
  return {
    hidden: { item: hiddenItem.id, parts: parts.hidden },
    released: { item: releasedItem.id, parts: parts.released },
  };
}

/** A SIR, an indicator on it, and an evidence link against it — every part
 * kind `requirements/:item/...` declares. */
async function seedRequirementParts(requirementId) {
  const sir = await call(RED_CM, 'POST', `requirements/${requirementId}/sirs`, { text: 'sir' });
  const indicator = await call(RED_CM, 'POST', `requirements/${requirementId}/indicators`, {
    sir_id: sir.id,
    description: 'd',
  });
  const report = await call(RED_CM, 'POST', 'reports', {
    text: 'r',
    reliability: 'A',
    credibility: 1,
  });
  const evidence = await call(RED_CM, 'POST', `requirements/${requirementId}/evidence`, {
    report_id: report.id,
    target_kind: 'sir',
    target_id: sir.id,
    relation: 'confirms',
  });
  return { sir: sir.id, indicator: indicator.id, evidence: evidence.id };
}

beforeAll(async () => {
  stateRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-exercise-sweep-'));
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-exercise-sweep-data-'));
  process.env.IPB_STATE_ROOT = stateRoot;
  process.env.IPB_DATA_ROOT = dataRoot;
  mkdirSync(path.join(dataRoot, 'exercise'), { recursive: true });
  writeFileSync(
    path.join(dataRoot, 'exercise', 'regions.json'),
    JSON.stringify({ type: 'FeatureCollection', features: [] }),
  );
  routes = (await import('./routes.js')).default;
  dispatcher = createDispatcher([routes], { publish: () => {} });
});

afterAll(() => {
  routes.close();
  delete process.env.IPB_STATE_ROOT;
  delete process.env.IPB_DATA_ROOT;
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
});

test('every route naming an item holds the line: 404 hidden, 403 released-but-not-owner', async () => {
  const requirement = await seedItem('requirements', { kind: 'PIR', text: 'x' });
  requirement.hidden.parts = await seedRequirementParts(requirement.hidden.item);
  requirement.released.parts = await seedRequirementParts(requirement.released.item);

  const report = await seedItem('reports', { text: 'r', reliability: 'A', credibility: 1 });
  const rfi = await seedItem('rfis', { question: 'q' });
  const track = await seedItem('tracks', {
    sidc: '10031000141211000000',
    lon: 1,
    lat: 1,
    observed_at: new Date().toISOString(),
  });
  const collector = await seedItem('collectors', { name: 'c', discipline: 'UAS' });

  // Taskings need their own collector + SIR, both Red-owned.
  const taskingCollector = await call(RED_CM, 'POST', 'collectors', {
    name: 'tc',
    discipline: 'UAS',
  });
  const taskingRequirement = await call(RED_CM, 'POST', 'requirements', {
    kind: 'PIR',
    text: 'for tasking',
  });
  const taskingSir = await call(RED_CM, 'POST', `requirements/${taskingRequirement.id}/sirs`, {
    text: 'sir',
  });
  const tasking = await seedItem('taskings', {
    collector_id: taskingCollector.id,
    sir_id: taskingSir.id,
    start_at: new Date().toISOString(),
    end_at: new Date(Date.now() + 3_600_000).toISOString(),
  });

  const intsum = await seedItem('intsums', {
    period_start: new Date().toISOString(),
    period_end: new Date().toISOString(),
  });

  const fixtures = { requirement, report, rfi, track, collector, tasking, intsum };
  const failures = await sweepRoutes({
    dispatcher,
    moduleId: 'exercise',
    actor: BLUE_CM,
    fixtures,
  });
  expect(failures).toEqual([]);
});
