import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HttpError,
  numberParameter,
  readJson,
  sendBytes,
  sendJson,
  serveFile,
} from '../../../server/http.js';
import { encodePng } from '../../../server/png.js';
import { contourTile } from './contours.js';
import { suggestAvenues } from './corridors.js';
import { metresBetween, openTerrain } from './dem.js';
import { elevationExtremes } from './extremes.js';
import { SLOPE_LEGEND, renderHillshade, renderSlopeClasses } from './rasterTiles.js';
import { openImagery } from './imagery.js';
import { keyTerrainCandidates } from './keyTerrain.js';
import { namedPeaks, vectorLayerNames } from './landcover.js';
import { LEGEND, mobilityOverlay } from './mobility.js';

const ID = 'terrain';
const DATA_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const ELEVATION_DATABASE = path.join(DATA_ROOT, 'terrain.db');
const BASEMAP = path.join(DATA_ROOT, 'vector.pmtiles');
const BASEMAP_URL = `/api/${ID}/tiles/vector.pmtiles`;
const IMAGERY_DATABASE = path.join(DATA_ROOT, 'satellite.mbtiles');

/** Raster overlays rendered from the elevation model, by URL segment. */
const RASTER_RENDERERS = { hillshade: renderHillshade, slope: renderSlopeClasses };
const RASTER_TILE = /^(hillshade|slope)\/(\d+)\/(\d+)\/(\d+)\.png$/;
const SATELLITE_TILE = /^satellite\/(\d+)\/(\d+)\/(\d+)\.jpg$/;
const CONTOUR_TILE = /^contours\/(\d+)\/(\d+)\/(\d+)\.json$/;
/** contours.js draws nothing below 10; past 14 the client reuses zoom-14 tiles. */
const CONTOUR_MIN_ZOOM = 10;
const CONTOUR_MAX_ZOOM = 14;
/** Past this the 30 m DEM has no more detail; the client upscales. */
const RASTER_MAX_ZOOM = 14;
const RASTER_MIN_ZOOM = 5;
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

let terrain;

function elevationModel() {
  try {
    terrain ??= openTerrain(ELEVATION_DATABASE);
  } catch {
    throw new HttpError(
      503,
      'No elevation data. Build it with modules/terrain/tools/build_terrain.mjs.',
    );
  }
  return terrain;
}

let imagery;

/** The satellite archive, or null until tools/build_satellite.mjs has run. */
function imageryArchive() {
  if (!imagery && existsSync(IMAGERY_DATABASE)) imagery = openImagery(IMAGERY_DATABASE);
  return imagery ?? null;
}

/** `{ z, x, y }` from the last three captures of a tile-route match. */
function tileAddress(match) {
  const [z, x, y] = match.slice(-3).map(Number);
  if (x >= 2 ** z || y >= 2 ** z) throw new HttpError(404, 'No such tile.');
  return { z, x, y };
}

/** Encoded tiles generated on request, least recently used evicted first. */
const tileCache = new Map();

function cachedTile(key, render) {
  let body = tileCache.get(key);
  if (body) {
    tileCache.delete(key);
  } else {
    body = render();
    if (tileCache.size >= TILE_CACHE_LIMIT) tileCache.delete(tileCache.keys().next().value);
  }
  tileCache.set(key, body);
  return body;
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
      if (z < RASTER_MIN_ZOOM || z > RASTER_MAX_ZOOM) {
        throw new HttpError(404, `No ${kind} tiles at this zoom.`);
      }
      const model = elevationModel();
      const png = cachedTile(`${kind}/${z}/${x}/${y}`, () =>
        encodePng(256, 256, RASTER_RENDERERS[kind](model.elevation, z, x, y)),
      );
      sendBytes(response, png, 'image/png', IMMUTABLE);
      return;
    }
    match = CONTOUR_TILE.exec(route);
    if (match) {
      const { z, x, y } = tileAddress(match);
      if (z < CONTOUR_MIN_ZOOM || z > CONTOUR_MAX_ZOOM) {
        throw new HttpError(404, 'No contours at this zoom.');
      }
      const model = elevationModel();
      const json = cachedTile(`contours/${z}/${x}/${y}`, () =>
        Buffer.from(JSON.stringify(contourTile(model.elevation, z, x, y))),
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
    if (route === 'meta') {
      const model = elevationModel();
      const archive = imageryArchive();
      const version = (value) => `?v=${encodeURIComponent(value ?? '')}`;
      sendJson(response, {
        elevation: {
          dataset: model.meta.dataset,
          bounds: model.bounds,
          verticalDatum: model.meta.vertical_datum,
          attribution: model.meta.attribution,
          builtAt: model.meta.built_at,
        },
        basemap: {
          url: BASEMAP_URL,
          attribution: '© OpenMapTiles © OpenStreetMap contributors',
          layers: await vectorLayerNames(BASEMAP),
        },
        hillshade: {
          url: `/api/${ID}/hillshade/{z}/{x}/{y}.png${version(model.meta.built_at)}`,
          minZoom: RASTER_MIN_ZOOM,
          maxZoom: RASTER_MAX_ZOOM,
        },
        slope: {
          url: `/api/${ID}/slope/{z}/{x}/{y}.png${version(model.meta.built_at)}`,
          minZoom: RASTER_MIN_ZOOM,
          maxZoom: RASTER_MAX_ZOOM,
          legend: SLOPE_LEGEND,
        },
        contours: {
          url: `/api/${ID}/contours/{z}/{x}/{y}.json${version(model.meta.built_at)}`,
          minZoom: CONTOUR_MIN_ZOOM,
          maxZoom: CONTOUR_MAX_ZOOM,
        },
        imagery: archive && {
          url: `/api/${ID}/satellite/{z}/{x}/{y}.jpg${version(archive.meta.builtAt)}`,
          bounds: archive.meta.bounds,
          minZoom: archive.meta.minZoom,
          maxZoom: archive.meta.maxZoom,
          attribution: archive.meta.attribution,
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
      const model = elevationModel();
      const body = await readJson(request);
      try {
        sendJson(response, elevationExtremes(model.elevation, body?.area));
      } catch (error) {
        throw new HttpError(422, error.message);
      }
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
      const model = elevationModel();
      const observers = pointList(query, 'at', MAX_OBSERVERS);
      try {
        const grid = model.viewshed({
          observers,
          radiusMetres: numberParameter(query, 'radius', 5000, 200, 25000),
          observerHeight: numberParameter(query, 'observer', 1.8, 0, 500),
          targetHeight: numberParameter(query, 'target', 1.8, 0, 500),
          cellMetres: numberParameter(query, 'cell', 50, 20, 250),
        });
        sendJson(response, gridPayload(grid));
      } catch (error) {
        throw new HttpError(422, error.message);
      }
      return;
    }
    if (route === 'avenues') {
      const model = elevationModel();
      // The corridor search runs on the same MCOO the analyst sees in step 2.
      const grid = await mobilityOverlay({
        terrain: model,
        basemapFile: BASEMAP,
        bounds: boundsParameter(query),
        cellMetres: numberParameter(query, 'cell', 100, 20, 500),
      });
      try {
        sendJson(
          response,
          suggestAvenues(grid, {
            from: point(query, 'from'),
            to: point(query, 'to'),
            corridorWidth: numberParameter(query, 'width', 500, 50, 10000),
            count: numberParameter(query, 'count', 3, 1, 5),
          }),
        );
      } catch (error) {
        throw new HttpError(422, error.message);
      }
      return;
    }
    if (route === 'key-terrain') {
      const model = elevationModel();
      const bounds = boundsParameter(query);
      // Ranked by what each summit overlooks: a coarse (100 m) single-post
      // viewshed is enough to compare candidates and keeps 16 runs quick.
      const radiusMetres = numberParameter(query, 'radius', 3000, 500, 10000);
      const visibleArea = (lon, lat) => {
        const grid = model.viewshed({ observers: [{ lon, lat }], radiusMetres, cellMetres: 100 });
        return (grid.visibleCells * grid.cellMetres ** 2) / 1e6;
      };
      const candidates = keyTerrainCandidates({
        elevation: model.elevation,
        bounds,
        minProminence: numberParameter(query, 'prominence', 30, 5, 500),
        limit: numberParameter(query, 'limit', 8, 1, 20),
        visibleArea,
      });
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
      const model = elevationModel();
      const grid = await mobilityOverlay({
        terrain: model,
        basemapFile: BASEMAP,
        bounds: boundsParameter(query),
        cellMetres: numberParameter(query, 'cell', 50, 20, 500),
      });
      sendJson(response, gridPayload(grid));
      return;
    }
    throw new HttpError(404, 'Unknown API route.');
  },
  close() {
    terrain?.close();
    terrain = undefined;
    imagery?.close();
    imagery = undefined;
    tileCache.clear();
  },
};
