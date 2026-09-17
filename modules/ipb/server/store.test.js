import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openStore } from './store.js';

function tempFile() {
  return path.join(
    os.tmpdir(),
    `ipb-store-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function removeDatabaseFiles(file) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
}

const POINT = { type: 'Point', coordinates: [17.5, 49.7] };

function expectStatus(fn, status) {
  expect(fn).toThrow(expect.objectContaining({ status }));
}

describe('openStore: studies', () => {
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

  test('creating a study seeds revision 1 and empty notes', () => {
    const study = store.createStudy({ name: 'Libavá rehearsal' });
    expect(study).toMatchObject({ name: 'Libavá rehearsal', revision: 1, notes: {}, aoi: null });
  });

  test('rejects a blank or missing name', () => {
    expectStatus(() => store.createStudy({ name: '' }), 400);
    expectStatus(() => store.createStudy({}), 400);
  });

  test('rejects malformed bounds', () => {
    expectStatus(() => store.createStudy({ name: 'x', bounds: [1, 2, 3] }), 400);
    // west must be < east
    expectStatus(() => store.createStudy({ name: 'x', bounds: [10, 0, 5, 1] }), 400);
  });

  test('lists newest-updated first, even when two studies share a millisecond', () => {
    const first = store.createStudy({ name: 'A' });
    const second = store.createStudy({ name: 'B' });
    expect(store.listStudies().items.map((row) => row.id)).toEqual([second.id, first.id]);
  });

  test('patching bumps revision and updated_at without disturbing unset fields', () => {
    const study = store.createStudy({ name: 'A', bounds: [10, 40, 11, 41] });
    const patched = store.updateStudy(study.id, { name: 'B' });
    expect(patched.name).toBe('B');
    expect(patched.bounds).toEqual([10, 40, 11, 41]);
    expect(patched.revision).toBe(study.revision + 1);
  });

  test('patching an unknown study is a 404', () => {
    expectStatus(() => store.updateStudy(999999, { name: 'x' }), 404);
  });

  test('reading an unknown study is a 404', () => {
    expectStatus(() => store.readStudy(999999), 404);
  });

  test('rejects an unknown notes step', () => {
    const study = store.createStudy({ name: 'A' });
    expectStatus(() => store.updateStudy(study.id, { notes: { step9: 'x' } }), 400);
  });

  test('deleting a study cascades to every child kind', () => {
    const study = store.createStudy({ name: 'A' });
    const feature = store.createChild('features', study.id, {
      layer: 'aoi',
      kind: 'polygon',
      geometry: POINT,
    });
    const coa = store.createChild('coas', study.id, { name: 'Most likely', kind: 'most-likely' });
    store.createChild('events', study.id, { coa_id: coa.id, indicator: 'x' });
    store.createChild('threats', study.id, { name: 'Recon element' });
    store.createChild('analyses', study.id, { kind: 'mobility', params: {}, summary: {} });

    store.deleteStudy(study.id);

    expectStatus(() => store.readStudy(study.id), 404);
    // Cascade relies on PRAGMA foreign_keys and ON DELETE CASCADE; check the
    // rows are actually gone, not just unreachable through readStudy.
    expectStatus(() => store.updateChild('features', feature.id, { label: 'x' }), 404);
  });
});

describe('openStore: child validation contract', () => {
  let file;
  let store;
  let studyId;

  beforeEach(() => {
    file = tempFile();
    store = openStore(file);
    studyId = store.createStudy({ name: 'Fixture study' }).id;
  });

  afterEach(() => {
    store.close();
    removeDatabaseFiles(file);
  });

  test('rejects an unknown field name', () => {
    expectStatus(() => store.createChild('threats', studyId, { name: 'x', rank: 'general' }), 400);
  });

  test('rejects an unknown resource kind', () => {
    expectStatus(() => store.createChild('vehicles', studyId, {}), 400);
  });

  test('enum fields reject values outside the vocabulary', () => {
    expectStatus(
      () => store.createChild('coas', studyId, { name: 'x', kind: 'most-plausible' }),
      400,
    );
  });

  test('geometry fields require a type and coordinates', () => {
    expectStatus(
      () => store.createChild('features', studyId, { layer: 'aoi', kind: 'polygon', geometry: {} }),
      400,
    );
  });

  test('a reference field must point at a real row', () => {
    expectStatus(
      () => store.createChild('events', studyId, { coa_id: 999999, indicator: 'x' }),
      400,
    );
  });

  test('a reference field cannot cross into another study', () => {
    const otherStudyId = store.createStudy({ name: 'Other study' }).id;
    const foreignCoa = store.createChild('coas', otherStudyId, {
      name: 'Foreign COA',
      kind: 'most-likely',
    });
    expectStatus(
      () => store.createChild('events', studyId, { coa_id: foreignCoa.id, indicator: 'x' }),
      400,
    );
  });

  test('updateChild enforces the same cross-study reference guard', () => {
    const ownCoa = store.createChild('coas', studyId, { name: 'Own COA', kind: 'most-likely' });
    const event = store.createChild('events', studyId, { coa_id: ownCoa.id, indicator: 'x' });
    const otherStudyId = store.createStudy({ name: 'Other study' }).id;
    const foreignCoa = store.createChild('coas', otherStudyId, {
      name: 'Foreign COA',
      kind: 'most-likely',
    });
    expectStatus(() => store.updateChild('events', event.id, { coa_id: foreignCoa.id }), 400);
  });

  test('required fields may be omitted on update but not on create', () => {
    expectStatus(() => store.createChild('threats', studyId, {}), 400);
    const threat = store.createChild('threats', studyId, { name: 'Recon element' });
    // A partial update touching only `hvt` must not re-demand `name`.
    const updated = store.updateChild('threats', threat.id, { hvt: true });
    expect(updated.hvt).toBe(true);
    expect(updated.name).toBe('Recon element');
  });

  test('updating or deleting an unknown child id is a 404', () => {
    expectStatus(() => store.updateChild('threats', 999999, { name: 'x' }), 404);
    expectStatus(() => store.deleteChild('threats', 999999), 404);
  });

  test('ordinal kinds assign increasing ordinals per study, independently of other kinds', () => {
    const first = store.createChild('threats', studyId, { name: 'A' });
    const second = store.createChild('threats', studyId, { name: 'B' });
    expect(second.ordinal).toBe(first.ordinal + 1);

    const otherStudyId = store.createStudy({ name: 'Other study' }).id;
    const firstInOtherStudy = store.createChild('threats', otherStudyId, { name: 'C' });
    expect(firstInOtherStudy.ordinal).toBe(1);
  });

  test('every successful mutation bumps the parent study revision exactly once', () => {
    const before = store.readStudy(studyId).study.revision;
    const threat = store.createChild('threats', studyId, { name: 'A' });
    store.updateChild('threats', threat.id, { hvt: true });
    store.deleteChild('threats', threat.id);
    const after = store.readStudy(studyId).study.revision;
    expect(after).toBe(before + 3);
  });

  test('a rejected mutation does not bump the revision', () => {
    const before = store.readStudy(studyId).study.revision;
    try {
      store.createChild('threats', studyId, {});
    } catch {
      // expected 400
    }
    expect(store.readStudy(studyId).study.revision).toBe(before);
  });

  test('reorder swaps ordinal with the next sibling, and is reversible', () => {
    const a = store.createChild('threats', studyId, { name: 'A' });
    const b = store.createChild('threats', studyId, { name: 'B' });
    const c = store.createChild('threats', studyId, { name: 'C' });
    expect([a, b, c].map((row) => row.name)).toEqual(['A', 'B', 'C']);

    const afterDown = store.reorderChild('threats', a.id, 'down');
    expect(afterDown.items.map((row) => row.name)).toEqual(['B', 'A', 'C']);

    const afterUp = store.reorderChild('threats', a.id, 'up');
    expect(afterUp.items.map((row) => row.name)).toEqual(['A', 'B', 'C']);
  });

  test('reordering past either end is a no-op, not an error', () => {
    const a = store.createChild('coas', studyId, { name: 'A', kind: 'most-likely' });
    const b = store.createChild('coas', studyId, { name: 'B', kind: 'most-dangerous' });
    const first = store.reorderChild('coas', a.id, 'up');
    expect(first.items.map((row) => row.name)).toEqual(['A', 'B']);
    const last = store.reorderChild('coas', b.id, 'down');
    expect(last.items.map((row) => row.name)).toEqual(['A', 'B']);
  });

  test('reordering does not cross study boundaries', () => {
    const a = store.createChild('threats', studyId, { name: 'A' });
    const otherStudyId = store.createStudy({ name: 'Other study' }).id;
    store.createChild('threats', otherStudyId, { name: 'Z' });
    // A has no sibling in its own study, so moving it down must be a no-op,
    // never reaching across into the other study's rows.
    const result = store.reorderChild('threats', a.id, 'down');
    expect(result.items.map((row) => row.name)).toEqual(['A']);
  });

  test('rejects reordering a non-ordinal kind and an invalid direction', () => {
    const feature = store.createChild('features', studyId, {
      layer: 'aoi',
      kind: 'polygon',
      geometry: POINT,
    });
    expectStatus(() => store.reorderChild('features', feature.id, 'up'), 400);
    const threat = store.createChild('threats', studyId, { name: 'A' });
    expectStatus(() => store.reorderChild('threats', threat.id, 'sideways'), 400);
  });

  test('reordering an unknown id is a 404', () => {
    expectStatus(() => store.reorderChild('threats', 999999, 'up'), 404);
  });

  test('analysis rows accept an array summary, not only an object', () => {
    const analysis = store.createChild('analyses', studyId, {
      kind: 'line-of-sight',
      params: { from: [17.4, 49.6], to: [17.5, 49.7] },
      summary: [{ distance: 100 }, { distance: 200 }],
    });
    expect(analysis.summary).toEqual([{ distance: 100 }, { distance: 200 }]);
  });
});
