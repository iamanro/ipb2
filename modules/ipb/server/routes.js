import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError, readJson, sendJson } from '../../../server/http.js';
import { stateDirectory } from '../../../server/state.js';
import { nearestStation } from './station.js';
import { openStore, readLiveCells } from './store.js';

const ID = 'ipb';
const STATE_ROOT = stateDirectory(
  ID,
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state'),
);
const DATABASE = path.join(STATE_ROOT, 'ipb.db');

const STUDIES = /^studies$/;
const STUDY = /^studies\/(\d+)$/;
const STUDY_RELEASE = /^studies\/(\d+)\/release$/;
const STUDY_OWNER = /^studies\/(\d+)\/owner$/;
const KINDS =
  'features|threats|coas|events|analyses|layers|points|phases|decision-points|civil-considerations';
const STUDY_CHILDREN = new RegExp(`^studies\\/(\\d+)\\/(${KINDS})$`);
const STUDY_EXPORT = /^studies\/(\d+)\/export\.(geojson|kml)$/;
const STUDY_FEATURES_BULK = /^studies\/(\d+)\/features\/bulk$/;
const CHILD = new RegExp(`^(${KINDS})\\/(\\d+)$`);
const CHILD_REORDER = new RegExp(`^(${KINDS})\\/(\\d+)\\/reorder$`);

/** C4: attach the cells a mutation's live event should reach, read off the
 * store's Symbol-keyed result (never serialized into the response body). */
function withLiveCells(request, result) {
  const cells = readLiveCells(result);
  if (cells) request.liveCells = cells;
  return result;
}

const EXPORT_CONTENT_TYPE = {
  geojson: 'application/geo+json',
  kml: 'application/vnd.google-earth.kml+xml',
};

/** A text export with a download filename, distinct from `sendJson`'s API responses. */
function sendExport(response, body, contentType, filename) {
  const bytes = Buffer.from(body, 'utf8');
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': bytes.byteLength,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  response.end(bytes);
}

function parseId(text) {
  return Number.parseInt(text, 10);
}

let store;

/** Latest METAR of the airfield nearest `?at=lon,lat`; goes online, only when asked. */
async function handleStation(url, response) {
  const [lon, lat] = (url.searchParams.get('at') || '').split(',').map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) {
    throw new HttpError(400, 'The at must be "lon,lat".');
  }
  let station;
  try {
    station = await nearestStation({ lon, lat });
  } catch (error) {
    throw new HttpError(502, `The station service did not answer (${error.message}).`);
  }
  if (!station) throw new HttpError(404, 'No reporting station within about 500 km.');
  sendJson(response, station);
}

async function handle({ route, url, request, response }) {
  if (route === 'weather/station') {
    if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    return handleStation(url, response);
  }
  store ??= openStore(DATABASE);
  const { method, user } = request;

  if (STUDIES.test(route)) {
    if (method === 'GET') return sendJson(response, store.listStudies(user));
    if (method === 'POST') {
      return sendJson(response, withLiveCells(request, store.createStudy(await readJson(request), user)));
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  let match = STUDY.exec(route);
  if (match) {
    const id = parseId(match[1]);
    if (method === 'GET') return sendJson(response, store.readStudy(id, user));
    if (method === 'PATCH') {
      return sendJson(response, withLiveCells(request, store.updateStudy(id, await readJson(request), user)));
    }
    if (method === 'DELETE') {
      return sendJson(response, withLiveCells(request, store.deleteStudy(id, user)));
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  match = STUDY_RELEASE.exec(route);
  if (match) {
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const id = parseId(match[1]);
    const body = await readJson(request);
    return sendJson(response, withLiveCells(request, store.releaseStudy(id, body?.cells, user)));
  }

  match = STUDY_OWNER.exec(route);
  if (match) {
    if (method !== 'PATCH') throw new HttpError(405, 'Method not allowed.');
    const id = parseId(match[1]);
    const body = await readJson(request);
    return sendJson(
      response,
      withLiveCells(request, store.reassignStudy(id, body?.owner_cell, user)),
    );
  }

  match = STUDY_CHILDREN.exec(route);
  if (match) {
    const id = parseId(match[1]);
    const kind = match[2];
    if (method === 'POST') {
      return sendJson(
        response,
        withLiveCells(request, store.createChild(kind, id, await readJson(request), user)),
      );
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  match = STUDY_EXPORT.exec(route);
  if (match) {
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    const id = parseId(match[1]);
    const format = match[2];
    const { body, filename } =
      format === 'geojson' ? store.exportGeoJson(id, user) : store.exportKml(id, user);
    return sendExport(response, body, EXPORT_CONTENT_TYPE[format], filename);
  }

  match = STUDY_FEATURES_BULK.exec(route);
  if (match) {
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const id = parseId(match[1]);
    const body = await readJson(request);
    return sendJson(
      response,
      withLiveCells(request, store.bulkCreateFeatures(id, body.features, user)),
    );
  }

  match = CHILD.exec(route);
  if (match) {
    const [, kind, rawId] = match;
    const id = parseId(rawId);
    if (kind === 'analyses') {
      // Analyses are immutable once recorded: no PATCH route.
      if (method === 'DELETE') {
        return sendJson(response, withLiveCells(request, store.deleteChild(kind, id, user)));
      }
      throw new HttpError(405, 'Method not allowed.');
    }
    if (method === 'PATCH') {
      return sendJson(
        response,
        withLiveCells(request, store.updateChild(kind, id, await readJson(request), user)),
      );
    }
    if (method === 'DELETE') {
      return sendJson(response, withLiveCells(request, store.deleteChild(kind, id, user)));
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  match = CHILD_REORDER.exec(route);
  if (match) {
    const [, kind, rawId] = match;
    const id = parseId(rawId);
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const body = await readJson(request);
    return sendJson(
      response,
      withLiveCells(request, store.reorderChild(kind, id, body.direction, user)),
    );
  }

  throw new HttpError(404, 'Unknown API route.');
}

export default {
  id: ID,
  handle,
  close() {
    store?.close();
    store = undefined;
  },
};
