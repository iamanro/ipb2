import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openState } from '../../../server/state.ts';
import { MIGRATIONS } from './schema.js';

function tempFile(label) {
  return path.join(
    os.tmpdir(),
    `ipb-schema-test-${label}-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function removeDatabaseFiles(file) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
}

let file;

beforeEach(() => {
  file = null;
});

afterEach(() => {
  if (file) removeDatabaseFiles(file);
});

/** MIGRATIONS[0..2]: the schema exactly as it stood before this slice's C6 work. */
function buildLegacyDatabase(target) {
  return openState(target, MIGRATIONS.slice(0, 3));
}

describe('IPB migrations on a synthetic legacy database', () => {
  test('a "threat" layer feature is folded into "unit", keeping its id', () => {
    file = tempFile('legacy-threat');
    let database = buildLegacyDatabase(file);
    const now = new Date().toISOString();
    database.exec(
      `INSERT INTO studies (name, notes, revision, created_at, updated_at) VALUES ('S', '{}', 1, '${now}', '${now}')`,
    );
    database.exec(
      `INSERT INTO features (id, study_id, layer, kind, label, geometry, properties, created_at, updated_at)
       VALUES (42, 1, 'threat', 'point', 'Enemy recon', '{"type":"Point","coordinates":[1,2]}', '{}', '${now}', '${now}')`,
    );
    database.close();

    database = openState(file, MIGRATIONS);
    const row = database.prepare('SELECT id, layer FROM features WHERE id = 42').get();
    expect(row).toEqual({ id: 42, layer: 'unit' });
    database.close();
  });

  test('nai_feature_id survives the features rebuild, and expected_time forms all migrate', () => {
    file = tempFile('legacy-events');
    let database = buildLegacyDatabase(file);
    const now = new Date().toISOString();
    database.exec(
      `INSERT INTO studies (name, notes, revision, created_at, updated_at) VALUES ('S', '{}', 1, '${now}', '${now}')`,
    );
    database.exec(
      `INSERT INTO features (id, study_id, layer, kind, label, geometry, properties, created_at, updated_at)
       VALUES (7, 1, 'nai', 'polygon', 'NAI 1',
         '{"type":"Polygon","coordinates":[[[0,0],[0,1],[1,1],[0,0]]]}', '{}', '${now}', '${now}')`,
    );
    database.exec(
      `INSERT INTO coas (id, study_id, name, kind, ordinal, created_at, updated_at)
       VALUES (1, 1, 'MLCOA', 'most-likely', 1, '${now}', '${now}')`,
    );
    const insertEvent = database.prepare(
      `INSERT INTO events
         (id, study_id, coa_id, nai_feature_id, indicator, expected_time, note, ordinal, created_at, updated_at)
       VALUES (?, 1, 1, 7, ?, ?, ?, ?, '${now}', '${now}')`,
    );
    insertEvent.run(1, 'Crosses PL', '251430ZSEP26', null, 1); // absolute DTG
    insertEvent.run(2, 'Reserve commits', 'H+4:30', null, 2); // H-hour offset
    insertEvent.run(3, 'Garbled text', 'whenever convenient', null, 3); // unparseable
    insertEvent.run(4, 'Garbled with note', 'soonish', 'existing note', 4); // unparseable, has a note
    insertEvent.run(5, 'No time set', null, null, 5); // unset
    database.close();

    database = openState(file, MIGRATIONS);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // The nai still exists at id 7, and the event's FK to it is untouched.
    expect(database.prepare('SELECT id FROM features WHERE id = 7').get()).toEqual({ id: 7 });
    const events = database
      .prepare(
        'SELECT id, nai_feature_id, expected_at, expected_offset, note FROM events ORDER BY id',
      )
      .all();
    expect(events[0]).toMatchObject({ nai_feature_id: 7, expected_offset: null });
    expect(events[0].expected_at).toMatch(/^2026-09-25T14:30/);
    expect(events[1]).toMatchObject({ expected_at: null, expected_offset: 270 });
    expect(events[2]).toMatchObject({
      expected_at: null,
      expected_offset: null,
      note: 'Time: whenever convenient',
    });
    expect(events[3]).toMatchObject({
      expected_at: null,
      expected_offset: null,
      note: 'existing note\nTime: soonish',
    });
    expect(events[4]).toMatchObject({ expected_at: null, expected_offset: null, note: null });
    database.close();
  });
});
