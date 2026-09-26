import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateDirectory } from '../../../server/state.js';
import { openStore, shapeOrbat } from './store.js';

const ID = 'orbat';
const STATE_ROOT = stateDirectory(
  ID,
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state'),
);
const DATABASE = path.join(STATE_ROOT, 'orbat.db');

let store;

/** Lazily opens the state DB. Called eagerly by every route below (the
 * dispatcher itself only opens it for routes that resolve an item/part). */
function open() {
  store ??= openStore(DATABASE);
  return store;
}

export default {
  id: ID,
  database: () => open().database,
  close() {
    store?.close();
    store = undefined;
  },
  items: {
    orbat: {
      table: 'orbats',
      path: 'orbats',
      label: 'ORBAT',
      shape: (row) => shapeOrbat(row),
    },
  },
  parts: {
    unit: { table: 'units', item: 'orbat', column: 'orbat_id', label: 'Unit' },
  },
  routes: [
    {
      method: 'GET',
      path: 'orbats',
      verb: 'list',
      handler: ({ access }) => open().listOrbats(access),
    },
    {
      method: 'POST',
      path: 'orbats',
      verb: 'create',
      item: 'orbat',
      handler: ({ body, owner }) => open().createOrbat(owner, body),
    },
    {
      method: 'POST',
      path: 'orbats/import',
      verb: 'create',
      item: 'orbat',
      handler: ({ body, owner }) => open().importOrbat(owner, body),
    },
    {
      method: 'GET',
      path: 'orbats/:item',
      verb: 'see',
      item: 'orbat',
      handler: ({ item }) => open().documentFor(item),
    },
    {
      method: 'PATCH',
      path: 'orbats/:item',
      verb: 'change',
      item: 'orbat',
      handler: ({ item, body }) => open().updateOrbat(item, body),
    },
    {
      method: 'DELETE',
      path: 'orbats/:item',
      verb: 'change',
      item: 'orbat',
      handler: ({ item }) => open().deleteOrbat(item),
    },
    {
      method: 'GET',
      path: 'orbats/:item/export',
      verb: 'see',
      item: 'orbat',
      handler: ({ item }) => open().exportOrbat(item),
    },
    {
      method: 'POST',
      path: 'orbats/:item/units',
      verb: 'change',
      item: 'orbat',
      handler: ({ item, body }) => open().addUnit(item, body),
    },
    {
      method: 'PATCH',
      path: 'orbats/:item/units/:part',
      verb: 'change',
      item: 'orbat',
      part: 'unit',
      handler: ({ part, body }) => open().updateUnit(part, body),
    },
    {
      method: 'DELETE',
      path: 'orbats/:item/units/:part',
      verb: 'change',
      item: 'orbat',
      part: 'unit',
      handler: ({ part }) => open().deleteUnit(part),
    },
    {
      method: 'POST',
      path: 'orbats/:item/units/:part/duplicate',
      verb: 'change',
      item: 'orbat',
      part: 'unit',
      handler: ({ part }) => open().duplicateUnit(part),
    },
  ],
};
