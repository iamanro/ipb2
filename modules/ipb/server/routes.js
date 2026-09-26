import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError } from '../../../server/http.js';
import { stateDirectory } from '../../../server/state.js';
import { nearestStation } from './station.js';
import { CHILDREN, openStore, shapeStudy } from './store.js';

const ID = 'ipb';
const STATE_ROOT = stateDirectory(
  ID,
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state'),
);
const DATABASE = path.join(STATE_ROOT, 'ipb.db');

const EXPORT_CONTENT_TYPE = {
  geojson: 'application/geo+json',
  kml: 'application/vnd.google-earth.kml+xml',
};

/** A text export with a download filename, distinct from the dispatcher's own JSON responses. */
function sendExport(response, { body, filename }, contentType) {
  const bytes = Buffer.from(body, 'utf8');
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': bytes.byteLength,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  response.end(bytes);
}

let store;

/** Lazy-opens the state file on first use (dispatch-contract.md's `database`). */
function getStore() {
  store ??= openStore(DATABASE);
  return store;
}

const ORDINAL_KINDS = new Set(
  Object.entries(CHILDREN)
    .filter(([, config]) => config.ordinal)
    .map(([kind]) => kind),
);

/** Every study part kind's route set: create, patch/delete by `:part`
 * (analyses is immutable: no PATCH), reorder for ordinal kinds. */
const partRoutes = Object.keys(CHILDREN).flatMap((kind) => {
  const routes = [
    {
      method: 'POST',
      path: `studies/:item/${kind}`,
      verb: 'change',
      item: 'study',
      handler: ({ item, body }) => getStore().createChild(kind, item.id, body),
    },
  ];
  if (kind !== 'analyses') {
    routes.push({
      method: 'PATCH',
      path: `studies/:item/${kind}/:part`,
      verb: 'change',
      item: 'study',
      part: kind,
      handler: ({ part, body }) => getStore().updateChild(kind, part.id, body),
    });
  }
  routes.push({
    method: 'DELETE',
    path: `studies/:item/${kind}/:part`,
    verb: 'change',
    item: 'study',
    part: kind,
    handler: ({ part }) => getStore().deleteChild(kind, part.id),
  });
  if (ORDINAL_KINDS.has(kind)) {
    routes.push({
      method: 'POST',
      path: `studies/:item/${kind}/:part/reorder`,
      verb: 'change',
      item: 'study',
      part: kind,
      handler: ({ part, body }) => getStore().reorderChild(kind, part.id, body?.direction),
    });
  }
  return routes;
});

export default {
  id: ID,
  database: () => getStore().database(),
  close() {
    store?.close();
    store = undefined;
  },
  items: {
    study: {
      table: 'studies',
      path: 'studies',
      label: 'Study',
      shape: (row) => shapeStudy(row),
      onOwnership: (change) => getStore().recordOwnershipChange(change),
    },
  },
  parts: Object.fromEntries(
    Object.entries(CHILDREN).map(([kind, config]) => [
      kind,
      { table: config.table, item: 'study', column: 'study_id', label: config.label },
    ]),
  ),
  routes: [
    { method: 'GET', path: 'studies', verb: 'list', handler: ({ access }) => getStore().listStudies(access) },
    {
      method: 'POST',
      path: 'studies',
      verb: 'create',
      item: 'study',
      handler: ({ body, owner }) => getStore().createStudy(body, owner),
    },
    {
      method: 'GET',
      path: 'studies/:item',
      verb: 'see',
      item: 'study',
      handler: ({ item }) => getStore().readStudy(item.id),
    },
    {
      method: 'PATCH',
      path: 'studies/:item',
      verb: 'change',
      item: 'study',
      handler: ({ item, body }) => getStore().updateStudy(item.id, body),
    },
    {
      method: 'DELETE',
      path: 'studies/:item',
      verb: 'change',
      item: 'study',
      handler: ({ item }) => getStore().deleteStudy(item.id),
    },
    {
      method: 'GET',
      path: 'studies/:item/export.geojson',
      verb: 'see',
      item: 'study',
      handler: ({ item, response }) => {
        sendExport(response, getStore().exportGeoJson(item.id), EXPORT_CONTENT_TYPE.geojson);
      },
    },
    {
      method: 'GET',
      path: 'studies/:item/export.kml',
      verb: 'see',
      item: 'study',
      handler: ({ item, response }) => {
        sendExport(response, getStore().exportKml(item.id), EXPORT_CONTENT_TYPE.kml);
      },
    },
    {
      method: 'POST',
      path: 'studies/:item/features/bulk',
      verb: 'change',
      item: 'study',
      handler: ({ item, body }) => getStore().bulkCreateFeatures(item.id, body?.features),
    },
    ...partRoutes,
    {
      method: 'GET',
      path: 'weather/station',
      verb: 'none',
      handler: async ({ query }) => {
        const [lon, lat] = (query.get('at') || '').split(',').map(Number);
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
        return station;
      },
    },
  ],
};
