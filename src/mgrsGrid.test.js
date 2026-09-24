import { describe, expect, test } from 'vitest';

import { lonLatToUtm } from './geo.js';
import { buildMgrsGrid, clipPolyline, gridZoneCells, mgrsGridSpacing } from './mgrsGrid.js';

// ~20 km views: Libavá (33U, north) and Rio de Janeiro (23K, south, false northing).
const LIBAVA = [17.35, 49.62, 17.62, 49.78];
const RIO = [-43.35, -23.0, -43.1, -22.85];

function offGrid(value, spacing) {
  const remainder = ((value % spacing) + spacing) % spacing;
  return Math.min(remainder, spacing - remainder);
}

describe('mgrsGridSpacing', () => {
  test('picks the finest spacing whose lines stay readable, down to GZD-only', () => {
    expect(mgrsGridSpacing(25)).toBe(1000); // 1 km = 40 px
    expect(mgrsGridSpacing(26)).toBe(10000);
    expect(mgrsGridSpacing(300)).toBe(100000);
    expect(mgrsGridSpacing(2600)).toBeNull();
  });
});

describe('buildMgrsGrid', () => {
  test.each([
    ['northern hemisphere', LIBAVA, 33],
    ['southern hemisphere', RIO, 23],
  ])('1 km lines lie on exact UTM kilometres (%s)', (_label, extent, zone) => {
    const { lines } = buildMgrsGrid({ extent, spacing: 1000 });
    const gridLines = lines.filter((line) => line.rank !== 'zone');
    expect(gridLines.length).toBeGreaterThan(20);
    for (const { coordinates } of gridLines) {
      const utm = coordinates.map(([lon, lat]) => lonLatToUtm(lon, lat, zone));
      // A line is constant in easting or in northing, at a kilometre. 0.1 m
      // absorbs the series-projection round trip (~1.5 cm); a wrong zone or
      // false northing is off by metres to kilometres.
      const eastingLine = utm.every((point) => Math.abs(point.easting - utm[0].easting) < 0.1);
      const value = eastingLine ? utm[0].easting : utm[0].northing;
      expect(offGrid(value, 1000)).toBeLessThan(0.1);
    }
  });

  test('labels each line with its principal digits on the bottom and left view edges', () => {
    const { labels } = buildMgrsGrid({ extent: LIBAVA, spacing: 1000 });
    const easting = labels.filter((label) => label.kind === 'easting');
    const northing = labels.filter((label) => label.kind === 'northing');
    expect(easting.length).toBeGreaterThan(10);
    for (const label of easting) {
      expect(label.coordinate[1]).toBeCloseTo(LIBAVA[1], 9);
      const { easting: value } = lonLatToUtm(...label.coordinate, 33);
      expect(label.text).toBe(String(Math.round(value / 1000) % 100).padStart(2, '0'));
    }
    expect(northing.length).toBeGreaterThan(10);
    for (const label of northing) {
      expect(label.coordinate[0]).toBeCloseTo(LIBAVA[0], 9);
      const { northing: value } = lonLatToUtm(...label.coordinate, 33);
      expect(label.text).toBe(String(Math.round(value / 1000) % 100).padStart(2, '0'));
    }
  });

  test('names the 100 km square the view is in', () => {
    const { labels } = buildMgrsGrid({ extent: LIBAVA, spacing: 10000 });
    expect(labels.filter((label) => label.kind === 'square').map((label) => label.text)).toContain(
      '33U XR',
    );
  });

  test('grid lines stop at a zone boundary instead of crossing into the next zone', () => {
    const extent = [17.8, 49.6, 18.2, 49.8]; // straddles 18°E, the 33/34 boundary
    const { lines } = buildMgrsGrid({ extent, spacing: 1000 });
    const boundary = lines.filter(
      (line) => line.rank === 'zone' && line.coordinates.every(([lon]) => lon === 18),
    );
    expect(boundary).toHaveLength(1);
    const gridLines = lines.filter((line) => line.rank !== 'zone');
    for (const { coordinates } of gridLines) {
      const lons = coordinates.map(([lon]) => lon);
      const west = lons.every((lon) => lon <= 18 + 1e-9);
      const east = lons.every((lon) => lon >= 18 - 1e-9);
      expect(west || east).toBe(true);
    }
    expect(gridLines.some((line) => line.coordinates[0][0] < 18)).toBe(true);
    expect(gridLines.some((line) => line.coordinates[0][0] > 18)).toBe(true);
  });

  test('outside the UTM latitude range there is nothing to draw', () => {
    expect(buildMgrsGrid({ extent: [0, 85, 10, 89], spacing: 1000 })).toEqual({
      lines: [],
      labels: [],
    });
  });
});

describe('gridZoneCells', () => {
  test('applies the Norway exception: 32V is widened west to 3°E', () => {
    const cells = gridZoneCells([1, 58, 8, 60]).map(
      (cell) => `${cell.zone}${cell.band}:${cell.box}`,
    );
    expect(cells).toEqual(['31V:0,56,3,64', '32V:3,56,12,64']);
  });
});

describe('clipPolyline', () => {
  test('splits a line that leaves and re-enters the box into separate runs', () => {
    const box = [0, 0, 10, 10];
    const runs = clipPolyline(
      [
        [1, 5],
        [5, 5],
        [15, 5],
        [5, 6],
        [2, 6],
      ],
      box,
    );
    expect(runs).toEqual([
      [
        [1, 5],
        [5, 5],
        [10, 5],
      ],
      [
        [10, 5.5],
        [5, 6],
        [2, 6],
      ],
    ]);
  });
});
