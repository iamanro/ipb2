import {
  requireItem,
  requireOwner,
  requirePart,
  type ModuleSpec,
} from '../../../server/dispatch.ts';
import state from './state.ts';
import { openStore, shapeOrbat } from './store.ts';

let store: ReturnType<typeof openStore> | undefined;
state.onClose(() => {
  store?.close();
  store = undefined;
});

/** Lazily opens the state DB. Called eagerly by every route below (the
 * dispatcher itself only opens it for routes that resolve an item/part). */
function open() {
  store ??= openStore(state.path);
  return store;
}

export default {
  id: state.id,
  database: () => open().database,
  close: state.close,
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
      handler: ({ body, owner }) => open().createOrbat(requireOwner(owner), body),
    },
    {
      method: 'POST',
      path: 'orbats/import',
      verb: 'create',
      item: 'orbat',
      handler: ({ body, owner }) => open().importOrbat(requireOwner(owner), body),
    },
    {
      method: 'GET',
      path: 'orbats/:item',
      verb: 'see',
      item: 'orbat',
      handler: ({ item }) => open().documentFor(requireItem(item)),
    },
    {
      method: 'PATCH',
      path: 'orbats/:item',
      verb: 'change',
      item: 'orbat',
      handler: ({ item, body }) => open().updateOrbat(requireItem(item), body),
    },
    {
      method: 'DELETE',
      path: 'orbats/:item',
      verb: 'change',
      item: 'orbat',
      handler: ({ item }) => open().deleteOrbat(requireItem(item)),
    },
    {
      method: 'GET',
      path: 'orbats/:item/export',
      verb: 'see',
      item: 'orbat',
      handler: ({ item }) => open().exportOrbat(requireItem(item)),
    },
    {
      method: 'POST',
      path: 'orbats/:item/units',
      verb: 'change',
      item: 'orbat',
      handler: ({ item, body }) => open().addUnit(requireItem(item), body),
    },
    {
      method: 'PATCH',
      path: 'orbats/:item/units/:part',
      verb: 'change',
      item: 'orbat',
      part: 'unit',
      handler: ({ part, body }) => open().updateUnit(requirePart(part), body),
    },
    {
      method: 'DELETE',
      path: 'orbats/:item/units/:part',
      verb: 'change',
      item: 'orbat',
      part: 'unit',
      handler: ({ part }) => open().deleteUnit(requirePart(part)),
    },
    {
      method: 'POST',
      path: 'orbats/:item/units/:part/duplicate',
      verb: 'change',
      item: 'orbat',
      part: 'unit',
      handler: ({ part }) => open().duplicateUnit(requirePart(part)),
    },
  ],
} satisfies ModuleSpec;
