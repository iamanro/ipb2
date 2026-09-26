import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openState } from './state.js';
import { declareStateDatabase } from './stateDatabase.js';

let root;
let state;
let connection;
let closed;

/** A store the way a module keeps one: opened lazily, dropped when the declaration closes it. */
function store() {
  connection ??= openState(state.path, ['CREATE TABLE notes (text TEXT)']);
  return connection;
}

const notes = () => store().prepare('SELECT text FROM notes').all().map((row) => row.text);

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'ipb-state-db-'));
  state = declareStateDatabase({ id: 'toy', file: 'toy.db', exercise: true, defaultDir: path.join(root, 'state') });
  connection = undefined;
  closed = 0;
  state.onClose(() => {
    connection?.close();
    connection = undefined;
    closed += 1;
  });
});

afterEach(() => {
  connection?.close();
  rmSync(root, { recursive: true, force: true });
});

test('a copy is a consistent snapshot, taken while the store stays open and writable', () => {
  store().prepare('INSERT INTO notes VALUES (?)').run('before');
  expect(state.copyInto(root)).toBeGreaterThan(0);
  store().prepare('INSERT INTO notes VALUES (?)').run('after');
  expect(notes()).toEqual(['before', 'after']);
  expect(closed).toBe(0);
});

test('an empty database copies as nothing', () => {
  expect(state.exists()).toBe(false);
  expect(state.copyInto(root)).toBeNull();
});

test('emptying closes the open store, removes every file, and the store reopens empty', () => {
  store().prepare('INSERT INTO notes VALUES (?)').run('gone');
  expect(state.looksOpen()).toBe(true);
  state.empty();
  expect(closed).toBe(1);
  expect(state.exists()).toBe(false);
  expect(state.looksOpen()).toBe(false);
  expect(notes()).toEqual([]);
});

test('replacing swaps in the copied file, and the store reads it on its next use', () => {
  store().prepare('INSERT INTO notes VALUES (?)').run('archived');
  state.copyInto(root);
  store().prepare('INSERT INTO notes VALUES (?)').run('later');
  state.replaceFrom(path.join(root, 'toy.db'));
  expect(closed).toBe(1);
  expect(notes()).toEqual(['archived']);
});

test('a damaged file is refused before the open store is touched', () => {
  store().prepare('INSERT INTO notes VALUES (?)').run('kept');
  const damaged = path.join(root, 'damaged.db');
  writeFileSync(damaged, 'not a database');
  expect(() => state.replaceFrom(damaged)).toThrow(/integrity check/);
  expect(closed).toBe(0);
  expect(notes()).toEqual(['kept']);
});

test('the path follows IPB_STATE_ROOT at the time of use, not at import', () => {
  const previous = process.env.IPB_STATE_ROOT;
  process.env.IPB_STATE_ROOT = path.join(root, 'elsewhere');
  try {
    expect(state.path).toBe(path.join(root, 'elsewhere', 'toy', 'toy.db'));
  } finally {
    if (previous === undefined) delete process.env.IPB_STATE_ROOT;
    else process.env.IPB_STATE_ROOT = previous;
  }
});
