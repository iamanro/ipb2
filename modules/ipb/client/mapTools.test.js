import { describe, expect, test } from 'vitest';

import { TACTICAL_GRAPHICS } from '../../../src/tactical.js';
import {
  AFFILIATIONS,
  ECHELON_NAMES,
  GRAPHIC_GROUPS,
  defaultAffiliationFor,
  formatMeasureReadout,
  parseRadiiInput,
  rangeRingsFromEntries,
} from './mapTools.js';

describe('GRAPHIC_GROUPS', () => {
  test('covers every TACTICAL_GRAPHICS key exactly once', () => {
    const grouped = GRAPHIC_GROUPS.flatMap((group) => group.keys);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(grouped.sort()).toEqual(Object.keys(TACTICAL_GRAPHICS).sort());
  });

  test('groups match the assignment: control measures, areas, obstacles', () => {
    expect(GRAPHIC_GROUPS.map((group) => group.label)).toEqual([
      'Control measures',
      'Areas',
      'Obstacles',
    ]);
    expect(GRAPHIC_GROUPS[0].keys).toEqual([
      'phase-line',
      'boundary',
      'axis-of-advance',
      'direction-of-attack',
    ]);
    expect(GRAPHIC_GROUPS[1].keys).toEqual([
      'objective',
      'assembly-area',
      'battle-position',
      'engagement-area',
    ]);
    expect(GRAPHIC_GROUPS[2].keys).toEqual([
      'minefield',
      'obstacle-line',
      'block',
      'fix',
      'turn',
      'disrupt',
    ]);
  });
});

describe('ECHELON_NAMES / AFFILIATIONS', () => {
  test('eleven echelons, smallest first, matching src/symbols/sidc.js amplifier keys', () => {
    expect(ECHELON_NAMES).toEqual([
      'team',
      'squad',
      'section',
      'platoon',
      'company',
      'battalion',
      'regiment',
      'brigade',
      'division',
      'corps',
      'army',
    ]);
  });

  test('affiliations match APP-6(D)', () => {
    expect(AFFILIATIONS).toEqual(['friendly', 'hostile', 'neutral', 'unknown', 'none']);
  });
});

describe('defaultAffiliationFor', () => {
  test('hostile inside a selected COA, friendly otherwise', () => {
    expect(defaultAffiliationFor(42)).toBe('hostile');
    expect(defaultAffiliationFor(null)).toBe('friendly');
    expect(defaultAffiliationFor(undefined)).toBe('friendly');
  });
});

describe('parseRadiiInput', () => {
  test('bare numbers default to km', () => {
    expect(parseRadiiInput('2, 5')).toEqual({ radii: [2000, 5000] });
  });

  test('mixed km/m units', () => {
    expect(parseRadiiInput('2km, 750m')).toEqual({ radii: [750, 2000] });
  });

  test('sorts ascending regardless of input order', () => {
    expect(parseRadiiInput('8km, 2km, 5km')).toEqual({ radii: [2000, 5000, 8000] });
  });

  test('rejects an empty list', () => {
    expect(parseRadiiInput('')).toEqual({ error: expect.any(String) });
    expect(parseRadiiInput('   ')).toEqual({ error: expect.any(String) });
  });

  test('rejects an unreadable token', () => {
    expect(parseRadiiInput('two km')).toEqual({ error: expect.stringContaining('two km') });
  });

  test('rejects a non-positive radius', () => {
    expect(parseRadiiInput('0km')).toEqual({ error: expect.any(String) });
    expect(parseRadiiInput('-2km')).toEqual({ error: expect.any(String) });
  });

  test('rejects duplicate radii', () => {
    expect(parseRadiiInput('2km, 2000m')).toEqual({ error: expect.stringContaining('distinct') });
  });

  test('rejects more than 8 radii', () => {
    const nine = Array.from({ length: 9 }, (_, index) => `${index + 1}km`).join(', ');
    expect(parseRadiiInput(nine)).toEqual({ error: expect.stringContaining('8') });
  });

  test('rejects a radius over 100 km, matching the server limit', () => {
    expect(parseRadiiInput('150km')).toEqual({ error: expect.stringContaining('100') });
  });
});

describe('rangeRingsFromEntries', () => {
  test('prefers max_m, falls back to min_m, ascending and labelled', () => {
    const { radii, ringLabels } = rangeRingsFromEntries(
      [
        { kind: 'effective', min_m: 500, max_m: 3000 },
        { kind: 'maximum', min_m: 1000, max_m: 5000 },
        { kind: 'sight', min_m: 800 }, // no max_m: falls back to min_m
      ],
      '2A46M',
    );
    expect(radii).toEqual([800, 3000, 5000]);
    expect(ringLabels).toEqual(['2A46M sight 0.8 km', '2A46M eff 3.0 km', '2A46M max 5.0 km']);
  });

  test('de-duplicates entries that round to the same radius', () => {
    const { radii } = rangeRingsFromEntries(
      [
        { kind: 'effective', max_m: 3000 },
        { kind: 'maximum', max_m: 3000.4 },
      ],
      'X',
    );
    expect(radii).toEqual([3000]);
  });

  test('drops entries with no usable range', () => {
    const { radii } = rangeRingsFromEntries([{ kind: 'other', min_m: null, max_m: null }], 'X');
    expect(radii).toEqual([]);
  });

  test('caps at 8 rings', () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      kind: 'other',
      max_m: (index + 1) * 1000,
    }));
    expect(rangeRingsFromEntries(entries, 'X').radii).toHaveLength(8);
  });

  test('rounds distances at or above 10 km to whole kilometres in labels', () => {
    const { ringLabels } = rangeRingsFromEntries([{ kind: 'maximum', max_m: 12_400 }], 'Long gun');
    expect(ringLabels).toEqual(['Long gun max 12 km']);
  });
});

describe('formatMeasureReadout', () => {
  test('null payload is blank', () => {
    expect(formatMeasureReadout(null)).toBe('');
  });

  test('distance: a single segment is just the total', () => {
    expect(
      formatMeasureReadout({
        mode: 'distance',
        segments: [{ from: [0, 0], to: [1, 1], distance: 1000, label: '1.00 km' }],
        total: 1000,
        totalLabel: '1.00 km',
        done: true,
      }),
    ).toBe('1.00 km');
  });

  test('distance: several segments show the sum', () => {
    expect(
      formatMeasureReadout({
        mode: 'distance',
        segments: [{ label: '1.00 km' }, { label: '2.00 km' }],
        totalLabel: '3.00 km',
      }),
    ).toBe('1.00 km + 2.00 km = Σ 3.00 km');
  });

  test('area', () => {
    expect(
      formatMeasureReadout({ mode: 'area', areaLabel: '1.20 km²', perimeterLabel: '4.10 km' }),
    ).toBe('1.20 km² · perimeter 4.10 km');
  });

  test('bearing before the second point is blank, not garbled', () => {
    expect(formatMeasureReadout({ mode: 'bearing', degrees: null })).toBe('');
  });

  test('bearing with both points', () => {
    expect(
      formatMeasureReadout({
        mode: 'bearing',
        degrees: 47,
        degreesLabel: '047',
        mils: 836,
        milsLabel: '0836',
        distanceLabel: '1.85 km',
      }),
    ).toBe('047° (0836 mils) · 1.85 km');
  });
});
