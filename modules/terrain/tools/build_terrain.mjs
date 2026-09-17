#!/usr/bin/env node
/**
 * Build `modules/terrain/data/terrain.db` from Copernicus GLO-30 GeoTIFFs.
 *
 *   node modules/terrain/tools/build_terrain.mjs \
 *     --source ../IPB/infra/terrain-data/offline/dem/glo30 \
 *     --bounds 17.2,49.5,17.8,49.9
 *
 * Source rasters are read straight from GeoTIFF (no GDAL) and resampled onto the
 * one-arc-second grid documented in schema.sql. Rebuilding is idempotent: the
 * output file is replaced.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { fromFile } from 'geotiff';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.join(HERE, '..');
const CELLS_PER_DEGREE = 3600;
const TILE = 256;
const DEFAULT_BOUNDS = [17.2, 49.5, 17.8, 49.9];

function parseArguments(argv) {
  const options = { source: null, bounds: DEFAULT_BOUNDS, out: null };
  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1];
    if (argv[index] === '--source') options.source = value;
    else if (argv[index] === '--out') options.out = value;
    else if (argv[index] === '--bounds') {
      const parts = value.split(',').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        throw new Error('--bounds needs west,south,east,north');
      }
      options.bounds = parts;
    } else throw new Error(`Unknown argument ${argv[index]}`);
  }
  if (!options.source) throw new Error('--source <directory of GLO-30 GeoTIFFs> is required');
  options.out ??= path.join(MODULE_ROOT, 'data', 'terrain.db');
  return options;
}

/** Cell-centre coordinate of a global cell index. */
const cellLongitude = (ix) => (ix + 0.5) / CELLS_PER_DEGREE;
const cellLatitude = (iy) => (iy + 0.5) / CELLS_PER_DEGREE;

async function openRaster(file) {
  const tiff = await fromFile(file);
  const image = await tiff.getImage();
  const [west, south, east, north] = image.getBoundingBox();
  const width = image.getWidth();
  const height = image.getHeight();
  const [values] = await image.readRasters();
  return {
    file,
    west,
    south,
    east,
    north,
    width,
    height,
    stepX: (east - west) / width,
    stepY: (north - south) / height,
    values,
    nodata: image.getGDALNoData(),
  };
}

/** Bilinear sample in raster pixel space; returns NaN outside the raster. */
function sample(raster, longitude, latitude) {
  const x = (longitude - raster.west) / raster.stepX - 0.5;
  const y = (raster.north - latitude) / raster.stepY - 0.5;
  if (x < -0.5 || y < -0.5 || x > raster.width - 0.5 || y > raster.height - 0.5) return NaN;
  const x0 = Math.min(Math.max(Math.floor(x), 0), raster.width - 1);
  const y0 = Math.min(Math.max(Math.floor(y), 0), raster.height - 1);
  const x1 = Math.min(x0 + 1, raster.width - 1);
  const y1 = Math.min(y0 + 1, raster.height - 1);
  const fx = Math.min(Math.max(x - x0, 0), 1);
  const fy = Math.min(Math.max(y - y0, 0), 1);
  const at = (column, row) => {
    const value = raster.values[row * raster.width + column];
    return raster.nodata !== null && value === raster.nodata ? NaN : value;
  };
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [west, south, east, north] = options.bounds;
  if (!(west < east && south < north)) throw new Error('--bounds must be west<east, south<north');

  const sources = readdirSync(options.source)
    .filter((name) => name.toLowerCase().endsWith('.tif'))
    .map((name) => path.join(options.source, name));
  if (!sources.length) throw new Error(`No GeoTIFFs in ${options.source}`);

  const txMin = Math.floor(Math.floor(west * CELLS_PER_DEGREE) / TILE);
  const txMax = Math.floor(Math.ceil(east * CELLS_PER_DEGREE - 1) / TILE);
  const tyMin = Math.floor(Math.floor(south * CELLS_PER_DEGREE) / TILE);
  const tyMax = Math.floor(Math.ceil(north * CELLS_PER_DEGREE - 1) / TILE);
  const tiles = new Map();
  const key = (tx, ty) => `${tx}/${ty}`;
  for (let tx = txMin; tx <= txMax; tx += 1) {
    for (let ty = tyMin; ty <= tyMax; ty += 1) {
      tiles.set(key(tx, ty), new Float32Array(TILE * TILE).fill(NaN));
    }
  }
  process.stdout.write(`${tiles.size} tiles from ${sources.length} rasters\n`);

  let filled = 0;
  for (const file of sources) {
    const raster = await openRaster(file);
    if (raster.east <= west || raster.west >= east || raster.north <= south || raster.south >= north)
      continue;
    process.stdout.write(`  ${path.basename(file)}\n`);
    for (const [id, grid] of tiles) {
      const [tx, ty] = id.split('/').map(Number);
      for (let row = 0; row < TILE; row += 1) {
        const latitude = cellLatitude(ty * TILE + row);
        if (latitude < raster.south || latitude > raster.north) continue;
        for (let column = 0; column < TILE; column += 1) {
          const longitude = cellLongitude(tx * TILE + column);
          if (longitude < raster.west || longitude > raster.east) continue;
          const value = sample(raster, longitude, latitude);
          if (Number.isNaN(value)) continue;
          grid[row * TILE + column] = value;
          filled += 1;
        }
      }
    }
    raster.values = null;
  }

  mkdirSync(path.dirname(options.out), { recursive: true });
  rmSync(options.out, { force: true });
  rmSync(`${options.out}-wal`, { force: true });
  rmSync(`${options.out}-shm`, { force: true });
  const database = new DatabaseSync(options.out);
  database.exec(readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));
  const insertTile = database.prepare('INSERT INTO dem_tiles (tx, ty, grid) VALUES (?, ?, ?)');
  const insertMeta = database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  database.exec('BEGIN IMMEDIATE');
  for (const [id, grid] of tiles) {
    const [tx, ty] = id.split('/').map(Number);
    insertTile.run(tx, ty, Buffer.from(grid.buffer, grid.byteOffset, grid.byteLength));
  }
  for (const [name, value] of [
    ['dataset', 'copernicus-dem-glo-30'],
    ['cells_per_degree', String(CELLS_PER_DEGREE)],
    ['tile_size', String(TILE)],
    ['bounds', JSON.stringify(options.bounds)],
    ['vertical_datum', 'EGM2008'],
    ['license', 'Copernicus DEM licence'],
    ['attribution', 'Copernicus DEM © DLR/ESA/EU'],
    ['built_at', new Date().toISOString()],
    ['source_files', JSON.stringify(sources.map((file) => path.basename(file)))],
  ]) {
    insertMeta.run(name, value);
  }
  database.exec('COMMIT');
  database.exec('VACUUM');
  database.close();
  process.stdout.write(`wrote ${options.out}: ${tiles.size} tiles, ${filled} cells\n`);
}

await main();
