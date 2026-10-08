import type { RouteSpec } from '../../../server/dispatch.ts';
import { errorMessage, HttpError } from '../../../server/http.ts';
import state from './state.ts';
import { MAX_DISTANCE_KM, nearestMeasurements } from './chmi.ts';
import { nearestStation } from './station.ts';
import { CHILDREN, openStore, shapeStudy } from './store.ts';

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
state.onClose(() => {
  store?.close();
  store = undefined;
});

/** Lazy-opens the state file on first use (dispatch-contract.md's `database`). */
function getStore() {
  store ??= openStore(state.path);
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
  const routes: RouteSpec[] = [
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
  id: state.id,
  database: () => getStore().database(),
  close: state.close,
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
    {
      method: 'GET',
      path: 'studies',
      verb: 'list',
      handler: ({ access }) => getStore().listStudies(access),
    },
    {
      method: 'POST',
      path: 'studies',
      verb: 'create',
      item: 'study',
      handler: ({ body, owner, access }) => {
        if (!access.white) throw new HttpError(403, 'Only White may create extra studies.');
        return getStore().createStudy(body, owner);
      },
    },
    {
      method: 'GET',
      path: 'studies/current',
      verb: 'list',
      handler: ({ query, access }) => {
        const cell = access.white ? (query.get('cell') ?? 'white') : access.cell;
        if (!cell) throw new HttpError(403, 'You are not assigned to a cell.');
        return getStore().readCellStudy(cell);
      },
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
      handler: ({ item, access }) => {
        if (!access.white) throw new HttpError(403, 'Only White may delete studies.');
        return getStore().deleteStudy(item.id);
      },
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
          throw new HttpError(502, `The station service did not answer (${errorMessage(error)}).`);
        }
        if (!station) throw new HttpError(404, 'No reporting station within about 500 km.');
        return station;
      },
    },
    {
      method: 'GET',
      path: 'weather/measured',
      verb: 'none',
      handler: async ({ query }) => {
        const [lon, lat] = (query.get('at') || '').split(',').map(Number);
        if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) {
          throw new HttpError(400, 'The at must be "lon,lat".');
        }
        let measured;
        try {
          measured = await nearestMeasurements({ lon, lat });
        } catch (error) {
          throw new HttpError(502, `ČHMÚ open data did not answer (${errorMessage(error)}).`);
        }
        if (!measured) {
          throw new HttpError(404, `No ČHMÚ station reporting within ${MAX_DISTANCE_KM} km.`);
        }
        return measured;
      },
    },
  ],
};
