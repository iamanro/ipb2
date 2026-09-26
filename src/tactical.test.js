import { describe, expect, test } from 'vitest';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Polygon from 'ol/geom/Polygon.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import { getDistance } from 'ol/sphere.js';

import {
  TACTICAL_GRAPHICS,
  axisOfAdvancePolygon,
  graphicColor,
  graphicGeometryType,
  graphicLabel,
  rangeRingGeometry,
} from './tactical.js';

// A short line east across Libavá (matches the tolerance/anchor convention
// used by src/geo.test.js), long enough that an axis-of-advance corridor's
// 1000 m default width is a small fraction of its length.
const LINE_LONLAT = [
  [17.4, 49.7],
  [17.5, 49.7],
  [17.6, 49.7],
];

describe('TACTICAL_GRAPHICS catalogue integrity', () => {
  const requiredKeys = [
    'phase-line',
    'boundary',
    'axis-of-advance',
    'direction-of-attack',
    'objective',
    'assembly-area',
    'battle-position',
    'engagement-area',
    'minefield',
    'obstacle-line',
    'block',
    'fix',
    'turn',
    'disrupt',
  ];

  test.each(requiredKeys)('%s is in the catalogue', (key) => {
    expect(TACTICAL_GRAPHICS[key]).toBeTruthy();
  });

  test.each(Object.entries(TACTICAL_GRAPHICS))(
    '%s has a label, a line/polygon geometry, a labelFormat and a style function',
    (_key, entry) => {
      expect(typeof entry.label).toBe('string');
      expect(['line', 'polygon']).toContain(entry.geometry);
      expect(typeof entry.labelFormat).toBe('function');
      expect(typeof entry.style).toBe('function');
    },
  );

  test.each(Object.entries(TACTICAL_GRAPHICS))(
    '%s builds a non-empty style array for a representative feature',
    (key, entry) => {
      const geometry =
        entry.geometry === 'line'
          ? new LineString(LINE_LONLAT.map((c) => fromLonLat(c)))
          : new Polygon([
              [
                [17.4, 49.7],
                [17.45, 49.7],
                [17.45, 49.75],
                [17.4, 49.75],
                [17.4, 49.7],
              ].map((c) => fromLonLat(c)),
            ]);
      const feature = new Feature(geometry);
      feature.set('properties', { echelon: 'XX', width_m: 1200 });
      const styles = entry.style(feature, {
        color: graphicColor('hostile', false),
        darkBase: false,
        label: entry.labelFormat('Alpha'),
      });
      expect(Array.isArray(styles)).toBe(true);
      expect(styles.length).toBeGreaterThan(0);
      expect(graphicGeometryType(key)).toBe(entry.geometry);
    },
  );
});

describe('graphicLabel', () => {
  test('formats a phase line and a boundary by their doctrinal prefix', () => {
    expect(graphicLabel('phase-line', 'ALPHA')).toBe('PL ALPHA');
    expect(graphicLabel('objective', 'BEAR')).toBe('OBJ BEAR');
  });

  test('falls back to the bare prefix without a name', () => {
    expect(graphicLabel('phase-line', '')).toBe('PL');
    expect(graphicLabel('phase-line', undefined)).toBe('PL');
  });

  test('an unknown key returns the name unchanged', () => {
    expect(graphicLabel('not-a-graphic', 'Something')).toBe('Something');
    expect(graphicLabel('not-a-graphic', undefined)).toBe('');
  });
});

describe('graphicColor', () => {
  test('affiliation colours match the C5 contract', () => {
    expect(graphicColor('friendly')).toBe('#3d8bff');
    expect(graphicColor('hostile')).toBe('#ff4d4d');
    expect(graphicColor('neutral')).toBe('#3fbf5f');
    expect(graphicColor('unknown')).toBe('#e6c229');
  });

  test('no affiliation falls back to plain ink, by basemap tone', () => {
    expect(graphicColor(undefined, false)).toBe('#12324a');
    expect(graphicColor(undefined, true)).toBe('#dfe8ea');
  });
});

describe('axisOfAdvancePolygon', () => {
  test('returns null for fewer than two distinct points', () => {
    expect(axisOfAdvancePolygon([[17.5, 49.7]])).toBeNull();
    expect(axisOfAdvancePolygon([[17.5, 49.7], [17.5, 49.7]])).toBeNull();
  });

  /** Distance from `point` to the nearest point on the polyline `line` (`[lon, lat]` pairs), by fine linear-interpolation sampling — accurate enough for a width sanity check without pulling in a full geodesic point-to-segment solver. */
  function distanceToPolyline(point, line) {
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
      for (let t = 0; t <= 1; t += 0.01) {
        const sample = [
          line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t,
          line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t,
        ];
        best = Math.min(best, getDistance(point, sample));
      }
    }
    return best;
  }

  test('the corridor stays within widthM of the centreline outside the arrowhead', () => {
    const widthM = 800;
    const ring = axisOfAdvancePolygon(LINE_LONLAT, widthM);
    expect(ring).not.toBeNull();
    // Every vertex stays within a generous bound of the centreline: up to
    // the head flare (its widest point, `widthM` itself) plus slack for the
    // sampling above.
    for (const point of ring) {
      expect(distanceToPolyline(point, LINE_LONLAT)).toBeLessThan(widthM * 1.2);
    }
    // The first shaft vertex (well clear of the head) sits at half-width.
    expect(distanceToPolyline(ring[0], LINE_LONLAT)).toBeCloseTo(widthM / 2, -2);
  });

  test('one vertex sits exactly at the line\'s last vertex (the tip)', () => {
    const ring = axisOfAdvancePolygon(LINE_LONLAT, 500);
    const lastVertex = LINE_LONLAT[LINE_LONLAT.length - 1];
    const closest = Math.min(...ring.map((point) => getDistance(point, lastVertex)));
    expect(closest).toBeLessThan(1);
  });

  test('the barbed head is wider than the shaft (an arrowhead, not a uniform corridor)', () => {
    const widthM = 600;
    const ring = axisOfAdvancePolygon(LINE_LONLAT, widthM);
    const distanceFromCentreline = (point) =>
      Math.min(...LINE_LONLAT.map((c) => getDistance(point, c)));
    // ring[0] is the first shaft vertex (half-width off the centreline); the
    // barb (the widest vertex anywhere in the ring) flares to the full width.
    expect(distanceFromCentreline(ring[0])).toBeCloseTo(widthM / 2, -2);
    const widest = Math.max(...ring.map(distanceFromCentreline));
    expect(widest).toBeGreaterThan(widthM * 0.9);
  });
});

describe('rangeRingGeometry', () => {
  test('every vertex is radiusMetres from the centre, geodesically', () => {
    const center = [17.5, 49.7];
    const radiusMetres = 5000;
    const ring = rangeRingGeometry(center, radiusMetres);
    const coordinates = ring.getCoordinates()[0];
    for (const vertex of coordinates) {
      expect(getDistance(center, vertex)).toBeCloseTo(radiusMetres, -1);
    }
  });

  test('the first vertex sits due north of the centre', () => {
    const center = [17.5, 49.7];
    const ring = rangeRingGeometry(center, 3000);
    const [lon, lat] = ring.getCoordinates()[0][0];
    expect(lon).toBeCloseTo(center[0], 6);
    expect(lat).toBeGreaterThan(center[1]);
  });

  test('a larger radius scales the ring proportionally', () => {
    const center = [17.5, 49.7];
    const small = rangeRingGeometry(center, 1000).getCoordinates()[0][0];
    const large = rangeRingGeometry(center, 2000).getCoordinates()[0][0];
    expect(getDistance(center, large)).toBeCloseTo(2 * getDistance(center, small), -1);
  });
});

// toLonLat is only used to sanity-check the fixture above stays anchored to
// the same real-world point every other test in the repo uses.
test('the fixture anchor round-trips through the map projection', () => {
  const [lon, lat] = toLonLat(fromLonLat([17.5, 49.7]));
  expect(lon).toBeCloseTo(17.5, 6);
  expect(lat).toBeCloseTo(49.7, 6);
});
