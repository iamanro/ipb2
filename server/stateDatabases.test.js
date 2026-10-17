import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { STATE_DATABASES } from './stateDatabases.ts';

const ROOT = path.join(import.meta.dirname, '..');

test('every module that declares a state database is backed up, archived and restored', () => {
  const declared = readdirSync(path.join(ROOT, 'modules')).filter((id) =>
    existsSync(path.join(ROOT, 'modules', id, 'server', 'state.ts')),
  );
  const registered = STATE_DATABASES.map((database) => database.id);
  for (const id of declared) expect(registered).toContain(id);
  expect(new Set(registered).size).toBe(registered.length);
  expect(new Set(STATE_DATABASES.map((database) => database.path)).size).toBe(registered.length);
});

test('backup and restore load the database list without any route code', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'ipb-no-routes-'));
  try {
    // A preloaded plugin that fails the process the moment any module's routes.ts loads.
    const guard = path.join(scratch, 'guard.ts');
    writeFileSync(
      guard,
      `Bun.plugin({
        name: 'no-routes',
        setup(build) {
          build.onLoad({ filter: /\\/server\\/routes\\.ts$/ }, ({ path }) => {
            throw new Error('route code loaded: ' + path);
          });
        },
      });`,
    );
    const env = {
      ...process.env,
      IPB_STATE_ROOT: path.join(scratch, 'state'),
      IPB_BACKUP_ROOT: path.join(scratch, 'backups'),
    };
    for (const tool of ['backup.mjs', 'restore.mjs']) {
      const output = execFileSync(
        process.execPath,
        ['--preload', guard, path.join(ROOT, 'server', 'tools', tool)],
        {
          env,
          encoding: 'utf8',
        },
      );
      expect(output).toMatch(/Nothing to back up|No backups/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
