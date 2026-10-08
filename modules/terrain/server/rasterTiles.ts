// Raster overlays rendered per web-mercator tile from the elevation model:
// hillshade (Terrain basemap) and slope classes. Both need the terrain
// gradient at every pixel, which `forEachGradient` provides.
import { NO_GO, SLOW_GO } from './landcover.ts';
import { LEGEND, NO_GO_SLOPE, SLOW_GO_SLOPE, slopeClass } from './mobility.ts';
import { tileXToLon, tileYToLat } from './tiles.ts';

/** Equatorial circumference of the web-mercator sphere, in metres. */
const MERCATOR_CIRCUMFERENCE = 40075016.686;

/**
 * Calls `visit(index, dzdx, dzdy)` for every pixel of tile z/x/y with the
 * terrain gradient (metres per metre, east and north), skipping pixels where
 * any neighbour lacks elevation data. `index` is the pixel's row-major index.
 * `elevation(lon, lat)` returns metres or NaN.
 */
function forEachGradient(elevation, z, x, y, size, visit) {
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
  for (let row = 0; row < size; row += 1) {
    const centre = (row + 1) * span + 1;
    const spacing = 2 * rowMetres[row + 1];
    for (let column = 0; column < size; column += 1) {
      const index = centre + column;
      const west = heights[index - 1];
      const east = heights[index + 1];
      const north = heights[index - span]; // rows run north to south
      const south = heights[index + span];
      if (Number.isNaN(west + east + north + south)) continue;
      visit(row * size + column, (east - west) / spacing, (north - south) / spacing);
    }
  }
}

// -- Hillshade ------------------------------------------------------------------

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
 * Hillshade overlay for one tile, as RGBA bytes.
 *
 * Drawn over the vector basemap rather than under it: flat ground is fully
 * transparent, slopes facing away from the sun get translucent black and
 * slopes facing it translucent white, so the basemap's own colours survive.
 * Pixels without elevation data (outside the built area) are transparent.
 */
export function renderHillshade(elevation, z, x, y, size = 256) {
  const rgba = new Uint8Array(size * size * 4);
  forEachGradient(elevation, z, x, y, size, (index, gx, gy) => {
    const dzdx = gx * VERTICAL_EXAGGERATION;
    const dzdy = gy * VERTICAL_EXAGGERATION;
    // Surface normal (-dz/dx, -dz/dy, 1), normalised, dotted with the sun.
    const light = (-dzdx * SUN[0] - dzdy * SUN[1] + SUN[2]) / Math.hypot(dzdx, dzdy, 1);
    const out = index * 4;
    if (light < FLAT) {
      rgba[out + 3] = Math.round((Math.min(FLAT - light, FLAT) / FLAT) * SHADOW_ALPHA);
    } else {
      rgba[out] = 255;
      rgba[out + 1] = 255;
      rgba[out + 2] = 255;
      rgba[out + 3] = Math.round(((light - FLAT) / (1 - FLAT)) * HIGHLIGHT_ALPHA);
    }
  });
  return rgba;
}

// -- Slope classes ----------------------------------------------------------------

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Same colours as the MCOO legend, drawn as hatching over a light tint: a
 * flat amber fill was hard to tell from brown contour lines, while hatching
 * reads as an area. SLOW-GO is single-hatched, NO-GO cross-hatched.
 */
/** The mobility legend entry for a class; the classes here are constants, so a miss is a bug. */
function legendEntry(value: number) {
  const entry = LEGEND.find((candidate) => candidate.value === value);
  if (!entry) throw new Error(`No mobility legend entry for class ${value}.`);
  return entry;
}

const HATCHES: [number, { tint: number; stroke: number; cross: boolean }][] = [
  [SLOW_GO, { tint: 35, stroke: 170, cross: false }],
  [NO_GO, { tint: 70, stroke: 200, cross: true }],
];
const SLOPE_HATCH = new Map(
  HATCHES.map(([value, hatch]) => [value, { ...hatch, rgb: hexToRgb(legendEntry(value).color) }]),
);
/** Hatch period and stripe width in pixels. */
const HATCH_PERIOD = 7;
const HATCH_WIDTH = 2;

/**
 * Slope-class overlay for one tile, as RGBA bytes: SLOW-GO and NO-GO slopes
 * (mobility.js `slopeClass`, true slope, no exaggeration) are hatched in
 * their MCOO colours; GO ground and pixels without data stay transparent.
 * The hatch follows global pixel positions, so it continues across tiles.
 */
export function renderSlopeClasses(elevation, z, x, y, size = 256) {
  const rgba = new Uint8Array(size * size * 4);
  forEachGradient(elevation, z, x, y, size, (index, dzdx, dzdy) => {
    const hatch = SLOPE_HATCH.get(slopeClass((Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI));
    if (!hatch) return;
    const gx = x * size + (index % size);
    const gy = y * size + Math.floor(index / size);
    const onStripe =
      (gx + gy) % HATCH_PERIOD < HATCH_WIDTH ||
      (hatch.cross && (((gx - gy) % HATCH_PERIOD) + HATCH_PERIOD) % HATCH_PERIOD < HATCH_WIDTH);
    rgba.set([...hatch.rgb, onStripe ? hatch.stroke : hatch.tint], index * 4);
  });
  return rgba;
}

/** Legend for the classes `renderSlopeClasses` tints, with their slope bands. */
export const SLOPE_LEGEND = [
  { value: SLOW_GO, range: `${SLOW_GO_SLOPE}–${NO_GO_SLOPE}°` },
  { value: NO_GO, range: `≥ ${NO_GO_SLOPE}°` },
].map(({ value, range }) => {
  const { code, label, color } = legendEntry(value);
  return { code, label, color, range };
});
