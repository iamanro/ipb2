/**
 * Point-in-geometry matching for auto-NAI linking: a report lands inside
 * the first NAI/TAI whose polygon contains it, or within 250 m of a point
 * NAI. Pure geometry, no database — the geometry is whatever IPB exported
 * (GeoJSON Polygon with holes, MultiPolygon, or Point).
 */
const POINT_MATCH_RADIUS_M = 250;
const EARTH_RADIUS_M = 6_371_000;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in metres between two lon/lat points (haversine). */
export function haversineMetres(lon1, lat1, lon2, lat2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, a)));
}

/**
 * Ray-cast point-in-ring (even-odd rule). `ring` is `[[lon, lat], ...]`,
 * closed or not — the wrap-around edge is always tested.
 */
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > lat !== yj > lat;
    if (!crosses) continue;
    const xAtLat = xi + ((xj - xi) * (lat - yi)) / (yj - yi);
    if (lon < xAtLat) inside = !inside;
  }
  return inside;
}

/** Point-in-polygon with holes: inside ring 0, outside every later ring. */
function pointInPolygonRings(lon, lat, rings) {
  if (!rings.length || !pointInRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i += 1) {
    if (pointInRing(lon, lat, rings[i])) return false;
  }
  return true;
}

/**
 * True when `[lon, lat]` matches a GeoJSON geometry: inside a
 * Polygon/MultiPolygon (holes excluded), or within 250 m of a Point.
 * Unknown or malformed geometry never matches.
 */
export function geometryContains(geometry, lon, lat) {
  if (!geometry || typeof geometry !== 'object' || !Array.isArray(geometry.coordinates)) {
    return false;
  }
  switch (geometry.type) {
    case 'Point': {
      const [glon, glat] = geometry.coordinates;
      return haversineMetres(lon, lat, glon, glat) <= POINT_MATCH_RADIUS_M;
    }
    case 'Polygon':
      return pointInPolygonRings(lon, lat, geometry.coordinates);
    case 'MultiPolygon':
      return geometry.coordinates.some((polygon) => pointInPolygonRings(lon, lat, polygon));
    default:
      return false;
  }
}
