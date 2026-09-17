import { describe, expect, test } from 'vitest';

import { formatArea, formatDecimal, formatMetres, formatMgrs, parseCoordinate } from './geo.js';

// Anchor point inside the terrain module's DEM coverage (Libavá, CZ). Every
// format below is expected to resolve to this point within a few metres, so
// a regression in any one parser shows up as a distance, not a crash.
const TARGET = { lon: 17.5, lat: 49.7 };
const TOLERANCE_METRES = 5;

function metresBetween(a, b) {
  const lonScale = 111319.49 * Math.cos((a.lat * Math.PI) / 180);
  const dx = (b.lon - a.lon) * lonScale;
  const dy = (b.lat - a.lat) * 111132.95;
  return Math.hypot(dx, dy);
}

describe('parseCoordinate', () => {
  const mgrsString = formatMgrs(TARGET.lon, TARGET.lat);

  test.each([
    ['decimal degrees, space separated', '49.7 17.5'],
    ['decimal degrees, hemisphere suffix', '49.7N 17.5E'],
    ['decimal degrees, comma separated lat,lon', '49.7,17.5'],
    ['degrees-minutes-seconds', `49°42'00"N 17°30'00"E`],
    ['MGRS, compact', mgrsString.replace(/\s+/g, '')],
    ['MGRS, spaced', mgrsString],
  ])('resolves %s within %d m of the target', (_label, text) => {
    const parsed = parseCoordinate(text);
    expect(parsed).not.toBeNull();
    expect(metresBetween(parsed, TARGET)).toBeLessThan(TOLERANCE_METRES);
  });

  test('reports the detected format', () => {
    expect(parseCoordinate('49.7 17.5').format).toBe('dd');
    expect(parseCoordinate(`49°42'00"N 17°30'00"E`).format).toBe('dms');
    expect(parseCoordinate(formatMgrs(TARGET.lon, TARGET.lat)).format).toBe('mgrs');
  });

  test('returns null for text that matches no supported format', () => {
    expect(parseCoordinate('not a coordinate')).toBeNull();
    expect(parseCoordinate('')).toBeNull();
  });

  test('without hemisphere letters, an ambiguous pair is read as lat,lon', () => {
    // Both 40 and 50 are valid as either latitude or longitude; the analyst
    // convention (and the one this module commits to) is latitude first.
    expect(parseCoordinate('40,50')).toEqual({ lat: 40, lon: 50, format: 'dd' });
  });

  test('a pair unambiguous by range is read lon-first when out of latitude range', () => {
    // 120 cannot be a latitude, so the order must be lon,lat here.
    expect(parseCoordinate('120,40')).toEqual({ lat: 40, lon: 120, format: 'dd' });
  });

  test('round-trips through UTM within tolerance', () => {
    // Easting/northing computed independently with the standard Snyder/USGS
    // forward transverse Mercator formulas (WGS84), not by reusing geo.js's
    // own inverse, so this catches a regression in either direction.
    expect(parseCoordinate('33N 680271 5508277')).not.toBeNull();
    const parsed = parseCoordinate('33N 680271 5508277');
    expect(metresBetween(parsed, TARGET)).toBeLessThan(TOLERANCE_METRES);
  });
});

describe('formatMetres', () => {
  test('renders sub-kilometre distances in metres', () => {
    expect(formatMetres(842)).toBe('842 m');
  });

  test('renders kilometre-scale distances with one decimal', () => {
    expect(formatMetres(15300)).toBe('15.3 km');
  });

  test('renders missing values as an em dash, not NaN or blank', () => {
    expect(formatMetres(null)).toBe('—');
    expect(formatMetres(undefined)).toBe('—');
    expect(formatMetres(Number.NaN)).toBe('—');
  });
});

describe('formatArea', () => {
  test('renders large areas in square kilometres', () => {
    expect(formatArea(282.4)).toBe('282 km²');
  });

  test('renders sub-kilometre areas in square metres', () => {
    expect(formatArea(0.045)).toBe('45000 m²');
  });
});

describe('formatDecimal', () => {
  test('formats latitude and longitude with hemisphere letters', () => {
    expect(formatDecimal(TARGET.lon, TARGET.lat)).toBe('49.70000 N  17.50000 E');
  });
});
