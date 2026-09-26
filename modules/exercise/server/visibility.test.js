/**
 * Phase 1 cell visibility matrix (docs/phase1-access.md C2/C3/C4), store
 * level: Blue must never reach a Red-owned row through any exercise store
 * function, release must make a row visible to exactly its target cell (and
 * hide it again on re-release without that cell), and only White (or an
 * analyst-or-above member of the owning cell) may release/reassign. See
 * `store.test.js` for the pre-existing, cell-blind CRUD behaviour this
 * builds on; see `routes.visibility.test.js` for the route-level
 * counterparts (`request.liveCells`, HTTP-layer wiring).
 */
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openStore } from './store.js';

function tempFile() {
  return path.join(
    os.tmpdir(),
    `exercise-visibility-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function removeDatabaseFiles(file) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
}

function expectStatus(fn, status) {
  expect(fn).toThrow(expect.objectContaining({ status }));
}

const WHITE = { name: 'white-op', admin: true, cell: 'white', role: 'game-master' };
// An admin holding no exercise membership still acts as White (C1/C2: the
// `admin` flag alone satisfies `isWhite`, independent of `cell`).
const ADMIN_NO_MEMBERSHIP = { name: 'admin-bare', admin: true, cell: null, role: null };
const BLUE_ANALYST = { name: 'blue-analyst', cell: 'blue', role: 'analyst' };
const BLUE_OBSERVER = { name: 'blue-observer', cell: 'blue', role: 'observer' };
const RED_ANALYST = { name: 'red-analyst', cell: 'red', role: 'analyst' };
const RED_OBSERVER = { name: 'red-observer', cell: 'red', role: 'observer' };

let file;
let store;

beforeEach(() => {
  file = tempFile();
  store = openStore(file);
});

afterEach(() => {
  store.close();
  removeDatabaseFiles(file);
});

describe('requirements, SIRs and indicators: a Red-owned tree is invisible to Blue', () => {
  function seedRedTree() {
    const requirement = store.createRequirement(RED_ANALYST, { kind: 'PIR', text: 'Red PIR' });
    const sir = store.createSir(RED_ANALYST, requirement.id, { text: 'Red SIR' });
    const indicator = store.createIndicator(RED_ANALYST, sir.id, { description: 'Red indicator' });
    return { requirement, sir, indicator };
  }

  test('list/get: Blue never sees the requirement, its fulfillment, its SIRs or its indicators', () => {
    const { requirement } = seedRedTree();
    expect(store.listRequirements(BLUE_ANALYST).find((r) => r.id === requirement.id)).toBeUndefined();
    expect(store.listRequirements(RED_ANALYST).find((r) => r.id === requirement.id)).toBeDefined();
    expect(store.listRequirements(WHITE).find((r) => r.id === requirement.id)).toBeDefined();
    expect(
      store.listRequirements(ADMIN_NO_MEMBERSHIP).find((r) => r.id === requirement.id),
    ).toBeDefined();
  });

  test('every mutation route into a Red SIR/indicator 404s for Blue, never a bare 403 (an invisible row looks nonexistent)', () => {
    const { requirement, sir, indicator } = seedRedTree();
    expectStatus(() => store.createSir(BLUE_ANALYST, requirement.id, { text: 'x' }), 404);
    expectStatus(() => store.updateSir(BLUE_ANALYST, sir.id, { text: 'x' }), 404);
    expectStatus(() => store.deleteSir(BLUE_ANALYST, sir.id), 404);
    expectStatus(() => store.createIndicator(BLUE_ANALYST, sir.id, { description: 'x' }), 404);
    expectStatus(() => store.updateIndicator(BLUE_ANALYST, indicator.id, { observed: true }), 404);
    expectStatus(() => store.deleteIndicator(BLUE_ANALYST, indicator.id), 404);
    expectStatus(() => store.updateRequirement(BLUE_ANALYST, requirement.id, { text: 'x' }), 404);
    expectStatus(() => store.deleteRequirement(BLUE_ANALYST, requirement.id), 404);
    // The owning cell, White and a member-less admin can all still reach it.
    expect(() => store.updateSir(RED_ANALYST, sir.id, { text: 'y' })).not.toThrow();
    expect(() => store.updateSir(WHITE, sir.id, { text: 'z' })).not.toThrow();
    expect(() => store.updateIndicator(ADMIN_NO_MEMBERSHIP, indicator.id, { observed: true })).not.toThrow();
  });
});

describe('reports and evidence: a Red-owned report is invisible to Blue', () => {
  test('list/get/evidence: Blue cannot read, mutate, or link evidence to a Red report', () => {
    // C2b: creating a link needs canEdit on the target, so the target must
    // be Red-owned (or White) for Red to be able to link evidence to it.
    const target = store.createRequirement(RED_ANALYST, { kind: 'PIR', text: 'Evidence target' });
    const redReport = store.createReport(RED_ANALYST, { text: 'Red sighting', reliability: 'A', credibility: 1 });
    expect(store.listReports(BLUE_ANALYST).find((r) => r.id === redReport.id)).toBeUndefined();
    expect(store.listReports(RED_ANALYST).find((r) => r.id === redReport.id)).toBeDefined();
    expectStatus(() => store.updateReport(BLUE_ANALYST, redReport.id, { text: 'x' }), 404);
    expectStatus(() => store.deleteReport(BLUE_ANALYST, redReport.id), 404);
    expectStatus(
      () =>
        store.createEvidenceLink(BLUE_ANALYST, redReport.id, {
          target_kind: 'requirement',
          target_id: target.id,
          relation: 'confirms',
        }),
      404,
    );
    const link = store.createEvidenceLink(RED_ANALYST, redReport.id, {
      target_kind: 'requirement',
      target_id: target.id,
      relation: 'confirms',
    });
    expectStatus(() => store.deleteEvidenceLink(BLUE_ANALYST, link.id), 404);
    expect(() => store.deleteEvidenceLink(WHITE, link.id)).not.toThrow();
  });
});

describe('tracks and positions: a Red-owned track is invisible to Blue', () => {
  test('list/get/positions: Blue cannot read, mutate, or add a position to a Red track', () => {
    const redTrack = store.createTrack(RED_ANALYST, {
      sidc: '10031000141211000000',
      lon: 10,
      lat: 10,
      observed_at: '2026-01-01T00:00:00.000Z',
    });
    expect(store.listTracks(BLUE_ANALYST).find((t) => t.id === redTrack.id)).toBeUndefined();
    expect(store.listTracks(RED_ANALYST).find((t) => t.id === redTrack.id)).toBeDefined();
    expectStatus(() => store.updateTrack(BLUE_ANALYST, redTrack.id, { notes: 'x' }), 404);
    expectStatus(() => store.deleteTrack(BLUE_ANALYST, redTrack.id), 404);
    expectStatus(
      () =>
        store.addTrackPosition(BLUE_ANALYST, redTrack.id, {
          lon: 11,
          lat: 11,
          observed_at: '2026-01-01T01:00:00.000Z',
        }),
      404,
    );
    expect(() =>
      store.addTrackPosition(RED_ANALYST, redTrack.id, {
        lon: 11,
        lat: 11,
        observed_at: '2026-01-01T01:00:00.000Z',
      }),
    ).not.toThrow();
  });
});

describe('RFIs: a Red-owned RFI is invisible to Blue', () => {
  test('list/get/transition: Blue cannot read, update, transition or delete a Red RFI', () => {
    const redRfi = store.createRfi(RED_ANALYST, { question: 'Red question' });
    expect(store.listRfis(BLUE_ANALYST).find((r) => r.id === redRfi.id)).toBeUndefined();
    expect(store.listRfis(RED_ANALYST).find((r) => r.id === redRfi.id)).toBeDefined();
    expectStatus(() => store.updateRfi(BLUE_ANALYST, redRfi.id, { question: 'x' }), 404);
    expectStatus(() => store.transitionRfi(BLUE_ANALYST, redRfi.id, 'submitted'), 404);
    expectStatus(() => store.deleteRfi(BLUE_ANALYST, redRfi.id), 404);
    expect(() => store.transitionRfi(RED_ANALYST, redRfi.id, 'submitted')).not.toThrow();
  });
});

describe('collectors, taskings and conflicts: Red-owned collection plan rows are invisible to Blue', () => {
  test('list/get: Blue cannot read or mutate a Red collector or tasking, nor task against one', () => {
    const redCollector = store.createCollector(RED_ANALYST, { name: 'RED-UAS', discipline: 'UAS' });
    const redRequirement = store.createRequirement(RED_ANALYST, { kind: 'PIR', text: 'Red collection PIR' });
    const redSir = store.createSir(RED_ANALYST, redRequirement.id, { text: 'Red collection SIR' });
    const redTasking = store.createTasking(RED_ANALYST, {
      collector_id: redCollector.id,
      sir_id: redSir.id,
      start_at: '2026-01-01T00:00:00.000Z',
      end_at: '2026-01-01T01:00:00.000Z',
    });

    expect(store.listCollectors(BLUE_ANALYST).find((c) => c.id === redCollector.id)).toBeUndefined();
    expect(store.listTaskings(BLUE_ANALYST).find((t) => t.id === redTasking.id)).toBeUndefined();
    expectStatus(() => store.updateCollector(BLUE_ANALYST, redCollector.id, { name: 'x' }), 404);
    expectStatus(() => store.deleteCollector(BLUE_ANALYST, redCollector.id), 404);
    expectStatus(() => store.updateTasking(BLUE_ANALYST, redTasking.id, { notes: 'x' }), 404);
    expectStatus(() => store.deleteTasking(BLUE_ANALYST, redTasking.id), 404);
    // Blue cannot even stand up a new tasking against a Red collector/SIR.
    expectStatus(
      () =>
        store.createTasking(BLUE_ANALYST, {
          collector_id: redCollector.id,
          sir_id: redSir.id,
          start_at: '2026-01-01T02:00:00.000Z',
          end_at: '2026-01-01T03:00:00.000Z',
        }),
      404,
    );
  });

  test('collection/conflicts: Blue never sees a conflict between two Red taskings', () => {
    const redCollector = store.createCollector(RED_ANALYST, { name: 'RED-IMINT', discipline: 'IMINT' });
    const redRequirement = store.createRequirement(RED_ANALYST, { kind: 'PIR', text: 'Red PIR' });
    const redSir = store.createSir(RED_ANALYST, redRequirement.id, { text: 'Red SIR' });
    const a = store.createTasking(RED_ANALYST, {
      collector_id: redCollector.id,
      sir_id: redSir.id,
      start_at: '2026-01-01T09:00:00.000Z',
      end_at: '2026-01-01T11:00:00.000Z',
    });
    const b = store.createTasking(RED_ANALYST, {
      collector_id: redCollector.id,
      sir_id: redSir.id,
      start_at: '2026-01-01T10:00:00.000Z',
      end_at: '2026-01-01T12:00:00.000Z',
    });
    expect(store.listCollectionConflicts(BLUE_ANALYST).overlaps).toEqual([]);
    expect(store.listCollectionConflicts(RED_ANALYST).overlaps).toEqual([
      { kind: 'overlap', collector_id: redCollector.id, tasking_ids: [a.id, b.id] },
    ]);
    expect(store.listCollectionConflicts(WHITE).overlaps).toHaveLength(1);
  });
});

describe('INTSUM: list/get and the draft generator only draw on what the caller can see', () => {
  test('list/get: Blue cannot read or mutate a Red INTSUM', () => {
    const redIntsum = store.createIntsum(RED_ANALYST, {
      period_start: '2026-01-01T00:00:00.000Z',
      period_end: '2026-01-01T23:59:59.000Z',
    });
    expect(store.listIntsums(BLUE_ANALYST).find((i) => i.id === redIntsum.id)).toBeUndefined();
    expectStatus(() => store.updateIntsum(BLUE_ANALYST, redIntsum.id, { author: 'x' }), 404);
    expectStatus(() => store.deleteIntsum(BLUE_ANALYST, redIntsum.id), 404);
  });

  test("draft generator: a Red track/report/requirement never feeds Blue's draft", () => {
    store.createTrack(RED_ANALYST, {
      sidc: '10031000141211000000',
      designation: 'RED-GHOST',
      lon: 10,
      lat: 10,
      observed_at: '2026-01-01T00:00:00.000Z',
    });
    store.createReport(RED_ANALYST, {
      text: 'Red-only significant activity',
      occurred_at: '2026-01-01T00:30:00.000Z',
      reliability: 'A',
      credibility: 1,
    });
    store.createRequirement(RED_ANALYST, { kind: 'PIR', text: 'Red-only PIR' });

    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-01-01T23:59:59.000Z';
    const blueDraft = store.draftIntsum(BLUE_ANALYST, from, to);
    expect(blueDraft.sections.situation.some((line) => line.includes('RED-GHOST'))).toBe(false);
    expect(
      blueDraft.sections.significant_activity.some((line) => line.includes('Red-only significant activity')),
    ).toBe(false);
    expect(blueDraft.sections.pir_status.some((p) => p.text === 'Red-only PIR')).toBe(false);

    const redDraft = store.draftIntsum(RED_ANALYST, from, to);
    expect(redDraft.sections.situation.some((line) => line.includes('RED-GHOST'))).toBe(true);
    expect(
      redDraft.sections.significant_activity.some((line) => line.includes('Red-only significant activity')),
    ).toBe(true);
    expect(redDraft.sections.pir_status.some((p) => p.text === 'Red-only PIR')).toBe(true);

    const whiteDraft = store.draftIntsum(WHITE, from, to);
    expect(whiteDraft.sections.situation.some((line) => line.includes('RED-GHOST'))).toBe(true);
  });
});

describe("the activity log: a Red-owned mutation never appears in Blue's AAR", () => {
  test('Blue sees no row for a Red mutation; Red and White do', () => {
    const before = store.listActivity(BLUE_ANALYST).length;
    store.createReport(RED_ANALYST, { text: 'Secret red report', reliability: 'A', credibility: 1 });
    expect(store.listActivity(BLUE_ANALYST)).toHaveLength(before);
    expect(store.listActivity(RED_ANALYST).some((row) => row.action === 'report:create')).toBe(true);
    expect(store.listActivity(WHITE).some((row) => row.action === 'report:create')).toBe(true);
  });
});

describe('NAIs: Red-owned NAIs imported from IPB are invisible to Blue', () => {
  test('list: Blue does not see a Red-imported NAI; Red and White do', () => {
    store.importIpbStudy(RED_ANALYST, {
      study: { id: 1, name: 'Red Study' },
      coas: [{ id: 1, name: 'C', kind: 'most-likely' }],
      nais: [{ id: 1, label: 'Red Alpha', kind: 'nai' }],
      events: [{ id: 1, coa_id: 1, nai_feature_id: 1, indicator: 'i', observed_status: 'expected' }],
    });
    const redNai = store.listNais(RED_ANALYST).find((n) => n.label === 'Red Alpha');
    expect(redNai.owner_cell).toBe('red');
    expect(store.listNais(BLUE_ANALYST).find((n) => n.id === redNai.id)).toBeUndefined();
    expect(store.listNais(WHITE).find((n) => n.id === redNai.id)).toBeDefined();
  });
});

describe('messages: a message inject released only to Red is invisible to Blue', () => {
  test('list: Blue does not see a Red-only fired message; Red and White do', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const event = store.createScenarioEvent({
      trigger_at: past,
      kind: 'message',
      payload: { text: 'Red-only chatter', release_to: ['red'] },
    });
    store.fireScenarioEvent(event.id);
    expect(store.listMessages(RED_ANALYST).some((m) => m.text === 'Red-only chatter')).toBe(true);
    expect(store.listMessages(BLUE_ANALYST).some((m) => m.text === 'Red-only chatter')).toBe(false);
    expect(store.listMessages(WHITE).some((m) => m.text === 'Red-only chatter')).toBe(true);
  });
});

describe('firing an inject reaches exactly its release_to cells', () => {
  test('a report inject released only to Red lands in Red\'s reports, not Blue\'s', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const event = store.createScenarioEvent({
      trigger_at: past,
      kind: 'report',
      payload: { text: 'Red-only inject report', reliability: 'B', credibility: 2, release_to: ['red'] },
    });
    store.fireScenarioEvent(event.id);
    expect(store.listReports(RED_ANALYST).some((r) => r.text === 'Red-only inject report')).toBe(true);
    expect(store.listReports(BLUE_ANALYST).some((r) => r.text === 'Red-only inject report')).toBe(false);
    expect(store.listReports(WHITE).some((r) => r.text === 'Red-only inject report')).toBe(true);
  });

  test('tickScenario fires a Blue-released message that only Blue (and White) sees', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    store.createScenarioEvent({
      trigger_at: past,
      kind: 'message',
      payload: { text: 'Blue-only tick message', release_to: ['blue'] },
    });
    store.tickScenario();
    expect(store.listMessages(BLUE_ANALYST).some((m) => m.text === 'Blue-only tick message')).toBe(true);
    expect(store.listMessages(RED_ANALYST).some((m) => m.text === 'Blue-only tick message')).toBe(false);
  });
});

describe('release makes an item visible to exactly its target cell; a re-release without that cell hides it again', () => {
  test('requirement: released to Blue is visible, re-released to nobody hides it again', () => {
    const requirement = store.createRequirement(WHITE, { kind: 'PIR', text: 'Releasable PIR' });
    expect(store.listRequirements(BLUE_ANALYST).find((r) => r.id === requirement.id)).toBeUndefined();
    expect(store.listRequirements(RED_ANALYST).find((r) => r.id === requirement.id)).toBeUndefined();

    store.releaseRequirement(WHITE, requirement.id, ['blue']);
    expect(store.listRequirements(BLUE_ANALYST).find((r) => r.id === requirement.id)).toBeDefined();
    expect(store.listRequirements(RED_ANALYST).find((r) => r.id === requirement.id)).toBeUndefined();

    store.releaseRequirement(WHITE, requirement.id, []);
    expect(store.listRequirements(BLUE_ANALYST).find((r) => r.id === requirement.id)).toBeUndefined();
  });

  test('report: released to Red is visible, re-released to Blue instead hides it from Red again', () => {
    const report = store.createReport(WHITE, { text: 'Shareable', reliability: 'A', credibility: 1 });
    store.releaseReport(WHITE, report.id, ['red']);
    expect(store.listReports(RED_ANALYST).find((r) => r.id === report.id)).toBeDefined();
    expect(store.listReports(BLUE_ANALYST).find((r) => r.id === report.id)).toBeUndefined();

    store.releaseReport(WHITE, report.id, ['blue']);
    expect(store.listReports(RED_ANALYST).find((r) => r.id === report.id)).toBeUndefined();
    expect(store.listReports(BLUE_ANALYST).find((r) => r.id === report.id)).toBeDefined();
  });
});

describe('release authorization: only White, or an analyst-or-above member of the owning cell', () => {
  test('a non-owner-cell member cannot release, even once the item has been released to them', () => {
    const requirement = store.createRequirement(RED_ANALYST, { kind: 'PIR', text: 'Red-owned, shared' });
    store.releaseRequirement(RED_ANALYST, requirement.id, ['blue']);
    // Blue can now see it (released to them) but is not a member of the
    // owning (Red) cell, so still cannot release it further.
    expect(store.listRequirements(BLUE_ANALYST).find((r) => r.id === requirement.id)).toBeDefined();
    expectStatus(() => store.releaseRequirement(BLUE_ANALYST, requirement.id, ['white']), 403);
  });

  test('an analyst of the owning cell may release; an observer of the owning cell may not', () => {
    const analystOwned = store.createRequirement(BLUE_ANALYST, { kind: 'PIR', text: 'Blue analyst release test' });
    expect(() => store.releaseRequirement(BLUE_ANALYST, analystOwned.id, ['red'])).not.toThrow();

    const observerOwned = store.createRequirement(BLUE_ANALYST, { kind: 'PIR', text: 'Blue observer release test' });
    expectStatus(() => store.releaseRequirement(BLUE_OBSERVER, observerOwned.id, ['red']), 403);
  });

  test('White may always release, regardless of owning cell', () => {
    const redOwned = store.createRequirement(RED_ANALYST, { kind: 'PIR', text: 'White releases Red item' });
    expect(() => store.releaseRequirement(WHITE, redOwned.id, ['blue'])).not.toThrow();
  });
});

describe('owner reassign is White-only (C3)', () => {
  test('a non-White member of the owning cell cannot reassign their own item', () => {
    const blueOwned = store.createRequirement(BLUE_ANALYST, { kind: 'PIR', text: 'Reassign test' });
    expectStatus(() => store.updateRequirement(BLUE_ANALYST, blueOwned.id, { owner_cell: 'red' }), 403);
  });

  test('White may reassign any item\'s owner', () => {
    const blueOwned = store.createRequirement(BLUE_ANALYST, { kind: 'PIR', text: 'Reassign test 2' });
    const reassigned = store.updateRequirement(WHITE, blueOwned.id, { owner_cell: 'red' });
    expect(reassigned.owner_cell).toBe('red');
    expect(store.listRequirements(RED_OBSERVER).find((r) => r.id === blueOwned.id)).toBeDefined();
    expect(store.listRequirements(BLUE_OBSERVER).find((r) => r.id === blueOwned.id)).toBeUndefined();
  });

  test('reassign is White-only across every releasable resource type, not just requirements', () => {
    const report = store.createReport(BLUE_ANALYST, { text: 'x', reliability: 'A', credibility: 1 });
    expectStatus(() => store.updateReport(BLUE_ANALYST, report.id, { owner_cell: 'red' }), 403);
    expect(store.updateReport(WHITE, report.id, { owner_cell: 'red' }).owner_cell).toBe('red');

    const track = store.createTrack(BLUE_ANALYST, {
      sidc: '10031000141211000000',
      lon: 1,
      lat: 1,
      observed_at: '2026-01-01T00:00:00.000Z',
    });
    expectStatus(() => store.updateTrack(BLUE_ANALYST, track.id, { owner_cell: 'red' }), 403);
    expect(store.updateTrack(WHITE, track.id, { owner_cell: 'red' }).owner_cell).toBe('red');

    const intsum = store.createIntsum(BLUE_ANALYST, {
      period_start: '2026-01-01T00:00:00.000Z',
      period_end: '2026-01-01T12:00:00.000Z',
    });
    expectStatus(() => store.updateIntsum(BLUE_ANALYST, intsum.id, { owner_cell: 'red' }), 403);
    expect(store.updateIntsum(WHITE, intsum.id, { owner_cell: 'red' }).owner_cell).toBe('red');

    const rfi = store.createRfi(BLUE_ANALYST, { question: 'x' });
    expectStatus(() => store.updateRfi(BLUE_ANALYST, rfi.id, { owner_cell: 'red' }), 403);
    expect(store.updateRfi(WHITE, rfi.id, { owner_cell: 'red' }).owner_cell).toBe('red');
  });
});

describe('RFI answers: White answering a non-White RFI auto-releases the answer to the requester\'s cell', () => {
  test('a White answer to a Blue RFI is visible to Blue, still invisible to Red', () => {
    const rfi = store.createRfi(BLUE_ANALYST, { question: 'Confirm hostile armor movement?' });
    store.transitionRfi(BLUE_ANALYST, rfi.id, 'submitted');
    store.transitionRfi(BLUE_ANALYST, rfi.id, 'assigned');
    store.transitionRfi(BLUE_ANALYST, rfi.id, 'in_collection');
    const whiteReport = store.createReport(WHITE, { text: 'EXCON-confirmed armor', reliability: 'A', credibility: 1 });
    store.transitionRfi(WHITE, rfi.id, 'answered', { answer_report_id: whiteReport.id });

    expect(store.listReports(BLUE_ANALYST).find((r) => r.id === whiteReport.id)).toBeDefined();
    expect(store.listReports(RED_ANALYST).find((r) => r.id === whiteReport.id)).toBeUndefined();
  });
});

describe('C2b: release grants read only \u2014 update/delete/child-create needs canEdit, canSee is not enough', () => {
  test('requirements (+ SIR child-create): 404 unreleased, 403 released-but-not-owner, 200 for owner/White', () => {
    const requirement = store.createRequirement(RED_ANALYST, { kind: 'PIR', text: 'C2b requirement' });
    expectStatus(() => store.updateRequirement(BLUE_ANALYST, requirement.id, { text: 'x' }), 404);
    expectStatus(() => store.deleteRequirement(BLUE_ANALYST, requirement.id), 404);
    expectStatus(() => store.createSir(BLUE_ANALYST, requirement.id, { text: 'x' }), 404);

    store.releaseRequirement(RED_ANALYST, requirement.id, ['blue']);
    expectStatus(() => store.updateRequirement(BLUE_ANALYST, requirement.id, { text: 'x' }), 403);
    expectStatus(() => store.deleteRequirement(BLUE_ANALYST, requirement.id), 403);
    expectStatus(() => store.createSir(BLUE_ANALYST, requirement.id, { text: 'x' }), 403);

    expect(() => store.updateRequirement(RED_ANALYST, requirement.id, { text: 'still red' })).not.toThrow();
    expect(() => store.updateRequirement(WHITE, requirement.id, { text: 'white too' })).not.toThrow();
  });

  test('SIRs and indicators: the same matrix, gated through the parent requirement', () => {
    const requirement = store.createRequirement(RED_ANALYST, { kind: 'PIR', text: 'C2b sir parent' });
    const sir = store.createSir(RED_ANALYST, requirement.id, { text: 'C2b sir' });
    const indicator = store.createIndicator(RED_ANALYST, sir.id, { description: 'C2b indicator' });
    store.releaseRequirement(RED_ANALYST, requirement.id, ['blue']);

    expectStatus(() => store.updateSir(BLUE_ANALYST, sir.id, { text: 'x' }), 403);
    expectStatus(() => store.deleteSir(BLUE_ANALYST, sir.id), 403);
    expectStatus(() => store.createIndicator(BLUE_ANALYST, sir.id, { description: 'x' }), 403);
    expectStatus(() => store.updateIndicator(BLUE_ANALYST, indicator.id, { observed: true }), 403);
    expectStatus(() => store.deleteIndicator(BLUE_ANALYST, indicator.id), 403);

    expect(() => store.updateSir(RED_ANALYST, sir.id, { text: 'still red' })).not.toThrow();
    expect(() => store.updateIndicator(WHITE, indicator.id, { observed: true })).not.toThrow();
  });

  test('reports: 404 unreleased, 403 released-but-not-owner, 200 for owner/White; evidence links need canEdit on the target, not the report', () => {
    const report = store.createReport(RED_ANALYST, { text: 'C2b report', reliability: 'A', credibility: 1 });
    expectStatus(() => store.updateReport(BLUE_ANALYST, report.id, { text: 'x' }), 404);

    store.releaseReport(RED_ANALYST, report.id, ['blue']);
    expectStatus(() => store.updateReport(BLUE_ANALYST, report.id, { text: 'x' }), 403);
    expectStatus(() => store.deleteReport(BLUE_ANALYST, report.id), 403);
    expect(() => store.updateReport(RED_ANALYST, report.id, { text: 'still red' })).not.toThrow();

    // Blue can cite the released (but not owned) report as evidence for
    // Blue's own PIR: canSee(report) + canEdit(target), exactly the "cite
    // a White inject as evidence" case the lead called out.
    const bluePir = store.createRequirement(BLUE_ANALYST, { kind: 'PIR', text: 'Blue PIR cites a released report' });
    const link = store.createEvidenceLink(BLUE_ANALYST, report.id, {
      target_kind: 'requirement',
      target_id: bluePir.id,
      relation: 'confirms',
    });
    expect(link.target_id).toBe(bluePir.id);
    // But Blue still cannot attach evidence to a PIR it doesn't own, even
    // citing a report it can see.
    const redPir = store.createRequirement(RED_ANALYST, { kind: 'PIR', text: 'Red PIR' });
    expectStatus(
      () =>
        store.createEvidenceLink(BLUE_ANALYST, report.id, {
          target_kind: 'requirement',
          target_id: redPir.id,
          relation: 'confirms',
        }),
      403,
    );
    // Deleting a link needs canEdit on its target: Red (owns the report,
    // not the target) may not delete Blue's link; Blue (owns the target) may.
    expectStatus(() => store.deleteEvidenceLink(RED_ANALYST, link.id), 403);
    expect(() => store.deleteEvidenceLink(BLUE_ANALYST, link.id)).not.toThrow();
  });

  test('tracks and positions: 404 unreleased, 403 released-but-not-owner, 200 for owner/White', () => {
    const track = store.createTrack(RED_ANALYST, {
      sidc: '10031000141211000000',
      lon: 1,
      lat: 1,
      observed_at: '2026-01-01T00:00:00.000Z',
    });
    const position = { lon: 2, lat: 2, observed_at: '2026-01-01T01:00:00.000Z' };
    expectStatus(() => store.updateTrack(BLUE_ANALYST, track.id, { notes: 'x' }), 404);
    expectStatus(() => store.addTrackPosition(BLUE_ANALYST, track.id, position), 404);

    store.releaseTrack(RED_ANALYST, track.id, ['blue']);
    expectStatus(() => store.updateTrack(BLUE_ANALYST, track.id, { notes: 'x' }), 403);
    expectStatus(() => store.deleteTrack(BLUE_ANALYST, track.id), 403);
    expectStatus(() => store.addTrackPosition(BLUE_ANALYST, track.id, position), 403);

    expect(() => store.addTrackPosition(RED_ANALYST, track.id, position)).not.toThrow();
    expect(() => store.updateTrack(WHITE, track.id, { notes: 'white too' })).not.toThrow();
  });

  test('RFIs: a cell only released to cannot transition; the owner cell may submit/assign/close its own RFI, but only White may answer', () => {
    const rfi = store.createRfi(RED_ANALYST, { question: 'C2b rfi' });
    store.releaseRfi(RED_ANALYST, rfi.id, ['blue']);

    expectStatus(() => store.transitionRfi(BLUE_ANALYST, rfi.id, 'submitted'), 403);
    expect(() => store.transitionRfi(RED_ANALYST, rfi.id, 'submitted')).not.toThrow();
    expect(() => store.transitionRfi(RED_ANALYST, rfi.id, 'assigned')).not.toThrow();
    expect(() => store.transitionRfi(RED_ANALYST, rfi.id, 'in_collection')).not.toThrow();

    const report = store.createReport(RED_ANALYST, { text: 'answer', reliability: 'A', credibility: 1 });
    // The owner cell cannot self-answer; only White may.
    expectStatus(
      () => store.transitionRfi(RED_ANALYST, rfi.id, 'answered', { answer_report_id: report.id }),
      403,
    );
    expect(() =>
      store.transitionRfi(WHITE, rfi.id, 'answered', { answer_report_id: report.id }),
    ).not.toThrow();
    // The owner cell may close its own answered RFI.
    expect(() => store.transitionRfi(RED_ANALYST, rfi.id, 'closed')).not.toThrow();
  });

  test('collectors and taskings: neither has a release path of its own, so a non-owner is always 404, never 403', () => {
    const collector = store.createCollector(RED_ANALYST, { name: 'C2b collector', discipline: 'HUMINT' });
    expectStatus(() => store.updateCollector(BLUE_ANALYST, collector.id, { name: 'x' }), 404);
    expect(() => store.updateCollector(RED_ANALYST, collector.id, { name: 'still red' })).not.toThrow();
    expect(() => store.updateCollector(WHITE, collector.id, { name: 'white too' })).not.toThrow();

    const requirement = store.createRequirement(RED_ANALYST, { kind: 'PIR', text: 'C2b tasking PIR' });
    const sir = store.createSir(RED_ANALYST, requirement.id, { text: 'C2b tasking SIR' });
    const tasking = store.createTasking(RED_ANALYST, {
      collector_id: collector.id,
      sir_id: sir.id,
      start_at: '2026-01-01T00:00:00.000Z',
      end_at: '2026-01-01T01:00:00.000Z',
    });
    expectStatus(() => store.updateTasking(BLUE_ANALYST, tasking.id, { notes: 'x' }), 404);
    expectStatus(() => store.deleteTasking(BLUE_ANALYST, tasking.id), 404);
    expect(() => store.updateTasking(RED_ANALYST, tasking.id, { notes: 'still red' })).not.toThrow();
  });

  test('INTSUMs: 404 unreleased, 403 released-but-not-owner, 200 for owner/White', () => {
    const intsum = store.createIntsum(RED_ANALYST, {
      period_start: '2026-01-01T00:00:00.000Z',
      period_end: '2026-01-01T12:00:00.000Z',
    });
    expectStatus(() => store.updateIntsum(BLUE_ANALYST, intsum.id, { author: 'x' }), 404);

    store.releaseIntsum(RED_ANALYST, intsum.id, ['blue']);
    expectStatus(() => store.updateIntsum(BLUE_ANALYST, intsum.id, { author: 'x' }), 403);
    expectStatus(() => store.deleteIntsum(BLUE_ANALYST, intsum.id), 403);

    expect(() => store.updateIntsum(RED_ANALYST, intsum.id, { author: 'still red' })).not.toThrow();
    expect(() => store.updateIntsum(WHITE, intsum.id, { author: 'white too' })).not.toThrow();
  });
});
