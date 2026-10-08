import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, expect, test } from 'vitest';

// Same pattern as `server/api.test.js`: `IPB_STATE_ROOT` is read once, at
// module load, by `stateDirectory` — set before the dynamic import, so this
// suite never touches the real `modules/orbat/state/orbat.db`.
let stateRoot;
let routes;
let dispatcher;
let createDispatcher;
let sweepRoutes;

const BLUE = { name: 'b', admin: false, cell: 'blue', role: 'analyst' };
const TIMESTAMP = new Date().toISOString();

beforeAll(async () => {
  stateRoot = path.join(
    os.tmpdir(),
    `ipb-orbat-sweep-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  process.env.IPB_STATE_ROOT = stateRoot;
  ({ default: routes } = await import('./routes.js'));
  ({ createDispatcher } = await import('../../../server/dispatch.ts'));
  ({ sweepRoutes } = await import('../../../server/routeSweep.ts'));
  dispatcher = createDispatcher([routes]);
});

afterAll(() => {
  routes.close();
  delete process.env.IPB_STATE_ROOT;
  rmSync(stateRoot, { recursive: true, force: true });
});

function insertOrbat(database, name, releasableTo) {
  const { lastInsertRowid } = database
    .prepare(
      `INSERT INTO orbats (name, description, created_at, updated_at, owner_cell, releasable_to)
       VALUES (?, '', ?, ?, 'red', ?)`,
    )
    .run(name, TIMESTAMP, TIMESTAMP, JSON.stringify(releasableTo));
  return Number(lastInsertRowid);
}

function insertUnit(database, orbatId, name) {
  const { lastInsertRowid } = database
    .prepare(
      `INSERT INTO units
         (orbat_id, parent_id, position, sidc, name, designation, higher_formation, reinforced, additional, notes)
       VALUES (?, NULL, 0, '10031000001211000000', ?, '', '', '', '', '')`,
    )
    .run(orbatId, name);
  return Number(lastInsertRowid);
}

test('every route naming an ORBAT or unit holds the line for a Blue analyst', async () => {
  const database = routes.database();

  const hiddenOrbat = insertOrbat(database, 'Red hidden', []);
  const hiddenUnit = insertUnit(database, hiddenOrbat, 'HQ');
  const releasedOrbat = insertOrbat(database, 'Red released', ['blue']);
  const releasedUnit = insertUnit(database, releasedOrbat, 'HQ');

  const fixtures = {
    orbat: {
      hidden: { item: hiddenOrbat, parts: { unit: hiddenUnit } },
      released: { item: releasedOrbat, parts: { unit: releasedUnit } },
    },
  };

  expect(await sweepRoutes({ dispatcher, moduleId: 'orbat', actor: BLUE, fixtures })).toEqual([]);
});
