import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, expect, test } from 'vitest';

const TOOLS = import.meta.dirname;

let root;
let env;

function run(tool, args = []) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [path.join(TOOLS, tool), ...args], {
        env,
        encoding: 'utf8',
      }),
    };
  } catch (error) {
    return { code: error.status, out: `${error.stdout}${error.stderr}` };
  }
}

/** A state database with one `notes` row, the way a module's store leaves it after a clean close. */
function writeState(id, file, text) {
  const dir = path.join(root, 'state', id);
  mkdirSync(dir, { recursive: true });
  const database = new DatabaseSync(path.join(dir, file));
  database.exec('CREATE TABLE IF NOT EXISTS notes (text TEXT); DELETE FROM notes;');
  database.prepare('INSERT INTO notes VALUES (?)').run(text);
  database.close();
}

function readState(id, file) {
  const database = new DatabaseSync(path.join(root, 'state', id, file), { readOnly: true });
  try {
    return database.prepare('SELECT text FROM notes').get().text;
  } finally {
    database.close();
  }
}

function backups() {
  return readdirSync(path.join(root, 'backups')).filter((name) => /^\d{4}-/.test(name));
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'ipb-restore-test-'));
  env = {
    ...process.env,
    IPB_STATE_ROOT: path.join(root, 'state'),
    IPB_BACKUP_ROOT: path.join(root, 'backups'),
  };
  writeState('auth', 'auth.db', 'users v1');
  writeState('ipb', 'ipb.db', 'studies v1');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('a backup restores the databases it holds and keeps the replaced state to undo with', () => {
  expect(run('backup.mjs').code).toBe(0);
  const [backup] = backups();
  writeState('auth', 'auth.db', 'users v2');
  writeState('ipb', 'ipb.db', 'studies v2');

  const dry = run('restore.mjs', [backup]);
  expect(dry.out).toContain('Dry run');
  expect(readState('ipb', 'ipb.db')).toBe('studies v2');

  const restored = run('restore.mjs', [backup, '--yes']);
  expect(restored.code).toBe(0);
  expect(readState('auth', 'auth.db')).toBe('users v1');
  expect(readState('ipb', 'ipb.db')).toBe('studies v1');

  // The state it replaced is kept, and is itself restorable.
  const safety = readdirSync(path.join(root, 'backups')).find((name) =>
    name.startsWith('pre-restore-'),
  );
  expect(run('restore.mjs', [safety, '--yes']).code).toBe(0);
  expect(readState('ipb', 'ipb.db')).toBe('studies v2');
});

test('--only restores just the named databases', () => {
  run('backup.mjs');
  const [backup] = backups();
  writeState('auth', 'auth.db', 'users v2');
  writeState('ipb', 'ipb.db', 'studies v2');
  expect(run('restore.mjs', [backup, '--only', 'ipb', '--yes']).code).toBe(0);
  expect(readState('ipb', 'ipb.db')).toBe('studies v1');
  expect(readState('auth', 'auth.db')).toBe('users v2');
  expect(run('restore.mjs', [backup, '--only', 'nope']).code).toBe(1);
});

test('refuses while a database is open (a running app), unless --force', () => {
  run('backup.mjs');
  const [backup] = backups();
  writeFileSync(path.join(root, 'state', 'ipb', 'ipb.db-shm'), '');
  const refused = run('restore.mjs', [backup, '--yes']);
  expect(refused.code).toBe(1);
  expect(refused.out).toMatch(/Stop the app first/);
  expect(run('restore.mjs', [backup, '--yes', '--force']).code).toBe(0);
});

test('a damaged backup file stops the whole restore before anything is touched', () => {
  run('backup.mjs');
  const [backup] = backups();
  writeState('auth', 'auth.db', 'users v2');
  writeFileSync(path.join(root, 'backups', backup, 'ipb.db'), 'not a database');
  const result = run('restore.mjs', [backup, '--yes']);
  expect(result.code).not.toBe(0);
  expect(readState('auth', 'auth.db')).toBe('users v2');
});

test('exercise archives are mirrored into backups and come back when the state volume lost them', () => {
  const archive = path.join(root, 'state', 'archives', '2026-01-01T00-00-00-000Z-exercise-1');
  mkdirSync(archive, { recursive: true });
  writeFileSync(path.join(archive, 'meta.json'), '{"name":"Exercise 1"}');
  run('backup.mjs');
  expect(
    existsSync(path.join(root, 'backups', 'archives', path.basename(archive), 'meta.json')),
  ).toBe(true);

  rmSync(path.join(root, 'state', 'archives'), { recursive: true });
  const [backup] = backups();
  expect(run('restore.mjs', [backup, '--yes']).code).toBe(0);
  expect(existsSync(path.join(archive, 'meta.json'))).toBe(true);
});
