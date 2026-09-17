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
