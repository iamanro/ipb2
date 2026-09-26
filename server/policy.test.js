import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { HttpError } from './http.js';
import {
  CELLS,
  canEdit,
  canRelease,
  canSee,
  isWhite,
  liveCellsFor,
  normalizeRelease,
  ownerCellForCreate,
  roleAtLeast,
  visibilitySql,
} from './policy.js';

// -- fixtures --------------------------------------------------------------

const admin = { name: 'root', admin: true, cell: null, role: null };
const adminEffectiveWhite = {
  name: 'root',
  admin: true,
  cell: 'white',
  role: 'game-master',
  effective: true,
};
const whiteGm = { name: 'wendy', admin: false, cell: 'white', role: 'game-master' };
const blueAnalyst = { name: 'bob', admin: false, cell: 'blue', role: 'analyst' };
const blueObserver = { name: 'billie', admin: false, cell: 'blue', role: 'observer' };
const redAnalyst = { name: 'rex', admin: false, cell: 'red', role: 'analyst' };
const redCm = { name: 'rita', admin: false, cell: 'red', role: 'collection-manager' };
const noCell = { name: 'nadia', admin: false, cell: null, role: null };

function item(ownerCell, releasableTo) {
  return { owner_cell: ownerCell, releasable_to: releasableTo };
}

// -- CELLS -------------------------------------------------------------

test('CELLS is white, blue, red', () => {
  expect(CELLS).toEqual(['white', 'blue', 'red']);
});

// -- isWhite -----------------------------------------------------------

test('isWhite: admin flag is always white, regardless of cell', () => {
  expect(isWhite(admin)).toBe(true);
  expect(isWhite(adminEffectiveWhite)).toBe(true);
  expect(isWhite({ name: 'x', admin: true, cell: 'red', role: 'observer' })).toBe(true);
});

test('isWhite: a white-cell non-admin is white; blue/red/no-cell are not', () => {
  expect(isWhite(whiteGm)).toBe(true);
  expect(isWhite(blueAnalyst)).toBe(false);
  expect(isWhite(redAnalyst)).toBe(false);
  expect(isWhite(noCell)).toBe(false);
  expect(isWhite(null)).toBe(false);
  expect(isWhite(undefined)).toBe(false);
});

// -- roleAtLeast (re-tested here since policy.js now owns it) ----------

test('roleAtLeast ranks observer < analyst < collection-manager < game-master < admin', () => {
  expect(roleAtLeast('observer', 'analyst')).toBe(false);
  expect(roleAtLeast('analyst', 'observer')).toBe(true);
  expect(roleAtLeast('admin', 'game-master')).toBe(true);
  expect(roleAtLeast('game-master', 'admin')).toBe(false);
});

// -- canSee: white / blue / red / admin / no-cell, array vs JSON text --

test('canSee: white and admin see every item regardless of owner or release', () => {
  expect(canSee(whiteGm, item('blue', []))).toBe(true);
  expect(canSee(whiteGm, item('red', '[]'))).toBe(true);
  expect(canSee(admin, item('blue', []))).toBe(true);
  expect(canSee(adminEffectiveWhite, item('red', '[]'))).toBe(true);
});

test("canSee: a cell member sees their own cell's items", () => {
  expect(canSee(blueAnalyst, item('blue', []))).toBe(true);
  expect(canSee(redAnalyst, item('red', '[]'))).toBe(true);
});

test("canSee: a cell member does not see another cell's unreleased item", () => {
  expect(canSee(blueAnalyst, item('red', []))).toBe(false);
  expect(canSee(redAnalyst, item('blue', '[]'))).toBe(false);
});

test('canSee: released-to grants visibility, as an array or as JSON text', () => {
  expect(canSee(blueAnalyst, item('red', ['blue']))).toBe(true);
  expect(canSee(blueAnalyst, item('red', '["blue"]'))).toBe(true);
  expect(canSee(redAnalyst, item('blue', ['red', 'white']))).toBe(true);
  expect(canSee(redAnalyst, item('blue', '["red"]'))).toBe(true);
});

test('canSee: released to a different cell does not grant visibility', () => {
  expect(canSee(blueAnalyst, item('red', ['white']))).toBe(false);
  expect(canSee(blueAnalyst, item('red', '["white"]'))).toBe(false);
});

test('canSee: a user with no cell sees nothing cell-owned, even their own former owner_cell of null', () => {
  expect(canSee(noCell, item('blue', []))).toBe(false);
  expect(canSee(noCell, item(null, []))).toBe(false);
});

test('canSee: malformed releasable_to text is treated as empty, not a crash', () => {
  expect(canSee(blueAnalyst, item('red', 'not json'))).toBe(false);
  expect(canSee(blueAnalyst, item('red', null))).toBe(false);
  expect(canSee(blueAnalyst, item('red', undefined))).toBe(false);
});

// -- visibilitySql: white is 1=1; a member's fragment run against a real table --

test('visibilitySql: white and admin get an unconditional 1=1, no params', () => {
  expect(visibilitySql(whiteGm)).toEqual({ sql: '1=1', params: [] });
  expect(visibilitySql(admin)).toEqual({ sql: '1=1', params: [] });
});

test('visibilitySql: a user with no cell gets an unconditional 0=1, no params', () => {
  expect(visibilitySql(noCell)).toEqual({ sql: '0=1', params: [] });
});

function seedTable(db) {
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, owner_cell TEXT, releasable_to TEXT);
  `);
  const insert = db.prepare('INSERT INTO items (id, owner_cell, releasable_to) VALUES (?, ?, ?)');
  insert.run(1, 'white', '[]');
  insert.run(2, 'blue', '[]');
  insert.run(3, 'red', '[]');
  insert.run(4, 'red', '["blue"]');
  insert.run(5, 'blue', '["red","white"]');
  insert.run(6, 'red', '["white"]');
}

test('visibilitySql: a real SQLite query returns exactly the rows a blue member should see', () => {
  const db = new DatabaseSync(':memory:');
  seedTable(db);
  const { sql, params } = visibilitySql(blueAnalyst);
  const rows = db.prepare(`SELECT id FROM items WHERE ${sql} ORDER BY id`).all(...params);
  // blue's own (2, 5), plus red's item released to blue (4) — not white's
  // item (owner white, no membership match), not red's plain item (3), not
  // red's item released only to white (6).
  expect(rows.map((r) => r.id)).toEqual([2, 4, 5]);
  db.close();
});

test('visibilitySql: a real SQLite query returns exactly the rows a red member should see', () => {
  const db = new DatabaseSync(':memory:');
  seedTable(db);
  const { sql, params } = visibilitySql(redAnalyst);
  const rows = db.prepare(`SELECT id FROM items WHERE ${sql} ORDER BY id`).all(...params);
  // red's own (3, 4, 6), plus blue's item released to red (5).
  expect(rows.map((r) => r.id)).toEqual([3, 4, 5, 6]);
  db.close();
});

test('visibilitySql: white sees every row via 1=1', () => {
  const db = new DatabaseSync(':memory:');
  seedTable(db);
  const { sql, params } = visibilitySql(whiteGm);
  const rows = db.prepare(`SELECT id FROM items WHERE ${sql} ORDER BY id`).all(...params);
  expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6]);
  db.close();
});

test('visibilitySql: the alias option prefixes both column references for a joined query', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, owner_cell TEXT, releasable_to TEXT);
    CREATE TABLE children (id INTEGER PRIMARY KEY, item_id INTEGER, note TEXT);
  `);
  db.prepare('INSERT INTO items (id, owner_cell, releasable_to) VALUES (?, ?, ?)').run(
    1,
    'red',
    '["blue"]',
  );
  db.prepare('INSERT INTO items (id, owner_cell, releasable_to) VALUES (?, ?, ?)').run(
    2,
    'red',
    '[]',
  );
  db.prepare('INSERT INTO children (id, item_id, note) VALUES (?, ?, ?)').run(1, 1, 'a');
  db.prepare('INSERT INTO children (id, item_id, note) VALUES (?, ?, ?)').run(2, 2, 'b');
  const { sql, params } = visibilitySql(blueAnalyst, { alias: 'i' });
  const rows = db
    .prepare(
      `SELECT c.id FROM children c JOIN items i ON i.id = c.item_id WHERE ${sql} ORDER BY c.id`,
    )
    .all(...params);
  expect(rows.map((r) => r.id)).toEqual([1]);
  db.close();
});

// -- ownerCellForCreate --------------------------------------------------

test('ownerCellForCreate: white may pick any cell, defaults to white', () => {
  expect(ownerCellForCreate(whiteGm, 'red')).toBe('red');
  expect(ownerCellForCreate(whiteGm, 'blue')).toBe('blue');
  expect(ownerCellForCreate(whiteGm, undefined)).toBe('white');
  expect(ownerCellForCreate(admin, undefined)).toBe('white');
  expect(ownerCellForCreate(admin, 'red')).toBe('red');
});

test('ownerCellForCreate: white requesting an unknown cell is a 400', () => {
  expect(() => ownerCellForCreate(whiteGm, 'purple')).toThrow(HttpError);
  try {
    ownerCellForCreate(whiteGm, 'purple');
    throw new Error('did not throw');
  } catch (error) {
    expect(error.status).toBe(400);
  }
});

test('ownerCellForCreate: a cell member always gets their own cell', () => {
  expect(ownerCellForCreate(blueAnalyst, undefined)).toBe('blue');
  expect(ownerCellForCreate(blueAnalyst, 'blue')).toBe('blue');
  expect(ownerCellForCreate(redAnalyst, undefined)).toBe('red');
});

test('ownerCellForCreate: a cell member requesting a different cell is a 400', () => {
  try {
    ownerCellForCreate(blueAnalyst, 'red');
    throw new Error('did not throw');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
  }
});

test('ownerCellForCreate: a user with no cell gets a 403', () => {
  try {
    ownerCellForCreate(noCell, undefined);
    throw new Error('did not throw');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(403);
  }
});

// -- canRelease -----------------------------------------------------------

test('canRelease: white and admin may always release', () => {
  expect(canRelease(whiteGm, item('blue', []))).toBe(true);
  expect(canRelease(admin, item('red', []))).toBe(true);
});

test('canRelease: an analyst-or-above member of the owning cell may release', () => {
  expect(canRelease(blueAnalyst, item('blue', []))).toBe(true);
  expect(canRelease(redCm, item('red', []))).toBe(true);
});

test('canRelease: an observer of the owning cell may not release', () => {
  expect(canRelease(blueObserver, item('blue', []))).toBe(false);
});

test('canRelease: a member of a different cell may not release', () => {
  expect(canRelease(blueAnalyst, item('red', []))).toBe(false);
});

test('canRelease: a user with no cell may not release', () => {
  expect(canRelease(noCell, item('blue', []))).toBe(false);
});

// -- normalizeRelease -----------------------------------------------------

test('normalizeRelease: drops the owner cell and duplicates, sorts', () => {
  expect(normalizeRelease(['red', 'blue', 'red', 'white'], 'white')).toEqual(['blue', 'red']);
  expect(normalizeRelease(['blue'], 'blue')).toEqual([]);
  expect(normalizeRelease([], 'white')).toEqual([]);
});

test('normalizeRelease: an unknown cell is a 400', () => {
  try {
    normalizeRelease(['purple'], 'white');
    throw new Error('did not throw');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
  }
});

test('normalizeRelease: a non-array is a 400', () => {
  try {
    normalizeRelease('blue', 'white');
    throw new Error('did not throw');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
  }
});

// -- liveCellsFor -----------------------------------------------------------

test('liveCellsFor: owner plus releasable_to, array or JSON text', () => {
  expect(liveCellsFor(item('red', ['blue']))).toEqual(['red', 'blue']);
  expect(liveCellsFor(item('red', '["blue","white"]'))).toEqual(['red', 'blue', 'white']);
  expect(liveCellsFor(item('white', []))).toEqual(['white']);
  expect(liveCellsFor(item('white', '[]'))).toEqual(['white']);
});

test('canEdit: release grants read only; White and the owning cell may change an item', () => {
  const redItem = { owner_cell: 'red', releasable_to: ['blue'] };
  const blue = { name: 'b', cell: 'blue', role: 'game-master' };
  const red = { name: 'r', cell: 'red', role: 'observer' };
  expect(canSee(blue, redItem)).toBe(true);
  expect(canEdit(blue, redItem)).toBe(false);
  expect(canEdit(red, redItem)).toBe(true);
  expect(canEdit({ name: 'w', cell: 'white', role: 'observer' }, redItem)).toBe(true);
  expect(canEdit({ name: 'a', admin: true, cell: null, role: null }, redItem)).toBe(true);
  expect(canEdit({ name: 'n', cell: null, role: null }, redItem)).toBe(false);
});
