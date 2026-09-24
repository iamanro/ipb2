import { describe, expect, test } from 'vitest';

import { suggestAvenues } from './corridors.js';
import { GO, NO_GO, SLOW_GO } from './landcover.js';

const CELL = 50; // metres
const WEST = 0;
const NORTH = 1;

/** Builds a grid extent for a `width`x`height` grid anchored at (WEST, NORTH). */
function buildGrid(width, height, fill = GO) {
  const values = new Uint8Array(width * height).fill(fill);
  const south = NORTH - (height * CELL) / 111132.95;
  const east = WEST + (width * CELL) / (111319.49 * Math.cos((NORTH * Math.PI) / 180));
  return { values, width, height, cellMetres: CELL, extent: [WEST, south, east, NORTH] };
}

function lonLatOfCell(grid, row, col) {
  const [west, south, east, north] = grid.extent;
  return {
    lon: west + (col + 0.5) * ((east - west) / grid.width),
    lat: north - (row + 0.5) * ((north - south) / grid.height),
  };
}

function metresBetween(a, b) {
  const midLat = (a.lat + b.lat) / 2;
  const dx = (b.lon - a.lon) * (111319.49 * Math.cos((midLat * Math.PI) / 180));
  const dy = (b.lat - a.lat) * 111132.95;
  return Math.hypot(dx, dy);
}

describe('suggestAvenues', () => {
  test('open GO field: near-straight route with goShare ~1', () => {
    const grid = buildGrid(40, 40);
    const from = lonLatOfCell(grid, 20, 2);
    const to = lonLatOfCell(grid, 20, 37);
    const { routes } = suggestAvenues(grid, { from, to, corridorWidth: 40, count: 1 });
    expect(routes.length).toBe(1);
    const straight = metresBetween(from, to);
    expect(routes[0].lengthMetres).toBeLessThan(straight * 1.05);
    expect(routes[0].goShare).toBeCloseTo(1, 5);
  });

  test('gap wider than corridor width lets the route through; narrower gap throws', () => {
    const width = 41;
    const height = 41;
    const gapCol = 20;
    const grid = buildGrid(width, height);
    // A NO_GO wall down the middle column, with one open gap.
    for (let r = 0; r < height; r += 1) {
      if (r === Math.floor(height / 2)) continue; // the gap row
      grid.values[r * width + gapCol] = NO_GO;
    }
    const from = lonLatOfCell(grid, 20, 2);
    const to = lonLatOfCell(grid, 20, 38);

    const wide = suggestAvenues(grid, { from, to, corridorWidth: 40, count: 1 });
    expect(wide.routes.length).toBe(1);
    const crossesGap = wide.routes[0].coordinates.some((c, i, arr) => {
      if (i === 0) return false;
      const prevLon = arr[i - 1][0];
      const gapLon = lonLatOfCell(grid, Math.floor(height / 2), gapCol).lon;
      return (prevLon - gapLon) * (c[0] - gapLon) <= 0;
    });
    expect(crossesGap).toBe(true);

    expect(() => suggestAvenues(grid, { from, to, corridorWidth: 200, count: 1 })).toThrow(
      /200 m wide/,
    );
  });

  test('prefers a cheaper GO detour over a short SLOW_GO shortcut when the detour is cheap', () => {
    const width = 30;
    const height = 30;
    const grid = buildGrid(width, height);
    // A SLOW_GO band across the middle that is the short, direct path.
    for (let c = 0; c < width; c += 1) grid.values[15 * width + c] = SLOW_GO;
    const from = lonLatOfCell(grid, 10, 15);
    const to = lonLatOfCell(grid, 20, 15);
    const { routes } = suggestAvenues(grid, { from, to, corridorWidth: 40, count: 1 });
    // GO detour (cost 1/m) around a 1-cell SLOW_GO band (cost 4/m) is cheaper
    // even though it is longer, so the route should barely touch SLOW_GO.
    expect(routes[0].slowGoShare).toBeLessThan(0.5);
  });

  test('crosses a wide SLOW_GO band when the detour would be much longer', () => {
    const width = 60;
    const height = 60;
    const grid = buildGrid(width, height);
    // A thick SLOW_GO band with NO_GO walls forcing any detour to be huge.
    for (let r = 20; r < 40; r += 1) {
      for (let c = 0; c < width; c += 1) grid.values[r * width + c] = SLOW_GO;
    }
    for (let r = 20; r < 40; r += 1) {
      grid.values[r * width + 0] = NO_GO;
      grid.values[r * width + (width - 1)] = NO_GO;
    }
    const from = lonLatOfCell(grid, 10, 30);
    const to = lonLatOfCell(grid, 50, 30);
    const { routes } = suggestAvenues(grid, { from, to, corridorWidth: 40, count: 1 });
    expect(routes[0].slowGoShare).toBeGreaterThan(0.3);
  });

  test('two separate gaps yield two distinct, non-duplicate alternatives', () => {
    const width = 61;
    const height = 41;
    const grid = buildGrid(width, height);
    const wallCol = 30;
    const gapRows = [5, 35]; // far apart, so the two corridors barely overlap
    for (let r = 0; r < height; r += 1) {
      if (gapRows.includes(r)) continue;
      grid.values[r * width + wallCol] = NO_GO;
    }
    const from = lonLatOfCell(grid, 20, 2);
    const to = lonLatOfCell(grid, 20, 58);
    // Ask for exactly the number of genuinely distinct corridors: the search
    // stops as soon as both gaps are covered, before it would consider a
    // third, merely-bowed alternative through an already-used gap.
    const { routes } = suggestAvenues(grid, { from, to, corridorWidth: 40, count: 2 });
    expect(routes.length).toBe(2);
    // The two routes should not be near-duplicates of each other.
    expect(routes[0].coordinates).not.toEqual(routes[1].coordinates);
    const wallLon = lonLatOfCell(grid, 0, wallCol).lon;
    const gapLats = gapRows.map((r) => lonLatOfCell(grid, r, wallCol).lat);
    // Each route should cross near a different one of the two gap rows.
    const crossingLats = routes.map((route) => {
      let closestLat = null;
      let closestDx = Infinity;
      for (const [lon, lat] of route.coordinates) {
        const dx = Math.abs(lon - wallLon);
        if (dx < closestDx) {
          closestDx = dx;
          closestLat = lat;
        }
      }
      return closestLat;
    });
    const nearestGap = (lat) =>
      gapLats.reduce((best, g) => (Math.abs(g - lat) < Math.abs(best - lat) ? g : best));
    expect(nearestGap(crossingLats[0])).not.toBeCloseTo(nearestGap(crossingLats[1]), 6);
  });

  test('throws when the start point is outside the AOI', () => {
    const grid = buildGrid(20, 20);
    const from = { lon: -5, lat: 10 };
    const to = lonLatOfCell(grid, 10, 10);
    expect(() => suggestAvenues(grid, { from, to, corridorWidth: 40, count: 1 })).toThrow(
      /start point is outside/,
    );
  });

  test('throws when the objective is outside the AOI', () => {
    const grid = buildGrid(20, 20);
    const from = lonLatOfCell(grid, 10, 10);
    const to = { lon: -5, lat: 10 };
    expect(() => suggestAvenues(grid, { from, to, corridorWidth: 40, count: 1 })).toThrow(
      /objective is outside/,
    );
  });

  test('completes a 400x400 GO grid corner-to-corner well under budget', () => {
    const grid = buildGrid(400, 400);
    const from = lonLatOfCell(grid, 2, 2);
    const to = lonLatOfCell(grid, 397, 397);
    const start = performance.now();
    const { routes } = suggestAvenues(grid, { from, to, corridorWidth: 40, count: 1 });
    const elapsed = performance.now() - start;
    expect(routes.length).toBe(1);
    expect(elapsed).toBeLessThan(1000);
  });
});
