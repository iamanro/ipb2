#!/usr/bin/env node
/**
 * Download aerial/satellite imagery into an MBTiles archive for the offline
 * "Satellite" and "Aerial" basemaps.
 *
 *   node modules/terrain/tools/build_satellite.mjs
 *   node modules/terrain/tools/build_satellite.mjs --bounds 17.2,49.5,17.8,49.9 --year 2025
 *   node modules/terrain/tools/build_satellite.mjs --source cuzk --study 3
 *
 * `--source eox` (default) writes `satellite.mbtiles` from EOxCloudless
 * (Sentinel-2 cloudless, 10 m, native around zoom 13-14; the map upscales
 * past `--max-zoom`). `--source cuzk` writes `ortho.mbtiles` from ČÚZK's
 * Ortofoto Web Mercator service (sub-metre, native to zoom 20).
 *
 * `--bounds` defaults to the bounds of the built terrain.db, so imagery and
 * elevation cover the same ground. `--study <id>` is the easy way to fetch a
 * chosen area of interest instead: it reads that IPB study's saved AOI
 * bounds (read-only) from the analyst's own `modules/ipb/state/ipb.db` (or
 * `$IPB_STATE_ROOT/ipb/ipb.db`). `--bounds` and `--study` are exclusive.
 *
 * Safe to interrupt: rerunning with the same source, year and bounds keeps
 * what is already downloaded and fetches the rest. Other settings start a
 * new archive.
 *
 * Licence, EOX: 2016 imagery is CC BY 4.0; 2017 and later are CC BY-NC-SA 4.0
 * (non-commercial). See https://cloudless.eox.at.
 * Licence, ČÚZK: Ortofoto ČR is CC BY 4.0. See https://cuzk.gov.cz.
 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { dataDirectory, stateDirectory } from '../../../server/state.ts';
import { tileRange, tmsRow } from '../server/tiles.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = dataDirectory('terrain', path.join(HERE, '..', 'data'));
const IPB_DATABASE = path.join(
  stateDirectory('ipb', path.join(HERE, '..', '..', 'ipb', 'state')),
  'ipb.db',
);
const DEFAULT_BOUNDS = [17.2, 49.5, 17.8, 49.9];
/** Default guard against an accidental huge download; `--max-tiles` raises it. */
const MAX_TILES = 20000;
/** Both services throttle bursts with transient errors; back off 1, 2, 4 s before giving up. */
const ATTEMPTS = 4;

/** Per-source defaults and how to name and address its tiles. */
const SOURCES = {
  eox: {
    out: 'satellite.mbtiles',
    minZoom: 8,
    maxZoom: 14,
    // EOX publishes 2016 without a year in the layer name.
    layer: (year) => (year === 2016 ? 's2cloudless_3857' : `s2cloudless-${year}_3857`),
    url: (layer, z, x, y) =>
      `https://tiles.maps.eox.at/wmts/1.0.0/${layer}/default/g/${z}/${y}/${x}.jpg`,
    name: (year) => `Sentinel-2 cloudless ${year}`,
    attribution: (year) => {
      const licence =
        year === 2016
          ? 'CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)'
          : 'CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/)';
      return `EOxCloudless ${year} https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data ${year}), ${licence}`;
    },
  },
  cuzk: {
    out: 'ortho.mbtiles',
    minZoom: 12,
    maxZoom: 18,
    layer: () => 'ortofoto_wm',
    url: (layer, z, x, y) =>
      `https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/${z}/${y}/${x}`,
    name: () => 'ČÚZK Ortofoto',
    attribution: () => 'Ortofoto © ČÚZK (CC BY 4.0)',
  },
};

function parseArguments(argv) {
  const options = {
    source: 'eox',
    bounds: null,
    study: null,
    year: null,
    minZoom: null,
    maxZoom: null,
    concurrency: 4,
    maxTiles: MAX_TILES,
    out: null,
  };
  const integer = (flag, value, min, max) => {
    const number = Number.parseInt(value, 10);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new Error(`${flag} must be an integer from ${min} to ${max}`);
    }
    return number;
  };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (flag === '--source') {
      if (!Object.hasOwn(SOURCES, value))
        throw new Error(`--source must be one of ${Object.keys(SOURCES).join(', ')}`);
      options.source = value;
    } else if (flag === '--bounds') {
      const parts = value.split(',').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        throw new Error('--bounds needs west,south,east,north');
      }
      options.bounds = parts;
    } else if (flag === '--study') options.study = integer(flag, value, 1, Number.MAX_SAFE_INTEGER);
    else if (flag === '--year') options.year = integer(flag, value, 2016, 2100);
    else if (flag === '--min-zoom') options.minZoom = integer(flag, value, 0, 22);
    else if (flag === '--max-zoom') options.maxZoom = integer(flag, value, 0, 22);
    else if (flag === '--concurrency') options.concurrency = integer(flag, value, 1, 16);
    else if (flag === '--max-tiles') options.maxTiles = integer(flag, value, 1, 10_000_000);
    else if (flag === '--out') options.out = value;
    else throw new Error(`Unknown argument ${flag}`);
  }
  const config = SOURCES[options.source];
  if (options.year !== null && options.source !== 'eox') {
    throw new Error('--year only applies to --source eox');
  }
  if (options.source === 'eox') options.year ??= 2025;
  options.minZoom ??= config.minZoom;
  options.maxZoom ??= config.maxZoom;
  if (options.minZoom > options.maxZoom) throw new Error('--min-zoom must be <= --max-zoom');
  if (options.bounds && options.study !== null) {
    throw new Error('--bounds and --study are exclusive');
  }
  if (options.study !== null) options.bounds = studyBounds(options.study);
  options.bounds ??= terrainBounds() ?? DEFAULT_BOUNDS;
  const [west, south, east, north] = options.bounds;
  if (!(west < east && south < north)) throw new Error('--bounds must be west<east, south<north');
  options.out ??= path.join(DATA_ROOT, config.out);
  return options;
}

/** Bounds of the built elevation model, so imagery covers the same ground. */
function terrainBounds() {
  const file = path.join(DATA_ROOT, 'terrain.db');
  if (!existsSync(file)) return null;
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const row = database.prepare("SELECT value FROM meta WHERE key = 'bounds'").get();
    return row ? JSON.parse(row.value) : null;
  } finally {
    database.close();
  }
}

/** An IPB study's saved AOI bounds, read-only, for `--study`. */
function studyBounds(id) {
  if (!existsSync(IPB_DATABASE)) {
    throw new Error(
      `No IPB state at ${IPB_DATABASE}; open the study once in the Exercise/IPB module first.`,
    );
  }
  const database = new DatabaseSync(IPB_DATABASE, { readOnly: true });
  try {
    const row = database.prepare('SELECT name, bounds FROM studies WHERE id = ?').get(id);
    if (!row) throw new Error(`No study ${id} in ${IPB_DATABASE}`);
    if (!row.bounds) throw new Error(`Study ${id} ("${row.name}") has no AOI bounds set yet.`);
    return JSON.parse(row.bounds);
  } finally {
    database.close();
  }
}

/**
 * The running server reads the archive while this writes it; wait out its
 * brief read locks instead of failing the tile.
 */
const WRITE_OPTIONS = { timeout: 5000 };

/** Open the archive, reusing it only if it was started with the same layer and bounds. */
function openArchive(file, layer, bounds) {
  if (existsSync(file)) {
    const existing = new DatabaseSync(file, WRITE_OPTIONS);
    const meta = Object.fromEntries(
      existing
        .prepare('SELECT name, value FROM metadata')
        .all()
        .map((row) => [row.name, row.value]),
    );
    if (meta.layer === layer && meta.bounds === bounds.join(',')) return existing;
    existing.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
  }
  const database = new DatabaseSync(file, WRITE_OPTIONS);
  // MBTiles 1.3 layout: rows are TMS (south-up), see tiles.js tmsRow.
  database.exec(`
    CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
    CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
  `);
  return database;
}

async function fetchTile(config, layer, { z, x, y }) {
  const url = config.url(layer, z, x, y);
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.headers.get('content-type')?.startsWith('image/jpeg')) {
        throw new Error(`unexpected ${response.headers.get('content-type')}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
      }
    }
  }
  throw new Error(`${z}/${x}/${y}: ${lastError.message}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const config = SOURCES[options.source];
  const layer = config.layer(options.year);

  const wanted = [];
  for (let z = options.minZoom; z <= options.maxZoom; z += 1) {
    const { minX, maxX, minY, maxY } = tileRange(options.bounds, z);
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) wanted.push({ z, x, y });
    }
  }
  if (wanted.length > options.maxTiles) {
    throw new Error(
      `${wanted.length} tiles is more than ${options.maxTiles}; narrow --bounds, ` +
        'lower --max-zoom, or raise --max-tiles',
    );
  }

  const database = openArchive(options.out, layer, options.bounds);
  const setMeta = database.prepare('INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)');
  for (const [name, value] of [
    ['name', config.name(options.year)],
    ['format', 'jpg'],
    ['type', 'baselayer'],
    ['bounds', options.bounds.join(',')],
    ['minzoom', String(options.minZoom)],
    ['maxzoom', String(options.maxZoom)],
    ['attribution', config.attribution(options.year)],
    ['layer', layer],
  ]) {
    setMeta.run(name, value);
  }

  const have = new Set(
    database
      .prepare('SELECT zoom_level, tile_column, tile_row FROM tiles')
      .all()
      .map((row) => `${row.zoom_level}/${row.tile_column}/${tmsRow(row.zoom_level, row.tile_row)}`),
  );
  const missing = wanted.filter(({ z, x, y }) => !have.has(`${z}/${x}/${y}`));
  process.stdout.write(
    `${layer}: ${wanted.length} tiles for zoom ${options.minZoom}-${options.maxZoom}, ` +
      `${wanted.length - missing.length} already downloaded\n`,
  );

  const insert = database.prepare(
    'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)',
  );
  let done = 0;
  const failures = [];
  let next = 0;
  async function worker() {
    while (next < missing.length) {
      const tile = missing[next];
      next += 1;
      try {
        insert.run(tile.z, tile.x, tmsRow(tile.z, tile.y), await fetchTile(config, layer, tile));
      } catch (error) {
        failures.push(error.message);
      }
      done += 1;
      if (done % 50 === 0 || done === missing.length) {
        process.stdout.write(`  ${done}/${missing.length}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: options.concurrency }, worker));

  setMeta.run('built_at', new Date().toISOString());
  database.close();
  if (failures.length) {
    process.stderr.write(`${failures.length} tiles failed, e.g. ${failures[0]}. Rerun to retry.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`wrote ${options.out}\n`);
}

await main();
