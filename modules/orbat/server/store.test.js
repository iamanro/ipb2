import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openStore } from './store.js';

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

beforeEach(() => {
  file = tempFile();
  store = openStore(file);
});

afterEach(() => {
  store.close();
  removeDatabaseFiles(file);
});

function createOrbat(name = 'Test ORBAT') {
  return store.createOrbat({ name }).orbat;
}

function byName(units) {
  return [...units].sort((a, b) => a.position - b.position).map((u) => u.name);
}

describe('orbats', () => {
  test('creates and lists newest-updated first', () => {
    createOrbat('Alpha');
    createOrbat('Bravo');
    expect(store.listOrbats().map((o) => o.name)).toEqual(['Bravo', 'Alpha']);
  });

  test('updating touches updated_at, so it resorts to the front', async () => {
    const a = createOrbat('Alpha');
    createOrbat('Bravo');
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.updateOrbat(a.id, { name: 'Alpha renamed' });
    expect(store.listOrbats().map((o) => o.name)).toEqual(['Alpha renamed', 'Bravo']);
  });

  test('a blank or overlong name is rejected', () => {
    expectStatus(() => store.createOrbat({ name: '   ' }), 400);
    expectStatus(() => store.createOrbat({ name: 'x'.repeat(121) }), 400);
  });

  test('an overlong description is rejected', () => {
    expectStatus(() => store.createOrbat({ name: 'x', description: 'y'.repeat(2001) }), 400);
  });

  test('unknown orbat ids are 404 everywhere', () => {
    expectStatus(() => store.getDocument(999), 404);
    expectStatus(() => store.updateOrbat(999, { name: 'x' }), 404);
    expectStatus(() => store.deleteOrbat(999), 404);
    expectStatus(() => store.exportOrbat(999), 404);
    expectStatus(() => store.addUnit(999, { parentId: null }), 404);
  });

  test('deleting removes it, and cascades its units', () => {
    const a = createOrbat('Alpha');
    store.addUnit(a.id, { parentId: null, name: 'X' });
    store.deleteOrbat(a.id);
    expect(store.listOrbats()).toHaveLength(0);
  });
});

describe('units: add', () => {
  test('appends by default; an explicit position inserts and renumbers', () => {
    const orbat = createOrbat();
    store.addUnit(orbat.id, { parentId: null, name: 'A' });
    store.addUnit(orbat.id, { parentId: null, name: 'B' });
    const doc = store.addUnit(orbat.id, { parentId: null, name: 'C', position: 1 });
    expect(byName(doc.units)).toEqual(['A', 'C', 'B']);
    expect([...doc.units].sort((x, y) => x.position - y.position).map((u) => u.position)).toEqual([
      0, 1, 2,
    ]);
  });

  test('sidc defaults when omitted, and rejects a bad one', () => {
    const orbat = createOrbat();
    const doc = store.addUnit(orbat.id, { parentId: null });
    expect(doc.units[0].sidc).toBe('10031000001211000000');
    expectStatus(() => store.addUnit(orbat.id, { parentId: null, sidc: 'nope' }), 400);
    expectStatus(() => store.addUnit(orbat.id, { parentId: null, sidc: '123' }), 400);
  });

  test('parentId is required, even if null', () => {
    expectStatus(() => store.addUnit(createOrbat().id, {}), 400);
  });

  test('a parentId from a different ORBAT, or an unknown one, is a 400', () => {
    const a = createOrbat('A');
    const b = createOrbat('B');
    const { unitId } = store.addUnit(a.id, { parentId: null });
    expectStatus(() => store.addUnit(b.id, { parentId: unitId }), 400);
    expectStatus(() => store.addUnit(b.id, { parentId: 999999 }), 400);
  });

  test('field length limits are enforced', () => {
    const orbat = createOrbat();
    expectStatus(
      () => store.addUnit(orbat.id, { parentId: null, designation: 'x'.repeat(41) }),
      400,
    );
    expectStatus(() => store.addUnit(orbat.id, { parentId: null, reinforced: '(++)' }), 400);
  });
});

describe('units: move', () => {
  function seedTree() {
    const orbat = createOrbat();
    const { unitId: root } = store.addUnit(orbat.id, { parentId: null, name: 'Root' });
    const { unitId: a } = store.addUnit(orbat.id, { parentId: root, name: 'A' });
    const { unitId: b } = store.addUnit(orbat.id, { parentId: root, name: 'B' });
    const { unitId: c } = store.addUnit(orbat.id, { parentId: root, name: 'C' });
    return { orbat, root, a, b, c };
  }

  test('reordering within the same parent renumbers that sibling list contiguously', () => {
    const { c, root } = seedTree();
    const doc = store.updateUnit(c, { position: 0 });
    const children = doc.units.filter((u) => u.parentId === root);
    expect(byName(children)).toEqual(['C', 'A', 'B']);
    expect([...children].sort((x, y) => x.position - y.position).map((u) => u.position)).toEqual([
      0, 1, 2,
    ]);
  });

  test('an out-of-range position clamps to the end', () => {
    const { c, root } = seedTree();
    const doc = store.updateUnit(c, { position: 999 });
    const children = doc.units.filter((u) => u.parentId === root);
    expect(byName(children)).toEqual(['A', 'B', 'C']);
  });

  test('moving to a different parent renumbers both sibling lists contiguously', () => {
    const { orbat, root, a } = seedTree();
    const { unitId: other } = store.addUnit(orbat.id, { parentId: null, name: 'Other' });
    const doc = store.updateUnit(a, { parentId: other });

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
    expectStatus(() => store.updateUnit(root, { parentId: root }), 409);
    expectStatus(() => store.updateUnit(root, { parentId: a }), 409);
  });

  test('moving under a unit from another ORBAT, or a unit that does not exist, is a 409', () => {
    const { a } = seedTree();
    const other = createOrbat('Other');
    const { unitId: foreign } = store.addUnit(other.id, { parentId: null });
    expectStatus(() => store.updateUnit(a, { parentId: foreign }), 409);
    expectStatus(() => store.updateUnit(a, { parentId: 999999 }), 409);
  });

  test('editing text fields does not require a move', () => {
    const { a } = seedTree();
    const doc = store.updateUnit(a, { name: 'Renamed', notes: 'note' });
    const unit = doc.units.find((u) => u.id === a);
    expect(unit.name).toBe('Renamed');
    expect(unit.notes).toBe('note');
  });

  test('editing an unknown unit is a 404', () => {
    expectStatus(() => store.updateUnit(999999, { name: 'x' }), 404);
  });
});

describe('units: delete', () => {
  test('removes the whole subtree and renumbers remaining siblings', () => {
    const orbat = createOrbat();
    store.addUnit(orbat.id, { parentId: null, name: 'A' });
    const { unitId: b } = store.addUnit(orbat.id, { parentId: null, name: 'B' });
    store.addUnit(orbat.id, { parentId: null, name: 'C' });
    const { unitId: child } = store.addUnit(orbat.id, { parentId: b, name: 'B-child' });

    const doc = store.deleteUnit(b);
    expect(byName(doc.units)).toEqual(['A', 'C']);
    expect([...doc.units].sort((x, y) => x.position - y.position).map((u) => u.position)).toEqual([
      0, 1,
    ]);
    expectStatus(() => store.updateUnit(child, { name: 'x' }), 404);
  });

  test('deleting an unknown unit is a 404', () => {
    expectStatus(() => store.deleteUnit(999999), 404);
  });
});

describe('units: duplicate', () => {
  test('deep-copies the subtree right after the original, with new ids', () => {
    const orbat = createOrbat();
    const { unitId: a } = store.addUnit(orbat.id, { parentId: null, name: 'A' });
    store.addUnit(orbat.id, { parentId: null, name: 'B' });
    const { unitId: child } = store.addUnit(orbat.id, { parentId: a, name: 'A-child' });

    const { unitId: copyId, units } = store.duplicateUnit(a);
    expect(copyId).not.toBe(a);

    const topLevel = units.filter((u) => u.parentId === null);
    expect(byName(topLevel)).toEqual(['A', 'A', 'B']);
    const copy = [...topLevel].sort((x, y) => x.position - y.position)[1];
    expect(copy.id).toBe(copyId);

    const copyChild = units.find((u) => u.parentId === copyId);
    expect(copyChild.name).toBe('A-child');
    expect(copyChild.id).not.toBe(child);
  });

  test('duplicating an unknown unit is a 404', () => {
    expectStatus(() => store.duplicateUnit(999999), 404);
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
    const { unitId: root } = store.addUnit(orbat.id, {
      parentId: null,
      name: 'HQ',
      sidc: '10031000001211000000',
    });
    store.addUnit(orbat.id, { parentId: root, name: 'Alpha Coy' });
    store.addUnit(orbat.id, { parentId: root, name: 'Bravo Coy' });

    const exported = store.exportOrbat(orbat.id);
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

    const imported = store.importOrbat(exported);
    expect(imported.orbat.name).toBe('Blue Corps');
    expect(imported.orbat.id).not.toBe(orbat.id);
    expect(store.exportOrbat(imported.orbat.id)).toEqual(exported);
  });

  test('rejects a bad sidc and writes nothing', () => {
    const before = store.listOrbats().length;
    expectStatus(
      () =>
        store.importOrbat({
          format: 'orbat',
          version: 1,
          name: 'x',
          units: [{ ...NODE, sidc: 'nope' }],
        }),
      400,
    );
    expect(store.listOrbats()).toHaveLength(before);
  });

  test('rejects a subtree deeper than the maximum and writes nothing', () => {
    const before = store.listOrbats().length;
    let node = { ...NODE };
    for (let i = 0; i < 30; i += 1) node = { ...NODE, children: [node] };
    expectStatus(
      () => store.importOrbat({ format: 'orbat', version: 1, name: 'x', units: [node] }),
      400,
    );
    expect(store.listOrbats()).toHaveLength(before);
  });

  test('rejects an unrecognised format or version, and writes nothing', () => {
    const before = store.listOrbats().length;
    expectStatus(
      () => store.importOrbat({ format: 'nope', version: 1, name: 'x', units: [] }),
      400,
    );
    expectStatus(
      () => store.importOrbat({ format: 'orbat', version: 2, name: 'x', units: [] }),
      400,
    );
    expect(store.listOrbats()).toHaveLength(before);
  });
});

describe('updatedAt', () => {
  test('bumps on unit add, edit, move, and delete', async () => {
    const orbat = createOrbat();
    const wait = () => new Promise((resolve) => setTimeout(resolve, 5));

    let last = store.getDocument(orbat.id).orbat.updatedAt;

    await wait();
    const { unitId, orbat: afterAdd } = store.addUnit(orbat.id, { parentId: null, name: 'A' });
    expect(afterAdd.updatedAt > last).toBe(true);
    last = afterAdd.updatedAt;

    await wait();
    const afterEdit = store.updateUnit(unitId, { name: 'A2' }).orbat;
    expect(afterEdit.updatedAt > last).toBe(true);
    last = afterEdit.updatedAt;

    await wait();
    store.addUnit(orbat.id, { parentId: null, name: 'B' });
    const afterMove = store.updateUnit(unitId, { position: 1 }).orbat;
    expect(afterMove.updatedAt > last).toBe(true);
    last = afterMove.updatedAt;

    await wait();
    const afterDelete = store.deleteUnit(unitId).orbat;
    expect(afterDelete.updatedAt > last).toBe(true);
  });
});

describe('openStore: cells (C2/C3 phase 1 access)', () => {
  const WHITE = { admin: false, cell: 'white', role: 'game-master' };
  const BLUE = { admin: false, cell: 'blue', role: 'analyst' };
  const BLUE_OBSERVER = { admin: false, cell: 'blue', role: 'observer' };
  const RED = { admin: false, cell: 'red', role: 'analyst' };
  const ADMIN = { admin: true, cell: null, role: null };

  test('an ORBAT defaults to the creator cell; White may choose any cell', () => {
    const blueOrbat = store.createOrbat({ name: 'Blue ORBAT' }, BLUE).orbat;
    expect(blueOrbat.owner_cell).toBe('blue');
    expect(blueOrbat.releasable_to).toEqual([]);
    const whiteChosen = store.createOrbat({ name: 'Red ORBAT', owner_cell: 'red' }, WHITE).orbat;
    expect(whiteChosen.owner_cell).toBe('red');
  });

  test('a non-White user cannot create an ORBAT for another cell', () => {
    expectStatus(() => store.createOrbat({ name: 'x', owner_cell: 'red' }, BLUE), 400);
  });

  test('list only returns visible ORBATs: own cell, released, or White/admin sees all', () => {
    store.createOrbat({ name: 'Blue A' }, BLUE);
    const redOrbat = store.createOrbat({ name: 'Red A' }, RED).orbat;
    store.createOrbat({ name: 'White A' }, WHITE);

    expect(store.listOrbats(BLUE).map((o) => o.name)).toEqual(['Blue A']);
    expect(store.listOrbats(RED).map((o) => o.name)).toEqual(['Red A']);
    expect(store.listOrbats(WHITE).map((o) => o.name).sort()).toEqual([
      'Blue A',
      'Red A',
      'White A',
    ]);
    expect(store.listOrbats(ADMIN)).toHaveLength(3);

    store.releaseOrbat(redOrbat.id, ['blue'], RED);
    expect(store.listOrbats(BLUE).map((o) => o.name).sort()).toEqual(['Blue A', 'Red A']);
  });

  test('Blue cannot reach a Red ORBAT or its units via ANY route: 404, not 403', () => {
    const redOrbat = store.createOrbat({ name: 'Red ORBAT' }, RED).orbat;
    const { unitId } = store.addUnit(redOrbat.id, { parentId: null, name: 'HQ' }, RED);

    expectStatus(() => store.getDocument(redOrbat.id, BLUE), 404);
    expectStatus(() => store.updateOrbat(redOrbat.id, { name: 'y' }, BLUE), 404);
    expectStatus(() => store.deleteOrbat(redOrbat.id, BLUE), 404);
    expectStatus(() => store.exportOrbat(redOrbat.id, BLUE), 404);
    expectStatus(
      () => store.addUnit(redOrbat.id, { parentId: null, name: 'z' }, BLUE),
      404,
    );
    expectStatus(() => store.updateUnit(unitId, { name: 'y' }, BLUE), 404);
    expectStatus(() => store.deleteUnit(unitId, BLUE), 404);
    expectStatus(() => store.duplicateUnit(unitId, BLUE), 404);
    expectStatus(() => store.releaseOrbat(redOrbat.id, ['blue'], BLUE), 404);
    expectStatus(() => store.reassignOrbat(redOrbat.id, 'blue', BLUE), 404);
  });

  test('once released to Blue, Blue can see the ORBAT, but release grants read only, not edit (C2b)', () => {
    const redOrbat = store.createOrbat({ name: 'Red ORBAT' }, RED).orbat;
    store.releaseOrbat(redOrbat.id, ['blue'], RED);
    expect(store.getDocument(redOrbat.id, BLUE).orbat.releasable_to).toEqual(['blue']);
    expectStatus(() => store.addUnit(redOrbat.id, { parentId: null, name: 'HQ' }, BLUE), 403);
  });

  test('a released cell can read regardless of role; role gating is the API layer', () => {
    const redOrbat = store.createOrbat({ name: 'Red ORBAT' }, RED).orbat;
    store.releaseOrbat(redOrbat.id, ['blue'], RED);
    expect(store.getDocument(redOrbat.id, BLUE_OBSERVER).orbat.id).toBe(redOrbat.id);
  });

  test('release: a non-owner, non-White user gets 403; the owner cell analyst or White succeeds', () => {
    const blueOrbat = store.createOrbat({ name: 'Blue ORBAT' }, BLUE).orbat;
    store.releaseOrbat(blueOrbat.id, ['red'], BLUE);
    expectStatus(() => store.releaseOrbat(blueOrbat.id, ['white'], RED), 403);
    const released = store.releaseOrbat(blueOrbat.id, ['red'], WHITE);
    expect(released.orbat.releasable_to).toEqual(['red']);
  });

  test('release requires analyst or above within the owning cell', () => {
    const blueOrbat = store.createOrbat({ name: 'Blue ORBAT' }, BLUE).orbat;
    expectStatus(() => store.releaseOrbat(blueOrbat.id, ['red'], BLUE_OBSERVER), 403);
  });

  test('release replaces (not merges) releasable_to, and never includes the owner', () => {
    const blueOrbat = store.createOrbat({ name: 'Blue ORBAT' }, BLUE).orbat;
    store.releaseOrbat(blueOrbat.id, ['red'], BLUE);
    const second = store.releaseOrbat(blueOrbat.id, ['white', 'blue'], BLUE);
    expect(second.orbat.releasable_to).toEqual(['white']);
  });

  test('reassign: White-only; a non-White user, even the owner, gets 403', () => {
    const blueOrbat = store.createOrbat({ name: 'Blue ORBAT' }, BLUE).orbat;
    expectStatus(() => store.reassignOrbat(blueOrbat.id, 'red', BLUE), 403);
    const reassigned = store.reassignOrbat(blueOrbat.id, 'red', WHITE);
    expect(reassigned.orbat.owner_cell).toBe('red');
  });

  test('reassign strips the new owner from releasable_to', () => {
    const blueOrbat = store.createOrbat({ name: 'Blue ORBAT' }, BLUE).orbat;
    store.releaseOrbat(blueOrbat.id, ['red'], BLUE);
    const reassigned = store.reassignOrbat(blueOrbat.id, 'red', WHITE);
    expect(reassigned.orbat.releasable_to).toEqual([]);
  });

  test('an unknown cell is rejected on create, release and reassign', () => {
    expectStatus(() => store.createOrbat({ name: 'x', owner_cell: 'green' }, WHITE), 400);
    const orbat = store.createOrbat({ name: 'y' }, WHITE).orbat;
    expectStatus(() => store.releaseOrbat(orbat.id, ['green'], WHITE), 400);
    expectStatus(() => store.reassignOrbat(orbat.id, 'green', WHITE), 400);
  });

  test('import stamps owner_cell as the importer\'s own cell, not White\'s choice', () => {
    const payload = { format: 'orbat', version: 1, name: 'Imported', units: [] };
    const asBlue = store.importOrbat(payload, BLUE);
    expect(asBlue.orbat.owner_cell).toBe('blue');
    const asWhite = store.importOrbat(payload, WHITE);
    expect(asWhite.orbat.owner_cell).toBe('white');
  });
});

describe('openStore: C2b — release grants read access only, never edit', () => {
  const WHITE = { admin: false, cell: 'white', role: 'game-master' };
  const BLUE = { admin: false, cell: 'blue', role: 'analyst' };
  const RED = { admin: false, cell: 'red', role: 'analyst' };

  function redOrbatReleasedToBlue() {
    const orbat = store.createOrbat({ name: 'Red ORBAT' }, RED).orbat;
    const { unitId } = store.addUnit(orbat.id, { parentId: null, name: 'HQ' }, RED);
    store.releaseOrbat(orbat.id, ['blue'], RED);
    return { orbat, unitId };
  }

  test('Blue gets 403 (not 404) on every mutation of a Red ORBAT released to Blue', () => {
    const { orbat, unitId } = redOrbatReleasedToBlue();

    expectStatus(() => store.updateOrbat(orbat.id, { name: 'y' }, BLUE), 403);
    expectStatus(() => store.deleteOrbat(orbat.id, BLUE), 403);
    expectStatus(() => store.addUnit(orbat.id, { parentId: null, name: 'z' }, BLUE), 403);
    expectStatus(() => store.updateUnit(unitId, { name: 'y' }, BLUE), 403);
    expectStatus(() => store.duplicateUnit(unitId, BLUE), 403);
    expectStatus(() => store.deleteUnit(unitId, BLUE), 403);
  });

  test('Blue still gets 404 (not 403) when the ORBAT is not released at all', () => {
    const orbat = store.createOrbat({ name: 'Red ORBAT' }, RED).orbat;
    const { unitId } = store.addUnit(orbat.id, { parentId: null, name: 'HQ' }, RED);
    expectStatus(() => store.updateOrbat(orbat.id, { name: 'y' }, BLUE), 404);
    expectStatus(() => store.updateUnit(unitId, { name: 'y' }, BLUE), 404);
  });

  test('the owner cell can still fully edit its own ORBAT once released elsewhere', () => {
    const { orbat } = redOrbatReleasedToBlue();
    const updated = store.updateOrbat(orbat.id, { name: 'Renamed by owner' }, RED);
    expect(updated.orbat.name).toBe('Renamed by owner');
  });

  test('White can edit any released ORBAT, same as the owner', () => {
    const { orbat } = redOrbatReleasedToBlue();
    const updated = store.updateOrbat(orbat.id, { name: 'Renamed by White' }, WHITE);
    expect(updated.orbat.name).toBe('Renamed by White');
  });

  test('reads (getDocument, export) still work for the released cell: release is read access', () => {
    const { orbat } = redOrbatReleasedToBlue();
    expect(store.getDocument(orbat.id, BLUE).orbat.id).toBe(orbat.id);
    expect(() => store.exportOrbat(orbat.id, BLUE)).not.toThrow();
  });
});
