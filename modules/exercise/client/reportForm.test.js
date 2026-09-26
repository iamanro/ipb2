import { describe, expect, test } from 'vitest';

import {
  credibilityOptionLabel,
  distanceKm,
  formatReportLocationMgrs,
  reliabilityOptionLabel,
  sortTracksByDistance,
} from './reportForm.js';

describe('distanceKm', () => {
  test('the same point is zero km apart', () => {
    expect(distanceKm(16.5, 48.45, 16.5, 48.45)).toBeCloseTo(0, 6);
  });

  test('one degree of longitude at the equator is about 111 km', () => {
    expect(distanceKm(0, 0, 1, 0)).toBeCloseTo(111.2, 0);
  });

  test('is symmetric', () => {
    const a = distanceKm(16.5, 48.45, 17.5, 49.7);
    const b = distanceKm(17.5, 49.7, 16.5, 48.45);
    expect(a).toBeCloseTo(b, 9);
  });
});

describe('sortTracksByDistance', () => {
  const point = { lon: 0, lat: 0 };
  const near = { id: 1, lon: 0.01, lat: 0 };
  const mid = { id: 2, lon: 0.1, lat: 0 };
  const far = { id: 3, lon: 1, lat: 0 };

  test('orders nearest first', () => {
    const sorted = sortTracksByDistance(point, [far, near, mid]);
    expect(sorted.map((entry) => entry.track.id)).toEqual([1, 2, 3]);
  });

  test('each entry carries its distance in km', () => {
    const [{ km }] = sortTracksByDistance(point, [far]);
    expect(km).toBeGreaterThan(100);
  });

  test('an empty track list sorts to empty', () => {
    expect(sortTracksByDistance(point, [])).toEqual([]);
  });
});

describe('formatReportLocationMgrs', () => {
  test('formats a located payload as MGRS', () => {
    expect(formatReportLocationMgrs({ lon: 16.51947, lat: 48.45412 })).toBe('33UXP1234567890');
  });

  test('null for an unlocated payload', () => {
    expect(formatReportLocationMgrs({ lon: null, lat: null })).toBeNull();
  });

  test('null for a missing payload', () => {
    expect(formatReportLocationMgrs(null)).toBeNull();
    expect(formatReportLocationMgrs(undefined)).toBeNull();
  });
});

describe('reliabilityOptionLabel / credibilityOptionLabel', () => {
  test('pairs the code with its Admiralty meaning', () => {
    expect(reliabilityOptionLabel('A')).toBe('A \u2014 Completely reliable');
    expect(reliabilityOptionLabel('F')).toBe('F \u2014 Reliability cannot be judged');
  });

  test('credibility likewise', () => {
    expect(credibilityOptionLabel(1)).toBe('1 \u2014 Confirmed by other sources');
    expect(credibilityOptionLabel(6)).toBe('6 \u2014 Truth cannot be judged');
  });
});
