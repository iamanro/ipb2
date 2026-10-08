import { expect, test } from 'vitest';

import { readGeometry } from './geometry.ts';

test('reads each geometry type this app stores', () => {
  const polygon = [
    [
      [16, 49],
      [17, 49],
      [17, 50],
      [16, 49],
    ],
  ];
  expect(readGeometry({ type: 'Point', coordinates: [16, 49] })).toEqual({
    type: 'Point',
    coordinates: [16, 49],
  });
  expect(readGeometry({ type: 'Polygon', coordinates: polygon })?.type).toBe('Polygon');
  expect(readGeometry({ type: 'MultiPolygon', coordinates: [polygon] })?.type).toBe('MultiPolygon');
});

test('rejects anything that is not a well-formed geometry', () => {
  expect(readGeometry(null)).toBeNull();
  expect(readGeometry({ type: 'Point', coordinates: [16] })).toBeNull();
  expect(readGeometry({ type: 'Point', coordinates: ['16', 49] })).toBeNull();
  expect(readGeometry({ type: 'Polygon', coordinates: [[16, 49]] })).toBeNull();
  expect(readGeometry({ type: 'GeometryCollection', geometries: [] })).toBeNull();
});
