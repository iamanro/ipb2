#!/usr/bin/env node
/**
 * Restores state databases from a backup made by `backup.mjs`. Run it with
 * the app STOPPED: it refuses while a database looks open (its `-wal`/`-shm`
 * files exist — a running server keeps them; a clean shutdown removes them).
 *
 *   node server/tools/restore.mjs                      # list backups
 *   node server/tools/restore.mjs <backup> [--only auth,ipb,...] [--yes] [--force]
 *
 * `<backup>` is a folder name under the backup root (`$IPB_BACKUP_ROOT` or
 * `<state root>/../backups`) or a path. Without `--yes` it only prints what
 * it would do. Before overwriting anything it saves the current databases to
 * `<backup root>/pre-restore-<time>/`, so a restore can itself be undone.
 * Every backup file must pass `PRAGMA integrity_check` first, or nothing is
 * touched. Exercise archives missing from the state volume are copied back
 * from `<backup root>/archives/`. `--force` skips the open-database check
 * (only for a state left behind by a crash).
 *
 * In the compose deployment:
 *
 *   docker compose stop app
 *   docker compose --profile backup run --rm --entrypoint node backup server/tools/restore.mjs <backup> --yes
 *   docker compose start app
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { archiveRoot, integrityCheck } from '../dbArchive.js';
import { STATE_DATABASES } from '../stateDatabases.js';

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : (args[index + 1] ?? null);
}

function backupRoot() {
  if (process.env.IPB_BACKUP_ROOT) return process.env.IPB_BACKUP_ROOT;
  const stateRoot = process.env.IPB_STATE_ROOT || path.join(import.meta.dirname, '..', '..', 'modules');
  return path.join(path.dirname(stateRoot), 'backups');
}

function fail(message) {
  console.error(`restore: ${message}`);
  process.exit(1);
}

function listBackups(root) {
  const entries = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d{4}-\d\d-\d\dT/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse()
    : [];
  if (!entries.length) {
    console.log(`No backups in ${root}.`);
    return;
  }
  console.log(`Backups in ${root} (newest first):`);
  for (const name of entries) {
    const files = readdirSync(path.join(root, name)).filter((file) => file.endsWith('.db'));
    console.log(`  ${name}  ${files.join(' ')}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const root = backupRoot();
  const target = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--only');
  if (!target) {
    listBackups(root);
    return;
  }
  const source = path.isAbsolute(target) ? target : path.join(root, target);
  if (!existsSync(source)) fail(`no backup at ${source}. Run without arguments to list backups.`);

  const only = flagValue(args, '--only')?.split(',').map((id) => id.trim()).filter(Boolean);
  const unknown = only?.filter((id) => !STATE_DATABASES.some((database) => database.id === id));
  if (unknown?.length) {
    fail(`unknown database(s): ${unknown.join(', ')}. Known: ${STATE_DATABASES.map((database) => database.id).join(', ')}.`);
  }

  const plan = [];
  for (const database of STATE_DATABASES) {
    if (only && !only.includes(database.id)) continue;
    const from = path.join(source, database.file);
    if (!existsSync(from)) {
      console.log(`  ${database.id}: not in this backup, left as is`);
      continue;
    }
    let check;
    try {
      check = integrityCheck(from);
    } catch (error) {
      check = error.message;
    }
    if (check !== 'ok') fail(`${from} failed its integrity check (${check}); nothing was restored.`);
    plan.push({ database, from });
  }
  if (!plan.length) fail('nothing to restore.');

  if (!args.includes('--force')) {
    const open = plan.filter(({ database }) => database.looksOpen());
    if (open.length) {
      fail(
        `${open.map(({ database }) => database.path).join(', ')} look open (a -wal/-shm file exists). ` +
          'Stop the app first (docker compose stop app). After a crash, --force skips this check.',
      );
    }
  }

  console.log(`Restore from ${source}:`);
  for (const { database, from } of plan) console.log(`  ${database.id}: ${from} -> ${database.path}`);
  if (!args.includes('--yes')) {
    console.log('Dry run. Add --yes to restore.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safety = path.join(root, `pre-restore-${stamp}`);
  mkdirSync(safety, { recursive: true });
  for (const { database } of plan) {
    if (database.copyInto(safety) !== null) console.log(`  saved current ${database.id} to ${safety}`);
  }

  for (const { database, from } of plan) {
    database.replaceFrom(from);
    console.log(`  restored ${database.id}`);
  }

  const mirrored = path.join(root, 'archives');
  if (existsSync(mirrored)) {
    const dest = archiveRoot();
    let copied = 0;
    for (const entry of readdirSync(mirrored, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || existsSync(path.join(dest, entry.name))) continue;
      cpSync(path.join(mirrored, entry.name), path.join(dest, entry.name), { recursive: true });
      copied += 1;
    }
    if (copied) console.log(`  copied back ${copied} exercise archive(s) missing from ${dest}`);
  }
  console.log(`Done. The previous state is in ${safety}. Start the app again.`);
}

main();
