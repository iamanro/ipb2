#!/usr/bin/env node
/**
 * Consistent online backup of every state database into a dated folder,
 * with rotation. Safe to run against a live server: `VACUUM INTO` takes a
 * read lock and streams a compacted, checkpoint-consistent copy — it never
 * blocks writers for the whole backup, only briefly at the WAL checkpoint.
 *
 *   node server/tools/backup.mjs [--out <dir>] [--keep <n>]
 *
 * `--out` defaults to `$IPB_BACKUP_ROOT` or `<state root>/../backups`.
 * `--keep` defaults to `$IPB_BACKUP_KEEP` or 14. Inside the app container:
 *
 *   docker compose exec app node server/tools/backup.mjs
 *
 * Restore: stop the app, copy the wanted dated folder's `*.db` files back
 * to their original paths under the state root (same file names — each
 * backup preserves them), then start the app again. Each file is a
 * complete, self-consistent SQLite database; there is no cross-database
 * transaction to restore, so partial restores (e.g. only `auth.db`) are
 * safe too.
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { vacuumInto } from '../dbArchive.js';
import { stateDirectory } from '../state.js';

/** `{ moduleId, defaultStateDir, file }` for every state database the app
 * opens (see `server/state.js`'s doc: reference data in `data/`, state in
 * `state/`, never the same file). Kept as a flat list here, not derived by
 * scanning `modules/`, so a backup never silently skips a new module's
 * database if that module fails to load for an unrelated reason. */
const DATABASES = [
  { moduleId: 'auth', defaultDir: path.join(import.meta.dirname, '..', 'state'), file: 'auth.db' },
  { moduleId: 'ipb', defaultDir: path.join(import.meta.dirname, '..', '..', 'modules', 'ipb', 'state'), file: 'ipb.db' },
  { moduleId: 'exercise', defaultDir: path.join(import.meta.dirname, '..', '..', 'modules', 'exercise', 'state'), file: 'exercise.db' },
  { moduleId: 'orbat', defaultDir: path.join(import.meta.dirname, '..', '..', 'modules', 'orbat', 'state'), file: 'orbat.db' },
  { moduleId: 'equipment', defaultDir: path.join(import.meta.dirname, '..', '..', 'modules', 'equipment', 'state'), file: 'bookmarks.db' },
];

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : (args[index + 1] ?? null);
}

function dtgStamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function backupRoot(args) {
  const explicit = flagValue(args, '--out') || process.env.IPB_BACKUP_ROOT;
  if (explicit) return explicit;
  const stateRoot = process.env.IPB_STATE_ROOT || path.join(import.meta.dirname, '..', '..', 'modules');
  return path.join(path.dirname(stateRoot), 'backups');
}

function keepCount(args) {
  const explicit = flagValue(args, '--keep') || process.env.IPB_BACKUP_KEEP;
  const parsed = Number.parseInt(explicit ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
}

function backupOne({ moduleId, defaultDir, file }, destDir) {
  const source = path.join(stateDirectory(moduleId, defaultDir), file);
  let stats;
  try {
    stats = statSync(source);
  } catch {
    console.log(`  skip ${moduleId}/${file}: not present`);
    return null;
  }
  const dest = path.join(destDir, file);
  vacuumInto(source, dest);
  const destStats = statSync(dest);
  console.log(`  ${moduleId}/${file}: ${(stats.size / 1024).toFixed(0)} KiB -> ${(destStats.size / 1024).toFixed(0)} KiB`);
  return dest;
}

function rotate(root, keep) {
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d\d-\d\dT/.test(entry.name))
    .sort((a, b) => (a.name < b.name ? 1 : -1)); // newest first
  for (const stale of entries.slice(keep)) {
    rmSync(path.join(root, stale.name), { recursive: true, force: true });
    console.log(`  rotated out ${stale.name}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const root = backupRoot(args);
  const keep = keepCount(args);
  const stamp = dtgStamp(new Date());
  const destDir = path.join(root, stamp);
  mkdirSync(destDir, { recursive: true });

  console.log(`Backing up state databases into ${destDir}`);
  let copied = 0;
  for (const entry of DATABASES) {
    if (backupOne(entry, destDir)) copied += 1;
  }
  if (copied === 0) {
    rmSync(destDir, { recursive: true, force: true });
    console.log('Nothing to back up (no state databases present yet).');
    return;
  }
  console.log(`Rotating: keeping the newest ${keep} backup(s) in ${root}`);
  rotate(root, keep);
  console.log('Done.');
}

main();
