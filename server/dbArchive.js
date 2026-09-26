import { DatabaseSync } from 'node:sqlite';

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
