import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError, numberParameter, sendJson, serveFile } from '../../../server/http.js';
import { openTerrain } from './dem.js';
import { LEGEND, mobilityOverlay } from './mobility.js';

const ID = 'terrain';
const DATA_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const ELEVATION_DATABASE = path.join(DATA_ROOT, 'terrain.db');
const BASEMAP = path.join(DATA_ROOT, 'vector.pmtiles');
const BASEMAP_URL = `/api/${ID}/tiles/vector.pmtiles`;

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

export default {
  id: ID,
  async handle({ route, url, request, response }) {
    const query = url.searchParams;
    if (route === 'tiles/vector.pmtiles') {
      await serveFile(request, response, BASEMAP, 'application/octet-stream');
      return;
    }
    if (route === 'meta') {
      const model = elevationModel();
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
  },
};
