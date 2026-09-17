import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Writable module state. Reference data lives in `modules/<id>/data/*.db` and is
 * rebuilt by the module tools; state lives in `modules/<id>/state/*.db` and is
 * the user's work, so the two never share a file or a lifetime.
 *
 * `migrations` is an ordered array of SQL strings. `PRAGMA user_version` records
 * how many have run, so opening an existing database only applies the new ones.
 */
export function openState(file, migrations) {
  mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  const applied = database.prepare('PRAGMA user_version').get().user_version;
  if (applied > migrations.length) {
    database.close();
    throw new Error(`${file} was written by a newer schema (${applied}).`);
  }
  for (let index = applied; index < migrations.length; index += 1) {
    transact(database, () => {
      database.exec(migrations[index]);
      database.exec(`PRAGMA user_version = ${index + 1}`);
    });
  }
  return database;
}

/** Run `work` in one transaction. Rolls back on any throw. */
export function transact(database, work) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The transaction already ended; the original error is what matters.
    }
    throw error;
  }
}
