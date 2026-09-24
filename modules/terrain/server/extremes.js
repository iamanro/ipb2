import { longitudeScale } from './dem.js';

const METRES_PER_DEGREE_LATITUDE = 111132.95;

/** Even-odd ray casting over every ring, so holes count as outside. */
export function insidePolygon(lon, lat, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * Highest and lowest ground inside a GeoJSON Polygon or MultiPolygon, from
 * an even sample grid over its envelope: as fine as the 30 m model allows,
 * coarsened so no more than `maxSamples` are taken. Cells outside the
 * polygon or without elevation data are skipped.
 * Returns `{ cellMetres, highest, lowest }`, each `{ lon, lat, elevation }`
 * or null when the polygon has no data.
 */
export function elevationExtremes(elevation, geometry, { maxSamples = 250_000 } = {}) {
  let polygons;
  if (geometry?.type === 'Polygon') polygons = [geometry.coordinates];
  else if (geometry?.type === 'MultiPolygon') polygons = geometry.coordinates;
  else throw new Error('The area must be a GeoJSON Polygon or MultiPolygon.');

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of polygons.flat(2)) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  if (!(west < east && south < north)) throw new Error('The area is empty.');

  const middle = (south + north) / 2;
  const width = (east - west) * longitudeScale(middle);
  const height = (north - south) * METRES_PER_DEGREE_LATITUDE;
  const cellMetres = Math.max(30, Math.sqrt((width * height) / maxSamples));
  const stepLat = cellMetres / METRES_PER_DEGREE_LATITUDE;
  const stepLon = cellMetres / longitudeScale(middle);

  let highest = null;
  let lowest = null;
  for (let lat = south + stepLat / 2; lat < north; lat += stepLat) {
    for (let lon = west + stepLon / 2; lon < east; lon += stepLon) {
      if (!polygons.some((rings) => insidePolygon(lon, lat, rings))) continue;
      const value = elevation(lon, lat);
      if (!Number.isFinite(value)) continue;
      if (!highest || value > highest.elevation) highest = { lon, lat, elevation: value };
      if (!lowest || value < lowest.elevation) lowest = { lon, lat, elevation: value };
    }
  }
  return { cellMetres, highest, lowest };
}
