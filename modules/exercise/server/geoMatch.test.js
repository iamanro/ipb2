import { describe, expect, test } from 'vitest';

import { geometryContains, haversineMetres } from './geoMatch.js';

const SQUARE = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
};

const SQUARE_WITH_HOLE = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [0, 0],
    ],
    [
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
      [1, 1],
    ],
  ],
};

const TWO_SQUARES = {
  type: 'MultiPolygon',
  coordinates: [SQUARE.coordinates, [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]]],
};

describe('haversineMetres', () => {
  test('zero for the same point', () => {
    expect(haversineMetres(17.5, 49.7, 17.5, 49.7)).toBe(0);
  });

  test('one degree of longitude at the equator is about 111 km', () => {
    expect(haversineMetres(0, 0, 1, 0)).toBeCloseTo(111_195, -2);
  });
});

describe('geometryContains: Polygon', () => {
  test('a point inside the ring matches', () => {
    expect(geometryContains(SQUARE, 0.5, 0.5)).toBe(true);
  });

  test('a point outside the ring does not match', () => {
    expect(geometryContains(SQUARE, 5, 5)).toBe(false);
  });

  test('a point on the boundary edge counts as inside (ray-cast half-open rule)', () => {
    expect(geometryContains(SQUARE, 0.5, 0)).toBe(true);
  });

  test('a point inside a hole does not match, even though it is inside the outer ring', () => {
    expect(geometryContains(SQUARE_WITH_HOLE, 2, 2)).toBe(false);
  });

  test('a point between the hole and the outer ring still matches', () => {
    expect(geometryContains(SQUARE_WITH_HOLE, 0.5, 0.5)).toBe(true);
  });
});

describe('geometryContains: MultiPolygon', () => {
  test('matches inside either part', () => {
    expect(geometryContains(TWO_SQUARES, 0.5, 0.5)).toBe(true);
    expect(geometryContains(TWO_SQUARES, 10.5, 10.5)).toBe(true);
  });

  test('does not match between the two parts', () => {
    expect(geometryContains(TWO_SQUARES, 5, 5)).toBe(false);
  });
});

describe('geometryContains: Point (NAI radius)', () => {
  const naiPoint = { type: 'Point', coordinates: [17.5, 49.7] };

  test('within 250 m matches', () => {
    // ~0.002 degrees of longitude at this latitude is roughly 150 m.
    expect(geometryContains(naiPoint, 17.502, 49.7)).toBe(true);
  });

  test('beyond 250 m does not match', () => {
    expect(geometryContains(naiPoint, 17.6, 49.7)).toBe(false);
  });
});

describe('geometryContains: malformed or unsupported geometry', () => {
  test('null geometry never matches', () => {
    expect(geometryContains(null, 0.5, 0.5)).toBe(false);
  });

  test('an unsupported geometry type never matches', () => {
    expect(geometryContains({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, 0.5, 0.5)).toBe(
      false,
    );
  });
});
