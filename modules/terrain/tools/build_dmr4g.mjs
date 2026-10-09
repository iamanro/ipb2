#!/usr/bin/env node
/**
 * Build `modules/terrain/data/terrain-dmr4g.db` from ČÚZK's DMR 4G (5 m
 * bare-earth LiDAR DTM, Bpv heights), a detail layer over the coarser GLO-30
 * `terrain.db` (see modules/terrain/server/dem.js's `openElevation`).
 *
 *   node modules/terrain/tools/build_dmr4g.mjs [--bounds west,south,east,north]
 *
 * Without `--bounds`, every one of the ~20,300 sheets in ČÚZK's ATOM feed is
 * built — all of Czechia. The feed (cached at `data/dmr4g/feed.xml`, refetch
 * with `--refresh-feed`) lists each 2x2 km sheet as `<E_km>_<N_km>` in
 * ETRS89/TM33N (EPSG:3045); its data comes from
 * `https://openzu.cuzk.gov.cz/opendata/DMR4G-TIFF/epsg-3045/<name>.zip`, a
 * small zip (a `.tif` and a `.tfw`) this tool unzips itself (no system
 * unzip, no extra dependency: see zip.mjs). Licence per the feed: "žádné
 * podmínky neplatí" (no conditions apply); attributed here as ČÚZK open data
 * (CC BY 4.0), "© ČÚZK".
 *
 * Two phases:
 *  1. Download every wanted sheet into `data/dmr4g/<name>.zip`, resumable
 *     (existing files are kept) and parallel (`--concurrency`, default 8).
 *  2. Reproject: a `--workers` (default up to 32) pool of worker_threads
 *     each decode a sheet's TIFF and bilinearly resample it, in UTM pixel
 *     space, onto the lon/lat grid documented in schema.sql, at
 *     `cells_per_degree = 21600` (1/6 arc-second, ~5.1 m N-S — DMR4G's own
 *     resolution, so this mostly isn't even upsampling). The UTM<->lon/lat
 *     transform is utm33.mjs, hand-written (no proj4 dependency) and
 *     unit-tested against known control points.
 *
 * Sheets are processed as they finish (any order); the main thread merges
 * their output tiles into a batch, and flushes the batch to the database
 * (reading and merging any tile a previous batch already touched, since a
 * tile can straddle two sheets) once it holds `FLUSH_TILES` tiles, so memory
 * stays bounded regardless of how many sheets there are in total. Only
 * tiles with at least one real sample are ever written.
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { dataDirectory } from '../../../server/state.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.join(HERE, '..');
const DATA_ROOT = dataDirectory('terrain', path.join(MODULE_ROOT, 'data'));
const SHEET_CACHE = path.join(DATA_ROOT, 'dmr4g');
const FEED_URL = 'https://atom.cuzk.gov.cz/DMR4G-ETRS89-TIFF/DMR4G-ETRS89-TIFF.xml';
const FEED_CACHE = path.join(SHEET_CACHE, 'feed.xml');
const DATA_URL_BASE = 'https://openzu.cuzk.gov.cz/opendata/DMR4G-TIFF/epsg-3045';

const CELLS_PER_DEGREE = 21600;
const TILE = 256;
/** Bounds memory: flush once a batch holds this many distinct output tiles (~1 GB of grids). */
const FLUSH_TILES = 3000;
/** Both a slow mirror and a 404 on a sheet just outside the border are possible; retry, then skip. */
const DOWNLOAD_ATTEMPTS = 4;

function parseArguments(argv) {
  const options = {
    bounds: null,
    concurrency: 8,
    workers: Math.min(32, os.availableParallelism()),
    out: null,
    refreshFeed: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--refresh-feed') {
      options.refreshFeed = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === '--bounds') {
      const parts = value.split(',').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        throw new Error('--bounds needs west,south,east,north');
      }
      options.bounds = parts;
    } else if (flag === '--concurrency') options.concurrency = Math.max(1, Number(value));
    else if (flag === '--workers') options.workers = Math.max(1, Number(value));
    else if (flag === '--out') options.out = value;
    else if (flag === '--feed') options.feedUrl = value;
    else throw new Error(`Unknown argument ${flag}`);
    index += 1;
  }
  options.out ??= path.join(DATA_ROOT, 'terrain-dmr4g.db');
  options.feedUrl ??= FEED_URL;
  return options;
}

/** Fetches (or reuses) the ATOM feed and pulls out every sheet name it lists. */
async function fetchSheetNames(feedUrl, refresh) {
  mkdirSync(SHEET_CACHE, { recursive: true });
  let xml;
  if (!refresh && existsSync(FEED_CACHE)) {
    xml = readFileSync(FEED_CACHE, 'utf8');
  } else {
    const response = await fetch(feedUrl);
    if (!response.ok) throw new Error(`GET ${feedUrl}: HTTP ${response.status}`);
    xml = await response.text();
    const partial = `${FEED_CACHE}.part`;
    writeFileSync(partial, xml);
    renameSync(partial, FEED_CACHE);
  }
  const names = [];
  const entryRegex = /<title>[^<]*mapov\S* list:\s*(\d+_\d+)<\/title>/g;
  let match;
  while ((match = entryRegex.exec(xml))) names.push(match[1]);
  if (!names.length) throw new Error(`No sheets found in the feed at ${feedUrl}`);
  return names;
}

/** UTM zone-33N bounds of a sheet, exact from its name (see build_dmr4g_worker.mjs). */
function sheetUtmBounds(name) {
  const [eastKm, northKm] = name.split('_').map(Number);
  const west = eastKm * 1000;
  const south = northKm * 1000;
  return [west, south, west + 2000, south + 2000];
}

/** Whether a sheet's lon/lat footprint (from its UTM corners) can overlap `bounds`. */
function overlapsBounds(name, bounds, utm33ToLonLat) {
  if (!bounds) return true;
  const [west, south, east, north] = sheetUtmBounds(name);
  const corners = [
    utm33ToLonLat(west, south),
    utm33ToLonLat(east, south),
    utm33ToLonLat(west, north),
    utm33ToLonLat(east, north),
  ];
  const lons = corners.map(([lon]) => lon);
  const lats = corners.map(([, lat]) => lat);
  const [bWest, bSouth, bEast, bNorth] = bounds;
  return (
    Math.min(...lons) < bEast &&
    Math.max(...lons) > bWest &&
    Math.min(...lats) < bNorth &&
    Math.max(...lats) > bSouth
  );
}

async function fetchSheetZip(name) {
  const file = path.join(SHEET_CACHE, `${name}.zip`);
  if (existsSync(file)) return file;
  const url = `${DATA_URL_BASE}/${name}.zip`;
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const partial = `${file}.part`;
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      renameSync(partial, file);
      return file;
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS)
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`${name}: ${lastError.message}`);
}

/** Prints `done/total`, a rate and an ETA, at most every second. */
function progress(label, startedAt) {
  let lastPrint = 0;
  return (done, total) => {
    const now = Date.now();
    if (done < total && now - lastPrint < 1000) return;
    lastPrint = now;
    const elapsed = (now - startedAt) / 1000;
    const rate = done / Math.max(elapsed, 0.001);
    const etaSeconds = rate > 0 ? Math.round((total - done) / rate) : 0;
    const eta =
      done < total
        ? `, ETA ${Math.floor(etaSeconds / 60)}m${String(etaSeconds % 60).padStart(2, '0')}s`
        : '';
    process.stdout.write(`  ${label} ${done}/${total} (${rate.toFixed(1)}/s${eta})\n`);
  };
}

async function downloadSheets(names, concurrency) {
  const report = progress('downloaded', Date.now());
  let done = 0;
  const failures = [];
  let next = 0;
  async function worker() {
    while (next < names.length) {
      const name = names[next];
      next += 1;
      try {
        await fetchSheetZip(name);
      } catch (error) {
        failures.push(error.message);
      }
      done += 1;
      report(done, names.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (failures.length) {
    process.stdout.write(
      `${failures.length} sheets failed to download, e.g. ${failures[0]}. Rerun to retry.\n`,
    );
  }
  return names.filter((name) => existsSync(path.join(SHEET_CACHE, `${name}.zip`)));
}

/** Merges `incoming` (NaN outside its data) into `existing`, keeping any value `existing` already has. */
function mergeGrid(existing, incoming) {
  for (let i = 0; i < incoming.length; i += 1) {
    if (!Number.isNaN(incoming[i])) existing[i] = incoming[i];
  }
}

function flushBatch(database, batch) {
  if (!batch.size) return;
  const selectTile = database.prepare('SELECT grid FROM dem_tiles WHERE tx = ? AND ty = ?');
  const upsertTile = database.prepare(
    'INSERT OR REPLACE INTO dem_tiles (tx, ty, grid) VALUES (?, ?, ?)',
  );
  database.exec('BEGIN IMMEDIATE');
  for (const { tx, ty, grid } of batch.values()) {
    const existingRow = selectTile.get(tx, ty);
    if (existingRow) {
      const existing = new Float32Array(
        existingRow.grid.buffer,
        existingRow.grid.byteOffset,
        existingRow.grid.byteLength / 4,
      );
      mergeGrid(existing, grid);
      upsertTile.run(
        tx,
        ty,
        Buffer.from(existing.buffer, existing.byteOffset, existing.byteLength),
      );
    } else {
      upsertTile.run(tx, ty, Buffer.from(grid.buffer, grid.byteOffset, grid.byteLength));
    }
  }
  database.exec('COMMIT');
  batch.clear();
}

/** Runs every sheet through the worker pool, flushing merged tiles to `database` as it goes. */
async function reproject(database, sheetFiles, workerCount) {
  const report = progress('reprojected', Date.now());
  const batch = new Map();
  let dataBounds = null;
  let totalFilled = 0;
  let done = 0;
  let failed = 0;
  let next = 0;
  const workerUrl = new URL('./build_dmr4g_worker.mjs', import.meta.url);

  await new Promise((resolve, reject) => {
    const workers = [];
    function assignNext(worker) {
      if (next >= sheetFiles.length) return false;
      const [name, zipFile] = sheetFiles[next];
      next += 1;
      worker.postMessage({ type: 'sheet', name, zipFile });
      return true;
    }
    function finishIfDone() {
      if (done + failed >= sheetFiles.length) {
        for (const worker of workers) worker.terminate();
        resolve();
      }
    }
    for (let i = 0; i < workerCount; i += 1) {
      const worker = new Worker(workerUrl, {
        workerData: { cellsPerDegree: CELLS_PER_DEGREE, tileSize: TILE },
      });
      workers.push(worker);
      worker.on('error', reject);
      worker.on('message', (message) => {
        if (message.type === 'ready') {
          if (!assignNext(worker)) finishIfDone();
          return;
        }
        if (message.type === 'error') {
          process.stdout.write(`  ${message.name}: ${message.message}\n`);
          failed += 1;
        } else if (message.type === 'result') {
          for (const { tx, ty, buffer } of message.tiles) {
            const key = `${tx}/${ty}`;
            const grid = new Float32Array(buffer);
            const existing = batch.get(key);
            if (existing) mergeGrid(existing.grid, grid);
            else batch.set(key, { tx, ty, grid });
          }
          totalFilled += message.filled;
          const [w, s, e, n] = message.lonLatBounds;
          dataBounds = dataBounds
            ? [
                Math.min(dataBounds[0], w),
                Math.min(dataBounds[1], s),
                Math.max(dataBounds[2], e),
                Math.max(dataBounds[3], n),
              ]
            : [w, s, e, n];
          done += 1;
          if (batch.size >= FLUSH_TILES) flushBatch(database, batch);
        }
        report(done + failed, sheetFiles.length);
        if (!assignNext(worker)) finishIfDone();
      });
    }
  });
  flushBatch(database, batch);
  return { dataBounds, totalFilled, failed };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { utm33ToLonLat } = await import('./utm33.mjs');

  process.stdout.write(`fetching sheet list from ${options.feedUrl}\n`);
  const allNames = await fetchSheetNames(options.feedUrl, options.refreshFeed);
  const names = allNames.filter((name) => overlapsBounds(name, options.bounds, utm33ToLonLat));
  if (!names.length) throw new Error('No DMR4G sheets cover --bounds');
  process.stdout.write(`${names.length} of ${allNames.length} sheets selected\n`);

  process.stdout.write('downloading (resumable; existing sheets are reused)\n');
  const downloaded = await downloadSheets(names, options.concurrency);
  if (!downloaded.length) throw new Error('No sheets downloaded');
  const sheetFiles = downloaded.map((name) => [name, path.join(SHEET_CACHE, `${name}.zip`)]);

  mkdirSync(path.dirname(options.out), { recursive: true });
  rmSync(options.out, { force: true });
  rmSync(`${options.out}-wal`, { force: true });
  rmSync(`${options.out}-shm`, { force: true });
  const database = new DatabaseSync(options.out);
  database.exec(readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));

  process.stdout.write(`reprojecting with ${options.workers} workers\n`);
  const { dataBounds, totalFilled, failed } = await reproject(
    database,
    sheetFiles,
    options.workers,
  );
  if (failed)
    process.stdout.write(
      `${failed} sheets failed to reproject (see above); the rest were built.\n`,
    );

  const insertMeta = database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  for (const [name, value] of [
    ['dataset', 'cuzk-dmr4g'],
    ['cells_per_degree', String(CELLS_PER_DEGREE)],
    ['tile_size', String(TILE)],
    ['bounds', JSON.stringify(dataBounds ?? [0, 0, 0, 0])],
    ['vertical_datum', 'Bpv'],
    [
      'license',
      'ČÚZK open data (CC BY 4.0); "žádné podmínky neplatí" (no conditions apply) per the ATOM feed',
    ],
    ['attribution', '© ČÚZK'],
    ['built_at', new Date().toISOString()],
    ['sheet_count', String(sheetFiles.length)],
  ]) {
    insertMeta.run(name, value);
  }
  database.exec('VACUUM');
  const tileCount = database.prepare('SELECT COUNT(*) AS n FROM dem_tiles').get().n;
  database.close();

  const size = statSync(options.out).size;
  process.stdout.write(
    `wrote ${options.out}: ${tileCount} tiles, ${totalFilled} cells, ${(size / 1024 / 1024).toFixed(1)} MB\n`,
  );
}

await main();
