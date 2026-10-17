import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(import.meta.dirname, '..');

/** Where exercise archives live: `$IPB_STATE_ROOT/archives`, or `modules/archives` in a checkout. */
export function archiveRoot() {
  const stateRoot = process.env.IPB_STATE_ROOT || path.join(ROOT, 'modules');
  return path.join(stateRoot, 'archives');
}

/** `PRAGMA integrity_check` on a database file, read-only: 'ok' or the first problems found. */
export function integrityCheck(file: string): string {
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
 * for the whole copy. Used through `server/stateDatabase.ts` (`copyInto`) for dated backups
 * and `server/exerciseLifecycle.ts`'s archive step, so there is one
 * implementation of "copy a database file safely", not two silently
 * drifting apart.
 */
export function vacuumInto(source: string, dest: string) {
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    database.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    database.close();
  }
}
