import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';

import type { Json, JsonObject } from './http.ts';

/** A SQLite row as `node:sqlite` returns it; read columns with the readers below. */
export type Row = Record<string, SQLOutputValue>;

export type Migration =
  | string
  | { sql: string; rebuild: true }
  | { run(database: DatabaseSync): void };

/**
 * A module's state directory: `modules/<id>/state` normally, or
 * `$IPB_STATE_ROOT/<id>` when set, so end-to-end tests run against a
 * throwaway copy and never touch the analyst's own studies.
 */
export function stateDirectory(moduleId: string, defaultDirectory: string) {
  const root = process.env.IPB_STATE_ROOT;
  return root ? path.join(root, moduleId) : defaultDirectory;
}

/**
 * A module's reference-data directory: `modules/<id>/data` normally, or
 * `$IPB_DATA_ROOT/<id>` when set, so a container mounts one data volume
 * (read-only for the server, writable for the build tools) instead of one
 * per module inside the code tree.
 */
export function dataDirectory(moduleId: string, defaultDirectory: string) {
  const root = process.env.IPB_DATA_ROOT;
  return root ? path.join(root, moduleId) : defaultDirectory;
}

/**
 * Writable module state. Reference data lives in `modules/<id>/data/*.db` and is
 * rebuilt by the module tools; state lives in `modules/<id>/state/*.db` and is
 * the user's work, so the two never share a file or a lifetime.
 *
 * `migrations` is an ordered array; `PRAGMA user_version` records how many have
 * run, so opening an existing database only applies the new ones. Each entry is
 * one of:
 * - a plain SQL string, run in a transaction (unchanged behaviour);
 * - `{ sql, rebuild: true }`, a table rebuild for schema changes SQLite can't do
 *   in place (widening a CHECK, dropping/renaming a constrained column). `sql`
 *   is the author's own `CREATE new_X` / `INSERT INTO new_X SELECT …` / `DROP
 *   TABLE X` / `ALTER TABLE new_X RENAME TO X` / index-recreation script — the
 *   parts of SQLite's 12-step ALTER procedure specific to the change. This
 *   function supplies the rest: foreign keys go off *outside* the transaction
 *   (SQLite ignores the pragma inside one), the script runs, `PRAGMA
 *   foreign_key_check` must come back empty or the transaction rolls back
 *   (leaving `user_version` unchanged), then foreign keys go back on;
 * - `{ run(database) }`, a JS-driven migration (e.g. reparsing a column's text
 *   into new columns before dropping it), executed inside one transaction.
 */
export function openState(file: string, migrations: Migration[]): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  const applied = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (applied > migrations.length) {
    database.close();
    throw new Error(`${file} was written by a newer schema (${applied}).`);
  }
  for (let index = applied; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (typeof migration === 'object' && 'rebuild' in migration) {
      runRebuildMigration(database, migration, index);
    } else if (typeof migration === 'object') {
      transact(database, () => {
        migration.run(database);
        database.exec(`PRAGMA user_version = ${index + 1}`);
      });
    } else {
      transact(database, () => {
        database.exec(migration);
        database.exec(`PRAGMA user_version = ${index + 1}`);
      });
    }
  }
  return database;
}

/**
 * SQLite's 12-step ALTER procedure: foreign keys off outside the transaction,
 * the rebuild script, a foreign-key check that must be clean, foreign keys
 * back on. `migration.sql` does the create-copy-drop-rename part; ids are
 * preserved because that script copies them, so any other table's foreign key
 * into the rebuilt table survives untouched.
 */
function runRebuildMigration(
  database: DatabaseSync,
  migration: { sql: string; rebuild: true },
  index: number,
) {
  database.exec('PRAGMA foreign_keys = OFF');
  try {
    transact(database, () => {
      database.exec(migration.sql);
      const violations = database.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) {
        throw new Error(
          `Rebuild migration ${index + 1} left ${violations.length} foreign key ` +
            `violation(s): ${JSON.stringify(violations)}`,
        );
      }
      database.exec(`PRAGMA user_version = ${index + 1}`);
    });
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}

// Column readers: a row's value with its real type, or an error naming the
// column when the schema and the code disagree (caught at the read, not later).
function columnError(column: string, expected: string, value: SQLOutputValue | undefined) {
  return new Error(`Column ${column}: expected ${expected}, got ${typeof value}.`);
}

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw columnError(column, 'text', value);
  return value;
}

export function textOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw columnError(column, 'text or NULL', value);
  return value;
}

/** An INTEGER or REAL column (node:sqlite returns both as JS numbers). */
export function num(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') throw columnError(column, 'a number', value);
  return value;
}

export function numOrNull(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') throw columnError(column, 'a number or NULL', value);
  return value;
}

/** A 0/1 INTEGER flag column. */
export function flag(row: Row, column: string): boolean {
  return num(row, column) !== 0;
}

/** A BLOB column. */
export function blob(row: Row, column: string): Uint8Array {
  const value = row[column];
  if (!(value instanceof Uint8Array)) throw columnError(column, 'a blob', value);
  return value;
}

/** A TEXT column holding JSON (as the stores write it), parsed. */
export function json(row: Row, column: string): Json {
  const parsed: Json = JSON.parse(text(row, column));
  return parsed;
}

/** A nullable TEXT column holding JSON: null when NULL. */
export function jsonOrNull(row: Row, column: string): Json {
  const raw = textOrNull(row, column);
  if (raw === null) return null;
  const parsed: Json = JSON.parse(raw);
  return parsed;
}

/** One SQLite value as JSON: integers stay numbers, a blob becomes base64 text. */
export function scalarJson(value: SQLOutputValue | undefined): Json {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}

/** A row passed through to a response as-is (reference data shown verbatim). */
export function rowJson(row: Row): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(row)) out[key] = scalarJson(value);
  return out;
}

/** The `n` of a `SELECT COUNT(*) AS n …` query, as a number. */
export function countRows(database: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return Number(database.prepare(sql).get(...params)?.n ?? 0);
}

/** Run `work` in one transaction. Rolls back on any throw. */
export function transact<T>(database: DatabaseSync, work: () => T): T {
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
