import { expect, test } from 'vitest';

import { lonLatToUtm33, utm33ToLonLat } from './utm33.mjs';

// Control values cross-checked against proj4 with
// "+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs" (EPSG:3045), which
// implements the same Snyder transverse-Mercator series independently.
const CONTROL_POINTS = [
  { lon: 15.74, lat: 50.736, easting: 552219.3278, northing: 5620728.8516 }, // Snezka summit
  { lon: 14.4212, lat: 50.087, easting: 458594.1241, northing: 5548464.2507 }, // Prague
  { lon: 12, lat: 48.55, easting: 278614.901, northing: 5381779.4345 }, // west edge of Czechia
  { lon: 18.87, lat: 51.06, easting: 771162.7292, northing: 5663624.952 }, // east edge of Czechia
  { lon: 15, lat: 50, easting: 500000, northing: 5538630.7027 }, // on the central meridian
];

test.each(CONTROL_POINTS)(
  'forward matches the known easting/northing for $lon,$lat',
  ({ lon, lat, easting, northing }) => {
    const [e, n] = lonLatToUtm33(lon, lat);
    expect(e).toBeCloseTo(easting, 2);
    expect(n).toBeCloseTo(northing, 2);
  },
);

test.each(CONTROL_POINTS)(
  'inverse matches the known lon/lat for $easting,$northing',
  ({ lon, lat, easting, northing }) => {
    const [gotLon, gotLat] = utm33ToLonLat(easting, northing);
    expect(gotLon).toBeCloseTo(lon, 6);
    expect(gotLat).toBeCloseTo(lat, 6);
  },
);

test('round-trips within a millimetre across Czechia', () => {
  for (let lon = 12; lon <= 18.87; lon += 0.7) {
    for (let lat = 48.55; lat <= 51.06; lat += 0.4) {
      const [e, n] = lonLatToUtm33(lon, lat);
      const [lon2, lat2] = utm33ToLonLat(e, n);
      expect(lon2).toBeCloseTo(lon, 7);
      expect(lat2).toBeCloseTo(lat, 7);
    }
  }
});
