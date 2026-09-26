import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(import.meta.dirname, '..');

/**
 * Every state database the app writes, as `{ id, defaultDir, file }`
 * (`stateDirectory(id, defaultDir)` resolves the directory). One list for
 * backup, restore and the exercise lifecycle, so a new database can't be
 * silently skipped by one of them. `exercise: true` marks the databases
 * that belong to the current exercise (archived/reset/restored together);
 * auth and equipment bookmarks outlive any one exercise.
 */
export const STATE_DATABASES = [
  { id: 'auth', defaultDir: path.join(ROOT, 'server', 'state'), file: 'auth.db', exercise: false },
  { id: 'ipb', defaultDir: path.join(ROOT, 'modules', 'ipb', 'state'), file: 'ipb.db', exercise: true },
  { id: 'exercise', defaultDir: path.join(ROOT, 'modules', 'exercise', 'state'), file: 'exercise.db', exercise: true },
  { id: 'orbat', defaultDir: path.join(ROOT, 'modules', 'orbat', 'state'), file: 'orbat.db', exercise: true },
  { id: 'equipment', defaultDir: path.join(ROOT, 'modules', 'equipment', 'state'), file: 'bookmarks.db', exercise: false },
];

/** Where exercise archives live: `$IPB_STATE_ROOT/archives`, or `modules/archives` in a checkout. */
export function archiveRoot() {
  const stateRoot = process.env.IPB_STATE_ROOT || path.join(ROOT, 'modules');
  return path.join(stateRoot, 'archives');
}

/** `PRAGMA integrity_check` on a database file, read-only: 'ok' or the first problems found. */
export function integrityCheck(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = database.prepare('PRAGMA integrity_check').all();
    return rows.map((row) => Object.values(row)[0]).join('; ');
  } finally {
    database.close();
  }
}

/**
 * A consistent, checkpoint-safe copy of the SQLite database at `source`
 * into `dest` via `VACUUM INTO`: safe against a live writer (a brief read
 * lock at the WAL checkpoint, never a long one) — it never blocks writers
 * for the whole copy. Shared by `server/tools/backup.mjs`'s dated backups
 * and `server/exerciseLifecycle.js`'s archive step, so there is one
 * implementation of "copy a database file safely", not two silently
 * drifting apart.
 */
export function vacuumInto(source, dest) {
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    database.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    database.close();
  }
}
