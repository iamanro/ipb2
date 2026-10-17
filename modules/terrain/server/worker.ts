// Runs inside a `node:worker_threads` Worker spawned by pool.js. Opens its
// own elevation model (see elevationSource.js) so it's independent of the
// main thread's cache and picks up rebuilt data the same way. Handles one
// job at a time — see pool.js for why (cheap, safe cancellation-by-termination).
import { parentPort as port } from 'node:worker_threads';

import { HttpError } from '../../../server/http.ts';
import { encodePng } from '../../../server/png.ts';
import { contourTile } from './contours.ts';
import { suggestAvenues } from './corridors.ts';
import { currentElevationModel, openElevationSource } from './elevationSource.ts';
import { elevationExtremes } from './extremes.ts';
import type { JobKind, JobRequest, JobResult, WorkerReply } from './jobs.ts';
import { keyTerrainCandidates } from './keyTerrain.ts';
import { mobilityOverlay } from './mobility.ts';
import { BASEMAP } from './paths.ts';
import { renderHillshade, renderSlopeClasses } from './rasterTiles.ts';

const RASTER_RENDERERS = { hillshade: renderHillshade, slope: renderSlopeClasses };

const source = openElevationSource();

/**
 * Default HTTP status for a plain (non-`HttpError`) domain error thrown by
 * each job kind — mirrors the try/catch that used to sit in routes.js right
 * next to each analysis call.
 */
const DEFAULT_ERROR_STATUS: Record<JobKind, number> = {
  viewshed: 422,
  extremes: 422,
  avenues: 422,
  mobility: 500,
  'key-terrain': 500,
  raster: 500,
  contour: 500,
};

/** A `Uint8Array` over its own, un-pooled `ArrayBuffer`, safe to hand to `postMessage`'s transfer list. */
function ownBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.byteOffset === 0 &&
    bytes.buffer instanceof ArrayBuffer &&
    bytes.buffer.byteLength === bytes.byteLength
  ) {
    return new Uint8Array(bytes.buffer);
  }
  return new Uint8Array(bytes); // copies out of a shared/offset buffer (e.g. Node's small-Buffer pool)
}

/** ArrayBuffers inside `result` that are safe and worthwhile to transfer instead of structured-cloning. */
function transferablesOf(result: JobResult): ArrayBuffer[] {
  const bytes =
    result instanceof Uint8Array
      ? result
      : !Array.isArray(result) && 'values' in result
        ? result.values
        : null;
  return bytes && bytes.buffer instanceof ArrayBuffer ? [bytes.buffer] : [];
}

async function runJob(job: JobRequest): Promise<JobResult> {
  switch (job.kind) {
    case 'raster': {
      const model = currentElevationModel(source);
      const { renderer, z, x, y } = job.payload;
      const pixels = RASTER_RENDERERS[renderer](model.elevation, z, x, y);
      return ownBytes(encodePng(256, 256, pixels));
    }
    case 'contour': {
      const model = currentElevationModel(source);
      const { z, x, y } = job.payload;
      return ownBytes(Buffer.from(JSON.stringify(contourTile(model.elevation, z, x, y))));
    }
    case 'viewshed': {
      const model = currentElevationModel(source);
      return model.viewshed(job.payload);
    }
    case 'extremes': {
      const model = currentElevationModel(source);
      return elevationExtremes(model.elevation, job.payload.area);
    }
    case 'key-terrain': {
      const model = currentElevationModel(source);
      const { bounds, minProminence, limit, radiusMetres } = job.payload;
      const visibleArea = (lon: number, lat: number) => {
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
        bounds: job.payload.bounds,
        cellMetres: job.payload.cellMetres,
      });
    }
    case 'avenues': {
      const model = currentElevationModel(source);
      const grid = await mobilityOverlay({
        terrain: model,
        basemapFile: BASEMAP,
        bounds: job.payload.bounds,
        cellMetres: job.payload.cellMetres,
      });
      return suggestAvenues(grid, job.payload.avenues);
    }
    default:
      throw new HttpError(400, 'Unknown terrain job kind.');
  }
}

// Loaded only as a worker thread; the pool passes this file to `new Worker()`.
if (!port) throw new Error('This file runs only as a worker thread.');
const parentPort = port;

parentPort.on('message', async (job: JobRequest) => {
  const { id, kind } = job;
  const reply = (message: WorkerReply, transfer: ArrayBuffer[] = []) =>
    parentPort.postMessage(message, transfer);
  try {
    const result = await runJob(job);
    reply({ id, ok: true, result }, transferablesOf(result));
  } catch (error) {
    const status = error instanceof HttpError ? error.status : DEFAULT_ERROR_STATUS[kind] || 500;
    reply({
      id,
      ok: false,
      status,
      message: (error instanceof Error && error.message) || 'Terrain analysis failed.',
    });
  }
});
