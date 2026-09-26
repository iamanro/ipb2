import {
  HttpError,
  numberParameter,
  readJson,
  sendBytes,
  sendJson,
  serveFile,
} from '../../../server/http.js';
import { currentElevationModel, openElevationSource } from './elevationSource.js';
import { BASEMAP, ID, IMAGERY_DATABASE, ORTHO_DATABASE } from './paths.js';
import { SLOPE_LEGEND } from './rasterTiles.js';
import { openImagery } from './imagery.js';
import { namedPeaks, vectorLayerNames } from './landcover.js';
import { metresBetween } from './lattice.js';
import { LEGEND } from './mobility.js';
import { createTerrainPool } from './pool.js';
import { referenceFile } from '../../../server/reference.js';

const BASEMAP_URL = `/api/${ID}/tiles/vector.pmtiles`;

/** Raster overlays rendered from the elevation model, by URL segment. */
const RASTER_TILE = /^(hillshade|slope)\/(\d+)\/(\d+)\/(\d+)\.png$/;
const SATELLITE_TILE = /^satellite\/(\d+)\/(\d+)\/(\d+)\.jpg$/;
const ORTHO_TILE = /^ortho\/(\d+)\/(\d+)\/(\d+)\.jpg$/;
const CONTOUR_TILE = /^contours\/(\d+)\/(\d+)\/(\d+)\.json$/;
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

function point(query, name) {
  const raw = query.get(name);
  const parts = (raw || '').split(',').map(Number);
  if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value))) {
    throw new HttpError(400, `The ${name} must be "lon,lat".`);
  }
  return { lon: parts[0], lat: parts[1] };
}

/** `"lon,lat;lon,lat;…"` → `[{ lon, lat }]`, between 1 and `max` points. */
function pointList(query, name, max) {
  const raw = (query.get(name) || '').split(';').filter(Boolean);
  if (!raw.length || raw.length > max) {
    throw new HttpError(
      400,
      `The ${name} must list 1 to ${max} "lon,lat" points separated by ";".`,
    );
  }
  return raw.map((text) => point(new URLSearchParams({ [name]: text }), name));
}

function boundsParameter(query) {
  const parts = (query.get('bounds') || '').split(',').map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw new HttpError(400, 'The bounds must be "west,south,east,north".');
  }
  const [west, south, east, north] = parts;
  if (west >= east || south >= north) throw new HttpError(400, 'The bounds are inverted.');
  return parts;
}

function gridPayload(grid) {
  const { values, ...rest } = grid;
  return { ...rest, values: Buffer.from(values).toString('base64') };
}

/** Version string for tile URLs and cache keys: both built_at times, so either rebuild busts them. */
function elevationVersion(model) {
  return model.meta.detail ? `${model.meta.built_at}+${model.meta.detail.built_at}` : model.meta.built_at;
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
let pool = null;

function elevationModel() {
  return currentElevationModel(terrain);
}

/** `request.user?.name` set by the api middleware, or the client IP when signed out — the pool's fairness key. */
function userKey(request) {
  return request.user?.name || request.socket?.remoteAddress || 'unknown';
}

/**
 * An `AbortSignal` that fires if `request` disconnects before the response
 * is sent, for cancelling the matching pool job; `dispose()` once the
 * request is done (successfully or not) so a normal `close` after the
 * response is sent doesn't matter.
 */
function abortSignal(request, response) {
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
async function poolJob(kind, payload, request, response) {
  const { signal, dispose } = abortSignal(request, response);
  try {
    pool ??= createTerrainPool();
    return await pool.submit(kind, payload, { user: userKey(request), signal });
  } finally {
    dispose();
  }
}

/**
 * Renders one map tile on the pool's tile lane. Never cancelled: browsers
 * drop tile requests all the time while panning, the render takes
 * milliseconds and fills the shared tile cache, and `cachedTile` may have
 * handed this same render to other users' requests too.
 */
function tileJob(kind, payload) {
  pool ??= createTerrainPool();
  return pool.submit(kind, payload, { lane: 'tile' });
}

/** The satellite archive, or null until tools/build_satellite.mjs has run. */
function imageryArchive() {
  return imagery.get();
}

/** The ČÚZK ortho archive, or null until build_satellite.mjs --source cuzk has run. */
function orthoArchive() {
  return ortho.get();
}

/** `{ z, x, y }` from the last three captures of a tile-route match. */
function tileAddress(match) {
  const [z, x, y] = match.slice(-3).map(Number);
  if (x >= 2 ** z || y >= 2 ** z) throw new HttpError(404, 'No such tile.');
  return { z, x, y };
}

/** Encoded tiles generated on request, least recently used evicted first. */
const tileCache = new Map();

/**
 * Caches `render()`'s (a promise, backed by a pool job) result under `key`,
 * least-recently-used evicted first. Concurrent requests for the same
 * missing key share one in-flight promise instead of rendering twice.
 */
async function cachedTile(key, render) {
  let pending = tileCache.get(key);
  if (pending) {
    tileCache.delete(key);
  } else {
    pending = render();
    if (tileCache.size >= TILE_CACHE_LIMIT) tileCache.delete(tileCache.keys().next().value);
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
  async handle({ route, url, request, response }) {
    const query = url.searchParams;
    if (route === 'tiles/vector.pmtiles') {
      await serveFile(request, response, BASEMAP, 'application/octet-stream');
      return;
    }
    let match = RASTER_TILE.exec(route);
    if (match) {
      const kind = match[1];
      const { z, x, y } = tileAddress(match);
      const model = elevationModel();
      const maxZoom = model.meta.detail ? DETAIL_RASTER_MAX_ZOOM : RASTER_MAX_ZOOM;
      if (z < RASTER_MIN_ZOOM || z > maxZoom) {
        throw new HttpError(404, `No ${kind} tiles at this zoom.`);
      }
      const png = await cachedTile(`${elevationVersion(model)}/${kind}/${z}/${x}/${y}`, () =>
        tileJob('raster', { renderer: kind, z, x, y }),
      );
      sendBytes(response, png, 'image/png', IMMUTABLE);
      return;
    }
    match = CONTOUR_TILE.exec(route);
    if (match) {
      const { z, x, y } = tileAddress(match);
      const model = elevationModel();
      const maxZoom = model.meta.detail ? DETAIL_CONTOUR_MAX_ZOOM : CONTOUR_MAX_ZOOM;
      if (z < CONTOUR_MIN_ZOOM || z > maxZoom) {
        throw new HttpError(404, 'No contours at this zoom.');
      }
      const json = await cachedTile(`${elevationVersion(model)}/contours/${z}/${x}/${y}`, () =>
        tileJob('contour', { z, x, y }),
      );
      sendBytes(response, json, 'application/geo+json', IMMUTABLE);
      return;
    }
    match = SATELLITE_TILE.exec(route);
    if (match) {
      const archive = imageryArchive();
      if (!archive) {
        throw new HttpError(404, 'No satellite imagery. Build it with tools/build_satellite.mjs.');
      }
      const { z, x, y } = tileAddress(match);
      const tile = archive.tile(z, x, y);
      if (!tile) throw new HttpError(404, 'No imagery tile here.');
      sendBytes(response, tile, 'image/jpeg', IMMUTABLE);
      return;
    }
    match = ORTHO_TILE.exec(route);
    if (match) {
      const archive = orthoArchive();
      if (!archive) {
        throw new HttpError(
          404,
          'No ortho imagery. Build it with tools/build_satellite.mjs --source cuzk.',
        );
      }
      const { z, x, y } = tileAddress(match);
      const tile = archive.tile(z, x, y);
      if (!tile) throw new HttpError(404, 'No imagery tile here.');
      sendBytes(response, tile, 'image/jpeg', IMMUTABLE);
      return;
    }
    if (route === 'meta') {
      const model = elevationModel();
      const archive = imageryArchive();
      const orthoImagery = orthoArchive();
      const version = (value) => `?v=${encodeURIComponent(value ?? '')}`;
      const elevationTileVersion = version(elevationVersion(model));
      const rasterMaxZoom = model.meta.detail ? DETAIL_RASTER_MAX_ZOOM : RASTER_MAX_ZOOM;
      const contourMaxZoom = model.meta.detail ? DETAIL_CONTOUR_MAX_ZOOM : CONTOUR_MAX_ZOOM;
      sendJson(response, {
        elevation: {
          dataset: model.meta.dataset,
          bounds: model.bounds,
          verticalDatum: model.meta.vertical_datum,
          attribution: model.meta.attribution,
          builtAt: model.meta.built_at,
          detail: model.meta.detail
            ? {
                dataset: model.meta.detail.dataset,
                bounds: JSON.parse(model.meta.detail.bounds || '[0,0,0,0]'),
                cellsPerDegree: Number(model.meta.detail.cells_per_degree),
                builtAt: model.meta.detail.built_at,
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
      });
      return;
    }
    if (route === 'elevation') {
      const model = elevationModel();
      const at = point(query, 'at');
      sendJson(response, {
        ...at,
        elevation: model.elevation(at.lon, at.lat),
        slope: model.slopeDegrees(at.lon, at.lat),
      });
      return;
    }
    if (route === 'extremes') {
      // POST, because an AOI polygon can outgrow a query string.
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      const body = await readJson(request);
      sendJson(response, await poolJob('extremes', { area: body?.area }, request, response));
      return;
    }
    if (route === 'line-of-sight') {
      const model = elevationModel();
      const options = {
        observerHeight: numberParameter(query, 'observer', 1.8, 0, 500),
        targetHeight: numberParameter(query, 'target', 1.8, 0, 500),
      };
      try {
        sendJson(response, model.lineOfSight(point(query, 'from'), point(query, 'to'), options));
      } catch (error) {
        throw new HttpError(422, error.message);
      }
      return;
    }
    if (route === 'viewshed') {
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
      sendJson(response, gridPayload(grid));
      return;
    }
    if (route === 'avenues') {
      // The corridor search runs on the same MCOO the analyst sees in step 2.
      const result = await poolJob(
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
      sendJson(response, result);
      return;
    }
    if (route === 'key-terrain') {
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
      sendJson(response, {
        radiusMetres,
        candidates: candidates.map((candidate) => {
          const named = peaks
            .map((peak) => ({ peak, distance: metresBetween(peak, candidate) }))
            .filter(({ distance }) => distance <= NAMED_PEAK_RADIUS)
            .sort((a, b) => a.distance - b.distance)[0]?.peak;
          return { ...candidate, name: named?.name ?? null };
        }),
      });
      return;
    }
    if (route === 'mobility') {
      const grid = await poolJob(
        'mobility',
        {
          bounds: boundsParameter(query),
          cellMetres: numberParameter(query, 'cell', 50, 20, 500),
        },
        request,
        response,
      );
      sendJson(response, gridPayload(grid));
      return;
    }
    throw new HttpError(404, 'Unknown API route.');
  },
  close() {
    pool?.close();
    pool = null;
    terrain.close();
    imagery.close();
    ortho.close();
    tileCache.clear();
  },
};
