import { existsSync } from 'node:fs';

import { HttpError } from '../../../server/http.ts';
import { referenceFile } from '../../../server/reference.ts';
import { openElevation, openTerrain } from './dem.js';
import { DETAIL_DATABASE, DETAIL_TILE_CACHE_LIMIT, ELEVATION_DATABASE } from './paths.js';

/**
 * The composite elevation model, reopened whenever `terrain.db` or
 * `terrain-dmr4g.db` changes on disk (see `referenceFile`). Both the main
 * thread (cheap point lookups, `meta`) and every terrain worker (heavy
 * analyses, see `pool.js`) call this independently, each holding its own
 * handle and its own DEM tile cache — so a rebuilt dataset is picked up by
 * every one of them without a restart, and workers don't fight the main
 * thread or each other over one cache.
 */
export function openElevationSource() {
  return referenceFile([ELEVATION_DATABASE, DETAIL_DATABASE], ([baseFile, detailFile]) => {
    const base = openTerrain(baseFile);
    const detail = existsSync(detailFile)
      ? openTerrain(detailFile, { tileCacheLimit: DETAIL_TILE_CACHE_LIMIT })
      : null;
    return openElevation(base, detail);
  });
}

/** The current elevation model, or a 503 `HttpError` while none is built. */
export function currentElevationModel(source) {
  let model;
  try {
    model = source.get();
  } catch {
    model = null;
  }
  if (!model) {
    throw new HttpError(
      503,
      'No elevation data. Build it with modules/terrain/tools/build_terrain.mjs.',
    );
  }
  return model;
}
