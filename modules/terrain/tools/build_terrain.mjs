#!/usr/bin/env node
/**
 * Build `modules/terrain/data/terrain.db` from Copernicus GLO-30 GeoTIFFs.
 *
 *   node modules/terrain/tools/build_terrain.mjs --bounds 17.2,49.5,17.8,49.9
 *
 * Without `--source`, the 1°×1° GLO-30 tiles covering `--bounds` are
 * downloaded from the public AWS Open Data bucket (no account) into
 * `data/glo30/`; tiles already there are reused. Tiles the dataset does not
 * have (open ocean) are skipped. With `--source <dir>`, every GeoTIFF in that
 * directory is used and nothing is downloaded.
 *
 * Source rasters are read straight from GeoTIFF (no GDAL) and resampled onto the
 * one-arc-second grid documented in schema.sql. Rebuilding is idempotent: the
 * output file is replaced.
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { fromFile } from 'geotiff';

import { dataDirectory } from '../../../server/state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.join(HERE, '..');
const DATA_ROOT = dataDirectory('terrain', path.join(MODULE_ROOT, 'data'));
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
  options.out ??= path.join(DATA_ROOT, 'terrain.db');
  return options;
}

const GLO30_BUCKET = 'https://copernicus-dem-30m.s3.amazonaws.com';
const GLO30_CACHE = path.join(DATA_ROOT, 'glo30');

/** GLO-30 tile name for the 1° cell whose south-west corner is (lon, lat). */
function glo30Name(lon, lat) {
  const ns = `${lat < 0 ? 'S' : 'N'}${String(Math.abs(lat)).padStart(2, '0')}`;
  const ew = `${lon < 0 ? 'W' : 'E'}${String(Math.abs(lon)).padStart(3, '0')}`;
  return `Copernicus_DSM_COG_10_${ns}_00_${ew}_00_DEM`;
}

/**
 * Download (or reuse from the cache) every GLO-30 tile intersecting the
 * bounds. Writes to `<name>.tif.part` and renames on completion, so an
 * interrupted run never leaves a truncated tile that a rerun would trust.
 */
async function fetchGlo30([west, south, east, north]) {
  mkdirSync(GLO30_CACHE, { recursive: true });
  const files = [];
  for (let lat = Math.floor(south); lat < north; lat += 1) {
    for (let lon = Math.floor(west); lon < east; lon += 1) {
      const name = glo30Name(lon, lat);
      const file = path.join(GLO30_CACHE, `${name}.tif`);
      if (existsSync(file)) {
        process.stdout.write(`  cached  ${name}\n`);
        files.push(file);
        continue;
      }
      const response = await fetch(`${GLO30_BUCKET}/${name}/${name}.tif`);
      if (response.status === 404 || response.status === 403) {
        // The bucket answers missing keys with 403 or 404; GLO-30 has no tile there (open ocean).
        process.stdout.write(`  no tile ${name} (no land in this cell)\n`);
        continue;
      }
      if (!response.ok) throw new Error(`GET ${name}: HTTP ${response.status}`);
      process.stdout.write(`  fetch   ${name}\n`);
      const partial = `${file}.part`;
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      renameSync(partial, file);
      files.push(file);
    }
  }
  return files;
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

  const sources = options.source
    ? readdirSync(options.source)
        .filter((name) => name.toLowerCase().endsWith('.tif'))
        .map((name) => path.join(options.source, name))
    : await fetchGlo30(options.bounds);
  if (!sources.length) {
    throw new Error(
      options.source ? `No GeoTIFFs in ${options.source}` : 'No GLO-30 tiles cover --bounds',
    );
  }

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
    if (
      raster.east <= west ||
      raster.west >= east ||
      raster.north <= south ||
      raster.south >= north
    )
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
