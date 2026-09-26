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

  test('the weather point is saved, reset to the AOI with null, and must be a lon/lat', () => {
    const { id } = store.createStudy({ name: 'Weather' });
    expect(store.readStudy(id).study.weather_point).toBeNull();
    store.updateStudy(id, { weather_point: { lon: 17.52, lat: 49.68 } });
    expect(store.readStudy(id).study.weather_point).toEqual({ lon: 17.52, lat: 49.68 });
    expectStatus(() => store.updateStudy(id, { weather_point: { lon: 17.5 } }), 400);
    expectStatus(() => store.updateStudy(id, { weather_point: { lon: 17.5, lat: 95 } }), 400);
    expectStatus(() => store.updateStudy(id, { weather_point: [17.5, 49.7] }), 400);
    store.updateStudy(id, { weather_point: null });
    expect(store.readStudy(id).study.weather_point).toBeNull();
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

describe('openStore: custom layers and points', () => {
  let file;
  let store;
  let studyId;

  beforeEach(() => {
    file = tempFile();
    store = openStore(file);
    studyId = store.createStudy({ name: 'Layers' }).id;
  });

  afterEach(() => {
    store.close();
    removeDatabaseFiles(file);
  });

  test('a point keeps its layer, name, note and position; deleting the layer deletes its points', () => {
    const layer = store.createChild('layers', studyId, { name: 'OPs' });
    expect(layer).toMatchObject({ name: 'OPs', color: '#d35400', visible: true });
    const point = store.createChild('points', studyId, {
      layer_id: layer.id,
      name: 'OP 1',
      note: 'Hill 697, overlooks the ford',
      lon: 17.506,
      lat: 49.621,
    });
    store.updateChild('points', point.id, { lon: 17.51, lat: 49.62 });
    expect(store.readStudy(studyId).points).toMatchObject([
      { layer_id: layer.id, name: 'OP 1', note: 'Hill 697, overlooks the ford', lon: 17.51 },
    ]);
    store.deleteChild('layers', layer.id);
    expect(store.readStudy(studyId).points).toEqual([]);
  });

  test('rejects a blank name, an off-globe position, a bad colour and a foreign layer', () => {
    const layer = store.createChild('layers', studyId, { name: 'Obstacles' });
    const point = { layer_id: layer.id, name: 'Ford', lon: 17.5, lat: 49.7 };
    expectStatus(() => store.createChild('layers', studyId, { name: '  ' }), 400);
    expectStatus(() => store.createChild('layers', studyId, { name: 'x', color: 'red' }), 400);
    expectStatus(() => store.createChild('points', studyId, { ...point, name: '' }), 400);
    expectStatus(() => store.createChild('points', studyId, { ...point, lat: 91 }), 400);
    expectStatus(() => store.createChild('points', studyId, { ...point, lon: '17.5' }), 400);
    const otherLayer = store.createChild('layers', store.createStudy({ name: 'Other' }).id, {
      name: 'Theirs',
    });
    expectStatus(
      () => store.createChild('points', studyId, { ...point, layer_id: otherLayer.id }),
      400,
    );
  });
});

const SIDC = '30031000001211000000'; // friendly land unit, infantry, no echelon
const LINE = {
  type: 'LineString',
  coordinates: [
    [17.4, 49.6],
    [17.5, 49.7],
  ],
};
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

describe('openStore: threats SIDC', () => {
  let file;
  let store;
  let studyId;

  beforeEach(() => {
    file = tempFile();
    store = openStore(file);
    studyId = store.createStudy({ name: 'Threats' }).id;
  });

  afterEach(() => {
    store.close();
    removeDatabaseFiles(file);
  });

  test('an unset sidc defaults from the echelon, hostile', () => {
    const threat = store.createChild('threats', studyId, { name: 'Recon coy', echelon: 'company' });
    expect(threat.sidc).toHaveLength(20);
    expect(threat.sidc[3]).toBe('6'); // hostile identity
  });

  test('an unset sidc with no or an unknown echelon still defaults, not throws', () => {
    expect(store.createChild('threats', studyId, { name: 'A' }).sidc).toHaveLength(20);
    expect(
      store.createChild('threats', studyId, { name: 'B', echelon: 'gaggle' }).sidc,
    ).toHaveLength(20);
  });

  test('an explicit sidc is normalized and a malformed one is rejected', () => {
    const spaced = store.createChild('threats', studyId, {
      name: 'C',
      sidc: '1003 1000 0012 1100 0000',
    });
    expect(spaced.sidc).toBe('10031000001211000000');
    expectStatus(() => store.createChild('threats', studyId, { name: 'D', sidc: '123' }), 400);
    expectStatus(
      () => store.createChild('threats', studyId, { name: 'D', sidc: 'x'.repeat(20) }),
      400,
    );
  });

  test('a loose orbat_unit_id and the hpt flag round-trip', () => {
    const threat = store.createChild('threats', studyId, {
      name: 'E',
      orbat_unit_id: 42,
      hpt: true,
    });
    expect(threat).toMatchObject({ orbat_unit_id: '42', hpt: true, hvt: false });
  });
});

describe('openStore: feature layers (unit, graphic, range-ring)', () => {
  let file;
  let store;
  let studyId;

  beforeEach(() => {
    file = tempFile();
    store = openStore(file);
    studyId = store.createStudy({ name: 'Features' }).id;
  });

  afterEach(() => {
    store.close();
    removeDatabaseFiles(file);
  });

  test('a unit feature requires kind symbol and a valid sidc', () => {
    const unit = store.createChild('features', studyId, {
      layer: 'unit',
      kind: 'symbol',
      geometry: POINT,
      properties: { sidc: SIDC },
    });
    expect(unit.properties.sidc).toBe(SIDC);
    expectStatus(
      () =>
        store.createChild('features', studyId, {
          layer: 'unit',
          kind: 'point',
          geometry: POINT,
          properties: { sidc: SIDC },
        }),
      400,
    );
    expectStatus(
      () =>
        store.createChild('features', studyId, {
          layer: 'unit',
          kind: 'symbol',
          geometry: POINT,
          properties: {},
        }),
      400,
    );
  });

  test('a unit feature\'s sidc is canonicalized: spaces/dashes stripped to the dense 20-digit form', () => {
    const grouped = '3003 1000-0012 1100 0000';
    const created = store.createChild('features', studyId, {
      layer: 'unit',
      kind: 'symbol',
      geometry: POINT,
      properties: { sidc: grouped },
    });
    expect(created.properties.sidc).toBe(SIDC);

    const updated = store.updateChild('features', created.id, {
      properties: { sidc: grouped },
    });
    expect(updated.properties.sidc).toBe(SIDC);
  });

  test('a graphic feature requires a known key and geometry matching its line/polygon type', () => {
    const line = store.createChild('features', studyId, {
      layer: 'graphic',
      kind: 'graphic',
      geometry: LINE,
      properties: { graphic: 'phase-line', name: 'PL COBRA' },
    });
    expect(line.properties.graphic).toBe('phase-line');
    const area = store.createChild('features', studyId, {
      layer: 'graphic',
      kind: 'graphic',
      geometry: POLYGON,
      properties: { graphic: 'engagement-area' },
    });
    expect(area.properties.graphic).toBe('engagement-area');
    expectStatus(
      () =>
        store.createChild('features', studyId, {
          layer: 'graphic',
          kind: 'graphic',
          geometry: LINE,
          properties: { graphic: 'not-a-real-graphic' },
        }),
      400,
    );
    expectStatus(
      () =>
        store.createChild('features', studyId, {
          layer: 'graphic',
          kind: 'graphic',
          geometry: POLYGON,
          properties: { graphic: 'phase-line' },
        }),
      400,
    );
  });

  test('a range-ring feature must be a Point with 1-8 ascending radii, each at most 100 km', () => {
    const rings = store.createChild('features', studyId, {
      layer: 'range-ring',
      kind: 'range-ring',
      geometry: POINT,
      properties: { radii: [500, 2000, 4000] },
    });
    expect(rings.properties.radii).toEqual([500, 2000, 4000]);
    expectStatus(
      () =>
        store.createChild('features', studyId, {
          layer: 'range-ring',
          kind: 'range-ring',
          geometry: LINE,
          properties: { radii: [500] },
        }),
      400,
    );
    expectStatus(
      () =>
        store.createChild('features', studyId, {
          layer: 'range-ring',
          kind: 'range-ring',
          geometry: POINT,
          properties: { radii: [2000, 500] }, // not ascending
        }),
      400,
    );
    expectStatus(
      () =>
        store.createChild('features', studyId, {
          layer: 'range-ring',
          kind: 'range-ring',
          geometry: POINT,
          properties: { radii: [100_001] }, // over 100 km
        }),
      400,
    );
    expectStatus(
      () =>
        store.createChild('features', studyId, {
          layer: 'range-ring',
          kind: 'range-ring',
          geometry: POINT,
          properties: { radii: Array(9).fill(1000) }, // over 8 rings
        }),
      400,
    );
  });

  test('properties.coa_id must name a COA in the same study, on create and update', () => {
    const coa = store.createChild('coas', studyId, { name: 'MLCOA', kind: 'most-likely' });
    const feature = store.createChild('features', studyId, {
      layer: 'aoi',
      kind: 'polygon',
      geometry: POLYGON,
      properties: { coa_id: coa.id },
    });
    expect(feature.properties.coa_id).toBe(coa.id);

    const otherStudyId = store.createStudy({ name: 'Other' }).id;
    const foreignCoa = store.createChild('coas', otherStudyId, {
      name: 'Theirs',
      kind: 'most-likely',
    });
    expectStatus(
      () =>
        store.createChild('features', studyId, {
          layer: 'aoi',
          kind: 'polygon',
          geometry: POLYGON,
          properties: { coa_id: foreignCoa.id },
        }),
      400,
    );
    expectStatus(
      () => store.updateChild('features', feature.id, { properties: { coa_id: foreignCoa.id } }),
      400,
    );
  });

  test('a "unit"/"graphic"/"range-ring" check also applies on update, against the merged row', () => {
    const unit = store.createChild('features', studyId, {
      layer: 'unit',
      kind: 'symbol',
      geometry: POINT,
      properties: { sidc: SIDC },
    });
    // Switching the layer away from unit without a valid sidc must still pass
    // (the rule is layer-specific); switching kind away from symbol must fail.
    expectStatus(() => store.updateChild('features', unit.id, { kind: 'point' }), 400);
    const moved = store.updateChild('features', unit.id, { layer: 'note', kind: 'point' });
    expect(moved.layer).toBe('note');
  });
});

describe('openStore: event time fields (C6)', () => {
  let file;
  let store;
  let studyId;
  let coaId;

  beforeEach(() => {
    file = tempFile();
    store = openStore(file);
    studyId = store.createStudy({ name: 'Events' }).id;
    coaId = store.createChild('coas', studyId, { name: 'MLCOA', kind: 'most-likely' }).id;
  });

  afterEach(() => {
    store.close();
    removeDatabaseFiles(file);
  });

  test('expected_at and expected_offset are mutually exclusive, on create and update', () => {
    expectStatus(
      () =>
        store.createChild('events', studyId, {
          coa_id: coaId,
          indicator: 'x',
          expected_at: '2026-09-25T14:30:00.000Z',
          expected_offset: 30,
        }),
      400,
    );
    const event = store.createChild('events', studyId, {
      coa_id: coaId,
      indicator: 'x',
      expected_offset: 30,
    });
    expectStatus(
      () => store.updateChild('events', event.id, { expected_at: '2026-09-25T14:30:00.000Z' }),
      400,
    );
  });

  test('expected_time is a clean cutover: no longer a known field', () => {
    expectStatus(
      () =>
        store.createChild('events', studyId, {
          coa_id: coaId,
          indicator: 'x',
          expected_time: '251430ZSEP26',
        }),
      400,
    );
    const event = store.createChild('events', studyId, { coa_id: coaId, indicator: 'x' });
    expectStatus(() => store.updateChild('events', event.id, { expected_time: 'H-hour' }), 400);
  });

  test('tai_feature_id and decision_point_id are validated like any other reference', () => {
    expectStatus(
      () =>
        store.createChild('events', studyId, {
          coa_id: coaId,
          indicator: 'x',
          tai_feature_id: 999999,
        }),
      400,
    );
    expectStatus(
      () =>
        store.createChild('events', studyId, {
          coa_id: coaId,
          indicator: 'x',
          decision_point_id: 999999,
        }),
      400,
    );
  });
});

describe('openStore: phases', () => {
  let file;
  let store;
  let studyId;

  beforeEach(() => {
    file = tempFile();
    store = openStore(file);
    studyId = store.createStudy({ name: 'Phases' }).id;
  });

  afterEach(() => {
    store.close();
    removeDatabaseFiles(file);
  });

  test('phases hold minute offsets from H-hour, ordered, end optional', () => {
    const prep = store.createChild('phases', studyId, { name: 'Prep', start_offset: -120 });
    const assault = store.createChild('phases', studyId, {
      name: 'Assault',
      start_offset: 0,
      end_offset: 240,
    });
    expect(prep.end_offset).toBeNull();
    expect(assault.ordinal).toBe(prep.ordinal + 1);
    expectStatus(
      () => store.createChild('phases', studyId, { name: 'Bad', start_offset: 1.5 }),
      400,
    );
  });
});

describe('openStore: decision points', () => {
  let file;
  let store;
  let studyId;

  beforeEach(() => {
    file = tempFile();
    store = openStore(file);
    studyId = store.createStudy({ name: 'DPs' }).id;
  });

  afterEach(() => {
    store.close();
    removeDatabaseFiles(file);
  });

  test('earliest/latest are each an at-or-offset pair, not both', () => {
    expectStatus(
      () =>
        store.createChild('decision-points', studyId, {
          name: 'DP1',
          earliest_at: '2026-09-25T00:00:00.000Z',
          earliest_offset: 10,
        }),
      400,
    );
    const dp = store.createChild('decision-points', studyId, {
      name: 'DP1',
      latest_offset: 60,
    });
    expectStatus(
      () => store.updateChild('decision-points', dp.id, { latest_at: '2026-09-25T00:00:00.000Z' }),
      400,
    );
  });

  test('coa_id/nai_feature_id/tai_feature_id are optional but validated against the study', () => {
    const dp = store.createChild('decision-points', studyId, { name: 'DP1' });
    expect(dp.coa_id).toBeNull();
    const otherStudyId = store.createStudy({ name: 'Other' }).id;
    const foreignCoa = store.createChild('coas', otherStudyId, {
      name: 'Theirs',
      kind: 'most-likely',
    });
    expectStatus(
      () => store.createChild('decision-points', studyId, { name: 'DP2', coa_id: foreignCoa.id }),
      400,
    );
  });

  test('decision points support the ordinal children pattern (list, reorder)', () => {
    const a = store.createChild('decision-points', studyId, { name: 'A' });
    store.createChild('decision-points', studyId, { name: 'B' });
    const reordered = store.reorderChild('decision-points', a.id, 'down');
    expect(reordered.items.map((row) => row.name)).toEqual(['B', 'A']);
  });
});

describe('openStore: civil considerations (ASCOPE x PMESII-PT)', () => {
  let file;
  let store;
  let studyId;

  beforeEach(() => {
    file = tempFile();
    store = openStore(file);
    studyId = store.createStudy({ name: 'Civil' }).id;
  });

  afterEach(() => {
    store.close();
    removeDatabaseFiles(file);
  });

  test('POSTing the same (ascope, pmesii) upserts one cell instead of creating a second', () => {
    const first = store.createChild('civil-considerations', studyId, {
      ascope: 'areas',
      pmesii: 'military',
      text: 'Border crossing under threat control',
    });
    const second = store.createChild('civil-considerations', studyId, {
      ascope: 'areas',
      pmesii: 'military',
      text: 'Updated assessment',
    });
    expect(second.id).toBe(first.id);
    expect(second.text).toBe('Updated assessment');
    expect(store.readStudy(studyId).civil_considerations).toHaveLength(1);
  });

  test('rejects an unknown ascope or pmesii value', () => {
    expectStatus(
      () =>
        store.createChild('civil-considerations', studyId, {
          ascope: 'weather',
          pmesii: 'military',
        }),
      400,
    );
    expectStatus(
      () =>
        store.createChild('civil-considerations', studyId, { ascope: 'areas', pmesii: 'cyber' }),
      400,
    );
  });

  test('distinct cells for the same study coexist', () => {
    store.createChild('civil-considerations', studyId, { ascope: 'areas', pmesii: 'military' });
    store.createChild('civil-considerations', studyId, { ascope: 'people', pmesii: 'social' });
    expect(store.readStudy(studyId).civil_considerations).toHaveLength(2);
  });
});

describe('openStore: bulk feature import', () => {
  let file;
  let store;
  let studyId;

  beforeEach(() => {
    file = tempFile();
    store = openStore(file);
    studyId = store.createStudy({ name: 'Bulk' }).id;
  });

  afterEach(() => {
    store.close();
    removeDatabaseFiles(file);
  });

  test('inserts every valid feature in one call', () => {
    const result = store.bulkCreateFeatures(studyId, [
      { layer: 'aoi', kind: 'polygon', geometry: POLYGON },
      { layer: 'note', kind: 'point', geometry: POINT, label: 'OP 1' },
    ]);
    expect(result.items).toHaveLength(2);
    expect(store.readStudy(studyId).features).toHaveLength(2);
  });

  test('one invalid feature rolls back the whole batch (all or nothing)', () => {
    expectStatus(
      () =>
        store.bulkCreateFeatures(studyId, [
          { layer: 'aoi', kind: 'polygon', geometry: POLYGON },
          { layer: 'unit', kind: 'symbol', geometry: POINT, properties: {} }, // missing sidc
        ]),
      400,
    );
    expect(store.readStudy(studyId).features).toHaveLength(0);
  });

  test('rejects an empty array and more than 2000 features', () => {
    expectStatus(() => store.bulkCreateFeatures(studyId, []), 400);
    const many = Array.from({ length: 2001 }, () => ({
      layer: 'aoi',
      kind: 'point',
      geometry: POINT,
    }));
    expectStatus(() => store.bulkCreateFeatures(studyId, many), 400);
  });
});

describe('openStore: study H-hour, classification and weather thresholds', () => {
  let file;
  let store;
  let studyId;

  beforeEach(() => {
    file = tempFile();
    store = openStore(file);
    studyId = store.createStudy({ name: 'Study fields' }).id;
  });

  afterEach(() => {
    store.close();
    removeDatabaseFiles(file);
  });

  test('classification defaults, and all three fields round-trip through PATCH', () => {
    const study = store.readStudy(studyId).study;
    expect(study.classification).toBe('UNCLASSIFIED // EXERCISE');
    expect(study.h_hour).toBeNull();
    expect(study.weather_thresholds).toBeNull();
    const updated = store.updateStudy(studyId, {
      h_hour: '2026-09-25T05:00:00.000Z',
      classification: 'SECRET // EXERCISE // REL NATO',
      weather_thresholds: { wind_kt: 25 },
    });
    expect(updated.h_hour).toBe('2026-09-25T05:00:00.000Z');
    expect(updated.classification).toBe('SECRET // EXERCISE // REL NATO');
    expect(updated.weather_thresholds).toEqual({ wind_kt: 25 });
    const cleared = store.updateStudy(studyId, { h_hour: null, weather_thresholds: null });
    expect(cleared.h_hour).toBeNull();
    expect(cleared.weather_thresholds).toBeNull();
  });

  test('rejects a malformed h_hour', () => {
    expectStatus(() => store.updateStudy(studyId, { h_hour: 'not a date' }), 400);
  });
});

describe('openStore: cells (C2/C3 phase 1 access)', () => {
  let file;
  let store;

  const WHITE = { admin: false, cell: 'white', role: 'game-master' };
  const BLUE = { admin: false, cell: 'blue', role: 'analyst' };
  const BLUE_OBSERVER = { admin: false, cell: 'blue', role: 'observer' };
  const RED = { admin: false, cell: 'red', role: 'analyst' };
  const ADMIN = { admin: true, cell: null, role: null };

  beforeEach(() => {
    file = tempFile();
    store = openStore(file);
  });

  afterEach(() => {
    store.close();
    removeDatabaseFiles(file);
  });

  test('a study defaults to the creator cell; White may choose any cell', () => {
    const blueStudy = store.createStudy({ name: 'Blue study' }, BLUE);
    expect(blueStudy.owner_cell).toBe('blue');
    expect(blueStudy.releasable_to).toEqual([]);

    const whiteChosen = store.createStudy({ name: 'Red study', owner_cell: 'red' }, WHITE);
    expect(whiteChosen.owner_cell).toBe('red');

    const whiteDefault = store.createStudy({ name: 'White study' }, WHITE);
    expect(whiteDefault.owner_cell).toBe('white');
  });

  test('a non-White user cannot create a study for another cell', () => {
    expectStatus(() => store.createStudy({ name: 'x', owner_cell: 'red' }, BLUE), 400);
  });

  test('a user with no cell cannot create a study', () => {
    expectStatus(
      () => store.createStudy({ name: 'x' }, { admin: false, cell: null, role: null }),
      403,
    );
  });

  test('list only returns visible studies: own cell, released, or White/admin sees all', () => {
    store.createStudy({ name: 'Blue A' }, BLUE);
    const redStudy = store.createStudy({ name: 'Red A' }, RED);
    store.createStudy({ name: 'White A' }, WHITE);

    expect(store.listStudies(BLUE).items.map((s) => s.name)).toEqual(['Blue A']);
    expect(store.listStudies(RED).items.map((s) => s.name)).toEqual(['Red A']);
    expect(store.listStudies(WHITE).items.map((s) => s.name).sort()).toEqual([
      'Blue A',
      'Red A',
      'White A',
    ]);
    expect(store.listStudies(ADMIN).items).toHaveLength(3);

    store.releaseStudy(redStudy.id, ['blue'], RED);
    expect(store.listStudies(BLUE).items.map((s) => s.name).sort()).toEqual(['Blue A', 'Red A']);
  });

  test('Blue cannot reach a Red study or any of its children via ANY route: 404, not 403', () => {
    const redStudy = store.createStudy({ name: 'Red study' }, RED);
    const coa = store.createChild('coas', redStudy.id, { name: 'MLCOA', kind: 'most-likely' }, RED);
    const threat = store.createChild('threats', redStudy.id, { name: 'Tank co' }, RED);
    const event = store.createChild(
      'events',
      redStudy.id,
      { coa_id: coa.id, indicator: 'x' },
      RED,
    );
    const layer = store.createChild('layers', redStudy.id, { name: 'L1' }, RED);
    const point = store.createChild(
      'points',
      redStudy.id,
      { layer_id: layer.id, name: 'P1', lon: 1, lat: 1 },
      RED,
    );
    const phase = store.createChild(
      'phases',
      redStudy.id,
      { name: 'Prep', start_offset: 0 },
      RED,
    );
    const analysis = store.createChild(
      'analyses',
      redStudy.id,
      { kind: 'mobility', params: {}, summary: {} },
      RED,
    );
    store.createChild(
      'civil-considerations',
      redStudy.id,
      { ascope: 'areas', pmesii: 'political', text: 'x' },
      RED,
    );

    expectStatus(() => store.readStudy(redStudy.id, BLUE), 404);
    expectStatus(() => store.updateStudy(redStudy.id, { name: 'y' }, BLUE), 404);
    expectStatus(() => store.deleteStudy(redStudy.id, BLUE), 404);
    expectStatus(() => store.exportGeoJson(redStudy.id, BLUE), 404);
    expectStatus(() => store.exportKml(redStudy.id, BLUE), 404);
    expectStatus(
      () => store.createChild('coas', redStudy.id, { name: 'x', kind: 'most-likely' }, BLUE),
      404,
    );
    expectStatus(
      () =>
        store.bulkCreateFeatures(
          redStudy.id,
          [{ layer: 'note', kind: 'point', geometry: POINT }],
          BLUE,
        ),
      404,
    );
    for (const [kind, id] of [
      ['coas', coa.id],
      ['threats', threat.id],
      ['events', event.id],
      ['layers', layer.id],
      ['points', point.id],
      ['phases', phase.id],
      ['analyses', analysis.id],
    ]) {
      expectStatus(() => store.updateChild(kind, id, { name: 'y' }, BLUE), 404);
      expectStatus(() => store.deleteChild(kind, id, BLUE), 404);
    }
    expectStatus(() => store.reorderChild('threats', threat.id, 'up', BLUE), 404);
    expectStatus(() => store.releaseStudy(redStudy.id, ['blue'], BLUE), 404);
    expectStatus(() => store.reassignStudy(redStudy.id, 'blue', BLUE), 404);
  });

  test('once released to Blue, Blue can see the study, but release grants read only, not edit (C2b)', () => {
    const redStudy = store.createStudy({ name: 'Red study' }, RED);
    store.releaseStudy(redStudy.id, ['blue'], RED);
    expect(store.readStudy(redStudy.id, BLUE).study.releasable_to).toEqual(['blue']);
    expectStatus(
      () => store.createChild('coas', redStudy.id, { name: 'seen', kind: 'most-likely' }, BLUE),
      403,
    );
  });

  test('an observer released cell can read but any write still 404s only when invisible (visibility != role)', () => {
    const redStudy = store.createStudy({ name: 'Red study' }, RED);
    store.releaseStudy(redStudy.id, ['blue'], RED);
    // Visible to blue observer: read succeeds regardless of role (role gating is the API layer's job).
    expect(store.readStudy(redStudy.id, BLUE_OBSERVER).study.id).toBe(redStudy.id);
  });

  test('release: a non-owner, non-White user gets 403; the owner cell analyst or White succeeds', () => {
    const blueStudy = store.createStudy({ name: 'Blue study' }, BLUE);
    expectStatus(() => store.releaseStudy(blueStudy.id, ['red'], RED), 404); // invisible to red
    const visibleToRed = store.createStudy({ name: 'Blue2' }, BLUE);
    store.releaseStudy(visibleToRed.id, ['red'], BLUE); // blue releases to red so red can see it
    expectStatus(() => store.releaseStudy(visibleToRed.id, ['white'], RED), 403); // red isn't owner
    const released = store.releaseStudy(blueStudy.id, ['red'], WHITE);
    expect(released.releasable_to).toEqual(['red']);
  });

  test('release requires analyst or above within the owning cell', () => {
    const blueStudy = store.createStudy({ name: 'Blue study' }, BLUE);
    expectStatus(
      () => store.releaseStudy(blueStudy.id, ['red'], BLUE_OBSERVER),
      403,
    );
  });

  test('release replaces (not merges) releasable_to, and never includes the owner', () => {
    const blueStudy = store.createStudy({ name: 'Blue study' }, BLUE);
    store.releaseStudy(blueStudy.id, ['red'], BLUE);
    const second = store.releaseStudy(blueStudy.id, ['white', 'blue'], BLUE);
    expect(second.releasable_to).toEqual(['white']); // blue (the owner) dropped; red un-released
  });

  test('reassign: White-only; a non-White user, even the owner, gets 403', () => {
    const blueStudy = store.createStudy({ name: 'Blue study' }, BLUE);
    expectStatus(() => store.reassignStudy(blueStudy.id, 'red', BLUE), 403);
    const reassigned = store.reassignStudy(blueStudy.id, 'red', WHITE);
    expect(reassigned.owner_cell).toBe('red');
  });

  test('reassign strips the new owner from releasable_to', () => {
    const blueStudy = store.createStudy({ name: 'Blue study' }, BLUE);
    store.releaseStudy(blueStudy.id, ['red'], BLUE);
    const reassigned = store.reassignStudy(blueStudy.id, 'red', WHITE);
    expect(reassigned.owner_cell).toBe('red');
    expect(reassigned.releasable_to).toEqual([]);
  });

  test('an unknown cell is rejected on create, release and reassign', () => {
    expectStatus(() => store.createStudy({ name: 'x', owner_cell: 'green' }, WHITE), 400);
    const study = store.createStudy({ name: 'y' }, WHITE);
    expectStatus(() => store.releaseStudy(study.id, ['green'], WHITE), 400);
    expectStatus(() => store.reassignStudy(study.id, 'green', WHITE), 400);
  });
});

describe('openStore: C2b — release grants read access only, never edit', () => {
  let file;
  let store;

  const WHITE = { admin: false, cell: 'white', role: 'game-master' };
  const BLUE = { admin: false, cell: 'blue', role: 'analyst' };
  const RED = { admin: false, cell: 'red', role: 'analyst' };

  beforeEach(() => {
    file = tempFile();
    store = openStore(file);
  });

  afterEach(() => {
    store.close();
    removeDatabaseFiles(file);
  });

  /** A Red study released to Blue, with one of every child kind and an
   * analysis, all owned by Red. */
  function redStudyReleasedToBlue() {
    const study = store.createStudy({ name: 'Red study' }, RED);
    const coa = store.createChild('coas', study.id, { name: 'MLCOA', kind: 'most-likely' }, RED);
    const threat = store.createChild('threats', study.id, { name: 'Tank co' }, RED);
    const event = store.createChild(
      'events',
      study.id,
      { coa_id: coa.id, indicator: 'x' },
      RED,
    );
    const layer = store.createChild('layers', study.id, { name: 'L1' }, RED);
    const point = store.createChild(
      'points',
      study.id,
      { layer_id: layer.id, name: 'P1', lon: 1, lat: 1 },
      RED,
    );
    const phase = store.createChild('phases', study.id, { name: 'Prep', start_offset: 0 }, RED);
    const analysis = store.createChild(
      'analyses',
      study.id,
      { kind: 'mobility', params: {}, summary: {} },
      RED,
    );
    store.releaseStudy(study.id, ['blue'], RED);
    return { study, coa, threat, event, layer, point, phase, analysis };
  }

  test('Blue gets 403 (not 404) on every mutation of a Red study released to Blue', () => {
    const { study, coa, threat, event, layer, point, phase, analysis } = redStudyReleasedToBlue();

    expectStatus(() => store.updateStudy(study.id, { name: 'y' }, BLUE), 403);
    expectStatus(() => store.deleteStudy(study.id, BLUE), 403);
    expectStatus(
      () => store.createChild('coas', study.id, { name: 'x', kind: 'most-likely' }, BLUE),
      403,
    );
    expectStatus(
      () =>
        store.bulkCreateFeatures(
          study.id,
          [{ layer: 'note', kind: 'point', geometry: POINT }],
          BLUE,
        ),
      403,
    );
    for (const [kind, id] of [
      ['coas', coa.id],
      ['threats', threat.id],
      ['events', event.id],
      ['layers', layer.id],
      ['points', point.id],
      ['phases', phase.id],
      ['analyses', analysis.id],
    ]) {
      expectStatus(() => store.updateChild(kind, id, { name: 'y' }, BLUE), 403);
      expectStatus(() => store.deleteChild(kind, id, BLUE), 403);
    }
    expectStatus(() => store.reorderChild('threats', threat.id, 'up', BLUE), 403);
  });

  test('Blue still gets 404 (not 403) when the study is not released at all', () => {
    const study = store.createStudy({ name: 'Red study' }, RED);
    const coa = store.createChild('coas', study.id, { name: 'MLCOA', kind: 'most-likely' }, RED);
    expectStatus(() => store.updateStudy(study.id, { name: 'y' }, BLUE), 404);
    expectStatus(() => store.updateChild('coas', coa.id, { name: 'y' }, BLUE), 404);
  });

  test('the owner cell can still fully edit its own study once released elsewhere', () => {
    const { study } = redStudyReleasedToBlue();
    const updated = store.updateStudy(study.id, { name: 'Renamed by owner' }, RED);
    expect(updated.name).toBe('Renamed by owner');
  });

  test('White can edit any released study, same as the owner', () => {
    const { study } = redStudyReleasedToBlue();
    const updated = store.updateStudy(study.id, { name: 'Renamed by White' }, WHITE);
    expect(updated.name).toBe('Renamed by White');
  });

  test('reads (GET, export) still work for the released cell: release is read access', () => {
    const { study } = redStudyReleasedToBlue();
    expect(store.readStudy(study.id, BLUE).study.id).toBe(study.id);
    expect(() => store.exportGeoJson(study.id, BLUE)).not.toThrow();
    expect(() => store.exportKml(study.id, BLUE)).not.toThrow();
  });
});
