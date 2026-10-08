import { GO, NO_GO, SLOW_GO, UNKNOWN, openLandcover } from './landcover.ts';
import type { ElevationModel } from './dem.ts';
import { latticeOver, type Bounds } from './lattice.ts';

/** One obstacle class per cell over a lattice: the MCOO grid. */
export type MobilityGrid = Awaited<ReturnType<typeof mobilityOverlay>>;

export const LEGEND = [
  { value: GO, code: 'GO', label: 'Unrestricted', color: '#2f7a3d' },
  { value: SLOW_GO, code: 'SLOW-GO', label: 'Restricted', color: '#c98a1b' },
  { value: NO_GO, code: 'NO-GO', label: 'Severely restricted', color: '#a32b2b' },
  { value: UNKNOWN, code: 'UNKNOWN', label: 'No data', color: '#6b7280' },
];

/** Slope band thresholds in degrees, per doctrinal cross-country mobility. */
export const SLOW_GO_SLOPE = 10;
export const NO_GO_SLOPE = 30;

export function slopeClass(degrees: number) {
  if (Number.isNaN(degrees)) return UNKNOWN;
  if (degrees >= NO_GO_SLOPE) return NO_GO;
  if (degrees >= SLOW_GO_SLOPE) return SLOW_GO;
  return GO;
}

/**
 * Modified combined obstacle overlay for one area of interest.
 *
 * Combines DEM slope bands with water, waterways, buildings, forest and
 * built-up areas from the offline vector basemap. `values` is one obstacle
 * class per cell, row-major, row 0 on the northern edge.
 */
export async function mobilityOverlay({
  terrain,
  basemapFile,
  bounds,
  cellMetres = 50,
  maxCells = 360000,
}: {
  terrain: ElevationModel;
  basemapFile: string;
  bounds: Bounds;
  cellMetres?: number;
  maxCells?: number;
}) {
  const grid = latticeOver(bounds, { cellMetres, maxCells });
  const { width, height, cellMetres: resolution } = grid;

  const landcover = openLandcover(basemapFile);
  let cover: Uint8Array;
  try {
    cover = await landcover.classify(grid);
  } finally {
    await landcover.close();
  }

  const values = new Uint8Array(width * height);
  const counts = new Map(LEGEND.map((entry) => [entry.value, 0]));
  for (let row = 0; row < height; row += 1) {
    const latitude = grid.lat(row);
    for (let column = 0; column < width; column += 1) {
      const longitude = grid.lon(column);
      const index = row * width + column;
      const fromSlope = slopeClass(terrain.slopeDegrees(longitude, latitude));
      const fromCover = cover[index];
      const value =
        fromSlope === UNKNOWN
          ? UNKNOWN
          : Math.max(fromSlope, fromCover === UNKNOWN ? 0 : fromCover);
      values[index] = value;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }

  const total = width * height;
  return {
    extent: grid.extent,
    cellMetres: resolution,
    width,
    height,
    legend: LEGEND,
    summary: LEGEND.map((entry) => ({
      code: entry.code,
      cells: counts.get(entry.value) || 0,
      share: total ? (counts.get(entry.value) || 0) / total : 0,
      areaSquareKm: ((counts.get(entry.value) || 0) * resolution ** 2) / 1e6,
    })),
    values,
  };
}
