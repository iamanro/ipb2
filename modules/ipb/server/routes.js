import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError, readJson, sendJson } from '../../../server/http.js';
import { openStore } from './store.js';

const ID = 'ipb';
const STATE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state');
const DATABASE = path.join(STATE_ROOT, 'ipb.db');

const STUDIES = /^studies$/;
const STUDY = /^studies\/(\d+)$/;
const STUDY_CHILDREN = /^studies\/(\d+)\/(features|threats|coas|events|analyses)$/;
const CHILD = /^(features|threats|coas|events|analyses)\/(\d+)$/;

function parseId(text) {
  return Number.parseInt(text, 10);
}

let store;

async function handle({ route, request, response }) {
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
