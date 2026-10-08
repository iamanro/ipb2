import { describe, expect, test } from 'vitest';

import { formatMetres, widenExtent } from './products.js';

describe('widenExtent', () => {
  test('a single point grows to the minimum span, centred on it', () => {
    const [west, south, east, north] = widenExtent([16.6, 49.2, 16.6, 49.2], 0.05);
    expect(west).toBeCloseTo(16.575);
    expect(south).toBeCloseTo(49.175);
    expect(east).toBeCloseTo(16.625);
    expect(north).toBeCloseTo(49.225);
  });

  test('widely separated tracks keep their own extent', () => {
    expect(widenExtent([14, 49, 17, 50], 0.05)).toEqual([14, 49, 17, 50]);
  });
});

describe('formatMetres', () => {
  test('never rounds a short distance down to 0 m', () => {
    expect(formatMetres(0.3)).toBe('0.3 m');
    expect(formatMetres(2.44)).toBe('2.4 m');
  });

  test('metres and kilometres', () => {
    expect(formatMetres(38.4)).toBe('38 m');
    expect(formatMetres(1234)).toBe('1.2 km');
  });
});
