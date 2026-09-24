import { describe, expect, test } from 'vitest';

import { elevationExtremes } from './extremes.js';

// Ground rising to the north-east: the envelope's highest corner is NE.
const ramp = (lon, lat) => (lon - 17) * 1000 + (lat - 49) * 1000;

describe('elevationExtremes', () => {
  test('searches the polygon, not its envelope: an L-shaped AOI excludes the NE corner', () => {
    // L: the full west column plus the southern row; the NE quarter is outside.
    const polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [17.0, 49.0],
          [17.2, 49.0],
          [17.2, 49.1],
          [17.1, 49.1],
          [17.1, 49.2],
          [17.0, 49.2],
          [17.0, 49.0],
        ],
      ],
    };
    const { highest, lowest } = elevationExtremes(ramp, polygon, { maxSamples: 20_000 });
    // Best inside the L is either arm's tip (~300 m); the NE corner would be 400 m.
    expect(highest.elevation).toBeLessThan(301);
    expect(highest.elevation).toBeGreaterThan(290);
    expect(lowest.elevation).toBeLessThan(5);
  });

  test('a hole and cells without data are skipped', () => {
    const polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [17.0, 49.0],
          [17.2, 49.0],
          [17.2, 49.2],
          [17.0, 49.2],
          [17.0, 49.0],
        ],
        // Hole over the lowest corner.
        [
          [17.0, 49.0],
          [17.1, 49.0],
          [17.1, 49.1],
          [17.0, 49.1],
          [17.0, 49.0],
        ],
      ],
    };
    // No data in the eastern half.
    const partial = (lon, lat) => (lon > 17.15 ? Number.NaN : ramp(lon, lat));
    const { highest, lowest } = elevationExtremes(partial, polygon, { maxSamples: 20_000 });
    expect(highest.lon).toBeLessThan(17.15);
    expect(lowest.elevation).toBeGreaterThan(99);
  });
});
