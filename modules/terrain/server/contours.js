import { tileXToLon, tileYToLat } from './tiles.js';

/**
 * Contour interval, in metres, for zoom `z`: `minor` for every contour line,
 * `index` for the bolder line drawn every fifth (typically labelled) contour.
 * `null` below zoom 10, where terrain relief is too coarse on screen to be
 * worth drawing.
 */
export function contourInterval(z) {
  if (z >= 13) return { minor: 10, index: 50 };
  if (z === 12) return { minor: 20, index: 100 };
  if (z === 11) return { minor: 50, index: 250 };
  if (z === 10) return { minor: 100, index: 500 };
  return null;
}

/** Edge key for a horizontal edge crossing between (r, c) and (r, c + 1). */
function horizontalKey(r, c) {
  return `h:${r}:${c}`;
}

/** Edge key for a vertical edge crossing between (r, c) and (r + 1, c). */
function verticalKey(r, c) {
  return `v:${r}:${c}`;
}

/** Fraction along an edge where the level crosses, linearly interpolated. */
function crossingFraction(a, b, level) {
  return (level - a) / (b - a);
}

/**
 * Contour lines for one web-mercator tile as a GeoJSON `FeatureCollection`.
 *
 * `elevation(lon, lat)` returns metres or NaN outside the elevation model.
 * Sampling happens on the uniform mercator grid shared by every tile at this
 * zoom (one ring of samples is taken outside the tile too, and smoothed with
 * a 3x3 mean), so adjacent tiles produce identical vertices along their
 * shared edge and lines meet exactly at tile boundaries.
 */
export function contourTile(elevation, z, x, y, { samples = 128 } = {}) {
  const interval = contourInterval(z);
  if (!interval) return { type: 'FeatureCollection', features: [] };

  const raw = sampleGrid(elevation, z, x, y, samples);
  const grid = smoothGrid(raw, samples);

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < grid.length; i += 1) {
    const value = grid[i];
    if (Number.isNaN(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { type: 'FeatureCollection', features: [] };
  }

  const size = samples + 1;
  const features = [];
  const firstLevel = Math.ceil(min / interval.minor) * interval.minor;
  for (let level = firstLevel; level <= max; level += interval.minor) {
    for (const path of traceLevel(grid, size, level)) {
      features.push(pathToFeature(path, level, interval, z, x, y, samples));
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Elevation on the `(samples + 3)`-wide grid, one extra ring on every side. */
function sampleGrid(elevation, z, x, y, samples) {
  const span = samples + 3; // samples+1 tile points, plus one ring each side
  const grid = new Float64Array(span * span);
  for (let r = 0; r < span; r += 1) {
    const lat = tileYToLat(y + (r - 1) / samples, z);
    for (let c = 0; c < span; c += 1) {
      const lon = tileXToLon(x + (c - 1) / samples, z);
      grid[r * span + c] = elevation(lon, lat);
    }
  }
  return grid;
}

/** 3x3 mean of the padded grid, back down to `(samples + 1)` per side. */
function smoothGrid(raw, samples) {
  const rawSpan = samples + 3;
  const size = samples + 1;
  const out = new Float64Array(size * size);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      let sum = 0;
      for (let dr = 0; dr < 3; dr += 1) {
        for (let dc = 0; dc < 3; dc += 1) {
          sum += raw[(r + dr) * rawSpan + (c + dc)];
        }
      }
      // NaN propagates through the sum automatically when any of the nine
      // samples is NaN, which is exactly the semantics we want.
      out[r * size + c] = sum / 9;
    }
  }
  return out;
}

/**
 * Marching squares for one contour level, stitched into maximal polylines.
 * Returns an array of paths, each an array of `[row, col]` grid coordinates
 * (fractional at the crossed edges).
 */
function traceLevel(grid, size, level) {
  const points = new Map(); // edge key -> [row, col]
  const adjacency = new Map(); // edge key -> [edge key, ...] (<= 2 entries)

  const at = (r, c) => grid[r * size + c];

  const addSegment = (keyA, pointA, keyB, pointB) => {
    if (!points.has(keyA)) points.set(keyA, pointA);
    if (!points.has(keyB)) points.set(keyB, pointB);
    if (!adjacency.has(keyA)) adjacency.set(keyA, []);
    if (!adjacency.has(keyB)) adjacency.set(keyB, []);
    adjacency.get(keyA).push(keyB);
    adjacency.get(keyB).push(keyA);
  };

  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const tl = at(r, c);
      const tr = at(r, c + 1);
      const br = at(r + 1, c + 1);
      const bl = at(r + 1, c);
      if (Number.isNaN(tl) || Number.isNaN(tr) || Number.isNaN(br) || Number.isNaN(bl)) continue;

      const above =
        (tl >= level ? 1 : 0) |
        (tr >= level ? 2 : 0) |
        (br >= level ? 4 : 0) |
        (bl >= level ? 8 : 0);
      if (above === 0 || above === 15) continue;

      const topKey = horizontalKey(r, c);
      const topPoint = [r, c + crossingFraction(tl, tr, level)];
      const bottomKey = horizontalKey(r + 1, c);
      const bottomPoint = [r + 1, c + crossingFraction(bl, br, level)];
      const leftKey = verticalKey(r, c);
      const leftPoint = [r + crossingFraction(tl, bl, level), c];
      const rightKey = verticalKey(r, c + 1);
      const rightPoint = [r + crossingFraction(tr, br, level), c + 1];

      // Saddle cases (5 = tl+br above, 10 = tr+bl above) are resolved with
      // the cell's mean value: below the mean, the two "above" corners stay
      // disconnected; above it, they join instead.
      const resolved =
        above === 5 || above === 10
          ? average4(tl, tr, br, bl) >= level
            ? above
            : 15 - above
          : above;

      switch (resolved) {
        case 1: // tl only
        case 14: // all but tl
          addSegment(leftKey, leftPoint, topKey, topPoint);
          break;
        case 2: // tr only
        case 13: // all but tr
          addSegment(topKey, topPoint, rightKey, rightPoint);
          break;
        case 4: // br only
        case 11: // all but br
          addSegment(rightKey, rightPoint, bottomKey, bottomPoint);
          break;
        case 8: // bl only
        case 7: // all but bl
          addSegment(bottomKey, bottomPoint, leftKey, leftPoint);
          break;
        case 3: // tl+tr above
        case 12: // bl+br above
          addSegment(leftKey, leftPoint, rightKey, rightPoint);
          break;
        case 6: // tr+br above
        case 9: // tl+bl above
          addSegment(topKey, topPoint, bottomKey, bottomPoint);
          break;
        case 5: // saddle, disconnected: tl / br
          addSegment(leftKey, leftPoint, topKey, topPoint);
          addSegment(rightKey, rightPoint, bottomKey, bottomPoint);
          break;
        case 10: // saddle, disconnected: tr / bl
          addSegment(topKey, topPoint, rightKey, rightPoint);
          addSegment(bottomKey, bottomPoint, leftKey, leftPoint);
          break;
        default:
          break;
      }
    }
  }

  return walkPaths(points, adjacency);
}

function average4(a, b, c, d) {
  return (a + b + c + d) / 4;
}

/** Walks the edge/adjacency graph into maximal polylines (open or closed). */
function walkPaths(points, adjacency) {
  const visited = new Set(); // "keyA|keyB" segment identifiers, order-independent
  const segmentId = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const visitSegment = (a, b) => visited.add(segmentId(a, b));
  const isVisited = (a, b) => visited.has(segmentId(a, b));
  const paths = [];

  // Follows unvisited edges from `start` until stuck (degree < 2 or back at
  // `start` for a closed loop); every key has degree <= 2 per level, so this
  // walk is unambiguous.
  const walkFrom = (start) => {
    const chain = [points.get(start)];
    let current = start;
    while (true) {
      const next = adjacency.get(current).find((n) => !isVisited(current, n));
      if (next === undefined) break;
      visitSegment(current, next);
      chain.push(points.get(next));
      current = next;
      if (current === start) break; // closed loop
    }
    return chain;
  };

  // Open chains first: start at any endpoint of degree 1, so closed loops
  // (all degree 2) are left for the second pass below.
  for (const [key, neighbours] of adjacency) {
    if (neighbours.length !== 1 || isVisited(key, neighbours[0])) continue;
    paths.push(walkFrom(key));
  }

  // Remaining edges belong entirely to closed loops.
  for (const [key, neighbours] of adjacency) {
    for (const neighbour of neighbours) {
      if (isVisited(key, neighbour)) continue;
      visitSegment(key, neighbour);
      const chain = [points.get(key), points.get(neighbour)];
      let current = neighbour;
      while (current !== key) {
        const next = adjacency.get(current).find((n) => !isVisited(current, n));
        if (next === undefined) break;
        visitSegment(current, next);
        chain.push(points.get(next));
        current = next;
      }
      paths.push(chain);
    }
  }

  return paths;
}

/** Converts a traced path of grid coordinates into a rounded GeoJSON feature. */
function pathToFeature(path, level, interval, z, x, y, samples) {
  const coordinates = path.map(([r, c]) => [
    round6(tileXToLon(x + c / samples, z)),
    round6(tileYToLat(y + r / samples, z)),
  ]);
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: { ele: level, index: level % interval.index === 0 },
  };
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}
