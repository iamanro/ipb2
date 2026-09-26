import { describe, expect, test } from 'vitest';

import { bearingDegrees, bearingMils, formatAreaLabel, formatDistanceLabel } from './measure.js';

describe('bearingDegrees', () => {
  test('due east is 90 degrees', () => {
    expect(bearingDegrees([17.0, 49.7], [17.1, 49.7])).toBeCloseTo(90, 0);
  });

  test('due north is 0 degrees', () => {
    expect(bearingDegrees([17.0, 49.7], [17.0, 49.8])).toBeCloseTo(0, 0);
  });

  test('due south wraps to 180, not a negative value', () => {
    expect(bearingDegrees([17.0, 49.7], [17.0, 49.6])).toBeCloseTo(180, 0);
  });

  test('due west is 270, not -90', () => {
    const bearing = bearingDegrees([17.0, 49.7], [16.9, 49.7]);
    expect(bearing).toBeGreaterThanOrEqual(0);
    expect(bearing).toBeCloseTo(270, 0);
  });
});

describe('bearingMils', () => {
  test('0/90/180/270 degrees map to 0/1600/3200/4800 mils', () => {
    expect(bearingMils(0)).toBe(0);
    expect(bearingMils(90)).toBe(1600);
    expect(bearingMils(180)).toBe(3200);
    expect(bearingMils(270)).toBe(4800);
  });

  test('360 degrees wraps to 0 mils, not 6400', () => {
    expect(bearingMils(360)).toBe(0);
  });
});

describe('formatDistanceLabel', () => {
  test('sub-kilometre distances round to whole metres', () => {
    expect(formatDistanceLabel(842)).toBe('842 m');
    expect(formatDistanceLabel(999.6)).toBe('1000 m');
  });

  test('kilometre-scale distances show 2 decimals of km, not metres', () => {
    expect(formatDistanceLabel(1000)).toBe('1.00 km');
    expect(formatDistanceLabel(15300)).toBe('15.30 km');
  });

  test('non-finite input renders as an em dash', () => {
    expect(formatDistanceLabel(null)).toBe('—');
    expect(formatDistanceLabel(Number.NaN)).toBe('—');
  });
});

describe('formatAreaLabel', () => {
  test('sub-100-hectare areas render in hectares', () => {
    expect(formatAreaLabel(45000)).toBe('4.50 ha');
  });

  test('100 hectares and above render in km2', () => {
    expect(formatAreaLabel(1e6)).toBe('1.00 km²');
    expect(formatAreaLabel(2.824e8)).toBe('282.40 km²');
  });

  test('non-finite input renders as an em dash', () => {
    expect(formatAreaLabel(undefined)).toBe('—');
  });
});
