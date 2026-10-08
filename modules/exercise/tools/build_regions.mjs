#!/usr/bin/env node
/**
 * Build `modules/exercise/data/regions.json` (GeoJSON, WGS84): the 14 Czech
 * kraje and 77 okresy (Praha counts as an okres too), for composing exercise
 * countries in the Exercise module.
 *
 *   node modules/exercise/tools/build_regions.mjs
 *
 * Source: the ČÚZK RÚIAN whole-state shapefile (S-JTSK / Krovak East North,
 * EPSG:5514), downloaded once into `data/cache/1.zip` and reused on later
 * runs (~253 MB; CC BY 4.0, © ČÚZK). Only the `VUSC_P` (kraje) and `OKRESY_P`
 * (okresy) layers are used; `OKRESY_P.VUSC_KOD` gives each okres its parent
 * kraj directly, so no spatial join is needed.
 *
 * mapshaper reprojects both layers together (`combine-files`, so they share
 * one arc topology: identical boundary segments are simplified once and stay
 * identical after simplification — no slivers or gaps between neighbours or
 * between an okres and the kraj it belongs to) and simplifies with topology
 * preserved. 10% of removable points keeps borders faithful at zoom ~11 and
 * the output under 3 MB (checked empirically: 6/8/10/12% land at roughly
 * 1.5/2.0/2.5/3.0 MB).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mapshaper from 'mapshaper';

import { dataDirectory } from '../../../server/state.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.join(HERE, '..');
const DATA_ROOT = dataDirectory('exercise', path.join(MODULE_ROOT, 'data'));
const CACHE_DIR = path.join(DATA_ROOT, 'cache');
const ZIP_PATH = path.join(CACHE_DIR, '1.zip');
const ZIP_URL = 'https://services.cuzk.gov.cz/shp/stat/epsg-5514/1.zip';
const OUTPUT_PATH = path.join(DATA_ROOT, 'regions.json');

/** Members of the zip actually needed: the two layers, minus their unusable .prj (below). */
const MEMBERS = ['VUSC_P', 'OKRESY_P'].flatMap((layer) =>
  ['shp', 'shx', 'dbf', 'cpg'].map((ext) => `1/${layer}.${ext}`),
);

/**
 * Proj.4 definition of EPSG:5514. The shapefiles ship a `.prj` with a WKT
 * mapshaper can't parse ("S-JTSK_Krovak_East_North"), so it is left out of
 * the extraction and the source CRS is given explicitly instead. The 7-term
 * Helmert (`+towgs84`) is the standard S-JTSK→WGS84 transform used by ČÚZK
 * tools; accurate to a few metres, well inside the simplification tolerance.
 */
const KROVAK_PROJ4 =
  '+proj=krovak +lat_0=49.5 +lon_0=24.83333333333333 +alpha=30.28813972222222 ' +
  '+k=0.9999 +x_0=0 +y_0=0 +ellps=bessel ' +
  '+towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56 +units=m +no_defs';

const SIMPLIFY_PERCENT = 10;

/** Download the RÚIAN whole-state shapefile zip, or reuse it if already cached. */
async function fetchZip() {
  if (existsSync(ZIP_PATH)) {
    process.stdout.write(`  cached  ${path.relative(MODULE_ROOT, ZIP_PATH)}\n`);
    return;
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  process.stdout.write(`  fetch   ${ZIP_URL}\n`);
  const response = await fetch(ZIP_URL);
  if (!response.ok) throw new Error(`GET ${ZIP_URL}: HTTP ${response.status}`);
  const partial = `${ZIP_PATH}.part`;
  writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  renameSync(partial, ZIP_PATH);
}

/** Extract just the kraje/okresy shapefile members (no `.prj`) into a scratch directory. */
function extractLayers() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ipb-regions-'));
  execFileSync('unzip', ['-o', '-j', ZIP_PATH, ...MEMBERS, '-d', dir], { stdio: 'pipe' });
  return dir;
}

/** Reproject + simplify both layers together (shared topology) via mapshaper's JS API. */
async function reprojectAndSimplify(dir) {
  const vusc = path.join(dir, 'VUSC_P.shp');
  const okresy = path.join(dir, 'OKRESY_P.shp');
  const command = [
    `-i ${vusc} ${okresy} encoding=win1250 combine-files`,
    `-proj crs=wgs84 init="${KROVAK_PROJ4}" target=*`,
    `-simplify weighted ${SIMPLIFY_PERCENT}% keep-shapes`,
    '-o format=geojson precision=0.00001',
  ].join(' ');
  const output = await mapshaper.applyCommands(command);
  return {
    vusc: JSON.parse(output['VUSC_P.json']),
    okresy: JSON.parse(output['OKRESY_P.json']),
  };
}

/** Round every coordinate in a Polygon/MultiPolygon geometry to 5 decimals. */
function round5(geometry) {
  const round = (n) => Math.round(n * 1e5) / 1e5;
  const ring = (points) => points.map(([x, y]) => [round(x), round(y)]);
  geometry.coordinates =
    geometry.type === 'Polygon'
      ? geometry.coordinates.map(ring)
      : geometry.coordinates.map((polygon) => polygon.map(ring));
  return geometry;
}

/** Build the regions FeatureCollection from the reprojected kraje/okresy layers. */
function toRegions({ vusc, okresy }) {
  const features = [];
  for (const feature of vusc.features) {
    const { KOD, NAZEV } = feature.properties;
    features.push({
      type: 'Feature',
      properties: { id: `kraj:${KOD}`, level: 'kraj', name: NAZEV },
      geometry: round5(feature.geometry),
    });
  }
  for (const feature of okresy.features) {
    const { KOD, NAZEV, VUSC_KOD } = feature.properties;
    features.push({
      type: 'Feature',
      properties: { id: `okres:${KOD}`, level: 'okres', name: NAZEV, kraj: `kraj:${VUSC_KOD}` },
      geometry: round5(feature.geometry),
    });
  }
  return { type: 'FeatureCollection', features };
}

async function main() {
  await fetchZip();
  const dir = extractLayers();
  let layers;
  try {
    layers = await reprojectAndSimplify(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const regions = toRegions(layers);
  const krajeCount = regions.features.filter((f) => f.properties.level === 'kraj').length;
  const okresyCount = regions.features.filter((f) => f.properties.level === 'okres').length;

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const partial = `${OUTPUT_PATH}.part`;
  writeFileSync(partial, JSON.stringify(regions));
  renameSync(partial, OUTPUT_PATH);

  const bytes = Buffer.byteLength(JSON.stringify(regions));
  process.stdout.write(
    `wrote ${OUTPUT_PATH}: ${krajeCount} kraje, ${okresyCount} okresy, ${(bytes / 1e6).toFixed(2)} MB\n`,
  );
}

await main();
