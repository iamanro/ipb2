import { renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { referenceFile } from './reference.ts';

let file;
let reference;

/** Build a one-value database the way the build tools do: beside, then renamed over. */
function build(value) {
  const temporary = `${file}.tmp`;
  rmSync(temporary, { force: true });
  const database = new DatabaseSync(temporary);
  database.exec(`CREATE TABLE meta (value TEXT); INSERT INTO meta VALUES ('${value}')`);
  database.close();
  renameSync(temporary, file);
}

const read = () => reference.get()?.prepare('SELECT value FROM meta').get().value ?? null;

beforeEach(() => {
  file = path.join(
    os.tmpdir(),
    `reference-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
  );
  reference = referenceFile(file, (name) => new DatabaseSync(name, { readOnly: true }));
});

afterEach(() => {
  reference.close();
  rmSync(file, { force: true });
});

test('is null until the file exists, then opens it', () => {
  expect(read()).toBeNull();
  build('first');
  expect(read()).toBe('first');
});

test('a rebuilt file replaces the open handle without a restart', () => {
  build('first');
  expect(read()).toBe('first');
  build('second');
  expect(read()).toBe('second');
});

test('a deleted file reads as missing again', () => {
  build('first');
  expect(read()).toBe('first');
  rmSync(file);
  expect(read()).toBeNull();
});

test('an array of files: open receives every path, and null until the first (required) one exists', () => {
  const second = path.join(os.tmpdir(), `reference-test-second-${process.pid}.db`);
  const seenPaths = [];
  const reference2 = referenceFile([file, second], (paths) => {
    seenPaths.push(paths);
    return { close() {} };
  });
  try {
    expect(reference2.get()).toBeNull(); // required first file missing
    build('first');
    expect(reference2.get()).not.toBeNull();
    expect(seenPaths.at(-1)).toEqual([file, second]);
  } finally {
    reference2.close();
    rmSync(second, { force: true });
  }
});

test('an array of files: a change to any of them, including an optional one appearing, reopens', () => {
  const second = path.join(os.tmpdir(), `reference-test-second-${process.pid}.db`);
  rmSync(second, { force: true });
  let opens = 0;
  const reference2 = referenceFile([file, second], () => {
    opens += 1;
    return { close() {} };
  });
  try {
    build('first');
    reference2.get();
    expect(opens).toBe(1);
    reference2.get(); // unchanged: no reopen
    expect(opens).toBe(1);

    // The optional second file appearing is a change even though the first
    // file (and its identity) did not move.
    const database = new DatabaseSync(second);
    database.exec("CREATE TABLE meta (value TEXT); INSERT INTO meta VALUES ('detail')");
    database.close();
    reference2.get();
    expect(opens).toBe(2);

    // Rebuilding the optional file alone also reopens.
    const rebuilt = new DatabaseSync(second);
    rebuilt.exec("INSERT INTO meta VALUES ('detail-2')");
    rebuilt.close();
    reference2.get();
    expect(opens).toBe(3);
  } finally {
    reference2.close();
    rmSync(second, { force: true });
  }
});
