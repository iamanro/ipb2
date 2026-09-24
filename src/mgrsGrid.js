// MGRS grid geometry for a map view: grid zone (GZD) boundaries, 100 km
// square boundaries, and 10 km / 1 km lines, all as lon/lat polylines plus
// label points. Pure: no DOM, no OpenLayers, so it is tested directly.
//
// Grid lines are straight in UTM, so each one is generated in its own zone's
// UTM coordinates, densified, projected to lon/lat, and clipped to that
// zone's cell. That is what makes lines stop at zone boundaries instead of
// running across into the neighbouring zone's (differently rotated) grid.
import { forward } from 'mgrs';

import { lonLatToUtm, utmToLonLat } from './geo.js';

const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
/** UTM/MGRS latitude coverage; beyond it MGRS switches to UPS polar grids. */
const MGRS_EXTENT = [-180, -80, 180, 84];
const SPACINGS = [1000, 10000, 100000];
/**
 * Smallest on-screen gap between adjacent lines, in CSS pixels. Spacings are
 * 10× apart, so just below this the next coarser grid is ~10× sparser; 40 px
 * keeps that worst case to about one line per 400 px, not a near-empty view.
 */
const MIN_LINE_GAP_PX = 40;
/** Segments per grid line; UTM lines curve gently in lon/lat. */
const LINE_SEGMENTS = 24;
/** Samples per cell edge when finding a cell's UTM easting/northing range. */
const EDGE_SAMPLES = 8;
/** Guard against pathological views generating thousands of lines. */
const MAX_LINES_PER_AXIS = 200;
/** Degrees; a clipped endpoint within this of a box edge lies on it. */
const EDGE_EPSILON = 1e-9;

/**
 * Line spacing in metres for a ground resolution (metres per CSS pixel):
 * the finest of 1 / 10 / 100 km whose lines stay at least MIN_LINE_GAP_PX
 * apart, or null when even 100 km would be too dense (GZD boundaries only).
 */
export function mgrsGridSpacing(metresPerPixel) {
  return SPACINGS.find((spacing) => spacing / metresPerPixel >= MIN_LINE_GAP_PX) ?? null;
}

/** Zone longitude ranges for one latitude band, with the Norway/Svalbard exceptions. */
function bandZones(band) {
  if (band === 'V') {
    return [...standardZones().filter(([zone]) => zone < 31 || zone > 32), [31, 0, 3], [32, 3, 12]];
  }
  if (band === 'X') {
    return [
      ...standardZones().filter(([zone]) => zone < 31 || zone > 37),
      [31, 0, 9],
      [33, 9, 21],
      [35, 21, 33],
      [37, 33, 42],
    ];
  }
  return standardZones();
}

let standardZoneCache;
function standardZones() {
  standardZoneCache ??= Array.from({ length: 60 }, (_, index) => [
    index + 1,
    -180 + index * 6,
    -174 + index * 6,
  ]);
  return standardZoneCache;
}

function intersect(a, b) {
  const box = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return box[0] < box[2] && box[1] < box[3] ? box : null;
}

/** Grid zone cells (zone × latitude band) overlapping a lon/lat extent. */
export function gridZoneCells(extent) {
  const cells = [];
  BANDS.split('').forEach((band, index) => {
    const south = -80 + index * 8;
    const north = band === 'X' ? 84 : south + 8;
    if (north <= extent[1] || south >= extent[3]) return;
    for (const [zone, west, east] of bandZones(band)) {
      if (east <= extent[0] || west >= extent[2]) continue;
      cells.push({
        zone,
        band,
        box: [west, south, east, north],
        hemisphere: south < 0 ? 'S' : 'N',
      });
    }
  });
  return cells;
}

/** Liang–Barsky: the part of segment p→q inside `box`, with its parameters. */
function clipSegment(p, q, box) {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  for (const [edge, distance] of [
    [-dx, p[0] - box[0]],
    [dx, box[2] - p[0]],
    [-dy, p[1] - box[1]],
    [dy, box[3] - p[1]],
  ]) {
    if (edge === 0) {
      if (distance < 0) return null;
      continue;
    }
    const t = distance / edge;
    if (edge < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return {
    t0,
    t1,
    from: t0 === 0 ? p : [p[0] + t0 * dx, p[1] + t0 * dy],
    to: t1 === 1 ? q : [p[0] + t1 * dx, p[1] + t1 * dy],
  };
}

/** The runs of a polyline that lie inside `box`, in input order. */
export function clipPolyline(points, box) {
  const runs = [];
  let run = null;
  let continuous = false;
  for (let index = 0; index < points.length - 1; index += 1) {
    const clipped = clipSegment(points[index], points[index + 1], box);
    if (!clipped) {
      if (run) runs.push(run);
      run = null;
      continuous = false;
      continue;
    }
    if (run && continuous && clipped.t0 === 0) run.push(clipped.to);
    else {
      if (run) runs.push(run);
      run = [clipped.from, clipped.to];
    }
    continuous = clipped.t1 === 1;
  }
  if (run) runs.push(run);
  return runs;
}

/** Min/max easting and northing of a lon/lat box, projected into `zone`. */
function utmRange(box, zone) {
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  const [west, south, east, north] = box;
  for (let step = 0; step <= EDGE_SAMPLES; step += 1) {
    const f = step / EDGE_SAMPLES;
    const lon = west + (east - west) * f;
    const lat = south + (north - south) * f;
    for (const [x, y] of [
      [lon, south],
      [lon, north],
      [west, lat],
      [east, lat],
    ]) {
      const { easting, northing } = lonLatToUtm(x, y, zone);
      if (easting < minE) minE = easting;
      if (easting > maxE) maxE = easting;
      if (northing < minN) minN = northing;
      if (northing > maxN) maxN = northing;
    }
  }
  return { minE, maxE, minN, maxN };
}

function multiplesIn(min, max, spacing) {
  const values = [];
  for (let value = Math.ceil(min / spacing) * spacing; value <= max; value += spacing) {
    values.push(value);
  }
  return values.length > MAX_LINES_PER_AXIS ? [] : values;
}

/** The two "principal digits" printed on map grid lines: kilometres mod 100. */
function principalDigits(metres) {
  return String(Math.floor(Math.round(metres) / 1000) % 100).padStart(2, '0');
}

function toLonLat(cell, easting, northing) {
  const { lon, lat } = utmToLonLat(cell.zone, cell.hemisphere, easting, northing);
  return [lon, lat];
}

/** One grid line at a fixed easting (`axis: 'easting'`) or northing. */
function gridLine(cell, axis, value, range) {
  const [from, to] = axis === 'easting' ? [range.minN, range.maxN] : [range.minE, range.maxE];
  const points = [];
  for (let step = 0; step <= LINE_SEGMENTS; step += 1) {
    const along = from + ((to - from) * step) / LINE_SEGMENTS;
    points.push(axis === 'easting' ? toLonLat(cell, value, along) : toLonLat(cell, along, value));
  }
  return points;
}

/**
 * Grid geometry for a view.
 *
 *   extent      visible lon/lat extent [west, south, east, north]: labels
 *               are placed on its edges (easting digits along the bottom,
 *               northing digits down the left, like a paper map sheet)
 *   drawExtent  a larger extent the lines are generated for, so panning does
 *               not reveal ungridded margins before the next rebuild
 *   spacing     1000 | 10000 | 100000 metres, or null for GZD lines only
 *
 * Returns `{ lines: [{ rank, coordinates }], labels: [{ kind, text, coordinate }] }`
 * with rank 'zone' | 'square' | 'line' and kind 'zone' | 'square' |
 * 'easting' | 'northing'; coordinates are [lon, lat].
 */
export function buildMgrsGrid({ extent, drawExtent = extent, spacing }) {
  const lines = [];
  const labels = [];
  const view = intersect(extent, MGRS_EXTENT);
  const draw = intersect(drawExtent, MGRS_EXTENT);
  if (!view || !draw) return { lines, labels };

  for (const cell of gridZoneCells(draw)) {
    const [west, south, east, north] = cell.box;
    // Each boundary is drawn once: every meridian boundary is some cell's
    // west edge and every parallel some cell's south edge; only 84°N is not.
    const edges = [
      [
        [west, south],
        [west, north],
      ],
      [
        [west, south],
        [east, south],
      ],
    ];
    if (north === 84) {
      edges.push([
        [west, north],
        [east, north],
      ]);
    }
    for (const edge of edges) {
      for (const coordinates of clipPolyline(edge, draw)) lines.push({ rank: 'zone', coordinates });
    }

    const drawBox = intersect(cell.box, draw);
    const viewBox = intersect(cell.box, view);
    if (viewBox && (spacing === null || spacing === 100000)) {
      labels.push({
        kind: 'zone',
        text: `${cell.zone}${cell.band}`,
        coordinate: [(viewBox[0] + viewBox[2]) / 2, (viewBox[1] + viewBox[3]) / 2],
      });
    }
    if (spacing === null || !drawBox) continue;

    const range = utmRange(drawBox, cell.zone);
    for (const axis of ['easting', 'northing']) {
      const [min, max] = axis === 'easting' ? [range.minE, range.maxE] : [range.minN, range.maxN];
      for (const value of multiplesIn(min, max, spacing)) {
        const points = gridLine(cell, axis, value, range);
        const rank = value % 100000 === 0 ? 'square' : 'line';
        for (const coordinates of clipPolyline(points, drawBox)) lines.push({ rank, coordinates });
        if (spacing === 100000 || !viewBox) continue;
        // Points run south→north (easting lines) or west→east (northing
        // lines), so a line's first visible point is where it enters the
        // view. Grid convergence tilts lines, so a northing line can enter
        // through the bottom edge; only label lines where they meet their
        // own edge, or northing digits would sit among the easting ones.
        const start = clipPolyline(points, viewBox)[0]?.[0];
        const onOwnEdge =
          start &&
          (axis === 'easting'
            ? Math.abs(start[1] - viewBox[1]) < EDGE_EPSILON
            : Math.abs(start[0] - viewBox[0]) < EDGE_EPSILON);
        if (onOwnEdge) labels.push({ kind: axis, text: principalDigits(value), coordinate: start });
      }
    }

    if (!viewBox) continue;
    const visible = utmRange(viewBox, cell.zone);
    for (const squareE of multiplesIn(Math.floor(visible.minE / 1e5) * 1e5, visible.maxE, 1e5)) {
      for (const squareN of multiplesIn(Math.floor(visible.minN / 1e5) * 1e5, visible.maxN, 1e5)) {
        // Centre of the visible part of this 100 km square.
        const centre = toLonLat(
          cell,
          (Math.max(squareE, visible.minE) + Math.min(squareE + 1e5, visible.maxE)) / 2,
          (Math.max(squareN, visible.minN) + Math.min(squareN + 1e5, visible.maxN)) / 2,
        );
        if (
          centre[0] <= viewBox[0] ||
          centre[0] >= viewBox[2] ||
          centre[1] <= viewBox[1] ||
          centre[1] >= viewBox[3]
        ) {
          continue;
        }
        const id = forward(centre, 0); // e.g. "33UXR"
        labels.push({
          kind: 'square',
          text: `${id.slice(0, -2)} ${id.slice(-2)}`,
          coordinate: centre,
        });
      }
    }
  }
  return { lines, labels };
}
