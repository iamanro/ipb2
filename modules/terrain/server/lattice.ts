/**
 * The terrain server's local metric plane: degrees to metres by an
 * equirectangular approximation at a reference latitude, and lattices of
 * square cells over lon/lat bounds. Every analysis grid (MCOO, viewshed, key
 * terrain, extremes) is a lattice, so a cell means the same ground everywhere.
 */

export type LonLat = { lon: number; lat: number };
/** `[west, south, east, north]` in degrees. */
export type Bounds = [number, number, number, number];
export type Lattice = ReturnType<typeof latticeOf>;

export const METRES_PER_DEGREE_LATITUDE = 111132.95;
const METRES_PER_DEGREE_LONGITUDE = 111319.49;

/** Metres per degree of longitude at a latitude. */
export function longitudeScale(latitude: number) {
  return METRES_PER_DEGREE_LONGITUDE * Math.cos((latitude * Math.PI) / 180);
}

export function metresBetween(a: LonLat, b: LonLat) {
  const dx = (b.lon - a.lon) * longitudeScale((a.lat + b.lat) / 2);
  const dy = (b.lat - a.lat) * METRES_PER_DEGREE_LATITUDE;
  return Math.hypot(dx, dy);
}

/**
 * Square cells of `cellMetres` covering `bounds` ([west, south, east, north]),
 * anchored at the north-west corner, row 0 on the northern edge. When covering
 * the bounds would take more than `maxCells` cells, every cell grows by the
 * same factor. The last column and row may reach past the east and south
 * edges so that no ground inside `bounds` is left out; `extent` is the ground
 * the cells actually cover.
 */
export function latticeOver(
  bounds: Bounds,
  { cellMetres, maxCells }: { cellMetres: number; maxCells: number },
) {
  const [west, south, east, north] = bounds;
  const metresPerLongitude = longitudeScale((south + north) / 2);
  const spanX = (east - west) * metresPerLongitude;
  const spanY = (north - south) * METRES_PER_DEGREE_LATITUDE;
  const natural = (spanX / cellMetres) * (spanY / cellMetres);
  const cell = natural > maxCells ? cellMetres * Math.sqrt(natural / maxCells) : cellMetres;
  // The epsilon keeps a span of exactly N cells from rounding up to N + 1.
  const width = Math.max(Math.ceil(spanX / cell - 1e-9), 1);
  const height = Math.max(Math.ceil(spanY / cell - 1e-9), 1);
  return latticeOf({
    extent: [
      west,
      north - (height * cell) / METRES_PER_DEGREE_LATITUDE,
      west + (width * cell) / metresPerLongitude,
      north,
    ],
    width,
    height,
    cellMetres: cell,
  });
}

/**
 * The lattice a grid payload (`{ extent, width, height, cellMetres }`, as
 * returned by the analyses) was built on.
 *
 * `lon(column)`/`lat(row)` are cell centres. `column(lon)`/`row(lat)` are
 * continuous positions: cell `c` spans `[c, c + 1)`, so `Math.floor` gives
 * the cell and values outside `[0, width)`/`[0, height)` are off the lattice.
 */
export function latticeOf({
  extent,
  width,
  height,
  cellMetres,
}: {
  extent: Bounds;
  width: number;
  height: number;
  cellMetres: number;
}) {
  const [west, south, east, north] = extent;
  const lonStep = (east - west) / width;
  const latStep = (north - south) / height;
  return {
    extent,
    width,
    height,
    cellMetres,
    lon: (column: number) => west + (column + 0.5) * lonStep,
    lat: (row: number) => north - (row + 0.5) * latStep,
    column: (lon: number) => (lon - west) / lonStep,
    row: (lat: number) => (north - lat) / latStep,
  };
}
