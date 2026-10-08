import type { Geometry, Position } from '../../../server/geometry.ts';
import type { ElevationFn } from './dem.ts';
import { latticeOver } from './lattice.ts';

type Spot = { lon: number; lat: number; elevation: number };

/** Even-odd ray casting over every ring, so holes count as outside. */
export function insidePolygon(lon: number, lat: number, rings: Position[][]) {
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
export function elevationExtremes(
  elevation: ElevationFn,
  geometry: Geometry | null | undefined,
  { maxSamples = 250_000 }: { maxSamples?: number } = {},
) {
  let polygons: Position[][][];
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

  const grid = latticeOver([west, south, east, north], { cellMetres: 30, maxCells: maxSamples });

  let highest: Spot | null = null;
  let lowest: Spot | null = null;
  for (let row = 0; row < grid.height; row += 1) {
    const lat = grid.lat(row);
    for (let column = 0; column < grid.width; column += 1) {
      const lon = grid.lon(column);
      if (!polygons.some((rings) => insidePolygon(lon, lat, rings))) continue;
      const value = elevation(lon, lat);
      if (!Number.isFinite(value)) continue;
      if (!highest || value > highest.elevation) highest = { lon, lat, elevation: value };
      if (!lowest || value < lowest.elevation) lowest = { lon, lat, elevation: value };
    }
  }
  return { cellMetres: grid.cellMetres, highest, lowest };
}
