import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HttpError,
  numberParameter,
  sendBytes,
  sendJson,
  serveFile,
} from '../../../server/http.js';
import { encodePng } from '../../../server/png.js';
import { openTerrain } from './dem.js';
import { renderHillshade } from './hillshade.js';
import { openImagery } from './imagery.js';
import { LEGEND, mobilityOverlay } from './mobility.js';

const ID = 'terrain';
const DATA_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const ELEVATION_DATABASE = path.join(DATA_ROOT, 'terrain.db');
const BASEMAP = path.join(DATA_ROOT, 'vector.pmtiles');
const BASEMAP_URL = `/api/${ID}/tiles/vector.pmtiles`;
const IMAGERY_DATABASE = path.join(DATA_ROOT, 'satellite.mbtiles');

const HILLSHADE_TILE = /^hillshade\/(\d+)\/(\d+)\/(\d+)\.png$/;
const SATELLITE_TILE = /^satellite\/(\d+)\/(\d+)\/(\d+)\.jpg$/;
/** Past this the 30 m DEM has no more detail; the client upscales. */
const HILLSHADE_MAX_ZOOM = 14;
const HILLSHADE_MIN_ZOOM = 5;
const HILLSHADE_CACHE_LIMIT = 512;
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

function tileAddress(match) {
  const [z, x, y] = match.slice(1).map(Number);
  if (x >= 2 ** z || y >= 2 ** z) throw new HttpError(404, 'No such tile.');
  return { z, x, y };
}

const hillshadeCache = new Map();

function hillshadePng(model, { z, x, y }) {
  const key = `${z}/${x}/${y}`;
  let png = hillshadeCache.get(key);
  if (png) {
    hillshadeCache.delete(key);
  } else {
    png = encodePng(256, 256, renderHillshade(model.elevation, z, x, y));
    if (hillshadeCache.size >= HILLSHADE_CACHE_LIMIT) {
      hillshadeCache.delete(hillshadeCache.keys().next().value);
    }
  }
  hillshadeCache.set(key, png);
  return png;
}

export default {
  id: ID,
  async handle({ route, url, request, response }) {
    const query = url.searchParams;
    if (route === 'tiles/vector.pmtiles') {
      await serveFile(request, response, BASEMAP, 'application/octet-stream');
      return;
    }
    let match = HILLSHADE_TILE.exec(route);
    if (match) {
      const address = tileAddress(match);
      if (address.z < HILLSHADE_MIN_ZOOM || address.z > HILLSHADE_MAX_ZOOM) {
        throw new HttpError(404, 'No hillshade at this zoom.');
      }
      sendBytes(response, hillshadePng(elevationModel(), address), 'image/png', IMMUTABLE);
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
        },
        hillshade: {
          url: `/api/${ID}/hillshade/{z}/{x}/{y}.png${version(model.meta.built_at)}`,
          minZoom: HILLSHADE_MIN_ZOOM,
          maxZoom: HILLSHADE_MAX_ZOOM,
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
      const at = point(query, 'at');
      try {
        const grid = model.viewshed({
          ...at,
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
    hillshadeCache.clear();
  },
};
