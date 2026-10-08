import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openStore } from './store.ts';

function tempFile() {
  return path.join(
    os.tmpdir(),
    `orbat-store-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function removeDatabaseFiles(file) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
}

function expectStatus(fn, status) {
  expect(fn).toThrow(expect.objectContaining({ status }));
}

let file;
let store;

// Cell access (visibility, edit gating, release/reassign) is decided by
// `server/dispatch.ts` before these functions ever run — covered by
// `dispatch.test.js` and this module's `routes.sweep.test.js`. These tests
// stay purely domain-level, so a fixed owner and an "everyone visible"
// access capability stand in for the dispatcher's decisions.
const OWNER = { owner_cell: 'white', releasable_to: [] };
const ALL_ACCESS = { visible: () => ({ sql: '1=1', params: [] }) };

beforeEach(() => {
  file = tempFile();
  store = openStore(file);
});

afterEach(() => {
  store.close();
  removeDatabaseFiles(file);
});

function createOrbat(name = 'Test ORBAT', owner = OWNER) {
  return store.createOrbat(owner, { name }).orbat;
}

function listOrbats() {
  return store.listOrbats(ALL_ACCESS);
}

function byName(units) {
  return [...units].sort((a, b) => a.position - b.position).map((u) => u.name);
}

describe('orbats', () => {
  test('creates and lists newest-updated first', () => {
    createOrbat('Alpha');
    createOrbat('Bravo');
    expect(listOrbats().map((o) => o.name)).toEqual(['Bravo', 'Alpha']);
  });

  test('updating touches updated_at, so it resorts to the front', async () => {
    const a = createOrbat('Alpha');
    createOrbat('Bravo');
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.updateOrbat(a, { name: 'Alpha renamed' });
    expect(listOrbats().map((o) => o.name)).toEqual(['Alpha renamed', 'Bravo']);
  });

  test('a blank or overlong name is rejected', () => {
    expectStatus(() => store.createOrbat(OWNER, { name: '   ' }), 400);
    expectStatus(() => store.createOrbat(OWNER, { name: 'x'.repeat(121) }), 400);
  });

  test('an overlong description is rejected', () => {
    expectStatus(() => store.createOrbat(OWNER, { name: 'x', description: 'y'.repeat(2001) }), 400);
  });

  test('deleting removes it, and cascades its units', () => {
    const a = createOrbat('Alpha');
    store.addUnit(a, { parentId: null, name: 'X' });
    store.deleteOrbat(a);
    expect(listOrbats()).toHaveLength(0);
  });
});

describe('units: add', () => {
  test('appends by default; an explicit position inserts and renumbers', () => {
    const orbat = createOrbat();
    store.addUnit(orbat, { parentId: null, name: 'A' });
    store.addUnit(orbat, { parentId: null, name: 'B' });
    const doc = store.addUnit(orbat, { parentId: null, name: 'C', position: 1 });
    expect(byName(doc.units)).toEqual(['A', 'C', 'B']);
    expect([...doc.units].sort((x, y) => x.position - y.position).map((u) => u.position)).toEqual([
      0, 1, 2,
    ]);
  });

  test('sidc defaults when omitted, and rejects a bad one', () => {
    const orbat = createOrbat();
    const doc = store.addUnit(orbat, { parentId: null });
    expect(doc.units[0].sidc).toBe('10031000001211000000');
    expectStatus(() => store.addUnit(orbat, { parentId: null, sidc: 'nope' }), 400);
    expectStatus(() => store.addUnit(orbat, { parentId: null, sidc: '123' }), 400);
  });

  test('parentId is required, even if null', () => {
    expectStatus(() => store.addUnit(createOrbat(), {}), 400);
  });

  test('a parentId from a different ORBAT, or an unknown one, is a 400', () => {
    const a = createOrbat('A');
    const b = createOrbat('B');
    const { unitId } = store.addUnit(a, { parentId: null });
    expectStatus(() => store.addUnit(b, { parentId: unitId }), 400);
    expectStatus(() => store.addUnit(b, { parentId: 999999 }), 400);
  });

  test('field length limits are enforced', () => {
    const orbat = createOrbat();
    expectStatus(() => store.addUnit(orbat, { parentId: null, designation: 'x'.repeat(41) }), 400);
    expectStatus(() => store.addUnit(orbat, { parentId: null, reinforced: '(++)' }), 400);
  });
});

describe('units: move', () => {
  function seedTree() {
    const orbat = createOrbat();
    const { unitId: root } = store.addUnit(orbat, { parentId: null, name: 'Root' });
    const { unitId: a } = store.addUnit(orbat, { parentId: root, name: 'A' });
    const { unitId: b } = store.addUnit(orbat, { parentId: root, name: 'B' });
    const { unitId: c } = store.addUnit(orbat, { parentId: root, name: 'C' });
    return { orbat, root, a, b, c };
  }

  test('reordering within the same parent renumbers that sibling list contiguously', () => {
    const { c, root } = seedTree();
    const doc = store.updateUnit(store.unitRow(c), { position: 0 });
    const children = doc.units.filter((u) => u.parentId === root);
    expect(byName(children)).toEqual(['C', 'A', 'B']);
    expect([...children].sort((x, y) => x.position - y.position).map((u) => u.position)).toEqual([
      0, 1, 2,
    ]);
  });

  test('an out-of-range position clamps to the end', () => {
    const { c, root } = seedTree();
    const doc = store.updateUnit(store.unitRow(c), { position: 999 });
    const children = doc.units.filter((u) => u.parentId === root);
    expect(byName(children)).toEqual(['A', 'B', 'C']);
  });

  test('moving to a different parent renumbers both sibling lists contiguously', () => {
    const { orbat, root, a } = seedTree();
    const { unitId: other } = store.addUnit(orbat, { parentId: null, name: 'Other' });
    const doc = store.updateUnit(store.unitRow(a), { parentId: other });

    const rootChildren = doc.units.filter((u) => u.parentId === root);
    expect(byName(rootChildren)).toEqual(['B', 'C']);
    expect(
      [...rootChildren].sort((x, y) => x.position - y.position).map((u) => u.position),
    ).toEqual([0, 1]);

    const otherChildren = doc.units.filter((u) => u.parentId === other);
    expect(byName(otherChildren)).toEqual(['A']);
    expect(otherChildren[0].position).toBe(0);
  });

  test('moving a unit under itself, or under its own descendant, is a 409', () => {
    const { root, a } = seedTree();
    expectStatus(() => store.updateUnit(store.unitRow(root), { parentId: root }), 409);
    expectStatus(() => store.updateUnit(store.unitRow(root), { parentId: a }), 409);
  });

  test('moving under a unit from another ORBAT, or a unit that does not exist, is a 409', () => {
    const { a } = seedTree();
    const other = createOrbat('Other');
    const { unitId: foreign } = store.addUnit(other, { parentId: null });
    expectStatus(() => store.updateUnit(store.unitRow(a), { parentId: foreign }), 409);
    expectStatus(() => store.updateUnit(store.unitRow(a), { parentId: 999999 }), 409);
  });

  test('editing text fields does not require a move', () => {
    const { a } = seedTree();
    const doc = store.updateUnit(store.unitRow(a), { name: 'Renamed', notes: 'note' });
    const unit = doc.units.find((u) => u.id === a);
    expect(unit.name).toBe('Renamed');
    expect(unit.notes).toBe('note');
  });
});

describe('units: delete', () => {
  test('removes the whole subtree and renumbers remaining siblings', () => {
    const orbat = createOrbat();
    store.addUnit(orbat, { parentId: null, name: 'A' });
    const { unitId: b } = store.addUnit(orbat, { parentId: null, name: 'B' });
    store.addUnit(orbat, { parentId: null, name: 'C' });
    store.addUnit(orbat, { parentId: b, name: 'B-child' });

    const doc = store.deleteUnit(store.unitRow(b));
    expect(byName(doc.units)).toEqual(['A', 'C']);
    expect([...doc.units].sort((x, y) => x.position - y.position).map((u) => u.position)).toEqual([
      0, 1,
    ]);
  });
});

describe('units: duplicate', () => {
  test('deep-copies the subtree right after the original, with new ids', () => {
    const orbat = createOrbat();
    const { unitId: a } = store.addUnit(orbat, { parentId: null, name: 'A' });
    store.addUnit(orbat, { parentId: null, name: 'B' });
    const { unitId: child } = store.addUnit(orbat, { parentId: a, name: 'A-child' });

    const { unitId: copyId, units } = store.duplicateUnit(store.unitRow(a));
    expect(copyId).not.toBe(a);

    const topLevel = units.filter((u) => u.parentId === null);
    expect(byName(topLevel)).toEqual(['A', 'A', 'B']);
    const copy = [...topLevel].sort((x, y) => x.position - y.position)[1];
    expect(copy.id).toBe(copyId);

    const copyChild = units.find((u) => u.parentId === copyId);
    expect(copyChild.name).toBe('A-child');
    expect(copyChild.id).not.toBe(child);
  });
});

describe('export / import', () => {
  const NODE = {
    sidc: '10031000001211000000',
    name: '',
    designation: '',
    higherFormation: '',
    reinforced: '',
    additional: '',
    notes: '',
    children: [],
  };

  test('round-trips a nested tree', () => {
    const orbat = createOrbat('Blue Corps');
    const { unitId: root } = store.addUnit(orbat, {
      parentId: null,
      name: 'HQ',
      sidc: '10031000001211000000',
    });
    store.addUnit(orbat, { parentId: root, name: 'Alpha Coy' });
    store.addUnit(orbat, { parentId: root, name: 'Bravo Coy' });

    const exported = store.exportOrbat(orbat);
    expect(exported).toEqual({
      format: 'orbat',
      version: 1,
      name: 'Blue Corps',
      description: '',
      units: [
        {
          ...NODE,
          name: 'HQ',
          children: [
            { ...NODE, name: 'Alpha Coy' },
            { ...NODE, name: 'Bravo Coy' },
          ],
        },
      ],
    });

    const imported = store.importOrbat(OWNER, exported);
    expect(imported.orbat.name).toBe('Blue Corps');
    expect(imported.orbat.id).not.toBe(orbat.id);
    expect(store.exportOrbat(store.orbatRow(imported.orbat.id))).toEqual(exported);
  });

  test('rejects a bad sidc and writes nothing', () => {
    const before = listOrbats().length;
    expectStatus(
      () =>
        store.importOrbat(OWNER, {
          format: 'orbat',
          version: 1,
          name: 'x',
          units: [{ ...NODE, sidc: 'nope' }],
        }),
      400,
    );
    expect(listOrbats()).toHaveLength(before);
  });

  test('rejects a subtree deeper than the maximum and writes nothing', () => {
    const before = listOrbats().length;
    let node = { ...NODE };
    for (let i = 0; i < 30; i += 1) node = { ...NODE, children: [node] };
    expectStatus(
      () => store.importOrbat(OWNER, { format: 'orbat', version: 1, name: 'x', units: [node] }),
      400,
    );
    expect(listOrbats()).toHaveLength(before);
  });

  test('rejects an unrecognised format or version, and writes nothing', () => {
    const before = listOrbats().length;
    expectStatus(
      () => store.importOrbat(OWNER, { format: 'nope', version: 1, name: 'x', units: [] }),
      400,
    );
    expectStatus(
      () => store.importOrbat(OWNER, { format: 'orbat', version: 2, name: 'x', units: [] }),
      400,
    );
    expect(listOrbats()).toHaveLength(before);
  });

  test('import stamps owner_cell as the owner it is given', () => {
    const payload = { format: 'orbat', version: 1, name: 'Imported', units: [] };
    const asBlue = store.importOrbat({ owner_cell: 'blue', releasable_to: [] }, payload);
    expect(asBlue.orbat.owner_cell).toBe('blue');
  });
});

describe('updatedAt', () => {
  test('bumps on unit add, edit, move, and delete', async () => {
    const orbat = createOrbat();
    const wait = () => new Promise((resolve) => setTimeout(resolve, 5));

    let last = store.documentFor(store.orbatRow(orbat.id)).orbat.updatedAt;

    await wait();
    const { unitId, orbat: afterAdd } = store.addUnit(orbat, { parentId: null, name: 'A' });
    expect(afterAdd.updatedAt > last).toBe(true);
    last = afterAdd.updatedAt;

    await wait();
    const afterEdit = store.updateUnit(store.unitRow(unitId), { name: 'A2' }).orbat;
    expect(afterEdit.updatedAt > last).toBe(true);
    last = afterEdit.updatedAt;

    await wait();
    store.addUnit(orbat, { parentId: null, name: 'B' });
    const afterMove = store.updateUnit(store.unitRow(unitId), { position: 1 }).orbat;
    expect(afterMove.updatedAt > last).toBe(true);
    last = afterMove.updatedAt;

    await wait();
    const afterDelete = store.deleteUnit(store.unitRow(unitId)).orbat;
    expect(afterDelete.updatedAt > last).toBe(true);
  });
});
