import { describe, expect, test } from 'vitest';
import { contourInterval, contourTile } from './contours.ts';
import { tileXToLon, tileYToLat } from './tiles.ts';

const Z = 13;

/** Global (non-fractional) tile x/y containing a lon/lat at zoom `z`. */
function tileContaining(lon, lat, z) {
  const x = Math.floor(((lon + 180) / 360) * 2 ** z);
  const radians = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * 2 ** z,
  );
  return { x, y };
}

const { x: TX, y: TY } = tileContaining(17.5, 49.7, Z);

/** Tilted plane in metres: 1000 at the tile's north-west corner, sloping east/south. */
function plane(lon, lat) {
  const west = tileXToLon(TX, Z);
  const north = tileYToLat(TY, Z);
  return 1000 + (lon - west) * 100000 - (lat - north) * 50000;
}

/** Paraboloid peaking at the tile centre, radius in degrees. */
function cone() {
  const west = tileXToLon(TX, Z);
  const east = tileXToLon(TX + 1, Z);
  const north = tileYToLat(TY, Z);
  const south = tileYToLat(TY + 1, Z);
  const cx = (west + east) / 2;
  const cy = (north + south) / 2;
  return (lon, lat) => 2000 - ((lon - cx) ** 2 + (lat - cy) ** 2) * 5e7;
}

describe('contourInterval', () => {
  test('matches the documented steps per zoom band', () => {
    expect(contourInterval(13)).toEqual({ minor: 10, index: 50 });
    expect(contourInterval(14)).toEqual({ minor: 10, index: 50 });
    expect(contourInterval(12)).toEqual({ minor: 20, index: 100 });
    expect(contourInterval(11)).toEqual({ minor: 50, index: 250 });
    expect(contourInterval(10)).toEqual({ minor: 100, index: 500 });
    expect(contourInterval(9)).toBeNull();
  });
});

describe('contourTile', () => {
  test('returns an empty collection below zoom 10', () => {
    const result = contourTile(plane, 9, TX >> 4, TY >> 4);
    expect(result).toEqual({ type: 'FeatureCollection', features: [] });
  });

  test('every vertex on a tilted plane matches the analytic elevation', () => {
    const result = contourTile(plane, Z, TX, TY);
    expect(result.features.length).toBeGreaterThan(0);
    for (const feature of result.features) {
      for (const [lon, lat] of feature.geometry.coordinates) {
        expect(plane(lon, lat)).toBeCloseTo(feature.properties.ele, 0); // within 0.5 m
      }
    }
  });

  test('levels are multiples of 10 and index is true exactly for multiples of 50', () => {
    const result = contourTile(plane, Z, TX, TY);
    expect(result.features.length).toBeGreaterThan(0);
    for (const feature of result.features) {
      const { ele, index } = feature.properties;
      expect(ele % 10).toBe(0);
      expect(index).toBe(ele % 50 === 0);
    }
  });

  test('a peak fully inside the tile produces one closed ring near the summit', () => {
    const result = contourTile(cone(), Z, TX, TY);
    const near = result.features.filter((f) => f.properties.ele === 1990);
    expect(near).toHaveLength(1);
    const coordinates = near[0].geometry.coordinates;
    expect(coordinates.length).toBeGreaterThan(3);
    expect(coordinates[0]).toEqual(coordinates[coordinates.length - 1]);
  });

  test('no vertex crosses the NaN boundary', () => {
    const west = tileXToLon(TX, Z);
    const east = tileXToLon(TX + 1, Z);
    const midLon = (west + east) / 2;
    const halfNaN = (lon, lat) => (lon < midLon ? NaN : plane(lon, lat));
    const result = contourTile(halfNaN, Z, TX, TY, { samples: 64 });
    expect(result.features.length).toBeGreaterThan(0);
    const slack = Math.abs(east - west) / 64; // one grid sample of slack
    for (const feature of result.features) {
      for (const [lon] of feature.geometry.coordinates) {
        expect(lon).toBeGreaterThanOrEqual(midLon - slack);
      }
    }
  });

  test('adjacent tiles share identical vertices along their common edge', () => {
    const left = contourTile(plane, Z, TX, TY, { samples: 32 });
    const right = contourTile(plane, Z, TX + 1, TY, { samples: 32 });
    const sharedLon = round6(tileXToLon(TX + 1, Z));

    const onSeam = (result) =>
      result.features.flatMap((f) => f.geometry.coordinates.filter(([lon]) => lon === sharedLon));

    const leftSeamPoints = onSeam(left);
    const rightSeamPoints = onSeam(right);
    expect(leftSeamPoints.length).toBeGreaterThan(0);

    for (const [, lat] of leftSeamPoints) {
      const match = rightSeamPoints.some(([, otherLat]) => Math.abs(otherLat - lat) < 1e-6);
      expect(match).toBe(true);
    }
  });
});

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}
