import { tileXToLon, tileYToLat } from './tiles.js';

/** Equatorial circumference of the web-mercator sphere, in metres. */
const MERCATOR_CIRCUMFERENCE = 40075016.686;
/** Cartographic convention: light from the north-west, 45° above the horizon. */
const SUN_AZIMUTH = (315 * Math.PI) / 180;
const SUN_ALTITUDE = (45 * Math.PI) / 180;
const SUN = [
  Math.sin(SUN_AZIMUTH) * Math.cos(SUN_ALTITUDE),
  Math.cos(SUN_AZIMUTH) * Math.cos(SUN_ALTITUDE),
  Math.sin(SUN_ALTITUDE),
];
/** Illumination of flat ground: the level the overlay leaves untouched. */
const FLAT = SUN[2];
/** Relief in rolling country reads flat at true scale; exaggerate it. */
const VERTICAL_EXAGGERATION = 2;
const SHADOW_ALPHA = 150;
const HIGHLIGHT_ALPHA = 90;

/**
 * Hillshade overlay for one web-mercator tile, as RGBA bytes.
 *
 * Drawn over the vector basemap rather than under it: flat ground is fully
 * transparent, slopes facing away from the sun get translucent black and
 * slopes facing it translucent white, so the basemap's own colours survive.
 * Pixels without elevation data (outside the built area) are transparent.
 *
 * `elevation(lon, lat)` returns metres or NaN.
 */
export function renderHillshade(elevation, z, x, y, size = 256) {
  // Elevation at every pixel centre plus a one-pixel border, so each output
  // pixel has all four neighbours for central differences.
  const span = size + 2;
  const heights = new Float64Array(span * span);
  const rowMetres = new Float64Array(span);
  for (let row = 0; row < span; row += 1) {
    const lat = tileYToLat(y + (row - 0.5) / size, z);
    rowMetres[row] = (MERCATOR_CIRCUMFERENCE / (size * 2 ** z)) * Math.cos((lat * Math.PI) / 180);
    for (let column = 0; column < span; column += 1) {
      heights[row * span + column] = elevation(tileXToLon(x + (column - 0.5) / size, z), lat);
    }
  }

  const rgba = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    const centre = (row + 1) * span + 1;
    const spacing = 2 * rowMetres[row + 1];
    for (let column = 0; column < size; column += 1) {
      const index = centre + column;
      const west = heights[index - 1];
      const east = heights[index + 1];
      const north = heights[index - span]; // rows run north to south
      const south = heights[index + span];
      if (Number.isNaN(west + east + north + south)) continue; // stays transparent
      const dzdx = ((east - west) / spacing) * VERTICAL_EXAGGERATION;
      const dzdy = ((north - south) / spacing) * VERTICAL_EXAGGERATION;
      // Surface normal (-dz/dx, -dz/dy, 1), normalised, dotted with the sun.
      const light = (-dzdx * SUN[0] - dzdy * SUN[1] + SUN[2]) / Math.hypot(dzdx, dzdy, 1);
      const out = (row * size + column) * 4;
      if (light < FLAT) {
        rgba[out + 3] = Math.round((Math.min(FLAT - light, FLAT) / FLAT) * SHADOW_ALPHA);
      } else {
        rgba[out] = 255;
        rgba[out + 1] = 255;
        rgba[out + 2] = 255;
        rgba[out + 3] = Math.round(((light - FLAT) / (1 - FLAT)) * HIGHLIGHT_ALPHA);
      }
    }
  }
  return rgba;
}
