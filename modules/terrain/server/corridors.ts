import { GO, NO_GO, SLOW_GO, UNKNOWN } from './landcover.ts';
import { METRES_PER_DEGREE_LATITUDE, latticeOf, longitudeScale, metresBetween } from './lattice.ts';

const BLOCK_SENTINEL = 1e9; // finite stand-in for "far from any obstacle" in the EDT pass

/** Per-metre movement cost for one obstacle class; only GO/SLOW-GO cells are ever traversable. */
function costPerMetre(cls) {
  return cls === SLOW_GO ? 4 : 1;
}

/**
 * Exact squared 1-D distance transform (Felzenszwalb & Huttenlocher), used
 * twice (columns then rows) to build a full 2-D Euclidean distance transform.
 * `f[i]` is 0 at a source and `BLOCK_SENTINEL` elsewhere.
 */
function edt1d(f, n, out, stride, offset) {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q += 1) {
    let s;
    for (;;) {
      const fv = f[v[k]] + v[k] * v[k];
      s = (f[q] + q * q - fv) / (2 * q - 2 * v[k]);
      if (s <= z[k] && k > 0) {
        k -= 1;
      } else {
        break;
      }
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1] < q) k += 1;
    const d = q - v[k];
    out[offset + q * stride] = d * d + f[v[k]];
  }
}

/**
 * Squared-distance grid (in cell units) from every cell to the nearest
 * blocking (NO_GO or UNKNOWN) cell. The AOI edge is not itself an obstacle,
 * so unblocked cells never see a bound imposed by the grid boundary.
 */
function distanceTransform(values, width, height) {
  const squared = new Float64Array(width * height);
  const column = new Float64Array(height);
  for (let c = 0; c < width; c += 1) {
    for (let r = 0; r < height; r += 1) {
      const cls = values[r * width + c];
      column[r] = cls === NO_GO || cls === UNKNOWN ? 0 : BLOCK_SENTINEL;
    }
    edt1d(column, height, squared, width, c);
  }
  const row = new Float64Array(width);
  const rowOut = new Float64Array(width);
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) row[c] = squared[r * width + c];
    edt1d(row, width, rowOut, 1, 0);
    for (let c = 0; c < width; c += 1) squared[r * width + c] = rowOut[c];
  }
  return squared;
}

/** Binary min-heap over parallel typed arrays; avoids per-node allocation. */
function makeHeap(capacity) {
  const nodes = new Int32Array(capacity);
  const costs = new Float64Array(capacity);
  let size = 0;
  function push(node, cost) {
    let i = size;
    size += 1;
    nodes[i] = node;
    costs[i] = cost;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (costs[parent] <= costs[i]) break;
      [costs[parent], costs[i]] = [costs[i], costs[parent]];
      [nodes[parent], nodes[i]] = [nodes[i], nodes[parent]];
      i = parent;
    }
  }
  function pop() {
    const topNode = nodes[0];
    const topCost = costs[0];
    size -= 1;
    nodes[0] = nodes[size];
    costs[0] = costs[size];
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < size && costs[left] < costs[smallest]) smallest = left;
      if (right < size && costs[right] < costs[smallest]) smallest = right;
      if (smallest === i) break;
      [costs[smallest], costs[i]] = [costs[i], costs[smallest]];
      [nodes[smallest], nodes[i]] = [nodes[i], nodes[smallest]];
      i = smallest;
    }
    return { node: topNode, cost: topCost };
  }
  return { push, pop, isEmpty: () => size === 0 };
}

const NEIGHBOURS = [
  [-1, 0, 1],
  [1, 0, 1],
  [0, -1, 1],
  [0, 1, 1],
  [-1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [1, 1, Math.SQRT2],
];

/**
 * A* over traversable cells. `costMultiplier` (per node) lets repeated calls
 * penalise cells already used by an accepted route so the next search finds
 * a genuinely different corridor. Returns an array of node indices, or null.
 */
function astar(grid, traversable, startNode, goalNode, costMultiplier) {
  const { width, height, cellMetres, values } = grid;
  const total = width * height;
  const goalRow = Math.floor(goalNode / width);
  const goalCol = goalNode % width;
  const gScore = new Float64Array(total).fill(Infinity);
  const visited = new Uint8Array(total);
  const cameFrom = new Int32Array(total).fill(-1);
  gScore[startNode] = 0;
  const heap = makeHeap(total * 8 + 8);
  const startRow = Math.floor(startNode / width);
  const startCol = startNode % width;
  heap.push(startNode, heuristic(startRow, startCol, goalRow, goalCol, cellMetres));

  function heuristic(r, c, gr, gc, cellSize) {
    return Math.hypot(r - gr, c - gc) * cellSize;
  }

  while (!heap.isEmpty()) {
    const { node } = heap.pop();
    if (visited[node]) continue;
    visited[node] = 1;
    if (node === goalNode) break;
    const row = Math.floor(node / width);
    const col = node % width;
    for (const [dr, dc, mult] of NEIGHBOURS) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
      const neighbour = nr * width + nc;
      if (!traversable[neighbour] || visited[neighbour]) continue;
      const stepLen = mult * cellMetres;
      const rate = (costPerMetre(values[node]) + costPerMetre(values[neighbour])) / 2;
      const penalty = (costMultiplier[node] + costMultiplier[neighbour]) / 2;
      const tentative = gScore[node] + rate * penalty * stepLen;
      if (tentative < gScore[neighbour]) {
        gScore[neighbour] = tentative;
        cameFrom[neighbour] = node;
        const nRow = Math.floor(neighbour / width);
        const nCol = neighbour % width;
        heap.push(neighbour, tentative + heuristic(nRow, nCol, goalRow, goalCol, cellMetres));
      }
    }
  }

  if (!visited[goalNode]) return null;
  const path: number[] = [];
  let cursor = goalNode;
  while (cursor !== -1) {
    path.push(cursor);
    cursor = cameFrom[cursor];
  }
  path.reverse();
  return path;
}

/** Cell-centre longitude/latitude for a node index. */
function cellCentre(grid, node) {
  return { lon: grid.lon(node % grid.width), lat: grid.lat(Math.floor(node / grid.width)) };
}

/** Nearest traversable cell to a lon/lat, within `maxMetres`; null if none qualifies. */
function snapToTraversable(grid, traversable, point, maxMetres) {
  const { width, height, cellMetres } = grid;
  const col = grid.column(point.lon);
  const row = grid.row(point.lat);
  const radiusCells = Math.max(1, Math.ceil(maxMetres / cellMetres));
  let best = -1;
  let bestDist = Infinity;
  const rMin = Math.max(0, Math.floor(row - radiusCells));
  const rMax = Math.min(height - 1, Math.ceil(row + radiusCells));
  const cMin = Math.max(0, Math.floor(col - radiusCells));
  const cMax = Math.min(width - 1, Math.ceil(col + radiusCells));
  for (let r = rMin; r <= rMax; r += 1) {
    for (let c = cMin; c <= cMax; c += 1) {
      const node = r * width + c;
      if (!traversable[node]) continue;
      const dr = r + 0.5 - row;
      const dc = c + 0.5 - col;
      const distMetres = Math.hypot(dr, dc) * cellMetres;
      if (distMetres <= maxMetres && distMetres < bestDist) {
        bestDist = distMetres;
        best = node;
      }
    }
  }
  return best === -1 ? null : best;
}

/** Local planar metres for perpendicular-distance math in Douglas-Peucker. */
function toLocalMetres(point, originLat) {
  return {
    x: point.lon * longitudeScale(originLat),
    y: point.lat * METRES_PER_DEGREE_LATITUDE,
  };
}

function perpendicularDistance(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  const clamped = Math.max(0, Math.min(1, t));
  const projX = a.x + clamped * dx;
  const projY = a.y + clamped * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

/** Douglas-Peucker simplification, always keeping the first and last points. */
function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  const originLat = points[0].lat;
  const local = points.map((p) => toLocalMetres(p, originLat));
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  for (let range = stack.pop(); range; range = stack.pop()) {
    const [start, end] = range;
    let maxDist = -1;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i += 1) {
      const dist = perpendicularDistance(local[i], local[start], local[end]);
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }
    if (maxDist > tolerance) {
      keep[maxIndex] = 1;
      stack.push([start, maxIndex], [maxIndex, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Marks cells within `radiusMetres` of any point on `path` (node indices) as `1`. */
function markCorridor(grid, path, radiusMetres, mask) {
  const { width, height, cellMetres } = grid;
  const radiusCells = Math.max(1, Math.round(radiusMetres / cellMetres));
  for (const node of path) {
    const row = Math.floor(node / width);
    const col = node % width;
    const rMin = Math.max(0, row - radiusCells);
    const rMax = Math.min(height - 1, row + radiusCells);
    const cMin = Math.max(0, col - radiusCells);
    const cMax = Math.min(width - 1, col + radiusCells);
    for (let r = rMin; r <= rMax; r += 1) {
      for (let c = cMin; c <= cMax; c += 1) {
        if (Math.hypot(r - row, c - col) * cellMetres <= radiusMetres) mask[r * width + c] = 1;
      }
    }
  }
}

function withinExtent(grid, point) {
  const [west, south, east, north] = grid.extent;
  return point.lon >= west && point.lon <= east && point.lat >= south && point.lat <= north;
}

/**
 * Up to `count` alternative avenues of approach between two points, routed
 * over the MCOO grid so a unit of frontage `corridorWidth` metres fits
 * through every cell it uses. Best (cheapest) route first.
 */
export function suggestAvenues(grid, { from, to, corridorWidth, count = 3 }) {
  if (!withinExtent(grid, from)) throw new Error('The start point is outside the AOI.');
  if (!withinExtent(grid, to)) throw new Error('The objective is outside the AOI.');

  const { width, height, values, cellMetres } = grid;
  const fullGrid = { ...latticeOf(grid), values };

  const squaredCellDist = distanceTransform(values, width, height);
  const traversable = new Uint8Array(width * height);
  const halfWidth = corridorWidth / 2;
  for (let i = 0; i < width * height; i += 1) {
    const cls = values[i];
    if (cls === NO_GO || cls === UNKNOWN) continue;
    const clearanceMetres = Math.sqrt(squaredCellDist[i]) * cellMetres;
    if (clearanceMetres >= halfWidth) traversable[i] = 1;
  }

  const snapRadius = Math.max(3 * corridorWidth, 3 * cellMetres);
  const startNode = snapToTraversable(fullGrid, traversable, from, snapRadius);
  const goalNode = snapToTraversable(fullGrid, traversable, to, snapRadius);
  if (startNode === null || goalNode === null) {
    throw new Error(`No corridor at least ${corridorWidth} m wide connects the two points.`);
  }

  const costMultiplier = new Float64Array(width * height).fill(1);
  const acceptedMask = new Uint8Array(width * height);
  const routes: any[] = [];
  const maxAttempts = count * 6;
  let attempts = 0;

  while (routes.length < count && attempts < maxAttempts) {
    attempts += 1;
    const path = astar(fullGrid, traversable, startNode, goalNode, costMultiplier);
    if (!path) break;

    // Multiply cost near this search's route so a repeat search finds something different.
    applyPenalty(fullGrid, path, corridorWidth, costMultiplier);

    if (routes.length > 0) {
      let nearCount = 0;
      for (const node of path) if (acceptedMask[node]) nearCount += 1;
      if (nearCount / path.length > 0.6) continue;
    }

    routes.push(buildRoute(fullGrid, path));
    markCorridor(fullGrid, path, corridorWidth, acceptedMask);
  }

  if (routes.length === 0) {
    throw new Error(`No corridor at least ${corridorWidth} m wide connects the two points.`);
  }
  routes.sort((a, b) => a.lengthMetres - b.lengthMetres);
  return { routes: routes.slice(0, count) };
}

/** Multiplies `costMultiplier` by 6 for every cell within `corridorWidth` of `path`. */
function applyPenalty(grid, path, corridorWidth, costMultiplier) {
  const mask = new Uint8Array(grid.width * grid.height);
  markCorridor(grid, path, corridorWidth, mask);
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) costMultiplier[i] *= 6;
}

/** Converts a node-index path into the public route shape. */
function buildRoute(grid, path) {
  const points = path.map((node) => cellCentre(grid, node));
  let lengthMetres = 0;
  let goLength = 0;
  let slowLength = 0;
  for (let i = 1; i < path.length; i += 1) {
    const stepLen = metresBetween(points[i - 1], points[i]);
    lengthMetres += stepLen;
    const classA = grid.values[path[i - 1]];
    const classB = grid.values[path[i]];
    const half = stepLen / 2;
    goLength += (classA === GO ? half : 0) + (classB === GO ? half : 0);
    slowLength += (classA === SLOW_GO ? half : 0) + (classB === SLOW_GO ? half : 0);
  }
  const simplified = simplify(points, grid.cellMetres);
  return {
    coordinates: simplified.map((p) => [p.lon, p.lat]),
    lengthMetres,
    goShare: lengthMetres > 0 ? goLength / lengthMetres : 1,
    slowGoShare: lengthMetres > 0 ? slowLength / lengthMetres : 0,
  };
}
