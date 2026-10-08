import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApiRequest } from '../../../server/api.ts';
import type { ModuleSpec } from '../../../server/dispatch.ts';
import { readGeometry } from '../../../server/geometry.ts';
import {
  errorMessage,
  fieldsOf,
  HttpError,
  isJsonObject,
  numberParameter,
  sendBytes,
  serveFile,
  type Json,
  type JsonObject,
} from '../../../server/http.ts';
import type { ElevationModel } from './dem.ts';
import { resultOf, type JobKind, type JobPayloads, type JobResults } from './jobs.ts';
import { currentElevationModel, openElevationSource } from './elevationSource.ts';
import { BASEMAP, ID, IMAGERY_DATABASE, ORTHO_DATABASE } from './paths.ts';
import { SLOPE_LEGEND } from './rasterTiles.ts';
import { openImagery } from './imagery.ts';
import { namedPeaks, vectorLayerNames } from './landcover.ts';
import { metresBetween, type Bounds, type LonLat } from './lattice.ts';
import { LEGEND } from './mobility.ts';
import { createTerrainPool } from './pool.ts';
import { referenceFile } from '../../../server/reference.ts';

const BASEMAP_URL = `/api/${ID}/tiles/vector.pmtiles`;

/** Raster overlays rendered from the elevation model, by URL segment. */
const RASTER_TILE = /^(?<kind>hillshade|slope)\/(?<z>\d+)\/(?<x>\d+)\/(?<y>\d+)\.png$/;
const SATELLITE_TILE = /^satellite\/(?<z>\d+)\/(?<x>\d+)\/(?<y>\d+)\.jpg$/;
const ORTHO_TILE = /^ortho\/(?<z>\d+)\/(?<x>\d+)\/(?<y>\d+)\.jpg$/;
const CONTOUR_TILE = /^contours\/(?<z>\d+)\/(?<x>\d+)\/(?<y>\d+)\.json$/;
const VECTOR_TILES = /^tiles\/vector\.pmtiles$/;
/** contours.js draws nothing below 10; past 14 the client reuses zoom-14 tiles. */
const CONTOUR_MIN_ZOOM = 10;
const CONTOUR_MAX_ZOOM = 14;
/** Past this the 30 m DEM has no more detail; the client upscales. */
const RASTER_MAX_ZOOM = 14;
const RASTER_MIN_ZOOM = 5;
/** With the 5 m DMR4G detail layer built, both raster and contour tiles hold up two zooms further. */
const DETAIL_RASTER_MAX_ZOOM = 16;
const DETAIL_CONTOUR_MAX_ZOOM = 16;
const TILE_CACHE_LIMIT = 1024;
/** Observation posts in one combined viewshed; each adds a full visibility pass. */
const MAX_OBSERVERS = 10;
/** A key-terrain candidate takes the name of a mapped peak this close to it. */
const NAMED_PEAK_RADIUS = 400;
/** Tile URLs carry the data's build time, so a rebuilt dataset gets new URLs. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

function point(query: URLSearchParams, name: string): LonLat {
  const raw = query.get(name);
  const parts = (raw || '').split(',').map(Number);
  if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value))) {
    throw new HttpError(400, `The ${name} must be "lon,lat".`);
  }
  return { lon: parts[0], lat: parts[1] };
}

/** `"lon,lat;lon,lat;…"` → `[{ lon, lat }]`, between 1 and `max` points. */
function pointList(query: URLSearchParams, name: string, max: number): LonLat[] {
  const raw = (query.get(name) || '').split(';').filter(Boolean);
  if (!raw.length || raw.length > max) {
    throw new HttpError(
      400,
      `The ${name} must list 1 to ${max} "lon,lat" points separated by ";".`,
    );
  }
  return raw.map((text) => point(new URLSearchParams({ [name]: text }), name));
}

function boundsParameter(query: URLSearchParams): Bounds {
  const parts = (query.get('bounds') || '').split(',').map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw new HttpError(400, 'The bounds must be "west,south,east,north".');
  }
  const [west, south, east, north] = parts;
  if (west >= east || south >= north) throw new HttpError(400, 'The bounds are inverted.');
  return [west, south, east, north];
}

/** An analysis grid for JSON: its cell values as base64. */
function gridPayload<G extends { values: Uint8Array }>(
  grid: G,
): Omit<G, 'values'> & { values: string } {
  const { values, ...rest } = grid;
  return { ...rest, values: Buffer.from(values).toString('base64') };
}

/** A text entry of a model's `meta` table ('' when absent). */
function metaText(meta: JsonObject, key: string): string {
  const value = meta[key];
  return typeof value === 'string' ? value : '';
}

/** The detail model's `meta`, when the composite has one. */
function detailMeta(model: ElevationModel): JsonObject | null {
  return isJsonObject(model.meta.detail) ? model.meta.detail : null;
}

/** Version string for tile URLs and cache keys: both built_at times, so either rebuild busts them. */
function elevationVersion(model: ElevationModel) {
  const detail = detailMeta(model);
  return detail
    ? `${metaText(model.meta, 'built_at')}+${metaText(detail, 'built_at')}`
    : metaText(model.meta, 'built_at');
}

// The main thread keeps its own elevation-model handle for cheap point
// lookups (`elevation`, `meta`) and the tile-address/version bookkeeping
// below; every heavy analysis and tile render below runs in the worker
// pool instead, each worker holding its own separate handle (see
// elevationSource.js and pool.js).
const terrain = openElevationSource();
const imagery = referenceFile(IMAGERY_DATABASE, openImagery);
const ortho = referenceFile(ORTHO_DATABASE, openImagery);
/**
 * Created on the first job, not at import: `vite.config.js` imports this
 * module for every `vp` command (test, lint, build), and live worker threads
 * would keep each of those processes from exiting.
 */
let pool: ReturnType<typeof createTerrainPool> | null = null;

function elevationModel() {
  return currentElevationModel(terrain);
}

/** `request.user?.name` set by the api middleware, or the client IP when signed out — the pool's fairness key. */
function userKey(request: ApiRequest | null) {
  return request?.user?.name || request?.socket.remoteAddress || 'unknown';
}

/**
 * An `AbortSignal` that fires if `request` disconnects before the response
 * is sent, for cancelling the matching pool job; `dispose()` once the
 * request is done (successfully or not) so a normal `close` after the
 * response is sent doesn't matter.
 */
function abortSignal(request: IncomingMessage, response: ServerResponse) {
  const controller = new AbortController();
  const onClose = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once('close', onClose);
  return { signal: controller.signal, dispose: () => request.off('close', onClose) };
}

/**
 * Runs one job on the worker pool for this request: fair-queued per user,
 * cancelled if the client disconnects first. The worker already tags
 * domain errors with the right HTTP status (see worker.js), so this just
 * forwards whatever `pool.submit` settles with.
 */
async function poolJob<K extends JobKind>(
  kind: K,
  payload: JobPayloads[K],
  request: IncomingMessage | null,
  response: ServerResponse | null,
): Promise<JobResults[K]> {
  // An internal call (no request) has no client to disconnect.
  const cancel = request && response ? abortSignal(request, response) : null;
  try {
    pool ??= createTerrainPool();
    return resultOf(
      kind,
      await pool.submit(kind, payload, { user: userKey(request), signal: cancel?.signal }),
    );
  } finally {
    cancel?.dispose();
  }
}

/**
 * Renders one map tile on the pool's tile lane. Never cancelled: browsers
 * drop tile requests all the time while panning, the render takes
 * milliseconds and fills the shared tile cache, and `cachedTile` may have
 * handed this same render to other users' requests too.
 */
async function tileJob<K extends 'raster' | 'contour'>(
  kind: K,
  payload: JobPayloads[K],
): Promise<Uint8Array> {
  pool ??= createTerrainPool();
  return resultOf(kind, await pool.submit(kind, payload, { lane: 'tile' }));
}

/** The response a streaming route writes to; internal calls never reach these routes. */
function needResponse(response: ServerResponse | null): ServerResponse {
  if (!response) throw new Error('This route streams to a response.');
  return response;
}

/** The satellite archive, or null until tools/build_satellite.mjs has run. */
function imageryArchive() {
  return imagery.get();
}

/** The ČÚZK ortho archive, or null until build_satellite.mjs --source cuzk has run. */
function orthoArchive() {
  return ortho.get();
}

/** `{ z, x, y }` (numbers) from a tile route's named capture groups. */
function tileAddress(params: Record<string, string>) {
  const z = Number(params.z);
  const x = Number(params.x);
  const y = Number(params.y);
  if (x >= 2 ** z || y >= 2 ** z) throw new HttpError(404, 'No such tile.');
  return { z, x, y };
}

/** Encoded tiles generated on request, least recently used evicted first. */
const tileCache = new Map<string, Promise<Uint8Array>>();

/**
 * Caches `render()`'s (a promise, backed by a pool job) result under `key`,
 * least-recently-used evicted first. Concurrent requests for the same
 * missing key share one in-flight promise instead of rendering twice.
 */
async function cachedTile(key: string, render: () => Promise<Uint8Array>): Promise<Uint8Array> {
  let pending = tileCache.get(key);
  if (pending) {
    tileCache.delete(key);
  } else {
    pending = render();
    const oldest = tileCache.keys().next().value;
    if (tileCache.size >= TILE_CACHE_LIMIT && oldest !== undefined) tileCache.delete(oldest);
  }
  tileCache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    tileCache.delete(key);
    throw error;
  }
}

export default {
  id: ID,
  close() {
    pool?.close();
    pool = null;
    terrain.close();
    imagery.close();
    ortho.close();
    tileCache.clear();
  },
  routes: [
    {
      method: 'GET',
      path: VECTOR_TILES,
      verb: 'none',
      handler: async ({ request, response }) => {
        if (!request) throw new Error('The basemap streams to a request.');
        await serveFile(request, needResponse(response), BASEMAP, 'application/octet-stream');
        return undefined;
      },
    },
    {
      method: 'GET',
      path: RASTER_TILE,
      verb: 'none',
      handler: async ({ params, response }) => {
        // RASTER_TILE only matches these two.
        const kind = params.kind === 'slope' ? 'slope' : 'hillshade';
        const { z, x, y } = tileAddress(params);
        const model = elevationModel();
        const maxZoom = detailMeta(model) ? DETAIL_RASTER_MAX_ZOOM : RASTER_MAX_ZOOM;
        if (z < RASTER_MIN_ZOOM || z > maxZoom) {
          throw new HttpError(404, `No ${kind} tiles at this zoom.`);
        }
        const png = await cachedTile(`${elevationVersion(model)}/${kind}/${z}/${x}/${y}`, () =>
          tileJob('raster', { renderer: kind, z, x, y }),
        );
        sendBytes(needResponse(response), png, 'image/png', IMMUTABLE);
        return undefined;
      },
    },
    {
      method: 'GET',
      path: CONTOUR_TILE,
      verb: 'none',
      handler: async ({ params, response }) => {
        const { z, x, y } = tileAddress(params);
        const model = elevationModel();
        const maxZoom = detailMeta(model) ? DETAIL_CONTOUR_MAX_ZOOM : CONTOUR_MAX_ZOOM;
        if (z < CONTOUR_MIN_ZOOM || z > maxZoom) {
          throw new HttpError(404, 'No contours at this zoom.');
        }
        const json = await cachedTile(`${elevationVersion(model)}/contours/${z}/${x}/${y}`, () =>
          tileJob('contour', { z, x, y }),
        );
        sendBytes(needResponse(response), json, 'application/geo+json', IMMUTABLE);
        return undefined;
      },
    },
    {
      method: 'GET',
      path: SATELLITE_TILE,
      verb: 'none',
      handler: async ({ params, response }) => {
        const archive = imageryArchive();
        if (!archive) {
          throw new HttpError(
            404,
            'No satellite imagery. Build it with tools/build_satellite.mjs.',
          );
        }
        const { z, x, y } = tileAddress(params);
        const tile = archive.tile(z, x, y);
        if (!tile) throw new HttpError(404, 'No imagery tile here.');
        sendBytes(needResponse(response), tile, 'image/jpeg', IMMUTABLE);
        return undefined;
      },
    },
    {
      method: 'GET',
      path: ORTHO_TILE,
      verb: 'none',
      handler: async ({ params, response }) => {
        const archive = orthoArchive();
        if (!archive) {
          throw new HttpError(
            404,
            'No ortho imagery. Build it with tools/build_satellite.mjs --source cuzk.',
          );
        }
        const { z, x, y } = tileAddress(params);
        const tile = archive.tile(z, x, y);
        if (!tile) throw new HttpError(404, 'No imagery tile here.');
        sendBytes(needResponse(response), tile, 'image/jpeg', IMMUTABLE);
        return undefined;
      },
    },
    {
      method: 'GET',
      path: 'meta',
      verb: 'none',
      handler: async () => {
        const model = elevationModel();
        const archive = imageryArchive();
        const orthoImagery = orthoArchive();
        const version = (value: string | null) => `?v=${encodeURIComponent(value ?? '')}`;
        const elevationTileVersion = version(elevationVersion(model));
        const detail = detailMeta(model);
        const rasterMaxZoom = detail ? DETAIL_RASTER_MAX_ZOOM : RASTER_MAX_ZOOM;
        const contourMaxZoom = detail ? DETAIL_CONTOUR_MAX_ZOOM : CONTOUR_MAX_ZOOM;
        const detailBounds: Json = detail
          ? JSON.parse(metaText(detail, 'bounds') || '[0,0,0,0]')
          : null;
        return {
          elevation: {
            dataset: model.meta.dataset,
            bounds: model.bounds,
            verticalDatum: model.meta.vertical_datum,
            attribution: model.meta.attribution,
            builtAt: model.meta.built_at,
            detail: detail
              ? {
                  dataset: detail.dataset,
                  bounds: detailBounds,
                  cellsPerDegree: Number(detail.cells_per_degree),
                  builtAt: detail.built_at,
                }
              : null,
          },
          basemap: {
            url: BASEMAP_URL,
            attribution: '© OpenMapTiles © OpenStreetMap contributors',
            layers: await vectorLayerNames(BASEMAP),
          },
          hillshade: {
            url: `/api/${ID}/hillshade/{z}/{x}/{y}.png${elevationTileVersion}`,
            minZoom: RASTER_MIN_ZOOM,
            maxZoom: rasterMaxZoom,
          },
          slope: {
            url: `/api/${ID}/slope/{z}/{x}/{y}.png${elevationTileVersion}`,
            minZoom: RASTER_MIN_ZOOM,
            maxZoom: rasterMaxZoom,
            legend: SLOPE_LEGEND,
          },
          contours: {
            url: `/api/${ID}/contours/{z}/{x}/{y}.json${elevationTileVersion}`,
            minZoom: CONTOUR_MIN_ZOOM,
            maxZoom: contourMaxZoom,
          },
          imagery: archive && {
            url: `/api/${ID}/satellite/{z}/{x}/{y}.jpg${version(archive.meta.builtAt)}`,
            bounds: archive.meta.bounds,
            minZoom: archive.meta.minZoom,
            maxZoom: archive.meta.maxZoom,
            attribution: archive.meta.attribution,
          },
          ortho: orthoImagery && {
            url: `/api/${ID}/ortho/{z}/{x}/{y}.jpg${version(orthoImagery.meta.builtAt)}`,
            bounds: orthoImagery.meta.bounds,
            minZoom: orthoImagery.meta.minZoom,
            maxZoom: orthoImagery.meta.maxZoom,
            attribution: orthoImagery.meta.attribution,
          },
          legend: LEGEND,
        };
      },
    },
    {
      method: 'GET',
      path: 'elevation',
      verb: 'none',
      handler: ({ query }) => {
        const model = elevationModel();
        const at = point(query, 'at');
        return {
          ...at,
          elevation: model.elevation(at.lon, at.lat),
          slope: model.slopeDegrees(at.lon, at.lat),
        };
      },
    },
    {
      // POST, because an AOI polygon can outgrow a query string.
      method: 'POST',
      path: 'extremes',
      verb: 'none',
      role: 'observer',
      changes: false,
      handler: ({ body, request, response }) =>
        poolJob('extremes', { area: readGeometry(fieldsOf(body).area) }, request, response),
    },
    {
      method: 'GET',
      path: 'line-of-sight',
      verb: 'none',
      handler: ({ query }) => {
        const model = elevationModel();
        const options = {
          observerHeight: numberParameter(query, 'observer', 1.8, 0, 500),
          targetHeight: numberParameter(query, 'target', 1.8, 0, 500),
        };
        try {
          return model.lineOfSight(point(query, 'from'), point(query, 'to'), options);
        } catch (error) {
          throw new HttpError(422, errorMessage(error));
        }
      },
    },
    {
      method: 'GET',
      path: 'viewshed',
      verb: 'none',
      handler: async ({ query, request, response }) => {
        const observers = pointList(query, 'at', MAX_OBSERVERS);
        const grid = await poolJob(
          'viewshed',
          {
            observers,
            radiusMetres: numberParameter(query, 'radius', 5000, 200, 25000),
            observerHeight: numberParameter(query, 'observer', 1.8, 0, 500),
            targetHeight: numberParameter(query, 'target', 1.8, 0, 500),
            cellMetres: numberParameter(query, 'cell', 50, 20, 250),
          },
          request,
          response,
        );
        return gridPayload(grid);
      },
    },
    {
      // The corridor search runs on the same MCOO the analyst sees in step 2.
      method: 'GET',
      path: 'avenues',
      verb: 'none',
      handler: async ({ query, request, response }) => {
        return poolJob(
          'avenues',
          {
            bounds: boundsParameter(query),
            cellMetres: numberParameter(query, 'cell', 100, 20, 500),
            avenues: {
              from: point(query, 'from'),
              to: point(query, 'to'),
              corridorWidth: numberParameter(query, 'width', 500, 50, 10000),
              count: numberParameter(query, 'count', 3, 1, 5),
            },
          },
          request,
          response,
        );
      },
    },
    {
      method: 'GET',
      path: 'key-terrain',
      verb: 'none',
      handler: async ({ query, request, response }) => {
        const bounds = boundsParameter(query);
        // Ranked by what each summit overlooks: a coarse (100 m) single-post
        // viewshed is enough to compare candidates and keeps 16 runs quick.
        const radiusMetres = numberParameter(query, 'radius', 3000, 500, 10000);
        const candidates = await poolJob(
          'key-terrain',
          {
            bounds,
            radiusMetres,
            minProminence: numberParameter(query, 'prominence', 30, 5, 500),
            limit: numberParameter(query, 'limit', 8, 1, 20),
          },
          request,
          response,
        );
        const peaks = await namedPeaks(BASEMAP, bounds);
        return {
          radiusMetres,
          candidates: candidates.map((candidate) => {
            const named = peaks
              .map((peak) => ({ peak, distance: metresBetween(peak, candidate) }))
              .filter(({ distance }) => distance <= NAMED_PEAK_RADIUS)
              .sort((a, b) => a.distance - b.distance)[0]?.peak;
            return { ...candidate, name: named?.name ?? null };
          }),
        };
      },
    },
    {
      method: 'GET',
      path: 'mobility',
      verb: 'none',
      handler: async ({ query, request, response }) => {
        const grid = await poolJob(
          'mobility',
          {
            bounds: boundsParameter(query),
            cellMetres: numberParameter(query, 'cell', 50, 20, 500),
          },
          request,
          response,
        );
        return gridPayload(grid);
      },
    },
  ],
} satisfies ModuleSpec;
