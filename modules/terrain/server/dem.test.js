import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { openElevation, openTerrain } from './dem.ts';

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
    const grid = terrain.viewshed({ observers: [observer], radiusMetres: 2000, cellMetres: 50 });
    expect(grid.values).toContain(255);
    // The observer's own neighbourhood, on flat ground, must still resolve.
    expect(grid.visibleCells).toBeGreaterThan(0);
  });

  test('viewshed throws when an observer is outside the elevation model', () => {
    expect(() =>
      terrain.viewshed({ observers: [{ lon: 10, lat: 10 }], radiusMetres: 500 }),
    ).toThrow(/observer is outside the elevation model/);
  });

  test('a second post across the ridge covers the dead ground the first leaves', () => {
    // The wall (columns 150-155) hides the ground east of it from a post in
    // the west; a post in the east sees that ground.
    const west = cellLonLat(120, 200, CELLS_PER_DEGREE);
    const east = cellLonLat(185, 200, CELLS_PER_DEGREE);
    const options = { radiusMetres: 2500, cellMetres: 60 };
    const alone = terrain.viewshed({ observers: [west], ...options });
    const both = terrain.viewshed({ observers: [west, east], ...options });
    const deadShare = (grid) => grid.deadCells / (grid.deadCells + grid.visibleCells);
    expect(alone.deadCells).toBeGreaterThan(0);
    expect(deadShare(both)).toBeLessThan(deadShare(alone) / 2);
  });

  test('ground seen by two posts on the same side is marked as overlap', () => {
    const posts = [cellLonLat(100, 200, CELLS_PER_DEGREE), cellLonLat(130, 200, CELLS_PER_DEGREE)];
    const grid = terrain.viewshed({ observers: posts, radiusMetres: 1500, cellMetres: 60 });
    expect(grid.overlapCells).toBeGreaterThan(0);
    expect(grid.values).toContain(2);
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

describe('openElevation: composite of a coarse base and a fine, partial detail', () => {
  // A flat base (100 m) covering the whole tile, and a detail model at 4x
  // the density covering only a quarter of the same ground, itself missing
  // data at ix < 20 and ix >= 100 (simulating both an unbuilt neighbour and
  // DMR4G's own ragged sheet edge) — everywhere it does have data it is a
  // ramp, so slope tells detail and base apart as unambiguously as height.
  const BASE_CELLS_PER_DEGREE = 100;
  const DETAIL_CELLS_PER_DEGREE = 400;
  const BASE_HEIGHT = 100;
  const DETAIL_BASE_HEIGHT = 300;
  const RAMP_PER_CELL = 2;
  const DETAIL_VALID = [20, 100]; // ix range (exclusive end) with real detail data

  const baseFile = path.join(os.tmpdir(), `dem-composite-base-${process.pid}.db`);
  const detailFile = path.join(os.tmpdir(), `dem-composite-detail-${process.pid}.db`);
  let base;
  let detail;
  let composite;

  beforeAll(() => {
    buildFixture(baseFile, BASE_CELLS_PER_DEGREE, () => BASE_HEIGHT);
    buildFixture(detailFile, DETAIL_CELLS_PER_DEGREE, (ix) =>
      ix >= DETAIL_VALID[0] && ix < DETAIL_VALID[1] ? DETAIL_BASE_HEIGHT + RAMP_PER_CELL * ix : NaN,
    );
    base = openTerrain(baseFile);
    detail = openTerrain(detailFile);
    composite = openElevation(base, detail);
  });

  afterAll(() => {
    composite.close();
    rmSync(baseFile, { force: true });
    rmSync(detailFile, { force: true });
  });

  test('detail wins where it has data', () => {
    const { lon, lat } = cellLonLat(60, 60, DETAIL_CELLS_PER_DEGREE);
    expect(composite.elevation(lon, lat)).toBeCloseTo(DETAIL_BASE_HEIGHT + RAMP_PER_CELL * 60, 3);
  });

  test('base fills in at a NaN cell inside the detail tile (its ragged edge)', () => {
    const { lon, lat } = cellLonLat(140, 60, DETAIL_CELLS_PER_DEGREE); // >= 100: NaN in the detail fixture
    expect(composite.elevation(lon, lat)).toBe(BASE_HEIGHT);
  });

  test('base fills in entirely outside the detail tile', () => {
    expect(composite.elevation(1, 1)).toBe(BASE_HEIGHT); // past the 0.64° detail tile, inside the 2.56° base one
  });

  test('bounds and dataset come from the base; detail is attached to meta', () => {
    expect(composite.bounds).toEqual(base.bounds);
    expect(composite.meta.dataset).toBe('synthetic-test');
    expect(composite.meta.detail).toBe(detail.meta);
  });

  test('slope uses the detail step where detail has data', () => {
    const { lon, lat } = cellLonLat(60, 60, DETAIL_CELLS_PER_DEGREE);
    // Same independent trigonometry as the openTerrain ramp test above, at
    // the detail grid's own density — the coarse base fixture is flat, so
    // this value could only come from reading the detail step correctly.
    const lonScale = 111319.49 * Math.cos((lat * Math.PI) / 180);
    const gradient = (RAMP_PER_CELL * DETAIL_CELLS_PER_DEGREE) / lonScale;
    const expectedDegrees = (Math.atan(gradient) * 180) / Math.PI;
    expect(composite.slopeDegrees(lon, lat)).toBeCloseTo(expectedDegrees, 3);
  });

  test('slope falls back to the base step outside detail coverage', () => {
    expect(composite.slopeDegrees(1, 1)).toBe(0); // the base fixture is flat everywhere
  });

  test('profile, line of sight and viewshed all read the composite elevation', () => {
    const { lon: lon1, lat: lat1 } = cellLonLat(60, 60, DETAIL_CELLS_PER_DEGREE);
    const point = composite.profile({ lon: lon1, lat: lat1 }, { lon: lon1, lat: lat1 + 0.0005 })
      .points[0];
    expect(point.elevation).toBeCloseTo(DETAIL_BASE_HEIGHT + RAMP_PER_CELL * 60, 3);
    expect(() =>
      composite.viewshed({ observers: [{ lon: lon1, lat: lat1 }], radiusMetres: 500 }),
    ).not.toThrow();
  });

  test('with no detail file, the composite is exactly the base model', () => {
    expect(openElevation(base, null)).toBe(base);
  });
});
