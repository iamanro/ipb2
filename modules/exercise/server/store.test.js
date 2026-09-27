import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { HttpError } from '../../../server/http.js';
import { formatMgrs } from '../../../src/geo.js';
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

// Every store function now takes the resolved item/part (or a dispatcher
// `owner`), never a user (docs/adr/0002-item-scoped-requests.md): cell
// visibility/edit gating (404/403 per route) is `server/dispatch.js`'s job
// alone, already covered by `dispatch.test.js` and `routes.sweep.test.js`.
// These tests are about domain behaviour, so a trivial White-sees-and-can-
// resolve-everything `access` stub — mirroring `accessFor` in dispatch.js,
// just without the cell math White never needs — is all they need; `row()`
// fetches the raw row a route would already have resolved before calling
// in.
const WHITE_OWNER = { owner_cell: 'white', releasable_to: [] };
const TABLE_BY_KIND = {
  nai: 'nais',
  track: 'tracks',
  report: 'reports',
  collector: 'collectors',
  sir: 'sirs',
  requirement: 'requirements',
};

let file;
let store;

function row(table, id) {
  return store.database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

const WHITE_ACCESS = {
  white: true,
  see(kind, id) {
    const found = row(TABLE_BY_KIND[kind], id);
    if (!found) throw new HttpError(404, `${kind} ${id} not found.`);
    return found;
  },
  canEdit: () => true,
  visible: () => ({ sql: '1=1', params: [] }),
};

beforeEach(() => {
  file = tempFile();
  store = openStore(file);
});

afterEach(() => {
  store.close();
  removeDatabaseFiles(file);
});

describe('requirements tree', () => {
  test('a PIR aggregates its SIRs and indicators, in creation order', () => {
    const pir = store.createRequirement(
      WHITE_OWNER,
      { kind: 'PIR', text: 'Will the enemy attack?', priority: 5 },
      WHITE_ACCESS,
    );
    const sir = store.createSir(
      row('requirements', pir.id),
      { text: 'Are engineers massing forward?' },
      WHITE_ACCESS,
    );
    store.createIndicator(row('requirements', pir.id), {
      sir_id: sir.id,
      description: 'Bridging equipment observed',
    });
    const [tree] = store.listRequirements(WHITE_ACCESS);
    expect(tree.sirs).toHaveLength(1);
    expect(tree.sirs[0].indicators).toHaveLength(1);
    expect(tree.sirs[0].indicators[0].observed).toBe(false);
  });

  test('deleting a requirement cascades through its SIRs and indicators', () => {
    const pir = store.createRequirement(WHITE_OWNER, { kind: 'PIR', text: 'x' }, WHITE_ACCESS);
    const sir = store.createSir(row('requirements', pir.id), { text: 'y' }, WHITE_ACCESS);
    const indicator = store.createIndicator(row('requirements', pir.id), {
      sir_id: sir.id,
      description: 'z',
    });
    store.deleteRequirement(row('requirements', pir.id));
    expect(store.listRequirements(WHITE_ACCESS)).toHaveLength(0);
    expect(row('sirs', sir.id)).toBeUndefined();
    expect(row('indicators', indicator.id)).toBeUndefined();
  });

  test('a blank requirement text is rejected', () => {
    expectStatus(
      () => store.createRequirement(WHITE_OWNER, { kind: 'PIR', text: '   ' }, WHITE_ACCESS),
      400,
    );
  });

  test('an indicator must name a SIR that belongs to this requirement', () => {
    const pir = store.createRequirement(WHITE_OWNER, { kind: 'PIR', text: 'x' }, WHITE_ACCESS);
    const other = store.createRequirement(WHITE_OWNER, { kind: 'PIR', text: 'y' }, WHITE_ACCESS);
    const otherSir = store.createSir(
      row('requirements', other.id),
      { text: 'other sir' },
      WHITE_ACCESS,
    );
    expectStatus(
      () =>
        store.createIndicator(row('requirements', pir.id), {
          sir_id: otherSir.id,
          description: 'z',
        }),
      400,
    );
    expectStatus(
      () => store.createIndicator(row('requirements', pir.id), { sir_id: 999, description: 'z' }),
      400,
    );
  });
});

describe('fulfillment, computed through real evidence joins', () => {
  function seed() {
    const pir = store.createRequirement(
      WHITE_OWNER,
      { kind: 'PIR', text: 'Will the enemy attack?' },
      WHITE_ACCESS,
    );
    const sirA = store.createSir(row('requirements', pir.id), { text: 'SIR A' }, WHITE_ACCESS);
    const sirB = store.createSir(row('requirements', pir.id), { text: 'SIR B' }, WHITE_ACCESS);
    return { pir, sirA, sirB };
  }

  test('starts open with no evidence', () => {
    const { pir } = seed();
    expect(store.listRequirements(WHITE_ACCESS)[0].fulfillment).toMatchObject({
      covered: 0,
      total: 2,
      percent: 0,
      state: 'open',
    });
    void pir;
  });

  test('a credible confirming report against one SIR moves it to partial', () => {
    const { pir, sirA } = seed();
    const report = store.createReport(
      WHITE_OWNER,
      { text: 'Convoy observed', reliability: 'B', credibility: 2 },
      WHITE_ACCESS,
    );
    store.createEvidenceLink(
      row('requirements', pir.id),
      { report_id: report.id, target_kind: 'sir', target_id: sirA.id, relation: 'confirms' },
      WHITE_ACCESS,
    );
    const [tree] = store.listRequirements(WHITE_ACCESS);
    expect(tree.fulfillment).toMatchObject({ covered: 1, total: 2, percent: 50, state: 'partial' });
    expect(tree.sirs.find((s) => s.id === sirA.id).fulfillment).toMatchObject({
      covered: 1,
      total: 1,
    });
  });

  test('a low-credibility report does not count', () => {
    const { pir, sirA } = seed();
    const report = store.createReport(
      WHITE_OWNER,
      { text: 'Rumour', reliability: 'F', credibility: 5 },
      WHITE_ACCESS,
    );
    store.createEvidenceLink(
      row('requirements', pir.id),
      { report_id: report.id, target_kind: 'sir', target_id: sirA.id, relation: 'confirms' },
      WHITE_ACCESS,
    );
    expect(store.listRequirements(WHITE_ACCESS)[0].fulfillment).toMatchObject({
      covered: 0,
      state: 'open',
    });
  });

  test('a link against the requirement itself covers every SIR under it', () => {
    seed();
    const [{ id: requirementId }] = store.listRequirements(WHITE_ACCESS);
    const report = store.createReport(
      WHITE_OWNER,
      { text: 'HUMINT summary', reliability: 'A', credibility: 1 },
      WHITE_ACCESS,
    );
    store.createEvidenceLink(
      row('requirements', requirementId),
      {
        report_id: report.id,
        target_kind: 'requirement',
        target_id: requirementId,
        relation: 'confirms',
      },
      WHITE_ACCESS,
    );
    expect(store.listRequirements(WHITE_ACCESS)[0].fulfillment).toMatchObject({
      covered: 2,
      total: 2,
      percent: 100,
      state: 'fulfilled',
    });
  });

  test('removing the qualifying evidence link reverts fulfillment', () => {
    const { pir, sirA } = seed();
    const report = store.createReport(
      WHITE_OWNER,
      { text: 'x', reliability: 'B', credibility: 1 },
      WHITE_ACCESS,
    );
    const link = store.createEvidenceLink(
      row('requirements', pir.id),
      { report_id: report.id, target_kind: 'sir', target_id: sirA.id, relation: 'confirms' },
      WHITE_ACCESS,
    );
    expect(store.listRequirements(WHITE_ACCESS)[0].fulfillment.covered).toBe(1);
    store.deleteEvidenceLink(row('requirements', pir.id), row('evidence_links', link.id));
    expect(store.listRequirements(WHITE_ACCESS)[0].fulfillment.covered).toBe(0);
  });

  test('an evidence link against an unknown target is a 400', () => {
    const pir = store.createRequirement(WHITE_OWNER, { kind: 'PIR', text: 'x' }, WHITE_ACCESS);
    const report = store.createReport(
      WHITE_OWNER,
      { text: 'x', reliability: 'B', credibility: 1 },
      WHITE_ACCESS,
    );
    expectStatus(
      () =>
        store.createEvidenceLink(
          row('requirements', pir.id),
          { report_id: report.id, target_kind: 'sir', target_id: 999, relation: 'confirms' },
          WHITE_ACCESS,
        ),
      400,
    );
  });
});

describe('RFI state machine, wired to the store', () => {
  test('a fresh RFI starts in draft and can only move forward one step at a time', () => {
    const rfi = store.createRfi(WHITE_OWNER, { question: 'Confirm bridge status?' }, WHITE_ACCESS);
    expect(rfi.state).toBe('draft');
    expectStatus(
      () => store.transitionRfi(row('rfis', rfi.id), { state: 'answered' }, WHITE_ACCESS),
      409,
    );
  });

  test('answering requires a real report id', () => {
    const rfi = store.createRfi(WHITE_OWNER, { question: 'x' }, WHITE_ACCESS);
    store.transitionRfi(row('rfis', rfi.id), { state: 'submitted' }, WHITE_ACCESS);
    store.transitionRfi(row('rfis', rfi.id), { state: 'assigned' }, WHITE_ACCESS);
    store.transitionRfi(row('rfis', rfi.id), { state: 'in_collection' }, WHITE_ACCESS);
    expectStatus(
      () => store.transitionRfi(row('rfis', rfi.id), { state: 'answered' }, WHITE_ACCESS),
      400,
    );
  });

  test('answering against a requirement creates the evidence link that closes the loop', () => {
    const pir = store.createRequirement(WHITE_OWNER, { kind: 'PIR', text: 'x' }, WHITE_ACCESS);
    const rfi = store.createRfi(
      WHITE_OWNER,
      { question: 'x', requirement_id: pir.id },
      WHITE_ACCESS,
    );
    store.transitionRfi(row('rfis', rfi.id), { state: 'submitted' }, WHITE_ACCESS);
    store.transitionRfi(row('rfis', rfi.id), { state: 'assigned' }, WHITE_ACCESS);
    store.transitionRfi(row('rfis', rfi.id), { state: 'in_collection' }, WHITE_ACCESS);
    const report = store.createReport(
      WHITE_OWNER,
      { text: 'Answer', reliability: 'A', credibility: 1 },
      WHITE_ACCESS,
    );
    const answered = store.transitionRfi(
      row('rfis', rfi.id),
      { state: 'answered', answer_report_id: report.id },
      WHITE_ACCESS,
    );
    expect(answered.state).toBe('answered');
    expect(answered.answer_report_id).toBe(report.id);
    const full = store.listReports(WHITE_ACCESS).find((r) => r.id === report.id);
    expect(full.links).toHaveLength(1);
    expect(full.links[0]).toMatchObject({
      target_kind: 'requirement',
      target_id: pir.id,
      relation: 'confirms',
      requirement_id: pir.id,
    });
  });

  test('closed is terminal', () => {
    const rfi = store.createRfi(WHITE_OWNER, { question: 'x' }, WHITE_ACCESS);
    store.transitionRfi(row('rfis', rfi.id), { state: 'submitted' }, WHITE_ACCESS);
    store.transitionRfi(row('rfis', rfi.id), { state: 'assigned' }, WHITE_ACCESS);
    store.transitionRfi(row('rfis', rfi.id), { state: 'in_collection' }, WHITE_ACCESS);
    const report = store.createReport(
      WHITE_OWNER,
      { text: 'x', reliability: 'A', credibility: 1 },
      WHITE_ACCESS,
    );
    store.transitionRfi(
      row('rfis', rfi.id),
      { state: 'answered', answer_report_id: report.id },
      WHITE_ACCESS,
    );
    store.transitionRfi(row('rfis', rfi.id), { state: 'closed' }, WHITE_ACCESS);
    expectStatus(
      () => store.transitionRfi(row('rfis', rfi.id), { state: 'reopened' }, WHITE_ACCESS),
      409,
    );
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
    const fired = store.fireScenarioEvent(event.id, WHITE_ACCESS);
    expect(fired.event.state).toBe('fired');
    expect(fired.cells).toEqual(['white', 'blue']);
    expectStatus(() => store.fireScenarioEvent(event.id, WHITE_ACCESS), 409);
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
    store.fireScenarioEvent(event.id, WHITE_ACCESS);
    const reports = store.listReports(WHITE_ACCESS);
    expect(reports.some((r) => r.text === 'Convoy sighted' && r.credibility === 2)).toBe(true);
  });

  test('every due pending event fires exactly once', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    store.createScenarioEvent({ trigger_at: past, kind: 'message', payload: { text: 'Due now' } });
    store.createScenarioEvent({
      trigger_at: future,
      kind: 'message',
      payload: { text: 'Not yet' },
    });
    const firstDue = store.dueScenarioEventIds();
    expect(firstDue).toHaveLength(1);
    firstDue.forEach((id) => store.fireScenarioEvent(id, WHITE_ACCESS));
    expect(store.dueScenarioEventIds()).toHaveLength(0);
  });

  test('cancelling a pending event stops it from ever firing', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const event = store.createScenarioEvent({
      trigger_at: past,
      kind: 'message',
      payload: { text: 'x' },
    });
    store.cancelScenarioEvent(event.id);
    expect(store.dueScenarioEventIds()).toHaveLength(0);
    expectStatus(() => store.fireScenarioEvent(event.id, WHITE_ACCESS), 409);
  });

  test('a draft event never comes due, no matter how far past its trigger time — only an explicit fire sends it', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const draft = store.createScenarioEvent({
      trigger_at: past,
      kind: 'message',
      payload: { text: 'Blue briefing draft' },
      delivery_mode: 'draft',
    });
    expect(draft.delivery_mode).toBe('draft');
    expect(store.dueScenarioEventIds()).toHaveLength(0);
    // "Send now" fires a draft directly, exactly once.
    const fired = store.fireScenarioEvent(draft.id, WHITE_ACCESS);
    expect(fired.event.state).toBe('fired');
    expectStatus(() => store.fireScenarioEvent(draft.id, WHITE_ACCESS), 409);
  });

  test('a scheduled event delivers exactly once: due, fired, then never due or fireable again', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const event = store.createScenarioEvent({
      trigger_at: past,
      kind: 'message',
      payload: { text: 'once only' },
    });
    expect(store.dueScenarioEventIds()).toEqual([event.id]);
    store.fireScenarioEvent(event.id, WHITE_ACCESS);
    expect(store.dueScenarioEventIds()).toHaveLength(0);
    expectStatus(() => store.fireScenarioEvent(event.id, WHITE_ACCESS), 409);
  });

  test('editing a pending event works, including draft->scheduled; a fired or cancelled event can no longer be edited', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const event = store.createScenarioEvent({
      trigger_at: past,
      kind: 'message',
      payload: { text: 'v1' },
      delivery_mode: 'draft',
    });
    const edited = store.updateScenarioEvent(event.id, {
      payload: { text: 'v2' },
      delivery_mode: 'scheduled',
    });
    expect(edited.payload.text).toBe('v2');
    expect(edited.delivery_mode).toBe('scheduled');
    expect(store.dueScenarioEventIds()).toEqual([event.id]);

    store.fireScenarioEvent(event.id, WHITE_ACCESS);
    expectStatus(() => store.updateScenarioEvent(event.id, { payload: { text: 'v3' } }), 409);

    const cancelled = store.createScenarioEvent({
      trigger_at: past,
      kind: 'message',
      payload: { text: 'x' },
    });
    store.cancelScenarioEvent(cancelled.id);
    expectStatus(() => store.updateScenarioEvent(cancelled.id, { payload: { text: 'y' } }), 409);
  });

  test('a scenario event can link to an existing situation, or reject an unknown one', () => {
    const situation = store.createSituation({ title: 'Ambush at the bridge' });
    const event = store.createScenarioEvent({
      trigger_at: new Date(Date.now() + 3_600_000).toISOString(),
      kind: 'message',
      payload: { text: 'x' },
      situation_id: situation.id,
    });
    expect(event.situation_id).toBe(situation.id);
    expectStatus(
      () =>
        store.createScenarioEvent({
          trigger_at: new Date(Date.now() + 3_600_000).toISOString(),
          kind: 'message',
          payload: { text: 'x' },
          situation_id: 999999,
        }),
      404,
    );
  });
});

describe('instructor authoring: story + situations (private, White-only ground truth)', () => {
  test('the story starts blank; reading it twice does not create two rows; patch changes only given fields', () => {
    const first = store.readStory();
    expect(first).toEqual({ title: '', briefing: '', objectives: '', instructor_notes: '' });
    expect(store.readStory()).toEqual(first);

    const patched = store.patchStory({
      title: 'Operation Falcon',
      briefing: 'Blue-facing background and mission.',
      objectives: 'Secret objective only White should ever see.',
    });
    expect(patched).toEqual({
      title: 'Operation Falcon',
      briefing: 'Blue-facing background and mission.',
      objectives: 'Secret objective only White should ever see.',
      instructor_notes: '',
    });

    const again = store.patchStory({
      instructor_notes: 'Future development: reinforcements arrive.',
    });
    expect(again).toMatchObject({
      title: 'Operation Falcon',
      instructor_notes: 'Future development: reinforcements arrive.',
    });
  });

  test('creating situations appends them in sort order; the aggregate view assembles story, situations, and events together', () => {
    const s1 = store.createSituation({ title: 'Beat one', ground_truth: 'Truth one' });
    const s2 = store.createSituation({ title: 'Beat two', ground_truth: 'Truth two' });
    expect(s1.sort_order).toBe(0);
    expect(s2.sort_order).toBe(1);
    expect(store.listSituations().map((s) => s.title)).toEqual(['Beat one', 'Beat two']);

    store.patchStory({ title: 'Operation Falcon' });
    store.createScenarioEvent({
      trigger_at: new Date(Date.now() + 3_600_000).toISOString(),
      kind: 'message',
      payload: { text: 'inject tied to a beat' },
      situation_id: s1.id,
    });

    const aggregate = store.getInstructorData();
    expect(aggregate.story.title).toBe('Operation Falcon');
    expect(aggregate.situations.map((s) => s.title)).toEqual(['Beat one', 'Beat two']);
    expect(aggregate.events).toHaveLength(1);
    expect(aggregate.events[0].situation_id).toBe(s1.id);
  });

  test('setting a situation active deactivates whichever one was active before (only one active at a time)', () => {
    const s1 = store.createSituation({ title: 'Beat one', status: 'active' });
    const s2 = store.createSituation({ title: 'Beat two' });
    expect(store.listSituations().find((s) => s.id === s1.id).status).toBe('active');

    const updated = store.updateSituation(s2.id, { status: 'active' });
    expect(updated.status).toBe('active');
    const after = store.listSituations();
    expect(after.find((s) => s.id === s1.id).status).toBe('complete');
    expect(after.find((s) => s.id === s2.id).status).toBe('active');
  });

  test('deleting a situation with no attached events succeeds; one with attached events (any state) is rejected', () => {
    const lone = store.createSituation({ title: 'Unused beat' });
    store.deleteSituation(lone.id);
    expect(store.listSituations()).toHaveLength(0);

    const used = store.createSituation({ title: 'Used beat' });
    const event = store.createScenarioEvent({
      trigger_at: new Date(Date.now() + 3_600_000).toISOString(),
      kind: 'message',
      payload: { text: 'x' },
      situation_id: used.id,
    });
    expectStatus(() => store.deleteSituation(used.id), 409);

    // Firing the event doesn't free the situation up either — a fired
    // event is a historical record still naming its situation.
    store.fireScenarioEvent(event.id, WHITE_ACCESS);
    expectStatus(() => store.deleteSituation(used.id), 409);
  });

  test('unknown story field values and situation ids 404/400 as usual', () => {
    expectStatus(() => store.createSituation({ title: '' }), 400);
    expectStatus(() => store.createSituation({ title: 'x', status: 'urgent' }), 400);
    expectStatus(() => store.updateSituation(999999, { title: 'y' }), 404);
    expectStatus(() => store.deleteSituation(999999), 404);
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
    const summary = store.importIpbStudy(WHITE_OWNER, study());
    expect(summary.requirements.created).toBe(2);
    expect(summary.sirs.created).toBe(3);
    expect(summary.indicators.created).toBe(4);
    expect(byText(store.listRequirements(WHITE_ACCESS))).toEqual({
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
    store.importIpbStudy(WHITE_OWNER, study());
    const before = store.listRequirements(WHITE_ACCESS);
    const summary = store.importIpbStudy(WHITE_OWNER, study());
    expect(summary).toEqual({
      requirements: { created: 0, updated: 0, unchanged: 2, stale: [] },
      sirs: { created: 0, updated: 0, unchanged: 3, stale: [] },
      indicators: { created: 0, updated: 0, unchanged: 4, stale: [] },
      nais: { created: 0, updated: 0, unchanged: 2, stale: [] },
    });
    expect(store.listRequirements(WHITE_ACCESS)).toEqual(before);
  });

  test('re-import follows IPB edits but keeps exercise-owned state and never deletes', () => {
    store.importIpbStudy(WHITE_OWNER, study());
    const attackNorth = store
      .listRequirements(WHITE_ACCESS)
      .find((r) => r.text.includes('Attack north'));
    const riverSir = attackNorth.sirs.find((s) => s.text.startsWith('NAI River'));
    const bridging = riverSir.indicators.find((i) => i.description.startsWith('Bridging'));
    store.updateIndicator(row('requirements', attackNorth.id), row('indicators', bridging.id), {
      observed: true,
    });
    const report = store.createReport(
      WHITE_OWNER,
      { text: 'Bridge layer seen', reliability: 'A', credibility: 1 },
      WHITE_ACCESS,
    );
    store.createEvidenceLink(
      row('requirements', attackNorth.id),
      { report_id: report.id, target_kind: 'sir', target_id: riverSir.id, relation: 'confirms' },
      WHITE_ACCESS,
    );

    const edited = study();
    edited.coas[0].name = 'Attack north-east';
    edited.events[0].nai_feature_id = 101; // bridging moves to the ridge NAI
    edited.events = edited.events.filter((e) => e.id !== 3); // radio silence removed in IPB
    const summary = store.importIpbStudy(WHITE_OWNER, edited);

    expect(summary.requirements).toMatchObject({ updated: 1, unchanged: 1 });
    expect(summary.indicators).toMatchObject({ updated: 1, stale: ['Radio silence'] });
    expect(summary.sirs).toMatchObject({
      created: 1,
      stale: ['No NAI assigned: indicators of Attack north'],
    });

    const after = store.listRequirements(WHITE_ACCESS);
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
      nais: expect.objectContaining({ stale: [] }),
    };
    store.importIpbStudy(WHITE_OWNER, study(1));
    expect(store.importIpbStudy(WHITE_OWNER, study(10))).toMatchObject(noneStale);
    expect(store.listRequirements(WHITE_ACCESS)).toHaveLength(4);
    expect(store.importIpbStudy(WHITE_OWNER, study(1))).toMatchObject(noneStale);
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
    const activity = store.listActivity(WHITE_ACCESS).length;
    expectStatus(() => store.importIpbStudy(WHITE_OWNER, bad), 400);
    expect(store.listRequirements(WHITE_ACCESS)).toEqual([]);
    expect(store.listActivity(WHITE_ACCESS)).toHaveLength(activity);
  });
});

describe('IPB import: NAI/TAI geometry upsert and SIR linking', () => {
  const naiGeometry = {
    type: 'Polygon',
    coordinates: [
      [
        [17, 49],
        [17.2, 49],
        [17.2, 49.2],
        [17, 49.2],
        [17, 49],
      ],
    ],
  };

  function studyWithGeometry() {
    return {
      study: { id: 5, name: 'Geometry Study' },
      coas: [{ id: 50, name: 'Push east', kind: 'most-likely' }],
      nais: [
        { id: 500, label: 'River Line', kind: 'nai', geometry: naiGeometry },
        { id: 501, label: 'Bridge TAI', kind: 'tai' },
      ],
      events: [
        {
          id: 1,
          coa_id: 50,
          nai_feature_id: 500,
          indicator: 'Bridging',
          observed_status: 'expected',
        },
      ],
    };
  }

  test('upserts NAIs/TAIs by source, storing geometry when given and NULL when not', () => {
    const summary = store.importIpbStudy(WHITE_OWNER, studyWithGeometry());
    expect(summary.nais).toEqual({ created: 2, updated: 0, unchanged: 0, stale: [] });
    const nais = store.listNais(WHITE_ACCESS);
    const river = nais.find((n) => n.label === 'River Line');
    const bridge = nais.find((n) => n.label === 'Bridge TAI');
    expect(river).toMatchObject({ source: 'ipb:5:nai:500', kind: 'nai', geometry: naiGeometry });
    expect(bridge).toMatchObject({ source: 'ipb:5:nai:501', kind: 'tai', geometry: null });
  });

  test('links the SIR generated for a COA x NAI pair to the real nais row', () => {
    store.importIpbStudy(WHITE_OWNER, studyWithGeometry());
    const river = store.listNais(WHITE_ACCESS).find((n) => n.label === 'River Line');
    const requirement = store.listRequirements(WHITE_ACCESS)[0];
    const sir = requirement.sirs[0];
    expect(sir.nai_id).toBe(river.id);
  });

  test('re-importing with a changed geometry updates the NAI, not duplicates it', () => {
    store.importIpbStudy(WHITE_OWNER, studyWithGeometry());
    const before = store.listNais(WHITE_ACCESS).find((n) => n.label === 'River Line');
    const edited = studyWithGeometry();
    edited.nais[0].geometry = { type: 'Point', coordinates: [17.1, 49.1] };
    const summary = store.importIpbStudy(WHITE_OWNER, edited);
    expect(summary.nais).toMatchObject({ updated: 1, unchanged: 1 });
    const after = store.listNais(WHITE_ACCESS).find((n) => n.id === before.id);
    expect(after.geometry).toEqual({ type: 'Point', coordinates: [17.1, 49.1] });
  });

  test('older payloads without kind/geometry still create a usable NAI (backwards compatible)', () => {
    const summary = store.importIpbStudy(WHITE_OWNER, {
      study: { id: 6, name: 'Legacy Study' },
      coas: [{ id: 60, name: 'Hold', kind: 'most-likely' }],
      nais: [{ id: 600, label: 'Legacy NAI' }],
      events: [
        { id: 1, coa_id: 60, nai_feature_id: 600, indicator: 'Watch', observed_status: 'expected' },
      ],
    });
    expect(summary.nais.created).toBe(1);
    const nai = store.listNais(WHITE_ACCESS).find((n) => n.label === 'Legacy NAI');
    expect(nai).toMatchObject({ kind: 'nai', geometry: null });
  });

  test('SIR text names the area once, as NAI or TAI', () => {
    store.importIpbStudy(WHITE_OWNER, {
      study: { id: 7, name: 'Naming' },
      coas: [{ id: 70, name: 'Push', kind: 'most-likely' }],
      nais: [
        { id: 700, label: 'NAI 1', kind: 'nai' },
        { id: 701, label: 'Ford', kind: 'tai' },
      ],
      events: [
        { id: 1, coa_id: 70, nai_feature_id: 700, indicator: 'a', observed_status: 'expected' },
        { id: 2, coa_id: 70, nai_feature_id: 701, indicator: 'b', observed_status: 'expected' },
      ],
    });
    const texts = store.listRequirements(WHITE_ACCESS).flatMap((r) => r.sirs.map((s) => s.text));
    expect(texts).toEqual(
      expect.arrayContaining(['NAI 1: indicators of Push', 'TAI Ford: indicators of Push']),
    );
  });
});

describe('reports: location, type, structured fields, SIDC, auto-NAI', () => {
  const naiPolygon = {
    type: 'Polygon',
    coordinates: [
      [
        [17, 49],
        [17.2, 49],
        [17.2, 49.2],
        [17, 49.2],
        [17, 49],
      ],
    ],
  };
  const validSidc = '10031000141211000000';

  function seedNai() {
    store.importIpbStudy(WHITE_OWNER, {
      study: { id: 1, name: 'S' },
      coas: [{ id: 1, name: 'C', kind: 'most-likely' }],
      nais: [{ id: 1, label: 'Alpha', kind: 'nai', geometry: naiPolygon }],
      events: [
        { id: 1, coa_id: 1, nai_feature_id: 1, indicator: 'i', observed_status: 'expected' },
      ],
    });
    return store.listNais(WHITE_ACCESS)[0];
  }

  test('a plain report with no location is unchanged from before', () => {
    const report = store.createReport(
      WHITE_OWNER,
      { text: 'Free text', reliability: 'C', credibility: 3 },
      WHITE_ACCESS,
    );
    expect(report).toMatchObject({
      lon: null,
      lat: null,
      report_type: 'free',
      fields: {},
      sidc: null,
      nai_id: null,
      track_id: null,
    });
  });

  test('lon without lat (or vice versa) is rejected', () => {
    expectStatus(
      () =>
        store.createReport(
          WHITE_OWNER,
          { text: 'x', reliability: 'A', credibility: 1, lon: 17 },
          WHITE_ACCESS,
        ),
      400,
    );
    expectStatus(
      () =>
        store.createReport(
          WHITE_OWNER,
          { text: 'x', reliability: 'A', credibility: 1, lat: 49 },
          WHITE_ACCESS,
        ),
      400,
    );
  });

  test('lon/lat out of range is rejected', () => {
    expectStatus(
      () =>
        store.createReport(
          WHITE_OWNER,
          { text: 'x', reliability: 'A', credibility: 1, lon: 200, lat: 49 },
          WHITE_ACCESS,
        ),
      400,
    );
    expectStatus(
      () =>
        store.createReport(
          WHITE_OWNER,
          { text: 'x', reliability: 'A', credibility: 1, lon: 17, lat: 95 },
          WHITE_ACCESS,
        ),
      400,
    );
  });

  test('report_type must be one of the enum values', () => {
    expectStatus(
      () =>
        store.createReport(
          WHITE_OWNER,
          { text: 'x', reliability: 'A', credibility: 1, report_type: 'rumour' },
          WHITE_ACCESS,
        ),
      400,
    );
  });

  test('salute fields are restricted to size/activity/location/unit/time/equipment', () => {
    const report = store.createReport(
      WHITE_OWNER,
      {
        text: 'SALUTE',
        reliability: 'B',
        credibility: 2,
        report_type: 'salute',
        fields: { size: '~squad', activity: 'digging in' },
      },
      WHITE_ACCESS,
    );
    expect(report.fields).toEqual({ size: '~squad', activity: 'digging in' });
    expectStatus(
      () =>
        store.createReport(
          WHITE_OWNER,
          {
            text: 'x',
            reliability: 'A',
            credibility: 1,
            report_type: 'salute',
            fields: { remarks: 'not a salute field' },
          },
          WHITE_ACCESS,
        ),
      400,
    );
  });

  test('spotrep fields additionally allow remarks', () => {
    const report = store.createReport(
      WHITE_OWNER,
      {
        text: 'SPOTREP',
        reliability: 'B',
        credibility: 2,
        report_type: 'spotrep',
        fields: { remarks: 'urgent' },
      },
      WHITE_ACCESS,
    );
    expect(report.fields).toEqual({ remarks: 'urgent' });
  });

  test('a field value over 500 characters is rejected', () => {
    expectStatus(
      () =>
        store.createReport(
          WHITE_OWNER,
          {
            text: 'x',
            reliability: 'A',
            credibility: 1,
            report_type: 'salute',
            fields: { size: 'a'.repeat(501) },
          },
          WHITE_ACCESS,
        ),
      400,
    );
  });

  test('sidc must be exactly 20 digits', () => {
    expectStatus(
      () =>
        store.createReport(
          WHITE_OWNER,
          { text: 'x', reliability: 'A', credibility: 1, sidc: '123' },
          WHITE_ACCESS,
        ),
      400,
    );
    expectStatus(
      () =>
        store.createReport(
          WHITE_OWNER,
          { text: 'x', reliability: 'A', credibility: 1, sidc: '1003100014121100000A' },
          WHITE_ACCESS,
        ),
      400,
    );
    const report = store.createReport(
      WHITE_OWNER,
      { text: 'x', reliability: 'A', credibility: 1, sidc: validSidc },
      WHITE_ACCESS,
    );
    expect(report.sidc).toBe(validSidc);
  });

  test('a SIDC copied in groups (spaces/dashes) is accepted and stored canonically', () => {
    const grouped = '1003 1000-1412 1100 0000';
    const report = store.createReport(
      WHITE_OWNER,
      { text: 'x', reliability: 'A', credibility: 1, sidc: grouped },
      WHITE_ACCESS,
    );
    expect(report.sidc).toBe(validSidc);
  });

  test('a report inside an NAI polygon auto-links to it on create', () => {
    const nai = seedNai();
    const report = store.createReport(
      WHITE_OWNER,
      { text: 'x', reliability: 'A', credibility: 1, lon: 17.1, lat: 49.1 },
      WHITE_ACCESS,
    );
    expect(report.nai_id).toBe(nai.id);
  });

  test('a report outside every NAI gets no auto-link', () => {
    seedNai();
    const report = store.createReport(
      WHITE_OWNER,
      { text: 'x', reliability: 'A', credibility: 1, lon: 30, lat: 10 },
      WHITE_ACCESS,
    );
    expect(report.nai_id).toBeNull();
  });

  test('an explicit nai_id is respected over auto-matching', () => {
    seedNai();
    const other = store.createReport(
      WHITE_OWNER,
      { text: 'x', reliability: 'A', credibility: 1, lon: 17.1, lat: 49.1, nai_id: null },
      WHITE_ACCESS,
    );
    expect(other.nai_id).toBeNull();
  });

  test('moving a report into an NAI on update re-runs the auto-match', () => {
    const nai = seedNai();
    const report = store.createReport(
      WHITE_OWNER,
      { text: 'x', reliability: 'A', credibility: 1, lon: 30, lat: 10 },
      WHITE_ACCESS,
    );
    expect(report.nai_id).toBeNull();
    const moved = store.updateReport(
      row('reports', report.id),
      { lon: 17.1, lat: 49.1 },
      WHITE_ACCESS,
    );
    expect(moved.nai_id).toBe(nai.id);
  });

  test('track_id must reference an existing track', () => {
    expectStatus(
      () =>
        store.createReport(
          WHITE_OWNER,
          { text: 'x', reliability: 'A', credibility: 1, track_id: 999 },
          WHITE_ACCESS,
        ),
      404,
    );
  });
});

describe('tracks: the current situation', () => {
  const sidc = '10031000141211000000';

  test('creating a track also creates its first position', () => {
    const track = store.createTrack(WHITE_OWNER, {
      sidc,
      designation: 'HOSTILE-1',
      lon: 17,
      lat: 49,
      observed_at: '2026-09-20T10:00:00.000Z',
    });
    expect(track.history).toHaveLength(1);
    expect(track.history[0]).toMatchObject({
      lon: 17,
      lat: 49,
      observed_at: '2026-09-20T10:00:00.000Z',
    });
  });

  test('a newer position moves the head', () => {
    const track = store.createTrack(WHITE_OWNER, {
      sidc,
      lon: 17,
      lat: 49,
      observed_at: '2026-09-20T10:00:00.000Z',
    });
    const moved = store.addTrackPosition(
      row('tracks', track.id),
      { lon: 17.5, lat: 49.5, observed_at: '2026-09-20T11:00:00.000Z' },
      WHITE_ACCESS,
    );
    expect(moved).toMatchObject({ lon: 17.5, lat: 49.5, observed_at: '2026-09-20T11:00:00.000Z' });
    expect(moved.history).toHaveLength(2);
  });

  test('an out-of-order (older) position is recorded in history but never moves the head back', () => {
    const track = store.createTrack(WHITE_OWNER, {
      sidc,
      lon: 17,
      lat: 49,
      observed_at: '2026-09-20T12:00:00.000Z',
    });
    const result = store.addTrackPosition(
      row('tracks', track.id),
      { lon: 99, lat: 1, observed_at: '2026-09-20T09:00:00.000Z' },
      WHITE_ACCESS,
    );
    expect(result).toMatchObject({ lon: 17, lat: 49, observed_at: '2026-09-20T12:00:00.000Z' });
    expect(result.history).toHaveLength(2);
    expect(result.history.map((p) => p.observed_at)).toEqual([
      '2026-09-20T09:00:00.000Z',
      '2026-09-20T12:00:00.000Z',
    ]);
  });

  test('a position exactly equal to the current head still counts as "moving" it', () => {
    const track = store.createTrack(WHITE_OWNER, {
      sidc,
      lon: 17,
      lat: 49,
      observed_at: '2026-09-20T12:00:00.000Z',
    });
    const result = store.addTrackPosition(
      row('tracks', track.id),
      { lon: 20, lat: 50, observed_at: '2026-09-20T12:00:00.000Z' },
      WHITE_ACCESS,
    );
    expect(result).toMatchObject({ lon: 20, lat: 50 });
  });

  test('linking a report_id to a position also links the report back to the track', () => {
    const track = store.createTrack(WHITE_OWNER, {
      sidc,
      lon: 17,
      lat: 49,
      observed_at: '2026-09-20T10:00:00.000Z',
    });
    const report = store.createReport(
      WHITE_OWNER,
      { text: 'seen again', reliability: 'A', credibility: 1 },
      WHITE_ACCESS,
    );
    store.addTrackPosition(
      row('tracks', track.id),
      { lon: 17.2, lat: 49.2, observed_at: '2026-09-20T11:00:00.000Z', report_id: report.id },
      WHITE_ACCESS,
    );
    const updatedReport = store.listReports(WHITE_ACCESS).find((r) => r.id === report.id);
    expect(updatedReport.track_id).toBe(track.id);
  });

  test('GET tracks includes full history sorted by time', () => {
    const track = store.createTrack(WHITE_OWNER, {
      sidc,
      lon: 17,
      lat: 49,
      observed_at: '2026-09-20T10:00:00.000Z',
    });
    store.addTrackPosition(
      row('tracks', track.id),
      { lon: 17.1, lat: 49.1, observed_at: '2026-09-20T12:00:00.000Z' },
      WHITE_ACCESS,
    );
    store.addTrackPosition(
      row('tracks', track.id),
      { lon: 17.05, lat: 49.05, observed_at: '2026-09-20T11:00:00.000Z' },
      WHITE_ACCESS,
    );
    const [listed] = store.listTracks(WHITE_ACCESS);
    expect(listed.history.map((p) => p.observed_at)).toEqual([
      '2026-09-20T10:00:00.000Z',
      '2026-09-20T11:00:00.000Z',
      '2026-09-20T12:00:00.000Z',
    ]);
  });

  test('sidc must be a 20-digit code and status must be a known value', () => {
    expectStatus(
      () =>
        store.createTrack(WHITE_OWNER, {
          sidc: '123',
          lon: 0,
          lat: 0,
          observed_at: '2026-09-20T10:00:00.000Z',
        }),
      400,
    );
    expectStatus(
      () =>
        store.createTrack(WHITE_OWNER, {
          sidc,
          status: 'lost-in-space',
          lon: 0,
          lat: 0,
          observed_at: '2026-09-20T10:00:00.000Z',
        }),
      400,
    );
  });
});

describe('collection plan: collectors, taskings, SOR, conflicts', () => {
  function seedRequirementAndSir() {
    const requirement = store.createRequirement(
      WHITE_OWNER,
      { kind: 'PIR', text: 'Where is the enemy reserve?' },
      WHITE_ACCESS,
    );
    const sir = store.createSir(
      row('requirements', requirement.id),
      { text: 'NAI Alpha: movement' },
      WHITE_ACCESS,
    );
    return { requirement, sir };
  }

  test('a collector requires a valid discipline', () => {
    expectStatus(() => store.createCollector(WHITE_OWNER, { name: 'X', discipline: 'BOGUS' }), 400);
    const collector = store.createCollector(WHITE_OWNER, { name: 'UAS-1', discipline: 'UAS' });
    expect(collector).toMatchObject({ name: 'UAS-1', discipline: 'UAS' });
  });

  test('available_from must be before available_to', () => {
    expectStatus(
      () =>
        store.createCollector(WHITE_OWNER, {
          name: 'X',
          discipline: 'HUMINT',
          available_from: '2026-09-20T12:00:00.000Z',
          available_to: '2026-09-20T10:00:00.000Z',
        }),
      400,
    );
  });

  test('a tasking needs an existing collector and start before end', () => {
    const { sir } = seedRequirementAndSir();
    expectStatus(
      () =>
        store.createTasking(
          WHITE_OWNER,
          {
            collector_id: 999,
            sir_id: sir.id,
            start_at: '2026-09-20T10:00:00.000Z',
            end_at: '2026-09-20T11:00:00.000Z',
          },
          WHITE_ACCESS,
        ),
      404,
    );
    const collector = store.createCollector(WHITE_OWNER, {
      name: 'HUMINT-1',
      discipline: 'HUMINT',
    });
    expectStatus(
      () =>
        store.createTasking(
          WHITE_OWNER,
          {
            collector_id: collector.id,
            sir_id: sir.id,
            start_at: '2026-09-20T12:00:00.000Z',
            end_at: '2026-09-20T10:00:00.000Z',
          },
          WHITE_ACCESS,
        ),
      400,
    );
  });

  test('SOR text names the collector, SIR, NAI and DTG window, with LTIOV', () => {
    const requirement = store.createRequirement(
      WHITE_OWNER,
      { kind: 'PIR', text: 'Is the bridge intact?', ltiov: '2026-09-21T06:00:00.000Z' },
      WHITE_ACCESS,
    );
    store.importIpbStudy(WHITE_OWNER, {
      study: { id: 9, name: 'SOR Study' },
      coas: [{ id: 90, name: 'C', kind: 'most-likely' }],
      nais: [{ id: 900, label: 'Crossing Site', kind: 'nai' }],
      events: [
        { id: 1, coa_id: 90, nai_feature_id: 900, indicator: 'i', observed_status: 'expected' },
      ],
    });
    const nai = store.listNais(WHITE_ACCESS).find((n) => n.label === 'Crossing Site');
    const sir = store.createSir(
      row('requirements', requirement.id),
      { text: 'Watch the crossing site', nai_id: nai.id },
      WHITE_ACCESS,
    );
    const collector = store.createCollector(WHITE_OWNER, { name: 'RECCE-2', discipline: 'RECCE' });
    const tasking = store.createTasking(
      WHITE_OWNER,
      {
        collector_id: collector.id,
        sir_id: sir.id,
        nai_id: sir.nai_id,
        start_at: '2026-09-20T05:00:00.000Z',
        end_at: '2026-09-20T09:00:00.000Z',
      },
      WHITE_ACCESS,
    );
    expect(tasking.sor).toContain('RECCE-2');
    expect(tasking.sor).toContain(sir.text);
    expect(tasking.sor).toContain('Crossing Site');
    expect(tasking.sor).toContain('200500ZSEP26');
    expect(tasking.sor).toContain('200900ZSEP26');
    expect(tasking.sor).toMatch(/report NLT 210600ZSEP26$/);
  });

  test('GET collection/conflicts finds overlapping taskings of the same collector and out-of-window taskings', () => {
    const { sir } = seedRequirementAndSir();
    const collector = store.createCollector(WHITE_OWNER, {
      name: 'IMINT-1',
      discipline: 'IMINT',
      available_from: '2026-09-20T08:00:00.000Z',
      available_to: '2026-09-20T18:00:00.000Z',
    });
    const a = store.createTasking(
      WHITE_OWNER,
      {
        collector_id: collector.id,
        sir_id: sir.id,
        start_at: '2026-09-20T09:00:00.000Z',
        end_at: '2026-09-20T11:00:00.000Z',
      },
      WHITE_ACCESS,
    );
    const b = store.createTasking(
      WHITE_OWNER,
      {
        collector_id: collector.id,
        sir_id: sir.id,
        start_at: '2026-09-20T10:00:00.000Z',
        end_at: '2026-09-20T12:00:00.000Z',
      },
      WHITE_ACCESS,
    );
    const c = store.createTasking(
      WHITE_OWNER,
      {
        collector_id: collector.id,
        sir_id: sir.id,
        start_at: '2026-09-20T19:00:00.000Z',
        end_at: '2026-09-20T20:00:00.000Z',
      },
      WHITE_ACCESS,
    );
    const conflicts = store.listCollectionConflicts(WHITE_ACCESS);
    expect(conflicts.overlaps).toEqual([
      { kind: 'overlap', collector_id: collector.id, tasking_ids: [a.id, b.id] },
    ]);
    expect(conflicts.outside).toEqual([
      { kind: 'unavailable', collector_id: collector.id, tasking_id: c.id },
    ]);
  });
});

function tempJsonFile() {
  return path.join(
    os.tmpdir(),
    `exercise-regions-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
  );
}

// The 14 official kraj names the EXAMPLE scenario matches against (see
// scenarioGeography.js); geometries are tiny non-overlapping unit squares —
// good enough to exercise the union without shipping real Czech borders.
const OFFICIAL_KRAJE = [
  'Hlavní město Praha',
  'Středočeský kraj',
  'Jihočeský kraj',
  'Plzeňský kraj',
  'Karlovarský kraj',
  'Ústecký kraj',
  'Liberecký kraj',
  'Královéhradecký kraj',
  'Pardubický kraj',
  'Kraj Vysočina',
  'Jihomoravský kraj',
  'Olomoucký kraj',
  'Zlínský kraj',
  'Moravskoslezský kraj',
];

function fixtureRegions() {
  return {
    type: 'FeatureCollection',
    features: OFFICIAL_KRAJE.map((name, index) => ({
      type: 'Feature',
      properties: { id: `kraj:K${index}`, level: 'kraj', name },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [index, index],
            [index + 1, index],
            [index + 1, index + 1],
            [index, index + 1],
            [index, index],
          ],
        ],
      },
    })),
  };
}

describe('products: INTSUM draft and CRUD', () => {
  test('the draft summarises tracks, in-window reports, and PIR fulfillment; assessment/outlook stay empty', () => {
    store.createTrack(WHITE_OWNER, {
      sidc: '10031000141211000000',
      designation: 'HOSTILE-1',
      status: 'confirmed',
      lon: 17.5,
      lat: 49.5,
      observed_at: '2026-09-20T10:00:00.000Z',
    });
    const inWindow = store.createReport(
      WHITE_OWNER,
      {
        text: 'Column moving south',
        reliability: 'B',
        credibility: 2,
        occurred_at: '2026-09-20T09:00:00.000Z',
        lon: 17.5,
        lat: 49.5,
        report_type: 'spotrep',
      },
      WHITE_ACCESS,
    );
    store.createReport(
      WHITE_OWNER,
      {
        text: 'Outside the window',
        reliability: 'C',
        credibility: 3,
        occurred_at: '2026-09-22T09:00:00.000Z',
      },
      WHITE_ACCESS,
    );
    const requirement = store.createRequirement(
      WHITE_OWNER,
      { kind: 'PIR', text: 'Is the enemy withdrawing?' },
      WHITE_ACCESS,
    );
    const sir = store.createSir(
      row('requirements', requirement.id),
      { text: 'Watch route 1' },
      WHITE_ACCESS,
    );
    store.createEvidenceLink(
      row('requirements', requirement.id),
      { report_id: inWindow.id, target_kind: 'sir', target_id: sir.id, relation: 'confirms' },
      WHITE_ACCESS,
    );

    const draft = store.draftIntsum(
      WHITE_ACCESS,
      '2026-09-20T00:00:00.000Z',
      '2026-09-20T23:59:59.000Z',
    );
    expect(draft.sections.situation).toEqual([
      `HOSTILE-1: CONFIRMED at ${formatMgrs(17.5, 49.5)}, last seen 201000ZSEP26`,
    ]);
    expect(draft.sections.significant_activity).toEqual([
      `200900ZSEP26 \u2013 SPOTREP \u2013 ${formatMgrs(17.5, 49.5)} \u2013 Column moving south (Admiralty B2)`,
    ]);
    expect(draft.sections.pir_status).toEqual([
      expect.objectContaining({ requirement_id: requirement.id, percent: 100, state: 'fulfilled' }),
    ]);
    expect(draft.sections.assessment).toBe('');
    expect(draft.sections.outlook).toBe('');
  });

  test('from must not be after to', () => {
    expectStatus(
      () => store.draftIntsum(WHITE_ACCESS, '2026-09-21T00:00:00.000Z', '2026-09-20T00:00:00.000Z'),
      400,
    );
  });

  test('CRUD: create fills unspecified sections with empty strings; update merges only the given keys', () => {
    const intsum = store.createIntsum(WHITE_OWNER, {
      period_start: '2026-09-20T00:00:00.000Z',
      period_end: '2026-09-21T00:00:00.000Z',
      author: 'S2',
      sections: { situation: ['line 1'] },
    });
    expect(intsum.sections).toEqual({
      situation: ['line 1'],
      significant_activity: '',
      pir_status: '',
      assessment: '',
      outlook: '',
    });
    const updated = store.updateIntsum(row('intsums', intsum.id), {
      sections: { assessment: 'Enemy likely to reinforce.' },
    });
    expect(updated.sections).toEqual({
      situation: ['line 1'],
      significant_activity: '',
      pir_status: '',
      assessment: 'Enemy likely to reinforce.',
      outlook: '',
    });
  });

  test('an unknown section key is rejected', () => {
    expectStatus(
      () =>
        store.createIntsum(WHITE_OWNER, {
          period_start: '2026-09-20T00:00:00.000Z',
          period_end: '2026-09-21T00:00:00.000Z',
          sections: { conclusion: 'nope' },
        }),
      400,
    );
  });
});

describe('scenario injects: a located report payload', () => {
  test('firing a report-kind inject creates a report with the same location/type/fields/sidc and auto-NAI', () => {
    store.importIpbStudy(WHITE_OWNER, {
      study: { id: 1, name: 'S' },
      coas: [{ id: 1, name: 'C', kind: 'most-likely' }],
      nais: [
        {
          id: 1,
          label: 'Alpha',
          kind: 'nai',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [17, 49],
                [17.2, 49],
                [17.2, 49.2],
                [17, 49.2],
                [17, 49],
              ],
            ],
          },
        },
      ],
      events: [
        { id: 1, coa_id: 1, nai_feature_id: 1, indicator: 'i', observed_status: 'expected' },
      ],
    });
    const nai = store.listNais(WHITE_ACCESS)[0];
    const event = store.createScenarioEvent({
      trigger_at: '2026-09-20T00:00:00.000Z',
      kind: 'report',
      payload: {
        text: 'Injected SALUTE',
        reliability: 'A',
        credibility: 1,
        lon: 17.1,
        lat: 49.1,
        report_type: 'salute',
        fields: { size: '~10 pax' },
        sidc: '10031000141211000000',
      },
    });
    const fired = store.fireScenarioEvent(event.id, WHITE_ACCESS);
    expect(fired.event.state).toBe('fired');
    const report = store.listReports(WHITE_ACCESS)[0];
    expect(report).toMatchObject({
      text: 'Injected SALUTE',
      lon: 17.1,
      lat: 49.1,
      report_type: 'salute',
      fields: { size: '~10 pax' },
      sidc: '10031000141211000000',
      nai_id: nai.id,
    });
  });

  test('an inject with a malformed SIDC is rejected at schedule time, not fire time', () => {
    expectStatus(
      () =>
        store.createScenarioEvent({
          trigger_at: '2026-09-20T00:00:00.000Z',
          kind: 'report',
          payload: { text: 'x', sidc: 'not-20-digits' },
        }),
      400,
    );
    expect(store.listScenarioEvents()).toEqual([]);
  });
});

describe('activity log', () => {
  test('grows by exactly one row per successful mutation', () => {
    const before = store.listActivity(WHITE_ACCESS).length;
    store.createReport(WHITE_OWNER, { text: 'x', reliability: 'A', credibility: 1 }, WHITE_ACCESS);
    store.createRequirement(WHITE_OWNER, { kind: 'PIR', text: 'x' }, WHITE_ACCESS);
    expect(store.listActivity(WHITE_ACCESS)).toHaveLength(before + 2);
  });

  test('a rejected mutation does not append an activity row', () => {
    const before = store.listActivity(WHITE_ACCESS).length;
    try {
      store.createRequirement(WHITE_OWNER, { kind: 'PIR', text: '' }, WHITE_ACCESS);
    } catch {
      // expected 400
    }
    expect(store.listActivity(WHITE_ACCESS)).toHaveLength(before);
  });
});

// Scenario/country/place management has never taken a user (it isn't
// cell-owned — every route here is `verb: 'none'`), so this whole section
// is unchanged by docs/adr/0002.
describe('exercise scenarios: kraje-composed countries, renamed places, one active scenario', () => {
  let regionsFile;
  let scenarioFile;
  let scenarioStore;

  beforeEach(() => {
    // `openStore` keeps one module-scope database/regions handle (like the
    // rest of this store), so close the outer `store` first rather than
    // orphaning its handle underneath this describe's own store.
    store.close();
    regionsFile = tempJsonFile();
    writeFileSync(regionsFile, JSON.stringify(fixtureRegions()));
    scenarioFile = tempFile();
    scenarioStore = openStore(scenarioFile, { regionsFile });
  });

  afterEach(() => {
    scenarioStore.close();
    removeDatabaseFiles(scenarioFile);
    rmSync(regionsFile, { force: true });
    store = openStore(file); // restore it for the outer afterEach's close()/cleanup
  });

  test('GET regions serves the built file', () => {
    expect(scenarioStore.getRegions()).toEqual(fixtureRegions());
  });

  test('getRegions and createExampleScenario are a 503 without a regions file', () => {
    scenarioStore.close();
    const bareFile = tempFile();
    const bareStore = openStore(bareFile);
    expectStatus(() => bareStore.getRegions(), 503);
    expectStatus(() => bareStore.createExampleScenario(), 503);
    bareStore.close();
    removeDatabaseFiles(bareFile);
    scenarioStore = openStore(scenarioFile, { regionsFile });
  });

  test('listing auto-seeds the EXAMPLE scenario exactly once, even across a reopen, but POST scenarios/example always works', () => {
    const items = scenarioStore.listScenarios();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      example: true,
      active: false,
      country_count: 3,
      place_count: 13,
    });
    const full = scenarioStore.getScenario(items[0].id);
    expect(full.countries.map((c) => c.name)).toEqual(['Arnland', 'Framland', 'Donovia']);
    expect(full.countries.map((c) => c.affiliation)).toEqual(['friendly', 'neutral', 'hostile']);
    expect(full.countries.every((c) => c.geometry?.type === 'MultiPolygon')).toBe(true);
    expect(full.places).toHaveLength(13);

    expect(scenarioStore.listScenarios()).toHaveLength(1);

    scenarioStore.deleteScenario(items[0].id);
    expect(scenarioStore.listScenarios()).toHaveLength(0);

    scenarioStore.close();
    scenarioStore = openStore(scenarioFile, { regionsFile });
    expect(scenarioStore.listScenarios()).toHaveLength(0);

    const recreated = scenarioStore.createExampleScenario();
    expect(recreated.example).toBe(true);
    expect(recreated.countries).toHaveLength(3);
    expect(scenarioStore.listScenarios()).toHaveLength(1);
  });

  test('only one scenario can be active; PATCH active:false leaves none active', () => {
    const a = scenarioStore.createScenario({ name: 'Alpha' });
    const b = scenarioStore.createScenario({ name: 'Bravo' });
    scenarioStore.updateScenario(a.id, { active: true });
    expect(scenarioStore.getScenario(a.id).active).toBe(true);

    const activatedB = scenarioStore.updateScenario(b.id, { active: true });
    expect(activatedB.active).toBe(true);
    expect(scenarioStore.getScenario(a.id).active).toBe(false);
    expect(scenarioStore.getActiveScenario().scenario.id).toBe(b.id);

    const deactivatedB = scenarioStore.updateScenario(b.id, { active: false });
    expect(deactivatedB.active).toBe(false);
    expect(scenarioStore.getActiveScenario().scenario).toBeNull();
  });

  test('deleting a scenario cascades to its countries and places', () => {
    const scenario = scenarioStore.createScenario({ name: 'Cascade test' });
    const country = scenarioStore.createCountry(scenario.id, {
      name: 'Redland',
      affiliation: 'hostile',
    });
    const place = scenarioStore.createPlace(scenario.id, {
      real_name: 'Brno',
      kind: 'city',
      lon: 16.6,
      lat: 49.2,
      name: 'Brunograd',
    });
    scenarioStore.deleteScenario(scenario.id);
    expectStatus(() => scenarioStore.updateCountry(country.id, { name: 'x' }), 404);
    expectStatus(() => scenarioStore.updatePlace(place.id, { name: 'x' }), 404);
  });

  test('a country normalizes Polygon geometry to MultiPolygon, defaults its color by affiliation, and validates regions', () => {
    const scenario = scenarioStore.createScenario({ name: 'Geo test' });
    const square = [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ];
    const country = scenarioStore.createCountry(scenario.id, {
      name: 'Redland',
      affiliation: 'hostile',
      regions: ['kraj:K0', 'kraj:K1'],
      geometry: { type: 'Polygon', coordinates: square },
    });
    expect(country.color).toBe('#ff4d4d');
    expect(country.geometry).toEqual({ type: 'MultiPolygon', coordinates: [square] });
    expect(country.regions).toEqual(['kraj:K0', 'kraj:K1']);

    expectStatus(
      () =>
        scenarioStore.createCountry(scenario.id, {
          name: 'Bad',
          affiliation: 'hostile',
          regions: ['not-a-region'],
        }),
      400,
    );
    expectStatus(
      () =>
        scenarioStore.createCountry(scenario.id, {
          name: 'Bad',
          affiliation: 'hostile',
          regions: ['kraj:K0', 'kraj:K0'],
        }),
      400,
    );
    expectStatus(
      () =>
        scenarioStore.createCountry(scenario.id, {
          name: 'Bad',
          affiliation: 'hostile',
          color: 'red',
        }),
      400,
    );
    expectStatus(
      () =>
        scenarioStore.createCountry(scenario.id, {
          name: 'Bad',
          affiliation: 'hostile',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 0],
              ],
            ],
          },
        }),
      400,
    );
  });

  test('geometry over the 2 MB limit is a 413', () => {
    const scenario = scenarioStore.createScenario({ name: 'Huge geo test' });
    const hugeRing = Array.from({ length: 250000 }, (_, i) => [
      (i % 3600) / 10 - 180,
      (i % 1800) / 10 - 90,
    ]);
    hugeRing.push(hugeRing[0]);
    expectStatus(
      () =>
        scenarioStore.createCountry(scenario.id, {
          name: 'Huge',
          affiliation: 'hostile',
          geometry: { type: 'Polygon', coordinates: [hugeRing] },
        }),
      413,
    );
  });

  test('countries are ordered by position, and PATCH can reorder them', () => {
    const scenario = scenarioStore.createScenario({ name: 'Order test' });
    const a = scenarioStore.createCountry(scenario.id, { name: 'A', affiliation: 'friendly' });
    const b = scenarioStore.createCountry(scenario.id, { name: 'B', affiliation: 'friendly' });
    expect(a.position).toBe(0);
    expect(b.position).toBe(1);
    scenarioStore.updateCountry(a.id, { position: 5 });
    expect(scenarioStore.getScenario(scenario.id).countries.map((c) => c.name)).toEqual(['B', 'A']);
  });

  test('PATCH/DELETE of a missing country or place is a 404', () => {
    expectStatus(() => scenarioStore.updateCountry(999, { name: 'x' }), 404);
    expectStatus(() => scenarioStore.deleteCountry(999), 404);
    expectStatus(() => scenarioStore.updatePlace(999, { name: 'x' }), 404);
    expectStatus(() => scenarioStore.deletePlace(999), 404);
  });

  test('a place validates its kind and its coordinates', () => {
    const scenario = scenarioStore.createScenario({ name: 'Place test' });
    expectStatus(
      () =>
        scenarioStore.createPlace(scenario.id, {
          real_name: 'Brno',
          kind: 'CITY',
          lon: 16.6,
          lat: 49.2,
          name: 'X',
        }),
      400,
    );
    expectStatus(
      () =>
        scenarioStore.createPlace(scenario.id, {
          real_name: 'Brno',
          kind: 'city',
          lon: 200,
          lat: 49.2,
          name: 'X',
        }),
      400,
    );
    expectStatus(
      () =>
        scenarioStore.createPlace(scenario.id, {
          real_name: 'Brno',
          kind: 'city',
          lon: 16.6,
          lat: 200,
          name: 'X',
        }),
      400,
    );
    const place = scenarioStore.createPlace(scenario.id, {
      real_name: 'Brno',
      kind: 'city',
      lon: 16.6,
      lat: 49.2,
      name: 'Brunograd',
    });
    const renamed = scenarioStore.updatePlace(place.id, { name: 'New name' });
    expect(renamed.name).toBe('New name');
  });

  test('duplicating a scenario copies its countries and places, inactive and independent of the original', () => {
    const scenario = scenarioStore.createScenario({ name: 'Original' });
    scenarioStore.updateScenario(scenario.id, { active: true });
    const country = scenarioStore.createCountry(scenario.id, {
      name: 'Redland',
      affiliation: 'hostile',
    });
    scenarioStore.createPlace(scenario.id, {
      real_name: 'Brno',
      kind: 'city',
      lon: 16.6,
      lat: 49.2,
      name: 'Brunograd',
    });

    const copy = scenarioStore.duplicateScenario(scenario.id);
    expect(copy.name).toBe('Original (copy)');
    expect(copy.active).toBe(false);
    expect(copy.id).not.toBe(scenario.id);
    expect(copy.countries).toHaveLength(1);
    expect(copy.places).toHaveLength(1);
    expect(copy.countries[0].id).not.toBe(country.id);
    expect(copy.countries[0].name).toBe('Redland');

    scenarioStore.updateCountry(copy.countries[0].id, { name: 'Renamed' });
    expect(scenarioStore.getScenario(scenario.id).countries[0].name).toBe('Redland');
    expect(scenarioStore.getScenario(scenario.id).active).toBe(true);
  });
});
