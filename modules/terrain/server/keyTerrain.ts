import { latticeOver } from './lattice.ts';

const MAX_CELLS = 250000;
const EDGE_MARGIN_CELLS = 2;

const NEIGHBOUR_OFFSETS = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

/** Union-find root with path compression. */
function find(parent, x) {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]];
    x = parent[x];
  }
  return x;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** Deterministic tie-break: elevation desc, then lon asc, then lat asc. */
function compareTies(a, b) {
  if (b.elevation !== a.elevation) return b.elevation - a.elevation;
  if (a.lon !== b.lon) return a.lon - b.lon;
  return a.lat - b.lat;
}

/**
 * Candidate key terrain: locally dominant high ground ranked by topographic
 * prominence (elevation above the highest connecting saddle to any taller
 * peak), optionally re-ranked by observed viewshed area. Peaks control the
 * ground around them; prominence is a cheap proxy for "how much ground" that
 * doesn't require a viewshed per candidate.
 */
export function keyTerrainCandidates({
  elevation,
  bounds,
  cellMetres = 50,
  minProminence = 30,
  limit = 8,
  visibleArea,
}) {
  const grid = latticeOver(bounds, { cellMetres, maxCells: MAX_CELLS });
  const { width, height } = grid;
  const total = width * height;

  const elevations = new Float64Array(total);
  const lons = Float64Array.from({ length: width }, (_, col) => grid.lon(col));
  const lats = Float64Array.from({ length: height }, (_, row) => grid.lat(row));

  let lowestFinite = Infinity;
  const order: number[] = [];
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const idx = row * width + col;
      const value = elevation(lons[col], lats[row]);
      elevations[idx] = value;
      if (Number.isFinite(value)) {
        order.push(idx);
        if (value < lowestFinite) lowestFinite = value;
      }
    }
  }
  order.sort((a, b) => elevations[b] - elevations[a]);

  const parent = new Int32Array(total).fill(-1);
  const peakIndexOf = new Int32Array(total).fill(-1);
  const peakElevOf = new Float64Array(total);
  const prominenceOf = new Float64Array(total).fill(NaN);

  for (const idx of order) {
    const row = (idx / width) | 0;
    const col = idx % width;
    const value = elevations[idx];

    const neighbourRoots = new Set<number>();
    for (const [dr, dc] of NEIGHBOUR_OFFSETS) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
      const nIdx = nr * width + nc;
      if (parent[nIdx] === -1) continue; // not processed yet (lower or NaN)
      neighbourRoots.add(find(parent, nIdx));
    }

    if (neighbourRoots.size === 0) {
      // New local peak.
      parent[idx] = idx;
      peakIndexOf[idx] = idx;
      peakElevOf[idx] = value;
      continue;
    }

    if (neighbourRoots.size === 1) {
      const [root] = neighbourRoots;
      parent[idx] = root;
      continue;
    }

    // Saddle joining two or more components: the highest peak survives.
    let winner = -1;
    for (const root of neighbourRoots) {
      if (winner === -1 || peakElevOf[root] > peakElevOf[winner]) winner = root;
    }
    for (const root of neighbourRoots) {
      if (root === winner) continue;
      prominenceOf[peakIndexOf[root]] = peakElevOf[root] - value;
      parent[root] = winner;
    }
    parent[idx] = winner;
  }

  // Surviving top peaks: prominence relative to the lowest sampled elevation.
  for (const idx of order) {
    if (parent[idx] !== idx) continue;
    if (Number.isNaN(prominenceOf[idx])) prominenceOf[idx] = peakElevOf[idx] - lowestFinite;
  }

  const candidates: any[] = [];
  for (let row = EDGE_MARGIN_CELLS; row < height - EDGE_MARGIN_CELLS; row += 1) {
    for (let col = EDGE_MARGIN_CELLS; col < width - EDGE_MARGIN_CELLS; col += 1) {
      const idx = row * width + col;
      const prominence = prominenceOf[idx];
      if (Number.isNaN(prominence) || prominence < minProminence) continue;
      candidates.push({
        idx,
        lon: lons[col],
        lat: lats[row],
        elevation: elevations[idx],
        prominence,
      });
    }
  }

  candidates.sort((a, b) => b.prominence - a.prominence || compareTies(a, b));
  const shortlist = candidates.slice(0, limit * 2);

  if (visibleArea) {
    for (const candidate of shortlist) {
      candidate.visibleAreaSquareKm = visibleArea(candidate.lon, candidate.lat);
    }
    shortlist.sort((a, b) => b.visibleAreaSquareKm - a.visibleAreaSquareKm || compareTies(a, b));
  }

  return shortlist.slice(0, limit).map((candidate) => ({
    lon: round6(candidate.lon),
    lat: round6(candidate.lat),
    elevation: round1(candidate.elevation),
    prominence: round1(candidate.prominence),
    visibleAreaSquareKm: visibleArea ? candidate.visibleAreaSquareKm : null,
  }));
}
