import { parsePlannedTime } from '../../../src/dtg.js';

/**
 * IPB state schema. `MIGRATIONS` is an ordered array consumed by `openState`
 * (see `server/state.js`), which tracks how many have run in
 * `PRAGMA user_version`. Append new migrations; never edit an applied one.
 * Entries are plain SQL strings, `{ sql, rebuild: true }` table rebuilds, or
 * `{ run(database) }` JS-driven migrations — see `openState`'s doc comment.
 */
export const MIGRATIONS = [
  `
  CREATE TABLE studies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    bounds TEXT,
    aoi TEXT,
    notes TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE features (
    id INTEGER PRIMARY KEY,
    study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    layer TEXT NOT NULL CHECK (layer IN (
      'aoi', 'mcoo', 'key-terrain', 'avenue', 'obstacle', 'nai', 'tai', 'coa', 'threat', 'note'
    )),
    kind TEXT NOT NULL CHECK (kind IN ('point', 'line', 'polygon', 'symbol')),
    label TEXT NOT NULL DEFAULT '',
    geometry TEXT NOT NULL,
    properties TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX features_study_layer ON features(study_id, layer);

  CREATE TABLE threats (
    id INTEGER PRIMARY KEY,
    study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    echelon TEXT,
    role TEXT,
    equipment_identifier TEXT,
    hvt INTEGER NOT NULL DEFAULT 0 CHECK (hvt IN (0, 1)),
    notes TEXT,
    ordinal INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX threats_study ON threats(study_id);

  CREATE TABLE coas (
    id INTEGER PRIMARY KEY,
    study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('most-likely', 'most-dangerous')),
    narrative TEXT,
    ordinal INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX coas_study ON coas(study_id);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    coa_id INTEGER NOT NULL REFERENCES coas(id) ON DELETE CASCADE,
    nai_feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL,
    indicator TEXT NOT NULL,
    expected_time TEXT,
    observed_status TEXT NOT NULL DEFAULT 'expected' CHECK (
      observed_status IN ('expected', 'observed', 'not-observed')
    ),
    note TEXT,
    ordinal INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX events_study ON events(study_id);
  CREATE INDEX events_coa ON events(coa_id);

  CREATE TABLE analyses (
    id INTEGER PRIMARY KEY,
    study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('mobility', 'viewshed', 'line-of-sight')),
    params TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX analyses_study ON analyses(study_id);

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    study_id INTEGER,
    at TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX activity_study ON activity(study_id);
  `,
  // Where the study takes its weather: JSON {lon, lat}; NULL means the AOI centre.
  `ALTER TABLE studies ADD COLUMN weather_point TEXT;`,
  // The analyst's own named layers of named, annotated points.
  `
  CREATE TABLE layers (
    id INTEGER PRIMARY KEY,
    study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#d35400',
    visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
    ordinal INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX layers_study ON layers(study_id);

  CREATE TABLE points (
    id INTEGER PRIMARY KEY,
    study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    layer_id INTEGER NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    note TEXT,
    lon REAL NOT NULL,
    lat REAL NOT NULL,
    ordinal INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX points_study ON points(study_id);
  CREATE INDEX points_layer ON points(layer_id);
  `,
  // Layer/kind widen for units, tactical graphics and range rings; the old
  // 'threat' layer is folded into 'unit' (threats are no longer drawn from a
  // feature layer at all) and dropped from the CHECK. A CHECK widening needs
  // the 12-step rebuild, not a plain ALTER.
  {
    rebuild: true,
    sql: `
    CREATE TABLE new_features (
      id INTEGER PRIMARY KEY,
      study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
      layer TEXT NOT NULL CHECK (layer IN (
        'aoi', 'mcoo', 'key-terrain', 'avenue', 'obstacle', 'nai', 'tai', 'coa', 'note',
        'unit', 'graphic', 'range-ring'
      )),
      kind TEXT NOT NULL CHECK (
        kind IN ('point', 'line', 'polygon', 'symbol', 'graphic', 'range-ring')
      ),
      label TEXT NOT NULL DEFAULT '',
      geometry TEXT NOT NULL,
      properties TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO new_features (id, study_id, layer, kind, label, geometry, properties, created_at, updated_at)
      SELECT id, study_id, CASE WHEN layer = 'threat' THEN 'unit' ELSE layer END,
        kind, label, geometry, properties, created_at, updated_at
      FROM features;
    DROP TABLE features;
    ALTER TABLE new_features RENAME TO features;
    CREATE INDEX features_study_layer ON features(study_id, layer);
    `,
  },
  // A threat's own SIDC (defaulted from its echelon on create), a loose link
  // to an ORBAT unit, and the HPT flag (mirrors the existing hvt column).
  `
  ALTER TABLE threats ADD COLUMN sidc TEXT;
  ALTER TABLE threats ADD COLUMN orbat_unit_id TEXT;
  ALTER TABLE threats ADD COLUMN hpt INTEGER NOT NULL DEFAULT 0 CHECK (hpt IN (0, 1));
  `,
  // H-hour, a print classification marking, and optional weather thresholds
  // (NULL = the client's built-in defaults).
  `
  ALTER TABLE studies ADD COLUMN h_hour TEXT;
  ALTER TABLE studies ADD COLUMN classification TEXT NOT NULL DEFAULT 'UNCLASSIFIED // EXERCISE';
  ALTER TABLE studies ADD COLUMN weather_thresholds TEXT;
  `,
  // A study's named phases, offsets in minutes from H-hour (end may be open).
  `
  CREATE TABLE phases (
    id INTEGER PRIMARY KEY,
    study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER,
    ordinal INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX phases_study ON phases(study_id);
  `,
  // Typed event times replace free-text expected_time. This needs JS
  // (parsePlannedTime), not SQL, so it runs as a { run } migration: add the
  // new columns, reparse every row's expected_time into expected_at or
  // expected_offset (unparseable text is kept, appended to note), then drop
  // expected_time — a clean cutover, no compatibility column left behind.
  // decision_point_id forward-references decision_points, created next: SQLite
  // does not require the referenced table to exist yet.
  {
    run(database) {
      database.exec(`
        ALTER TABLE events ADD COLUMN expected_at TEXT;
        ALTER TABLE events ADD COLUMN expected_offset INTEGER;
        ALTER TABLE events ADD COLUMN tai_feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL;
        ALTER TABLE events ADD COLUMN decision_point_id INTEGER REFERENCES decision_points(id) ON DELETE SET NULL;
      `);
      const rows = database.prepare('SELECT id, expected_time, note FROM events').all();
      const update = database.prepare(
        'UPDATE events SET expected_at = ?, expected_offset = ?, note = ? WHERE id = ?',
      );
      for (const row of rows) {
        const text = row.expected_time;
        if (text === null || text === undefined || text === '') {
          update.run(null, null, row.note, row.id);
          continue;
        }
        const planned = parsePlannedTime(text);
        if (planned && 'at' in planned) {
          update.run(new Date(planned.at).toISOString(), null, row.note, row.id);
        } else if (planned && 'offset' in planned) {
          update.run(null, planned.offset, row.note, row.id);
        } else {
          const suffix = `Time: ${text}`;
          update.run(null, null, row.note ? `${row.note}\n${suffix}` : suffix, row.id);
        }
      }
      database.exec('ALTER TABLE events DROP COLUMN expected_time');
    },
  },
  // Decision points: linked to a COA and an NAI/TAI, with the same
  // DTG-or-H-offset time pair as events, for each of an earliest/latest window.
  `
  CREATE TABLE decision_points (
    id INTEGER PRIMARY KEY,
    study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    coa_id INTEGER REFERENCES coas(id) ON DELETE SET NULL,
    nai_feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL,
    tai_feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL,
    earliest_at TEXT,
    earliest_offset INTEGER,
    latest_at TEXT,
    latest_offset INTEGER,
    decision TEXT,
    ordinal INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX decision_points_study ON decision_points(study_id);
  `,
  // The ASCOPE x PMESII-PT matrix: one upserted cell per (ascope, pmesii).
  `
  CREATE TABLE civil_considerations (
    id INTEGER PRIMARY KEY,
    study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    ascope TEXT NOT NULL CHECK (ascope IN (
      'areas', 'structures', 'capabilities', 'organizations', 'people', 'events'
    )),
    pmesii TEXT NOT NULL CHECK (pmesii IN (
      'political', 'military', 'economic', 'social', 'information', 'infrastructure',
      'physical-environment', 'time'
    )),
    text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (study_id, ascope, pmesii)
  );
  CREATE INDEX civil_considerations_study ON civil_considerations(study_id);
  `,
  // Phase 1 cells: every study is owned by a cell and may be released to
  // others. Existing studies migrate to 'white' (visible to nobody else)
  // so nothing leaks; White can reassign or release them. Child rows
  // (features, threats, coas, events, analyses, layers, points, phases,
  // decision_points, civil_considerations) inherit the study's visibility
  // and carry no columns of their own.
  `
  ALTER TABLE studies ADD COLUMN owner_cell TEXT NOT NULL DEFAULT 'white'
    CHECK (owner_cell IN ('white', 'blue', 'red'));
  ALTER TABLE studies ADD COLUMN releasable_to TEXT NOT NULL DEFAULT '[]';
  `,
];
