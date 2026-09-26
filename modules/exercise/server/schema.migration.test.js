import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

import { openState } from '../../../server/state.js';
import { MIGRATIONS } from './schema.js';

const REAL_DB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state', 'exercise.db');

let tmpDir;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

function tableCounts(database, tables) {
  return Object.fromEntries(tables.map((table) => [table, database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
}

describe('evidence_links/indicators requirement_id migration, on a copy of the real state db', () => {
  test('never touches the real file: runs against a copy only', () => {
    expect(existsSync(REAL_DB)).toBe(true);
  });

  test('preserves every row count and backfills requirement_id correctly', () => {
    if (!existsSync(REAL_DB)) return; // no real state db in this checkout (fresh clone) — nothing to prove against
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'exercise-migration-real-'));
    const copy = path.join(tmpDir, 'exercise.db');
    copyFileSync(REAL_DB, copy);

    const before = new DatabaseSync(copy, { readOnly: true });
    const tables = ['requirements', 'sirs', 'indicators', 'evidence_links', 'reports', 'rfis', 'tracks', 'collectors', 'taskings', 'intsums'];
    const beforeCounts = tableCounts(before, tables);
    before.close();

    const database = openState(copy, MIGRATIONS);
    const afterCounts = tableCounts(database, tables);
    expect(afterCounts).toEqual(beforeCounts);

    // Every indicator's requirement_id matches its SIR's own requirement_id.
    const mismatchedIndicators = database
      .prepare('SELECT COUNT(*) AS n FROM indicators i JOIN sirs s ON s.id = i.sir_id WHERE i.requirement_id IS NOT s.requirement_id')
      .get().n;
    expect(mismatchedIndicators).toBe(0);

    // Every evidence link's requirement_id resolves: directly for a
    // requirement-kind target, via the SIR for a sir-kind one.
    const mismatchedLinks = database
      .prepare(
        `SELECT COUNT(*) AS n FROM evidence_links el
         WHERE (el.target_kind = 'requirement' AND el.requirement_id IS NOT el.target_id)
            OR (el.target_kind = 'sir' AND el.requirement_id IS NOT (SELECT s.requirement_id FROM sirs s WHERE s.id = el.target_id))`,
      )
      .get().n;
    expect(mismatchedLinks).toBe(0);

    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    database.close();
  });
});

describe('evidence_links rebuild: orphan handling, re-parenting, and the dropped report_id cascade', () => {
  function seedPreMigrationDatabase(file) {
    // Every migration except the two new ones (evidence_links rebuild +
    // indicators.requirement_id), so this seeds pre-migration shape.
    const database = openState(file, MIGRATIONS.slice(0, MIGRATIONS.length - 2));
    const now = new Date().toISOString();
    database.exec(`
      INSERT INTO requirements (id, kind, text, priority, owner_cell, releasable_to, created_at, updated_at)
        VALUES (1, 'PIR', 'R1', 0, 'white', '[]', '${now}', '${now}');
      INSERT INTO sirs (id, requirement_id, text, created_at, updated_at) VALUES (1, 1, 'S1', '${now}', '${now}');
      INSERT INTO reports (id, text, reliability, credibility, owner_cell, releasable_to, created_at, updated_at)
        VALUES (1, 'Rep1', 'A', 1, 'white', '[]', '${now}', '${now}');
      INSERT INTO evidence_links (id, report_id, target_kind, target_id, relation, created_at) VALUES
        (1, 1, 'requirement', 1, 'confirms', '${now}'),
        (2, 1, 'sir', 1, 'confirms', '${now}'),
        (3, 1, 'requirement', 999, 'confirms', '${now}'),
        (4, 1, 'sir', 999, 'confirms', '${now}');
    `);
    database.close();
  }

  test('drops orphan target rows, re-parents live ones by requirement_id, and lets a report delete leave the link (no cascade)', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'exercise-migration-synthetic-'));
    const file = path.join(tmpDir, 'exercise.db');
    seedPreMigrationDatabase(file);

    const database = openState(file, MIGRATIONS);
    const rows = database.prepare('SELECT id, report_id, requirement_id, target_kind, target_id FROM evidence_links ORDER BY id').all();
    expect(rows).toEqual([
      { id: 1, report_id: 1, requirement_id: 1, target_kind: 'requirement', target_id: 1 },
      { id: 2, report_id: 1, requirement_id: 1, target_kind: 'sir', target_id: 1 },
    ]);

    database.exec('DELETE FROM reports WHERE id = 1');
    expect(database.prepare('SELECT COUNT(*) AS n FROM evidence_links').get().n).toBe(2);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    database.exec('DELETE FROM requirements WHERE id = 1');
    expect(database.prepare('SELECT COUNT(*) AS n FROM evidence_links').get().n).toBe(0);
    database.close();
  });
});
