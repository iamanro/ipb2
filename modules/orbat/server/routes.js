import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError, readJson, sendJson } from '../../../server/http.js';
import { stateDirectory } from '../../../server/state.js';
import { openStore, readLiveCells } from './store.js';

const ID = 'orbat';
const STATE_ROOT = stateDirectory(
  ID,
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state'),
);
const DATABASE = path.join(STATE_ROOT, 'orbat.db');

function parseId(text) {
  return Number.parseInt(text, 10);
}

let store;

/** C4: attach the cells a mutation's live event should reach, read off the
 * store's Symbol-keyed result (never serialized into the response body). */
function withLiveCells(request, result) {
  const cells = readLiveCells(result);
  if (cells) request.liveCells = cells;
  return result;
}

const ROUTES = [
  [
    /^orbats$/,
    {
      GET: (m, request) => store.listOrbats(request.user),
      POST: async (m, request) =>
        withLiveCells(request, store.createOrbat(await readJson(request), request.user)),
    },
  ],
  [
    /^orbats\/import$/,
    {
      POST: async (m, request) =>
        withLiveCells(request, store.importOrbat(await readJson(request), request.user)),
    },
  ],
  [
    /^orbats\/(\d+)$/,
    {
      GET: (m, request) => store.getDocument(parseId(m[1]), request.user),
      PATCH: async (m, request) =>
        withLiveCells(
          request,
          store.updateOrbat(parseId(m[1]), await readJson(request), request.user),
        ),
      DELETE: (m, request) => withLiveCells(request, store.deleteOrbat(parseId(m[1]), request.user)),
    },
  ],
  [
    /^orbats\/(\d+)\/release$/,
    {
      POST: async (m, request) => {
        const body = await readJson(request);
        return withLiveCells(
          request,
          store.releaseOrbat(parseId(m[1]), body?.cells, request.user),
        );
      },
    },
  ],
  [
    /^orbats\/(\d+)\/owner$/,
    {
      PATCH: async (m, request) => {
        const body = await readJson(request);
        return withLiveCells(
          request,
          store.reassignOrbat(parseId(m[1]), body?.owner_cell, request.user),
        );
      },
    },
  ],
  [
    /^orbats\/(\d+)\/units$/,
    {
      POST: async (m, request) =>
        withLiveCells(request, store.addUnit(parseId(m[1]), await readJson(request), request.user)),
    },
  ],
  [
    /^orbats\/(\d+)\/export$/,
    { GET: (m, request) => store.exportOrbat(parseId(m[1]), request.user) },
  ],

  [
    /^units\/(\d+)$/,
    {
      PATCH: async (m, request) =>
        withLiveCells(
          request,
          store.updateUnit(parseId(m[1]), await readJson(request), request.user),
        ),
      DELETE: (m, request) => withLiveCells(request, store.deleteUnit(parseId(m[1]), request.user)),
    },
  ],
  [
    /^units\/(\d+)\/duplicate$/,
    { POST: (m, request) => withLiveCells(request, store.duplicateUnit(parseId(m[1]), request.user)) },
  ],
];

async function handle({ route, request, response }) {
  store ??= openStore(DATABASE);
  for (const [pattern, methods] of ROUTES) {
    const match = pattern.exec(route);
    if (!match) continue;
    const handler = methods[request.method];
    if (!handler) throw new HttpError(405, 'Method not allowed.');
    sendJson(response, await handler(match, request));
    return;
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
