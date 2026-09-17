import { longitudeScale } from './dem.js';
import { GO, NO_GO, SLOW_GO, UNKNOWN, openLandcover } from './landcover.js';

const METRES_PER_DEGREE_LATITUDE = 111132.95;

export const LEGEND = [
  { value: GO, code: 'GO', label: 'Unrestricted', color: '#2f7a3d' },
  { value: SLOW_GO, code: 'SLOW-GO', label: 'Restricted', color: '#c98a1b' },
  { value: NO_GO, code: 'NO-GO', label: 'Severely restricted', color: '#a32b2b' },
  { value: UNKNOWN, code: 'UNKNOWN', label: 'No data', color: '#6b7280' },
];

/** Slope band thresholds in degrees, per doctrinal cross-country mobility. */
const SLOW_GO_SLOPE = 10;
const NO_GO_SLOPE = 30;

function slopeClass(degrees) {
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
}) {
  const [west, south, east, north] = bounds;
  const midLatitude = (south + north) / 2;
  const metresPerLongitude = longitudeScale(midLatitude);
  const spanX = (east - west) * metresPerLongitude;
  const spanY = (north - south) * METRES_PER_DEGREE_LATITUDE;
  const cells = (spanX / cellMetres) * (spanY / cellMetres);
  const resolution = cells > maxCells ? cellMetres * Math.sqrt(cells / maxCells) : cellMetres;
  const width = Math.max(Math.round(spanX / resolution), 1);
  const height = Math.max(Math.round(spanY / resolution), 1);

  const grid = {
    west,
    north,
    cellMetres: resolution,
    width,
    height,
    metresPerLongitude,
    metresPerLatitude: METRES_PER_DEGREE_LATITUDE,
  };

  const landcover = openLandcover(basemapFile);
  let cover;
  try {
    cover = await landcover.classify(grid);
  } finally {
    await landcover.close();
  }

  const values = new Uint8Array(width * height);
  const counts = new Map(LEGEND.map((entry) => [entry.value, 0]));
  for (let row = 0; row < height; row += 1) {
    const latitude = north - ((row + 0.5) * resolution) / METRES_PER_DEGREE_LATITUDE;
    for (let column = 0; column < width; column += 1) {
      const longitude = west + ((column + 0.5) * resolution) / metresPerLongitude;
      const index = row * width + column;
      const fromSlope = slopeClass(terrain.slopeDegrees(longitude, latitude));
      const fromCover = cover[index];
      const value =
        fromSlope === UNKNOWN ? UNKNOWN : Math.max(fromSlope, fromCover === UNKNOWN ? 0 : fromCover);
      values[index] = value;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }

  const total = width * height;
  return {
    extent: [
      west,
      north - (height * resolution) / METRES_PER_DEGREE_LATITUDE,
      west + (width * resolution) / metresPerLongitude,
      north,
    ],
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
