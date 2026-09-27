/**
 * An area's corners as text and back: one corner per line in any notation
 * `src/geo.js`'s `parseCoordinate` reads (MGRS, UTM, DMS, decimal degrees).
 * Pure (no DOM); `areas.js` builds the table and the editor on it.
 */
import { formatMgrs, parseCoordinate } from '../../../src/geo.js';

export const CORNER_FORMATS = {
  mgrs: 'MGRS',
  dd: 'Decimal degrees',
};

/** Decimal degrees to 6 places (~0.1 m), latitude first, e.g. "49.701234 N 17.504211 E". */
export function formatDegrees(lon, lat) {
  const latText = `${Math.abs(lat).toFixed(6)} ${lat < 0 ? 'S' : 'N'}`;
  const lonText = `${Math.abs(lon).toFixed(6)} ${lon < 0 ? 'W' : 'E'}`;
  return `${latText} ${lonText}`;
}

/** One corner as a line of text in `format` ('mgrs' | 'dd'). */
export function formatCorner([lon, lat], format) {
  return format === 'dd' ? formatDegrees(lon, lat) : formatMgrs(lon, lat, 5, { spaced: true });
}

/**
 * Reads one corner per non-empty line. A line that is exactly how
 * `originals` (the corners the text was filled with) printed it keeps that
 * corner's exact position, so saving untouched text never moves a corner by
 * the rounding of its notation. A last line repeating the first (a closed
 * ring pasted from elsewhere) is dropped.
 *
 * Returns `{ corners, errors }`: `errors` is `[{ line, text }]` (1-based
 * line numbers) for lines that are no coordinate, plus `{ line: null, text }`
 * when there are fewer than 3 different corners.
 */
export function parseCornerLines(text, { originals = [], format = 'mgrs' } = {}) {
  const exact = new Map(originals.map((corner) => [formatCorner(corner, format), corner]));
  const corners = [];
  const errors = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const kept = exact.get(line);
    if (kept) {
      corners.push([kept[0], kept[1]]);
      return;
    }
    const parsed = parseCoordinate(line);
    if (parsed) corners.push([parsed.lon, parsed.lat]);
    else errors.push({ line: index + 1, text: line });
  });
  if (corners.length > 1) {
    const [first, last] = [corners[0], corners.at(-1)];
    if (first[0] === last[0] && first[1] === last[1]) corners.pop();
  }
  const distinct = new Set(corners.map(([lon, lat]) => `${lon},${lat}`));
  if (!errors.length && distinct.size < 3) {
    errors.push({ line: null, text: 'An area needs at least 3 different corners.' });
  }
  return { corners, errors };
}
