import { describe, expect, test } from 'vitest';

import { affiliationOf } from '../../../src/symbols/sidc.js';
import { layoutUnits, orbatLinkStatus, orbatUnitProperties } from './orbatPlacement.js';

const FRIENDLY_BATTALION = '10031000161211000000';

const unit = (id, parentId, extra = {}) => ({
  id,
  parentId,
  sidc: FRIENDLY_BATTALION,
  name: `Unit ${id}`,
  designation: '',
  higherFormation: '',
  reinforced: '',
  additional: '',
  ...extra,
});

describe('orbatUnitProperties', () => {
  test('copies the amplifiers and links back; empty ORBAT text becomes unset', () => {
    const placed = orbatUnitProperties(
      unit(4, null, { designation: '1-4', higherFormation: '3', reinforced: '(+)' }),
      { orbatId: 2 },
    );
    expect(placed).toEqual({
      label: 'Unit 4 — 1-4',
      properties: {
        sidc: FRIENDLY_BATTALION,
        designation: '1-4',
        higher_formation: '3',
        reinforced: '(+)',
        additional: null,
        orbat_id: 2,
        orbat_unit_id: 4,
        orbat_affiliation: 'orbat',
      },
    });
  });

  test('a forced affiliation changes only the standard identity', () => {
    const { properties } = orbatUnitProperties(unit(4, null), {
      orbatId: 2,
      affiliation: 'hostile',
    });
    expect(affiliationOf(properties.sidc)).toBe('hostile');
    expect(properties.sidc.slice(4)).toBe(FRIENDLY_BATTALION.slice(4));
  });
});

describe('orbatLinkStatus', () => {
  const orbatUnit = unit(4, null, { designation: '1-4' });
  const placed = (overrides = {}) => {
    const { label, properties } = orbatUnitProperties(orbatUnit, {
      orbatId: 2,
      affiliation: 'hostile',
    });
    return { label, properties: { ...properties, coa_id: 7, direction: 90, ...overrides } };
  };

  test('no ORBAT link, or the ORBAT not loaded yet: no status', () => {
    expect(
      orbatLinkStatus({ label: 'x', properties: { sidc: FRIENDLY_BATTALION } }, new Map()),
    ).toBeNull();
    expect(orbatLinkStatus(placed(), new Map())).toBeNull();
  });

  test('current when the ORBAT unit still matches, whatever was set only on the map', () => {
    expect(orbatLinkStatus(placed(), new Map([[2, [orbatUnit]]]))).toEqual({
      status: 'current',
      update: null,
    });
  });

  test("changed: the update applies the ORBAT's values with the placed affiliation, keeping map-only properties", () => {
    const edited = { ...orbatUnit, designation: '2-4', reinforced: '(-)' };
    const result = orbatLinkStatus(placed(), new Map([[2, [edited]]]));
    expect(result.status).toBe('changed');
    expect(result.update.label).toBe('Unit 4 — 2-4');
    expect(result.update.properties).toMatchObject({
      designation: '2-4',
      reinforced: '(-)',
      coa_id: 7,
      direction: 90,
      orbat_affiliation: 'hostile',
    });
    expect(affiliationOf(result.update.properties.sidc)).toBe('hostile');
  });

  test('missing when the unit left the ORBAT; unavailable when the ORBAT cannot be loaded', () => {
    expect(orbatLinkStatus(placed(), new Map([[2, [unit(5, null)]]]))).toEqual({
      status: 'missing',
      update: null,
    });
    expect(orbatLinkStatus(placed(), new Map([[2, null]]))).toEqual({
      status: 'unavailable',
      update: null,
    });
  });
});

describe('layoutUnits', () => {
  test('HQ above its subordinates, each row centred on the click', () => {
    const units = [unit(1, null), unit(2, 1), unit(3, 1), unit(4, 1)];
    expect(layoutUnits(units, { spacingX: 100, spacingY: 50 })).toEqual([
      { unit: units[0], dx: 0, dy: 0 },
      { unit: units[1], dx: -100, dy: 50 },
      { unit: units[2], dx: 0, dy: 50 },
      { unit: units[3], dx: 100, dy: 50 },
    ]);
  });

  test('depth counts only chosen ancestors; long levels wrap into further rows', () => {
    // 1 was not chosen, so its subordinates 2 and 3 are the top row.
    const units = [unit(2, 1), unit(5, 2), unit(6, 2), unit(7, 2), unit(3, 1)];
    const layout = layoutUnits(units, { spacingX: 10, spacingY: 20, perRow: 2 });
    expect(layout.map(({ unit: { id }, dx, dy }) => [id, dx, dy])).toEqual([
      [2, -5, 0],
      [5, -5, 20],
      [6, 5, 20],
      [7, 0, 40],
      [3, 5, 0],
    ]);
  });
});
