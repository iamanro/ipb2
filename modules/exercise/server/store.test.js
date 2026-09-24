import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openStore } from './store.js';

function tempFile() {
  return path.join(
    os.tmpdir(),
    `exercise-store-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function removeDatabaseFiles(file) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
}

function expectStatus(fn, status) {
  expect(fn).toThrow(expect.objectContaining({ status }));
}

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

describe('roster', () => {
  test('adds and lists members, newest last', () => {
    store.createRosterMember({ name: 'Alex', role: 'analyst' });
    store.createRosterMember({ name: 'Sam', role: 'game-master' });
    expect(store.listRoster().map((m) => m.name)).toEqual(['Alex', 'Sam']);
  });

  test('rejects a duplicate name with 409, an unknown role with 400', () => {
    store.createRosterMember({ name: 'Alex', role: 'analyst' });
    expectStatus(() => store.createRosterMember({ name: 'Alex', role: 'analyst' }), 409);
    expectStatus(() => store.createRosterMember({ name: 'Jo', role: 'commander' }), 400);
  });

  test('removing an unknown member is a 404', () => {
    expectStatus(() => store.deleteRosterMember(999), 404);
  });
});

describe('requirements tree', () => {
  test('a PIR aggregates its SIRs and indicators, in creation order', () => {
    const pir = store.createRequirement({
      kind: 'PIR',
      text: 'Will the enemy attack?',
      priority: 5,
    });
    const sir = store.createSir(pir.id, { text: 'Are engineers massing forward?' });
    store.createIndicator(sir.id, { description: 'Bridging equipment observed' });
    const [tree] = store.listRequirements();
    expect(tree.sirs).toHaveLength(1);
    expect(tree.sirs[0].indicators).toHaveLength(1);
    expect(tree.sirs[0].indicators[0].observed).toBe(false);
  });

  test('an SIR requires a real parent requirement', () => {
    expectStatus(() => store.createSir(999, { text: 'x' }), 404);
  });

  test('deleting a requirement cascades through its SIRs and indicators', () => {
    const pir = store.createRequirement({ kind: 'PIR', text: 'x' });
    const sir = store.createSir(pir.id, { text: 'y' });
    const indicator = store.createIndicator(sir.id, { description: 'z' });
    store.deleteRequirement(pir.id);
    expect(store.listRequirements()).toHaveLength(0);
    expectStatus(() => store.updateSir(sir.id, { text: 'still there?' }), 404);
    expectStatus(() => store.updateIndicator(indicator.id, { observed: true }), 404);
  });

  test('a blank requirement text is rejected', () => {
    expectStatus(() => store.createRequirement({ kind: 'PIR', text: '   ' }), 400);
  });
});

describe('fulfillment, computed through real evidence joins', () => {
  function seed() {
    const pir = store.createRequirement({ kind: 'PIR', text: 'Will the enemy attack?' });
    const sirA = store.createSir(pir.id, { text: 'SIR A' });
    const sirB = store.createSir(pir.id, { text: 'SIR B' });
    return { pir, sirA, sirB };
  }

  test('starts open with no evidence', () => {
    const { pir } = seed();
    expect(store.listRequirements()[0].fulfillment).toMatchObject({
      covered: 0,
      total: 2,
      percent: 0,
      state: 'open',
    });
    void pir;
  });

  test('a credible confirming report against one SIR moves it to partial', () => {
    const { sirA } = seed();
    const report = store.createReport({
      text: 'Convoy observed',
      reliability: 'B',
      credibility: 2,
    });
    store.createEvidenceLink(report.id, {
      target_kind: 'sir',
      target_id: sirA.id,
      relation: 'confirms',
    });
    const [tree] = store.listRequirements();
    expect(tree.fulfillment).toMatchObject({ covered: 1, total: 2, percent: 50, state: 'partial' });
    expect(tree.sirs.find((s) => s.id === sirA.id).fulfillment).toMatchObject({
      covered: 1,
      total: 1,
    });
  });

  test('a low-credibility report does not count', () => {
    const { sirA } = seed();
    const report = store.createReport({ text: 'Rumour', reliability: 'F', credibility: 5 });
    store.createEvidenceLink(report.id, {
      target_kind: 'sir',
      target_id: sirA.id,
      relation: 'confirms',
    });
    expect(store.listRequirements()[0].fulfillment).toMatchObject({ covered: 0, state: 'open' });
  });

  test('a link against the requirement itself covers every SIR under it', () => {
    seed();
    const [{ id: requirementId }] = store.listRequirements();
    const report = store.createReport({ text: 'HUMINT summary', reliability: 'A', credibility: 1 });
    store.createEvidenceLink(report.id, {
      target_kind: 'requirement',
      target_id: requirementId,
      relation: 'confirms',
    });
    expect(store.listRequirements()[0].fulfillment).toMatchObject({
      covered: 2,
      total: 2,
      percent: 100,
      state: 'fulfilled',
    });
  });

  test('removing the qualifying evidence link reverts fulfillment', () => {
    const { sirA } = seed();
    const report = store.createReport({ text: 'x', reliability: 'B', credibility: 1 });
    const link = store.createEvidenceLink(report.id, {
      target_kind: 'sir',
      target_id: sirA.id,
      relation: 'confirms',
    });
    expect(store.listRequirements()[0].fulfillment.covered).toBe(1);
    store.deleteEvidenceLink(link.id);
    expect(store.listRequirements()[0].fulfillment.covered).toBe(0);
  });

  test('an evidence link against an unknown target is a 400', () => {
    const report = store.createReport({ text: 'x', reliability: 'B', credibility: 1 });
    expectStatus(
      () =>
        store.createEvidenceLink(report.id, {
          target_kind: 'sir',
          target_id: 999,
          relation: 'confirms',
        }),
      400,
    );
  });
});

describe('RFI state machine, wired to the store', () => {
  test('a fresh RFI starts in draft and can only move forward one step at a time', () => {
    const rfi = store.createRfi({ question: 'Confirm bridge status?' });
    expect(rfi.state).toBe('draft');
    expectStatus(() => store.transitionRfi(rfi.id, 'answered', {}), 409);
  });

  test('answering requires a real report id', () => {
    const rfi = store.createRfi({ question: 'x' });
    store.transitionRfi(rfi.id, 'submitted');
    store.transitionRfi(rfi.id, 'assigned');
    store.transitionRfi(rfi.id, 'in_collection');
    expectStatus(() => store.transitionRfi(rfi.id, 'answered', {}), 400);
  });

  test('answering against a requirement creates the evidence link that closes the loop', () => {
    const pir = store.createRequirement({ kind: 'PIR', text: 'x' });
    const rfi = store.createRfi({ question: 'x', requirement_id: pir.id });
    store.transitionRfi(rfi.id, 'submitted');
    store.transitionRfi(rfi.id, 'assigned');
    store.transitionRfi(rfi.id, 'in_collection');
    const report = store.createReport({ text: 'Answer', reliability: 'A', credibility: 1 });
    const answered = store.transitionRfi(rfi.id, 'answered', { answer_report_id: report.id });
    expect(answered.state).toBe('answered');
    expect(answered.answer_report_id).toBe(report.id);
    const full = store.listReports().find((r) => r.id === report.id);
    expect(full.links).toHaveLength(1);
    expect(full.links[0]).toMatchObject({
      target_kind: 'requirement',
      target_id: pir.id,
      relation: 'confirms',
    });
  });

  test('closed is terminal', () => {
    const rfi = store.createRfi({ question: 'x' });
    store.transitionRfi(rfi.id, 'submitted');
    store.transitionRfi(rfi.id, 'assigned');
    store.transitionRfi(rfi.id, 'in_collection');
    const report = store.createReport({ text: 'x', reliability: 'A', credibility: 1 });
    store.transitionRfi(rfi.id, 'answered', { answer_report_id: report.id });
    store.transitionRfi(rfi.id, 'closed');
    expectStatus(() => store.transitionRfi(rfi.id, 'reopened'), 409);
  });
});

describe('scenario clock and events', () => {
  test('starts paused, and reading it twice does not create two rows', () => {
    const first = store.readClock();
    const second = store.readClock();
    expect(first.paused).toBe(true);
    expect(second.base_real_ts).toBe(first.base_real_ts);
  });

  test('resuming then pausing preserves scenario time across the round trip', () => {
    store.patchClock({ paused: false });
    const paused = store.patchClock({ paused: true });
    expect(paused.paused).toBe(true);
    expect(typeof paused.now).toBe('string');
  });

  test('rejects a non-positive rate', () => {
    expectStatus(() => store.patchClock({ rate: 0 }), 400);
    expectStatus(() => store.patchClock({ rate: -1 }), 400);
  });

  test('a message event fires and moves to state fired', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const event = store.createScenarioEvent({
      trigger_at: past,
      kind: 'message',
      payload: { text: 'Contact!' },
    });
    const fired = store.fireScenarioEvent(event.id);
    expect(fired.state).toBe('fired');
    expectStatus(() => store.fireScenarioEvent(event.id), 409);
  });

  test('a malformed report inject is rejected at schedule time, not fire time', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expectStatus(
      () =>
        store.createScenarioEvent({
          trigger_at: future,
          kind: 'report',
          payload: { reliability: 'Z' },
        }),
      400,
    );
    expectStatus(
      () => store.createScenarioEvent({ trigger_at: future, kind: 'report', payload: {} }),
      400,
    );
  });

  test('a report event materialises a real report when fired', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const event = store.createScenarioEvent({
      trigger_at: past,
      kind: 'report',
      payload: { text: 'Convoy sighted', reliability: 'B', credibility: 2 },
    });
    store.fireScenarioEvent(event.id);
    const reports = store.listReports();
    expect(reports.some((r) => r.text === 'Convoy sighted' && r.credibility === 2)).toBe(true);
  });

  test('tickScenario fires every due pending event exactly once', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    store.createScenarioEvent({ trigger_at: past, kind: 'message', payload: { text: 'Due now' } });
    store.createScenarioEvent({
      trigger_at: future,
      kind: 'message',
      payload: { text: 'Not yet' },
    });
    const first = store.tickScenario();
    expect(first.fired).toHaveLength(1);
    const second = store.tickScenario();
    expect(second.fired).toHaveLength(0);
  });

  test('cancelling a pending event stops it from ever firing', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const event = store.createScenarioEvent({
      trigger_at: past,
      kind: 'message',
      payload: { text: 'x' },
    });
    store.cancelScenarioEvent(event.id);
    const result = store.tickScenario();
    expect(result.fired).toHaveLength(0);
    expectStatus(() => store.fireScenarioEvent(event.id), 409);
  });
});

describe('IPB event-matrix import', () => {
  function study(id = 1, overrides = {}) {
    return {
      study: { id, name: 'Libavá' },
      coas: [
        { id: 10, name: 'Attack north', kind: 'most-likely' },
        { id: 11, name: 'Envelop west', kind: 'most-dangerous' },
      ],
      nais: [
        { id: 100, label: 'River crossing' },
        { id: 101, label: 'Ridge' },
      ],
      events: [
        {
          id: 1,
          coa_id: 10,
          nai_feature_id: 100,
          indicator: 'Bridging assets',
          expected_time: 'H+4',
          observed_status: 'expected',
        },
        {
          id: 2,
          coa_id: 10,
          nai_feature_id: 100,
          indicator: 'Recon patrols',
          expected_time: null,
          observed_status: 'observed',
        },
        {
          id: 3,
          coa_id: 10,
          nai_feature_id: null,
          indicator: 'Radio silence',
          expected_time: null,
          observed_status: 'expected',
        },
        {
          id: 4,
          coa_id: 11,
          nai_feature_id: 101,
          indicator: 'Artillery displaces',
          expected_time: 'H+1',
          observed_status: 'expected',
        },
      ],
      ...overrides,
    };
  }

  const byText = (requirements) =>
    Object.fromEntries(
      requirements.map((r) => [
        r.text,
        Object.fromEntries(
          r.sirs.map((s) => [s.text, s.indicators.map((i) => [i.description, i.observed])]),
        ),
      ]),
    );

  test('maps each COA to a PIR, each COA×NAI to a SIR, each event to an indicator', () => {
    const summary = store.importIpbStudy(study());
    expect(summary.requirements.created).toBe(2);
    expect(summary.sirs.created).toBe(3);
    expect(summary.indicators.created).toBe(4);
    expect(byText(store.listRequirements())).toEqual({
      'Libavá: is the enemy executing Attack north (most likely COA)?': {
        'NAI River crossing: indicators of Attack north': [
          ['Bridging assets (expected H+4)', false],
          ['Recon patrols', true],
        ],
        'No NAI assigned: indicators of Attack north': [['Radio silence', false]],
      },
      'Libavá: is the enemy executing Envelop west (most dangerous COA)?': {
        'NAI Ridge: indicators of Envelop west': [['Artillery displaces (expected H+1)', false]],
      },
    });
  });

  test('re-importing the same study changes nothing and duplicates nothing', () => {
    store.importIpbStudy(study());
    const before = store.listRequirements();
    const summary = store.importIpbStudy(study());
    expect(summary).toEqual({
      requirements: { created: 0, updated: 0, unchanged: 2, stale: [] },
      sirs: { created: 0, updated: 0, unchanged: 3, stale: [] },
      indicators: { created: 0, updated: 0, unchanged: 4, stale: [] },
    });
    expect(store.listRequirements()).toEqual(before);
  });

  test('re-import follows IPB edits but keeps exercise-owned state and never deletes', () => {
    store.importIpbStudy(study());
    const attackNorth = store.listRequirements().find((r) => r.text.includes('Attack north'));
    const riverSir = attackNorth.sirs.find((s) => s.text.startsWith('NAI River'));
    const bridging = riverSir.indicators.find((i) => i.description.startsWith('Bridging'));
    store.updateIndicator(bridging.id, { observed: true });
    const report = store.createReport({
      text: 'Bridge layer seen',
      reliability: 'A',
      credibility: 1,
    });
    store.createEvidenceLink(report.id, {
      target_kind: 'sir',
      target_id: riverSir.id,
      relation: 'confirms',
    });

    const edited = study();
    edited.coas[0].name = 'Attack north-east';
    edited.events[0].nai_feature_id = 101; // bridging moves to the ridge NAI
    edited.events = edited.events.filter((e) => e.id !== 3); // radio silence removed in IPB
    const summary = store.importIpbStudy(edited);

    expect(summary.requirements).toMatchObject({ updated: 1, unchanged: 1 });
    expect(summary.indicators).toMatchObject({ updated: 1, stale: ['Radio silence'] });
    // Ridge SIR is new for this COA; the no-NAI SIR lost its only event.
    expect(summary.sirs).toMatchObject({
      created: 1,
      stale: ['No NAI assigned: indicators of Attack north'],
    });

    const after = store.listRequirements();
    const renamed = after.find((r) => r.id === attackNorth.id);
    expect(renamed.text).toContain('Attack north-east');
    const river = renamed.sirs.find((s) => s.id === riverSir.id);
    expect(river.fulfillment.percent).toBe(100);
    const ridge = renamed.sirs.find((s) => s.text.startsWith('NAI Ridge'));
    expect(ridge.indicators).toEqual([
      expect.objectContaining({ id: bridging.id, observed: true }),
    ]);
    const orphan = renamed.sirs.find((s) => s.text.startsWith('No NAI'));
    expect(orphan.indicators.map((i) => i.description)).toEqual(['Radio silence']);
  });

  test('two studies never touch or stale each other, even with prefix-like ids', () => {
    const noneStale = {
      requirements: expect.objectContaining({ stale: [] }),
      sirs: expect.objectContaining({ stale: [] }),
      indicators: expect.objectContaining({ stale: [] }),
    };
    store.importIpbStudy(study(1));
    expect(store.importIpbStudy(study(10))).toEqual(noneStale);
    expect(store.listRequirements()).toHaveLength(4);
    expect(store.importIpbStudy(study(1))).toEqual(noneStale);
  });

  test('an event pointing at an unknown COA is a 400 and writes nothing', () => {
    const bad = study();
    bad.events.push({
      id: 9,
      coa_id: 99,
      nai_feature_id: null,
      indicator: 'x',
      observed_status: 'expected',
    });
    const activity = store.listActivity().length;
    expectStatus(() => store.importIpbStudy(bad), 400);
    expect(store.listRequirements()).toEqual([]);
    expect(store.listActivity()).toHaveLength(activity);
  });
});

describe('activity log', () => {
  test('grows by exactly one row per successful mutation', () => {
    const before = store.listActivity().length;
    store.createRosterMember({ name: 'Alex', role: 'analyst' });
    store.createRequirement({ kind: 'PIR', text: 'x' });
    expect(store.listActivity()).toHaveLength(before + 2);
  });

  test('a rejected mutation does not append an activity row', () => {
    const before = store.listActivity().length;
    try {
      store.createRosterMember({ name: '', role: 'analyst' });
    } catch {
      // expected 400
    }
    expect(store.listActivity()).toHaveLength(before);
  });
});
