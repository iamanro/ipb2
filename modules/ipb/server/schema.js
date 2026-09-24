/**
 * IPB state schema. `MIGRATIONS` is an ordered array of SQL strings consumed
 * by `openState` (see `server/state.js`), which tracks how many have run in
 * `PRAGMA user_version`. Append new migrations; never edit an applied one.
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
];
