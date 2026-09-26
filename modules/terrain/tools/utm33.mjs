/**
 * ETRS89 / UTM zone 33N (EPSG:3045) <-> WGS84-ish lon/lat, on the GRS80
 * ellipsoid, closed-form (Snyder 1987 "Map Projections: A Working Manual",
 * transverse Mercator §3-21/3-26). No external projection library: this is
 * the only place `modules/terrain/tools/build_dmr4g.mjs` needs one, and it
 * is short enough to hand-verify. Accurate to millimetres within a UTM zone,
 * comfortably more than the 5 m grid it feeds.
 */

const A = 6378137.0; // GRS80 semi-major axis, metres
const F = 1 / 298.257222101; // GRS80 flattening
const B = A * (1 - F);
const E2 = (A * A - B * B) / (A * A); // first eccentricity squared
const EP2 = (A * A - B * B) / (B * B); // second eccentricity squared
const K0 = 0.9996; // UTM scale factor at the central meridian
const LON0 = (15 * Math.PI) / 180; // zone 33 central meridian
const FALSE_EASTING = 500000;

const E4 = E2 * E2;
const E6 = E4 * E2;

/** Meridional arc length from the equator to `lat` (radians). */
function meridianArc(lat) {
  return (
    A *
    ((1 - E2 / 4 - (3 * E4) / 64 - (5 * E6) / 256) * lat -
      ((3 * E2) / 8 + (3 * E4) / 32 + (45 * E6) / 1024) * Math.sin(2 * lat) +
      ((15 * E4) / 256 + (45 * E6) / 1024) * Math.sin(4 * lat) -
      ((35 * E6) / 3072) * Math.sin(6 * lat))
  );
}

/** Longitude/latitude (degrees) to UTM zone 33N easting/northing (metres). */
export function lonLatToUtm33(lon, lat) {
  const phi = (lat * Math.PI) / 180;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const nu = A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  const t = tanPhi * tanPhi;
  const c = EP2 * cosPhi * cosPhi;
  const lambda = (lon * Math.PI) / 180 - LON0;
  const aTerm = lambda * cosPhi;
  const a2 = aTerm * aTerm;
  const a3 = a2 * aTerm;
  const a4 = a2 * a2;
  const a5 = a4 * aTerm;
  const a6 = a4 * a2;
  const m = meridianArc(phi);
  const easting =
    K0 *
      nu *
      (aTerm + ((1 - t + c) * a3) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * EP2) * a5) / 120) +
    FALSE_EASTING;
  const northing =
    K0 *
    (m +
      nu *
        tanPhi *
        (a2 / 2 +
          ((5 - t + 9 * c + 4 * c * c) * a4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * EP2) * a6) / 720));
  return [easting, northing];
}

/** UTM zone 33N easting/northing (metres) to longitude/latitude (degrees). */
export function utm33ToLonLat(easting, northing) {
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const m = northing / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E4) / 64 - (5 * E6) / 256));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);
  const nu1 = A / Math.sqrt(1 - E2 * sinPhi1 * sinPhi1);
  const r1 = (A * (1 - E2)) / (1 - E2 * sinPhi1 * sinPhi1) ** 1.5;
  const t1 = tanPhi1 * tanPhi1;
  const c1 = EP2 * cosPhi1 * cosPhi1;
  const d = (easting - FALSE_EASTING) / (nu1 * K0);
  const d2 = d * d;
  const d3 = d2 * d;
  const d4 = d2 * d2;
  const d5 = d4 * d;
  const d6 = d4 * d2;
  const lat =
    phi1 -
    ((nu1 * tanPhi1) / r1) *
      (d2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d6) / 720);
  const lon =
    LON0 +
    (d -
      ((1 + 2 * t1 + c1) * d3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d5) / 120) /
      cosPhi1;
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}
