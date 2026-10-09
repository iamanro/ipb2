import { describe, expect, test } from 'vitest';

import { METRES_PER_DEGREE_LATITUDE, latticeOf, latticeOver, longitudeScale } from './lattice.ts';

const BOUNDS = [17.45, 49.62, 17.6, 49.72];
const [WEST, SOUTH, EAST, NORTH] = BOUNDS;

/**
 * East-west and north-south size of one cell in metres, from the extent. The
 * extent's mid-latitude sits a little south of the bounds' one, so the
 * east-west size agrees to millimetres, not exactly.
 */
function cellSize(lattice) {
  const [west, south, east, north] = lattice.extent;
  const middle = (south + north) / 2;
  return {
    x: ((east - west) * longitudeScale(middle)) / lattice.width,
    y: ((north - south) * METRES_PER_DEGREE_LATITUDE) / lattice.height,
  };
}

describe('latticeOver', () => {
  test('covers the whole of the bounds with square cells, overshooting by under one cell', () => {
    const lattice = latticeOver(BOUNDS, { cellMetres: 50, maxCells: 1e6 });
    const [west, south, east, north] = lattice.extent;
    expect([west, north]).toEqual([WEST, NORTH]);
    expect(east).toBeGreaterThanOrEqual(EAST);
    expect(south).toBeLessThanOrEqual(SOUTH);
    expect((east - EAST) * longitudeScale((SOUTH + NORTH) / 2)).toBeLessThan(50);
    expect((SOUTH - south) * METRES_PER_DEGREE_LATITUDE).toBeLessThan(50);
    const size = cellSize(lattice);
    expect(size.x).toBeCloseTo(50, 2);
    expect(size.y).toBeCloseTo(50, 2);
  });

  test('bounds an exact number of cells wide get no extra column or row', () => {
    const middle = 49.7;
    const halfLat = 500 / METRES_PER_DEGREE_LATITUDE;
    const bounds = [17.5, middle - halfLat, 17.5 + 2000 / longitudeScale(middle), middle + halfLat];
    const lattice = latticeOver(bounds, { cellMetres: 100, maxCells: 1e6 });
    expect([lattice.width, lattice.height]).toEqual([20, 10]);
  });

  test('grows every cell alike to stay near maxCells', () => {
    const lattice = latticeOver(BOUNDS, { cellMetres: 10, maxCells: 10_000 });
    expect(lattice.cellMetres).toBeGreaterThan(10);
    expect(lattice.width * lattice.height).toBeLessThan(10_000 * 1.05);
    expect(lattice.width * lattice.height).toBeGreaterThan(10_000 * 0.95);
    const size = cellSize(lattice);
    expect(size.x).toBeCloseTo(lattice.cellMetres, 2);
    expect(size.y).toBeCloseTo(lattice.cellMetres, 2);
  });

  test('a sliver still gets one cell', () => {
    const lattice = latticeOver([17.5, 49.7, 17.5000001, 49.7000001], {
      cellMetres: 50,
      maxCells: 1e6,
    });
    expect([lattice.width, lattice.height]).toEqual([1, 1]);
  });
});

describe('lattice positions', () => {
  const lattice = latticeOver(BOUNDS, { cellMetres: 75, maxCells: 1e6 });

  test('a cell centre sits in the middle of its cell', () => {
    for (const cell of [0, 7, lattice.width - 1]) {
      expect(lattice.column(lattice.lon(cell))).toBeCloseTo(cell + 0.5, 9);
    }
    for (const cell of [0, 11, lattice.height - 1]) {
      expect(lattice.row(lattice.lat(cell))).toBeCloseTo(cell + 0.5, 9);
    }
  });

  test('row 0 is the northern edge and column 0 the western edge', () => {
    const [west, south, east, north] = lattice.extent;
    expect(lattice.column(west)).toBeCloseTo(0, 9);
    expect(lattice.column(east)).toBeCloseTo(lattice.width, 9);
    expect(lattice.row(north)).toBeCloseTo(0, 9);
    expect(lattice.row(south)).toBeCloseTo(lattice.height, 9);
    expect(lattice.lat(0)).toBeGreaterThan(lattice.lat(1));
  });

  test('latticeOf a grid payload lands every cell on the same ground', () => {
    const { extent, width, height, cellMetres } = lattice;
    const rebuilt = latticeOf(JSON.parse(JSON.stringify({ extent, width, height, cellMetres })));
    expect(rebuilt.cellMetres).toBe(cellMetres);
    for (const cell of [0, 13, width - 1]) expect(rebuilt.lon(cell)).toBe(lattice.lon(cell));
    for (const cell of [0, 13, height - 1]) expect(rebuilt.lat(cell)).toBe(lattice.lat(cell));
  });
});
