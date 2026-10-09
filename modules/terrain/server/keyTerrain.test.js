import { describe, expect, test } from 'vitest';

import { keyTerrainCandidates } from './keyTerrain.ts';
import { METRES_PER_DEGREE_LATITUDE, longitudeScale } from './lattice.ts';

const METRES_PER_DEGREE_LONGITUDE = longitudeScale(0); // the fixture sits on the equator

const WEST = 0;
const SOUTH = 0;
const EAST = 4000 / METRES_PER_DEGREE_LONGITUDE;
const NORTH = 3000 / METRES_PER_DEGREE_LATITUDE;
const BOUNDS = [WEST, SOUTH, EAST, NORTH];

const BASE = 300;
const PEAK_A = { x: 1000, y: 1500, amplitude: 100, sigma: 300 }; // taller hill
const PEAK_B = { x: 3000, y: 1500, amplitude: 60, sigma: 250 }; // smaller hill

function toMetres(lon, lat) {
  return {
    x: (lon - WEST) * METRES_PER_DEGREE_LONGITUDE,
    y: (lat - SOUTH) * METRES_PER_DEGREE_LATITUDE,
  };
}

function gaussian(x, y, peak) {
  const dx = x - peak.x;
  const dy = y - peak.y;
  return peak.amplitude * Math.exp(-(dx * dx + dy * dy) / (2 * peak.sigma * peak.sigma));
}

/** Two hills joined by a low saddle ridge ~20 m above the flat base. */
function twinHillsElevation(lon, lat) {
  const { x, y } = toMetres(lon, lat);
  const ga = gaussian(x, y, PEAK_A);
  const gb = gaussian(x, y, PEAK_B);

  const dx = PEAK_B.x - PEAK_A.x;
  const dy = PEAK_B.y - PEAK_A.y;
  const len2 = dx * dx + dy * dy;
  let t = ((x - PEAK_A.x) * dx + (y - PEAK_A.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = PEAK_A.x + t * dx;
  const py = PEAK_A.y + t * dy;
  const perpendicular = Math.hypot(x - px, y - py);
  const corridor = Math.max(0, 20 - (perpendicular * 20) / 150);

  return BASE + Math.max(ga, gb, corridor);
}

describe('keyTerrainCandidates', () => {
  test('finds both hill summits with prominence relative to the saddle', () => {
    const candidates = keyTerrainCandidates({
      elevation: twinHillsElevation,
      bounds: BOUNDS,
      cellMetres: 50,
      minProminence: 5,
      limit: 8,
    });

    expect(candidates.length).toBeGreaterThanOrEqual(2);

    const near = (candidate, peak) => {
      const { x, y } = toMetres(candidate.lon, candidate.lat);
      return Math.hypot(x - peak.x, y - peak.y) <= 2 * 50;
    };

    const taller = candidates.find((c) => near(c, PEAK_A));
    const smaller = candidates.find((c) => near(c, PEAK_B));

    expect(taller).toBeDefined();
    expect(smaller).toBeDefined();

    // Taller peak: prominence measured against the flat base (the grid's lowest cell).
    expect(taller.prominence).toBeGreaterThan(90);
    expect(taller.prominence).toBeLessThan(102);

    // Smaller peak: prominence measured against the ~320 m saddle, so ~40 m.
    expect(smaller.prominence).toBeGreaterThan(30);
    expect(smaller.prominence).toBeLessThan(50);
  });

  test('excludes a small bump below minProminence', () => {
    const bumpElevation = (lon, lat) => {
      const { x, y } = toMetres(lon, lat);
      return BASE + gaussian(x, y, { x: 2000, y: 1500, amplitude: 10, sigma: 200 });
    };

    const candidates = keyTerrainCandidates({
      elevation: bumpElevation,
      bounds: BOUNDS,
      cellMetres: 50,
      minProminence: 30,
      limit: 8,
    });

    expect(candidates).toHaveLength(0);
  });

  test('a monotonic plane with its peak on the border yields no candidates', () => {
    const planeElevation = (lon, lat) => {
      const { x } = toMetres(lon, lat);
      return BASE + x * 0.05; // strictly rising to the east; max sits on the east edge
    };

    const candidates = keyTerrainCandidates({
      elevation: planeElevation,
      bounds: BOUNDS,
      cellMetres: 50,
      minProminence: 5,
      limit: 8,
    });

    expect(candidates).toHaveLength(0);
  });

  test('skips a NaN region without crashing or returning candidates inside it', () => {
    // NaN patch covers the eastern half; a valid hill sits in the western half.
    const nanElevation = (lon, lat) => {
      const { x, y } = toMetres(lon, lat);
      if (x > 2000) return NaN;
      return BASE + gaussian(x, y, { x: 1000, y: 1500, amplitude: 80, sigma: 250 });
    };

    let candidates;
    expect(() => {
      candidates = keyTerrainCandidates({
        elevation: nanElevation,
        bounds: BOUNDS,
        cellMetres: 50,
        minProminence: 20,
        limit: 8,
      });
    }).not.toThrow();

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      const { x } = toMetres(candidate.lon, candidate.lat);
      expect(x).toBeLessThanOrEqual(2000);
    }
  });

  test('re-ranks by visibleArea, favouring the smaller hill, within the call budget', () => {
    let calls = 0;
    const visibleArea = (lon, lat) => {
      calls += 1;
      const { x, y } = toMetres(lon, lat);
      const distanceToSmallHill = Math.hypot(x - PEAK_B.x, y - PEAK_B.y);
      // Larger visible area the closer the candidate is to the smaller hill.
      return Math.max(0, 100 - distanceToSmallHill / 10);
    };

    const limit = 4;
    const candidates = keyTerrainCandidates({
      elevation: twinHillsElevation,
      bounds: BOUNDS,
      cellMetres: 50,
      minProminence: 5,
      limit,
      visibleArea,
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].visibleAreaSquareKm).not.toBeNull();

    const { x, y } = toMetres(candidates[0].lon, candidates[0].lat);
    const distanceToSmallHill = Math.hypot(x - PEAK_B.x, y - PEAK_B.y);
    const distanceToTallHill = Math.hypot(x - PEAK_A.x, y - PEAK_A.y);
    expect(distanceToSmallHill).toBeLessThan(distanceToTallHill);

    expect(calls).toBeLessThanOrEqual(limit * 2);
  });

  test('visibleAreaSquareKm is null when visibleArea is not supplied', () => {
    const candidates = keyTerrainCandidates({
      elevation: twinHillsElevation,
      bounds: BOUNDS,
      cellMetres: 50,
      minProminence: 5,
      limit: 4,
    });

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.visibleAreaSquareKm).toBeNull();
    }
  });

  test('caps a huge grid and stays fast with a cheap elevation function', () => {
    const west = 0;
    const south = 0;
    const east = 50000 / METRES_PER_DEGREE_LONGITUDE;
    const north = 50000 / METRES_PER_DEGREE_LATITUDE;
    const cheapElevation = (lon, lat) =>
      300 + Math.sin(lon * 1000) * 20 + Math.cos(lat * 1000) * 20;

    const start = performance.now();
    const candidates = keyTerrainCandidates({
      elevation: cheapElevation,
      bounds: [west, south, east, north],
      cellMetres: 50,
      minProminence: 5,
      limit: 8,
    });
    const elapsed = performance.now() - start;

    expect(Array.isArray(candidates)).toBe(true);
    expect(elapsed).toBeLessThan(1500);
  });
});
