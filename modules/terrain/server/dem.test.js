import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { openTerrain } from './dem.js';

const TILE = 256;

/**
 * Build a one-tile synthetic elevation database at `cellsPerDegree`. `fill`
 * receives global cell indices `(ix, iy)` and returns the elevation in
 * metres for that cell. The tile always sits at tx=0, ty=0, so it covers
 * longitude/latitude `[0, TILE / cellsPerDegree)`.
 */
function buildFixture(file, cellsPerDegree, fill) {
  rmSync(file, { force: true });
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE dem_tiles (
      tx INTEGER NOT NULL,
      ty INTEGER NOT NULL,
      grid BLOB NOT NULL,
      PRIMARY KEY (tx, ty)
    ) WITHOUT ROWID;
  `);
  const grid = new Float32Array(TILE * TILE);
  for (let iy = 0; iy < TILE; iy += 1) {
    for (let ix = 0; ix < TILE; ix += 1) {
      grid[iy * TILE + ix] = fill(ix, iy);
    }
  }
  database
    .prepare('INSERT INTO dem_tiles (tx, ty, grid) VALUES (0, 0, ?)')
    .run(Buffer.from(grid.buffer, grid.byteOffset, grid.byteLength));
  const span = TILE / cellsPerDegree;
  const insertMeta = database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  insertMeta.run('cells_per_degree', String(cellsPerDegree));
  insertMeta.run('bounds', JSON.stringify([0, 0, span, span]));
  insertMeta.run('dataset', 'synthetic-test');
  database.close();
}

/** Cell-centre coordinate of a global cell index, matching build_terrain.mjs. */
function cellLonLat(ix, iy, cellsPerDegree) {
  return { lon: (ix + 0.5) / cellsPerDegree, lat: (iy + 0.5) / cellsPerDegree };
}

describe('openTerrain: elevation, slope, and line of sight', () => {
  // Realistic 1-arcsecond density (3600 cells/degree, ~30.9 m/cell at the
  // equator): a ramp corner for interpolation, a tall ridge for a genuine
  // terrain obstruction, and flat ground everywhere else.
  const CELLS_PER_DEGREE = 3600;
  const RAMP_PER_CELL = 4; // metres of rise per cell, eastward, inside the ramp corner
  const WALL_COLUMNS = [150, 155];
  const WALL_HEIGHT = 5000;
  const FLAT_HEIGHT = 50;

  const file = path.join(os.tmpdir(), `dem-fixture-${process.pid}.db`);
  let terrain;

  beforeAll(() => {
    buildFixture(file, CELLS_PER_DEGREE, (ix, iy) => {
      if (ix >= WALL_COLUMNS[0] && ix <= WALL_COLUMNS[1]) return WALL_HEIGHT;
      if (ix < 50 && iy < 50) return FLAT_HEIGHT + RAMP_PER_CELL * ix;
      return FLAT_HEIGHT;
    });
    terrain = openTerrain(file);
  });

  afterAll(() => {
    terrain.close();
    rmSync(file, { force: true });
  });

  test('elevation is exact at a cell centre and linear at a fractional offset', () => {
    const centre = cellLonLat(20, 20, CELLS_PER_DEGREE);
    expect(terrain.elevation(centre.lon, centre.lat)).toBeCloseTo(
      FLAT_HEIGHT + RAMP_PER_CELL * 20,
      4,
    );

    // Halfway between cell 20 and cell 21: a linear ramp interpolates exactly
    // to the midpoint value, not to either neighbour.
    const halfway = { lon: centre.lon + 0.5 / CELLS_PER_DEGREE, lat: centre.lat };
    expect(terrain.elevation(halfway.lon, halfway.lat)).toBeCloseTo(
      FLAT_HEIGHT + RAMP_PER_CELL * 20.5,
      4,
    );
  });

  test('elevation does not vary with latitude when the fixture does not', () => {
    // Catches a row/column (ix/iy) transposition: the ramp only depends on
    // ix, so two points sharing a longitude must report the same elevation
    // regardless of latitude.
    const lon = cellLonLat(20, 0, CELLS_PER_DEGREE).lon;
    const a = terrain.elevation(lon, cellLonLat(0, 10, CELLS_PER_DEGREE).lat);
    const b = terrain.elevation(lon, cellLonLat(0, 40, CELLS_PER_DEGREE).lat);
    expect(a).toBeCloseTo(b, 4);
  });

  test('elevation outside the built tile is NaN', () => {
    expect(Number.isNaN(terrain.elevation(5, 5))).toBe(true);
  });

  test('slope on the ramp matches plain trigonometry on the known gradient', () => {
    const point = cellLonLat(20, 20, CELLS_PER_DEGREE);
    // Independent of dem.js: gradient (m/m) = rise-per-cell * cells-per-degree
    // / metres-per-degree-of-longitude at this latitude; slope = atan(gradient).
    const lonScale = 111319.49 * Math.cos((point.lat * Math.PI) / 180);
    const gradient = (RAMP_PER_CELL * CELLS_PER_DEGREE) / lonScale;
    const expectedDegrees = (Math.atan(gradient) * 180) / Math.PI;
    expect(terrain.slopeDegrees(point.lon, point.lat)).toBeCloseTo(expectedDegrees, 3);
  });

  test('flat ground reports zero slope', () => {
    const point = cellLonLat(200, 200, CELLS_PER_DEGREE);
    expect(terrain.slopeDegrees(point.lon, point.lat)).toBeCloseTo(0, 6);
  });

  test('line of sight is clear over flat ground at short range', () => {
    const from = cellLonLat(60, 200, CELLS_PER_DEGREE);
    const to = cellLonLat(90, 200, CELLS_PER_DEGREE);
    const result = terrain.lineOfSight(from, to);
    expect(result.visible).toBe(true);
    expect(result.blockedAt).toBeNull();
  });

  test('a ridge between two points blocks line of sight at the ridge', () => {
    const from = cellLonLat(100, 200, CELLS_PER_DEGREE);
    const to = cellLonLat(200, 200, CELLS_PER_DEGREE);
    const result = terrain.lineOfSight(from, to);
    expect(result.visible).toBe(false);
    // The ridge sits at columns 150-155, i.e. roughly (150-100) to (155-100)
    // cells from the observer; give the crossing a generous but real bound.
    expect(result.blockedAt).toBeGreaterThan(1000);
    expect(result.blockedAt).toBeLessThan(2200);
  });

  test('line of sight throws when either end leaves the elevation model', () => {
    const inside = cellLonLat(60, 200, CELLS_PER_DEGREE);
    expect(() => terrain.lineOfSight(inside, { lon: 10, lat: 10 })).toThrow(
      /leaves the elevation model/,
    );
  });

  test('viewshed reports no-data cells past the edge of the built tile', () => {
    const observer = cellLonLat(10, 200, CELLS_PER_DEGREE);
    const grid = terrain.viewshed({ ...observer, radiusMetres: 2000, cellMetres: 50 });
    expect(grid.values).toContain(255);
    // The observer's own neighbourhood, on flat ground, must still resolve.
    expect(grid.visibleCells).toBeGreaterThan(0);
  });

  test('viewshed throws when the observer itself is outside the elevation model', () => {
    expect(() => terrain.viewshed({ lon: 10, lat: 10, radiusMetres: 500 })).toThrow(
      /observer is outside the elevation model/,
    );
  });
});

describe('openTerrain: earth curvature over long, flat range', () => {
  // A coarse grid (20 cells/degree, ~5.6 km/cell) so a 256-cell tile spans
  // over a thousand kilometres — enough room to demonstrate curvature
  // blocking line of sight on perfectly flat ground, something no amount of
  // terrain relief in a realistic-density fixture could show.
  const CELLS_PER_DEGREE = 20;
  const FLAT_HEIGHT = 50;
  const file = path.join(os.tmpdir(), `dem-curvature-fixture-${process.pid}.db`);
  let terrain;

  beforeAll(() => {
    buildFixture(file, CELLS_PER_DEGREE, () => FLAT_HEIGHT);
    terrain = openTerrain(file);
  });

  afterAll(() => {
    terrain.close();
    rmSync(file, { force: true });
  });

  test('flat ground is visible within the standard-observer horizon', () => {
    // Distance-to-horizon for a 1.8 m eye height is ~4.8 km; two observers
    // of that height see each other up to roughly double that, combined.
    const from = cellLonLat(60, 128, CELLS_PER_DEGREE);
    const to = cellLonLat(61, 128, CELLS_PER_DEGREE); // ~5.6 km
    expect(terrain.lineOfSight(from, to).visible).toBe(true);
  });

  test('flat ground beyond the horizon is blocked by curvature alone', () => {
    // ~56 km at default 1.8 m heights is far past the ~9.6 km combined
    // horizon; nothing in the fixture is anything but flat, so a visible
    // verdict here could only mean curvature was not applied.
    const from = cellLonLat(60, 128, CELLS_PER_DEGREE);
    const to = cellLonLat(70, 128, CELLS_PER_DEGREE);
    const result = terrain.lineOfSight(from, to);
    expect(result.visible).toBe(false);
  });

  test('a taller observer sees further, all else equal', () => {
    const from = cellLonLat(60, 128, CELLS_PER_DEGREE);
    const to = cellLonLat(70, 128, CELLS_PER_DEGREE);
    const short = terrain.lineOfSight(from, to, { observerHeight: 1.8, targetHeight: 1.8 });
    // sqrt(2 * earthRadius * height) must clear the ~55.7 km baseline plus
    // the target's own ~4.8 km horizon; 500 m does so with headroom.
    const tall = terrain.lineOfSight(from, to, { observerHeight: 500, targetHeight: 1.8 });
    expect(short.visible).toBe(false);
    expect(tall.visible).toBe(true);
  });
});
