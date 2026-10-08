import { describe, expect, test } from 'vitest';

import { GO, NO_GO, SLOW_GO, UNKNOWN } from './landcover.ts';
import { slopeClass } from './mobility.ts';

// Slope bands are doctrine (cross-country mobility classification), not
// arbitrary tuning: 10 deg and 30 deg are the boundaries, and each boundary
// value itself belongs to the stricter band it starts.
describe('slopeClass', () => {
  test('below 10 degrees is GO', () => {
    expect(slopeClass(0)).toBe(GO);
    expect(slopeClass(9.999)).toBe(GO);
  });

  test('10 up to 30 degrees is SLOW-GO, including the 10 degree boundary', () => {
    expect(slopeClass(10)).toBe(SLOW_GO);
    expect(slopeClass(29.999)).toBe(SLOW_GO);
  });

  test('30 degrees and above is NO-GO, including the boundary', () => {
    expect(slopeClass(30)).toBe(NO_GO);
    expect(slopeClass(89)).toBe(NO_GO);
  });

  test('NaN slope (no elevation data) is UNKNOWN, never a default GO', () => {
    expect(slopeClass(Number.NaN)).toBe(UNKNOWN);
  });
});
