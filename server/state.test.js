import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openState } from './state.js';

function tempFile() {
  return path.join(
    os.tmpdir(),
    `state-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function removeDatabaseFiles(file) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
}

let file;

beforeEach(() => {
  file = tempFile();
});

afterEach(() => {
  removeDatabaseFiles(file);
});

const BASE = [
  `
  CREATE TABLE parent (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('a', 'b'))
  );
  CREATE TABLE child (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES parent(id) ON DELETE SET NULL,
    note TEXT
  );
  `,
];

test('a plain SQL migration still runs once, tracked by user_version', () => {
  const database = openState(file, BASE);
  expect(database.prepare('PRAGMA user_version').get().user_version).toBe(1);
  database.exec("INSERT INTO parent (id, status) VALUES (1, 'a')");
  database.close();

  // Reopening with the same list must not re-run it (no duplicate table error).
  const reopened = openState(file, BASE);
  expect(reopened.prepare('SELECT * FROM parent').all()).toHaveLength(1);
  reopened.close();
});

test('a rebuild that widens a CHECK keeps row ids and the child FK intact', () => {
  let database = openState(file, BASE);
  database.exec("INSERT INTO parent (id, status) VALUES (1, 'a'), (2, 'b')");
  database.exec("INSERT INTO child (id, parent_id, note) VALUES (10, 1, 'x'), (11, 2, 'y')");
  database.close();

  const widened = [
    ...BASE,
    {
      rebuild: true,
      sql: `
        CREATE TABLE new_parent (
          id INTEGER PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('a', 'b', 'c'))
        );
        INSERT INTO new_parent (id, status) SELECT id, status FROM parent;
        DROP TABLE parent;
        ALTER TABLE new_parent RENAME TO parent;
      `,
    },
  ];
  database = openState(file, widened);
  expect(database.prepare('PRAGMA user_version').get().user_version).toBe(2);
  // The widened CHECK now accepts 'c'.
  database.exec("INSERT INTO parent (id, status) VALUES (3, 'c')");
  // Ids and the child's FK survived the rebuild untouched.
  expect(database.prepare('SELECT id, status FROM parent ORDER BY id').all()).toEqual([
    { id: 1, status: 'a' },
    { id: 2, status: 'b' },
    { id: 3, status: 'c' },
  ]);
  expect(database.prepare('SELECT id, parent_id FROM child ORDER BY id').all()).toEqual([
    { id: 10, parent_id: 1 },
    { id: 11, parent_id: 2 },
  ]);
  database.close();
});

test('a rebuild that would break a foreign key throws and leaves user_version unchanged', () => {
  let database = openState(file, BASE);
  database.exec("INSERT INTO parent (id, status) VALUES (1, 'a'), (2, 'b')");
  database.exec('INSERT INTO child (id, parent_id) VALUES (10, 1), (11, 2)');
  database.close();

  const broken = [
    ...BASE,
    {
      rebuild: true,
      // Drops row id=2 from the rebuilt table, orphaning child id=11.
      sql: `
        CREATE TABLE new_parent (
          id INTEGER PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('a', 'b', 'c'))
        );
        INSERT INTO new_parent (id, status) SELECT id, status FROM parent WHERE id = 1;
        DROP TABLE parent;
        ALTER TABLE new_parent RENAME TO parent;
      `,
    },
  ];
  expect(() => openState(file, broken)).toThrow(/foreign key/i);

  // Foreign keys must be back on, and the failed migration must not be recorded.
  database = openState(file, BASE);
  expect(database.prepare('PRAGMA user_version').get().user_version).toBe(1);
  expect(database.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
  expect(database.prepare('SELECT id, status FROM parent ORDER BY id').all()).toEqual([
    { id: 1, status: 'a' },
    { id: 2, status: 'b' },
  ]);
  database.close();
});

test('a { run } migration executes JS inside the transaction and is tracked once', () => {
  let database = openState(file, BASE);
  database.exec("INSERT INTO parent (id, status) VALUES (1, 'a')");
  database.exec("INSERT INTO child (id, parent_id, note) VALUES (10, 1, 'loose text: keep me')");
  database.close();

  let runs = 0;
  const withRun = [
    ...BASE,
    {
      run(db) {
        runs += 1;
        db.exec('ALTER TABLE child ADD COLUMN parsed_note TEXT');
        for (const row of db.prepare('SELECT id, note FROM child').all()) {
          db.prepare('UPDATE child SET parsed_note = ? WHERE id = ?').run(
            row.note.toUpperCase(),
            row.id,
          );
        }
      },
    },
  ];
  database = openState(file, withRun);
  expect(database.prepare('PRAGMA user_version').get().user_version).toBe(2);
  expect(database.prepare('SELECT parsed_note FROM child WHERE id = 10').get().parsed_note).toBe(
    'LOOSE TEXT: KEEP ME',
  );
  database.close();

  // Reopening must not re-run it.
  database = openState(file, withRun);
  expect(runs).toBe(1);
  database.close();
});
