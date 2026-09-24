import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError, readJson, sendJson } from '../../../server/http.js';
import { stateDirectory } from '../../../server/state.js';
import { nearestStation } from './station.js';
import { openStore } from './store.js';

const ID = 'ipb';
const STATE_ROOT = stateDirectory(
  ID,
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state'),
);
const DATABASE = path.join(STATE_ROOT, 'ipb.db');

const STUDIES = /^studies$/;
const STUDY = /^studies\/(\d+)$/;
const KINDS = 'features|threats|coas|events|analyses|layers|points';
const STUDY_CHILDREN = new RegExp(`^studies\\/(\\d+)\\/(${KINDS})$`);
const CHILD = new RegExp(`^(${KINDS})\\/(\\d+)$`);
const CHILD_REORDER = new RegExp(`^(${KINDS})\\/(\\d+)\\/reorder$`);

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
  const { method } = request;

  if (STUDIES.test(route)) {
    if (method === 'GET') return sendJson(response, store.listStudies());
    if (method === 'POST') return sendJson(response, store.createStudy(await readJson(request)));
    throw new HttpError(405, 'Method not allowed.');
  }

  let match = STUDY.exec(route);
  if (match) {
    const id = parseId(match[1]);
    if (method === 'GET') return sendJson(response, store.readStudy(id));
    if (method === 'PATCH') {
      return sendJson(response, store.updateStudy(id, await readJson(request)));
    }
    if (method === 'DELETE') return sendJson(response, store.deleteStudy(id));
    throw new HttpError(405, 'Method not allowed.');
  }

  match = STUDY_CHILDREN.exec(route);
  if (match) {
    const id = parseId(match[1]);
    const kind = match[2];
    if (method === 'POST') {
      return sendJson(response, store.createChild(kind, id, await readJson(request)));
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  match = CHILD.exec(route);
  if (match) {
    const [, kind, rawId] = match;
    const id = parseId(rawId);
    if (kind === 'analyses') {
      // Analyses are immutable once recorded: no PATCH route.
      if (method === 'DELETE') return sendJson(response, store.deleteChild(kind, id));
      throw new HttpError(405, 'Method not allowed.');
    }
    if (method === 'PATCH') {
      return sendJson(response, store.updateChild(kind, id, await readJson(request)));
    }
    if (method === 'DELETE') return sendJson(response, store.deleteChild(kind, id));
    throw new HttpError(405, 'Method not allowed.');
  }

  match = CHILD_REORDER.exec(route);
  if (match) {
    const [, kind, rawId] = match;
    const id = parseId(rawId);
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const body = await readJson(request);
    return sendJson(response, store.reorderChild(kind, id, body.direction));
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
