// Runs inside a `node:worker_threads` Worker spawned by pool.js. Opens its
// own elevation model (see elevationSource.js) so it's independent of the
// main thread's cache and picks up rebuilt data the same way. Handles one
// job at a time — see pool.js for why (cheap, safe cancellation-by-termination).
import { parentPort } from 'node:worker_threads';

import { HttpError } from '../../../server/http.js';
import { encodePng } from '../../../server/png.js';
import { contourTile } from './contours.js';
import { suggestAvenues } from './corridors.js';
import { currentElevationModel, openElevationSource } from './elevationSource.js';
import { elevationExtremes } from './extremes.js';
import { keyTerrainCandidates } from './keyTerrain.js';
import { mobilityOverlay } from './mobility.js';
import { BASEMAP } from './paths.js';
import { renderHillshade, renderSlopeClasses } from './rasterTiles.js';

const RASTER_RENDERERS = { hillshade: renderHillshade, slope: renderSlopeClasses };

const source = openElevationSource();

/**
 * Default HTTP status for a plain (non-`HttpError`) domain error thrown by
 * each job kind — mirrors the try/catch that used to sit in routes.js right
 * next to each analysis call.
 */
const DEFAULT_ERROR_STATUS = {
  viewshed: 422,
  extremes: 422,
  avenues: 422,
  mobility: 500,
  'key-terrain': 500,
  raster: 500,
  contour: 500,
};

/** A `Uint8Array` over its own, un-pooled `ArrayBuffer`, safe to hand to `postMessage`'s transfer list. */
function ownBytes(bytes) {
  if (bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength) {
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer);
  }
  return new Uint8Array(bytes); // copies out of a shared/offset buffer (e.g. Node's small-Buffer pool)
}

/** ArrayBuffers inside `result` that are safe and worthwhile to transfer instead of structured-cloning. */
function transferablesOf(result) {
  if (result instanceof Uint8Array) return [result.buffer];
  if (result?.values instanceof Uint8Array) return [result.values.buffer];
  return [];
}

async function runJob(kind, payload) {
  switch (kind) {
    case 'raster': {
      const model = currentElevationModel(source);
      const { renderer, z, x, y } = payload;
      const pixels = RASTER_RENDERERS[renderer](model.elevation, z, x, y);
      return ownBytes(encodePng(256, 256, pixels));
    }
    case 'contour': {
      const model = currentElevationModel(source);
      const { z, x, y } = payload;
      return ownBytes(Buffer.from(JSON.stringify(contourTile(model.elevation, z, x, y))));
    }
    case 'viewshed': {
      const model = currentElevationModel(source);
      return model.viewshed(payload);
    }
    case 'extremes': {
      const model = currentElevationModel(source);
      return elevationExtremes(model.elevation, payload.area);
    }
    case 'key-terrain': {
      const model = currentElevationModel(source);
      const { bounds, minProminence, limit, radiusMetres } = payload;
      const visibleArea = (lon, lat) => {
        const grid = model.viewshed({ observers: [{ lon, lat }], radiusMetres, cellMetres: 100 });
        return (grid.visibleCells * grid.cellMetres ** 2) / 1e6;
      };
      return keyTerrainCandidates({
        elevation: model.elevation,
        bounds,
        minProminence,
        limit,
        visibleArea,
      });
    }
    case 'mobility': {
      const model = currentElevationModel(source);
      return mobilityOverlay({
        terrain: model,
        basemapFile: BASEMAP,
        bounds: payload.bounds,
        cellMetres: payload.cellMetres,
      });
    }
    case 'avenues': {
      const model = currentElevationModel(source);
      const grid = await mobilityOverlay({
        terrain: model,
        basemapFile: BASEMAP,
        bounds: payload.bounds,
        cellMetres: payload.cellMetres,
      });
      return suggestAvenues(grid, payload.avenues);
    }
    default:
      throw new HttpError(400, `Unknown terrain job kind "${kind}".`);
  }
}

parentPort.on('message', async ({ id, kind, payload }) => {
  try {
    const result = await runJob(kind, payload);
    parentPort.postMessage({ id, ok: true, result }, transferablesOf(result));
  } catch (error) {
    const status = error instanceof HttpError ? error.status : DEFAULT_ERROR_STATUS[kind] || 500;
    parentPort.postMessage({
      id,
      ok: false,
      status,
      message: error.message || 'Terrain analysis failed.',
    });
  }
});
