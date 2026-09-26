import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dataDirectory } from '../../../server/state.js';

export const ID = 'terrain';

export const DATA_ROOT = dataDirectory(
  ID,
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'),
);

export const ELEVATION_DATABASE = path.join(DATA_ROOT, 'terrain.db');
/** ČÚZK DMR4G, 5 m bare-earth detail over the 30 m base; optional (build_dmr4g.mjs). */
export const DETAIL_DATABASE = path.join(DATA_ROOT, 'terrain-dmr4g.db');
export const BASEMAP = path.join(DATA_ROOT, 'vector.pmtiles');
export const IMAGERY_DATABASE = path.join(DATA_ROOT, 'satellite.mbtiles');
export const ORTHO_DATABASE = path.join(DATA_ROOT, 'ortho.mbtiles');

// A 256-cell DMR4G tile spans ~1.3 km N-S (~0.85 km E-W at Czech latitudes)
// at 21600 cells/degree; a 15 km-radius viewshed's 30x30 km bounding square
// can touch on the order of 800 of them. Sized (and measured, see README) so
// one combined viewshed at 5 m doesn't evict and re-decode its own tiles.
// This cache lives per elevation-model instance, and every terrain worker
// (see pool.js) opens its own instance, so this is per-worker memory - mind
// IPB_TERRAIN_WORKERS when changing it (see pool.js for the budget).
export const DETAIL_TILE_CACHE_LIMIT = 1536;
