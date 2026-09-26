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
 * Exercise archives (`$IPB_STATE_ROOT/archives/*`, written by Admin →
 * Exercise → Archive/Reset) are immutable once written, so they're mirrored
 * into `<backup root>/archives/` (new ones only) and never rotated: losing
 * the state volume must not lose past exercises.
 *
 * Restore with `server/tools/restore.mjs` (app stopped).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { STATE_DATABASES, archiveRoot, vacuumInto } from '../dbArchive.js';
import { stateDirectory } from '../state.js';

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

function backupOne({ id: moduleId, defaultDir, file }, destDir) {
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

/** Copies exercise archives not yet in `<root>/archives`; returns how many. */
function mirrorArchives(root) {
  const source = archiveRoot();
  if (!existsSync(source)) return 0;
  const dest = path.join(root, 'archives');
  let copied = 0;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || existsSync(path.join(dest, entry.name))) continue;
    // Copy under a temporary name first, so an interrupted copy is never mistaken for a complete archive.
    const partial = path.join(dest, `.partial-${entry.name}`);
    rmSync(partial, { recursive: true, force: true });
    cpSync(path.join(source, entry.name), partial, { recursive: true });
    renameSync(partial, path.join(dest, entry.name));
    copied += 1;
  }
  return copied;
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
  for (const entry of STATE_DATABASES) {
    if (backupOne(entry, destDir)) copied += 1;
  }
  if (copied === 0) {
    rmSync(destDir, { recursive: true, force: true });
    console.log('Nothing to back up (no state databases present yet).');
    return;
  }
  console.log(`Rotating: keeping the newest ${keep} backup(s) in ${root}`);
  rotate(root, keep);
  const archives = mirrorArchives(root);
  if (archives) console.log(`  mirrored ${archives} new exercise archive(s) into ${path.join(root, 'archives')}`);
  console.log('Done.');
}

main();
