/**
 * Exercise state schema: the intelligence-cycle groupware layer (roster,
 * requirements, reports, RFI, scenario clock, AAR). Separate from `ipb`
 * (which owns terrain/threat/COA analysis for one AOI) because this module
 * has a distinct job: running the collection cycle for a classroom exercise,
 * not modelling a battlefield.
 */
export const MIGRATIONS = [
  `
  CREATE TABLE roster (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('analyst', 'collection-manager', 'game-master')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE requirements (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('PIR', 'FFIR')),
    text TEXT NOT NULL,
    decision_point TEXT,
    ltiov TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE sirs (
    id INTEGER PRIMARY KEY,
    requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    time_window_start TEXT,
    time_window_end TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX sirs_requirement ON sirs(requirement_id);

  CREATE TABLE indicators (
    id INTEGER PRIMARY KEY,
    sir_id INTEGER NOT NULL REFERENCES sirs(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    observed INTEGER NOT NULL DEFAULT 0 CHECK (observed IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX indicators_sir ON indicators(sir_id);

  CREATE TABLE reports (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    occurred_at TEXT,
    source TEXT,
    author TEXT,
    reliability TEXT NOT NULL CHECK (reliability IN ('A', 'B', 'C', 'D', 'E', 'F')),
    credibility INTEGER NOT NULL CHECK (credibility IN (1, 2, 3, 4, 5, 6)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE evidence_links (
    id INTEGER PRIMARY KEY,
    report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('requirement', 'sir')),
    target_id INTEGER NOT NULL,
    relation TEXT NOT NULL CHECK (relation IN ('confirms', 'denies', 'partial', 'context')),
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX evidence_links_report ON evidence_links(report_id);
  CREATE INDEX evidence_links_target ON evidence_links(target_kind, target_id);

  CREATE TABLE rfis (
    id INTEGER PRIMARY KEY,
    requester TEXT,
    assignee TEXT,
    requirement_id INTEGER REFERENCES requirements(id) ON DELETE SET NULL,
    sir_id INTEGER REFERENCES sirs(id) ON DELETE SET NULL,
    question TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine', 'priority', 'immediate')),
    nlt TEXT,
    state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN (
      'draft', 'submitted', 'assigned', 'in_collection', 'answered', 'closed', 'rejected', 'reopened'
    )),
    answer_report_id INTEGER REFERENCES reports(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE scenario_clock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    base_real_ts TEXT NOT NULL,
    base_scenario_ts TEXT NOT NULL,
    rate REAL NOT NULL DEFAULT 1,
    paused INTEGER NOT NULL DEFAULT 1 CHECK (paused IN (0, 1))
  );

  CREATE TABLE scenario_events (
    id INTEGER PRIMARY KEY,
    trigger_at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'report')),
    payload TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'fired', 'cancelled')),
    fired_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX scenario_events_state ON scenario_events(state, trigger_at);

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    detail TEXT
  );
  `,
  // Provenance key for rows derived from another module (see ipbImport.js),
  // e.g. 'ipb:3:coa:5'. NULL for hand-entered rows; SQLite UNIQUE allows
  // any number of NULLs, so the index only constrains derived rows.
  `
  ALTER TABLE requirements ADD COLUMN source TEXT;
  ALTER TABLE sirs ADD COLUMN source TEXT;
  ALTER TABLE indicators ADD COLUMN source TEXT;
  CREATE UNIQUE INDEX requirements_source ON requirements(source);
  CREATE UNIQUE INDEX sirs_source ON sirs(source);
  CREATE UNIQUE INDEX indicators_source ON indicators(source);
  `,
  // The one active scenario for the whole app (kraje/okresy-composed fictional
  // countries and renamed places over real Czech terrain).
  // `scenarios(active)` has a partial unique index, not a CHECK, because "at
  // most one" is a cross-row invariant; store.js also deactivates the rest in
  // the same transaction before flipping a row on, so the index never fires.
  `
  CREATE TABLE scenarios (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    example INTEGER NOT NULL DEFAULT 0 CHECK (example IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX scenarios_active ON scenarios(active) WHERE active = 1;

  CREATE TABLE scenario_countries (
    id INTEGER PRIMARY KEY,
    scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    affiliation TEXT NOT NULL CHECK (affiliation IN ('friendly', 'hostile', 'neutral', 'unknown')),
    color TEXT NOT NULL,
    regions TEXT NOT NULL DEFAULT '[]',
    geometry TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX scenario_countries_scenario ON scenario_countries(scenario_id, position);

  CREATE TABLE scenario_places (
    id INTEGER PRIMARY KEY,
    scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    real_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    lon REAL NOT NULL,
    lat REAL NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX scenario_places_scenario ON scenario_places(scenario_id);

  -- Single-row flag: has the EXAMPLE scenario ever been created? Set on
  -- first creation (auto or explicit) so deleting it does not bring it back
  -- on the next listing; \`POST scenarios/example\` still recreates it.
  CREATE TABLE scenario_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    example_seeded INTEGER NOT NULL DEFAULT 0 CHECK (example_seeded IN (0, 1))
  );
  `,
  // NAIs/TAIs imported from IPB, with geometry for auto point-in-polygon
  // linking of reports (see geoMatch.js). `source`/`study_id`/`feature_id`
  // tie a row back to the IPB feature it came from; geometry is nullable so
  // older import payloads (label only) still land a usable row, just one
  // that never auto-matches a report. SIRs point at the NAI/TAI their text
  // used to name only in prose.
  `
  CREATE TABLE nais (
    id INTEGER PRIMARY KEY,
    source TEXT UNIQUE,
    study_id INTEGER,
    feature_id INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('nai', 'tai')),
    label TEXT NOT NULL,
    geometry TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX nais_study ON nais(study_id);

  ALTER TABLE sirs ADD COLUMN nai_id INTEGER REFERENCES nais(id) ON DELETE SET NULL;
  CREATE INDEX sirs_nai ON sirs(nai_id);
  `,
  // The current situation: enemy/unknown/friendly tracks with a time and
  // position history. `tracks` holds the head (most recent) position for
  // cheap map rendering; `track_positions` is the full history a report can
  // append to. The head only ever moves forward in `observed_at` (see
  // store.js `addTrackPosition`), so an out-of-order report can enrich
  // history without corrupting the current picture.
  `
  CREATE TABLE tracks (
    id INTEGER PRIMARY KEY,
    sidc TEXT NOT NULL,
    designation TEXT,
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'suspected', 'destroyed', 'lost')),
    lon REAL NOT NULL,
    lat REAL NOT NULL,
    observed_at TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE track_positions (
    id INTEGER PRIMARY KEY,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    lon REAL NOT NULL,
    lat REAL NOT NULL,
    observed_at TEXT NOT NULL,
    report_id INTEGER REFERENCES reports(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX track_positions_track ON track_positions(track_id, observed_at);
  `,
  // Reports gain a location, a typed structured payload, a reported SIDC,
  // and links to the NAI they landed in and the track they update. `fields`
  // is a JSON object shaped by `report_type` (see store.js FIELDS_BY_TYPE).
  // lon/lat travel together: the CHECK enforces both-or-neither at the
  // schema level even though the store also validates it, because this
  // column pair is cheap to protect twice and easy to get wrong from a
  // future direct-SQL script.
  `
  ALTER TABLE reports ADD COLUMN lon REAL;
  ALTER TABLE reports ADD COLUMN lat REAL CHECK ((lat IS NULL) = (lon IS NULL));
  ALTER TABLE reports ADD COLUMN report_type TEXT NOT NULL DEFAULT 'free' CHECK (report_type IN ('free', 'spotrep', 'salute'));
  ALTER TABLE reports ADD COLUMN fields TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE reports ADD COLUMN sidc TEXT;
  ALTER TABLE reports ADD COLUMN nai_id INTEGER REFERENCES nais(id) ON DELETE SET NULL;
  ALTER TABLE reports ADD COLUMN track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL;
  CREATE INDEX reports_nai ON reports(nai_id);
  CREATE INDEX reports_track ON reports(track_id);
  `,
  // Collection plan: collectors (the ISR assets) tasked against a SIR x NAI
  // x time window. A tasking's `report_id` is the report that answered it,
  // set by hand once collection produces one worth citing.
  `
  CREATE TABLE collectors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    discipline TEXT NOT NULL CHECK (discipline IN (
      'HUMINT', 'SIGINT', 'IMINT', 'GEOINT', 'OSINT', 'MASINT', 'UAS', 'RECCE', 'OP', 'OTHER'
    )),
    unit TEXT,
    range_km REAL,
    available_from TEXT,
    available_to TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE taskings (
    id INTEGER PRIMARY KEY,
    collector_id INTEGER NOT NULL REFERENCES collectors(id) ON DELETE CASCADE,
    sir_id INTEGER NOT NULL REFERENCES sirs(id) ON DELETE CASCADE,
    nai_id INTEGER REFERENCES nais(id) ON DELETE SET NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'tasked', 'active', 'complete', 'cancelled')),
    report_id INTEGER REFERENCES reports(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX taskings_collector ON taskings(collector_id, start_at);
  CREATE INDEX taskings_sir ON taskings(sir_id);
  `,
  // INTSUMs: the periodic intelligence summary product. `sections` is a
  // JSON object with fixed keys (situation, significant_activity,
  // pir_status, assessment, outlook); the draft endpoint fills the first
  // three from tracks/reports/fulfillment, the analyst edits the rest.
  `
  CREATE TABLE intsums (
    id INTEGER PRIMARY KEY,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    dtg TEXT NOT NULL,
    author TEXT,
    sections TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX intsums_period ON intsums(period_start);
  `,
  // Phase 1 cells (docs/phase1-access.md): every cell-owned table gets
  // `owner_cell`/`releasable_to`, defaulting existing rows to White so
  // nothing already in a running exercise leaks to Blue/Red. Child rows
  // (sirs, indicators, evidence_links, track_positions) have no columns of
  // their own — they inherit the parent's visibility (C3). `messages` holds
  // fired MESSAGE injects, White-owned with `releasable_to` set to the
  // inject's target cells. `roster` is superseded by exercise memberships
  // (server/auth.js `memberships`, cell + role together) and is dropped —
  // the exercise client now reads/writes members through the admin API.
  `
  ALTER TABLE requirements ADD COLUMN owner_cell TEXT NOT NULL DEFAULT 'white';
  ALTER TABLE requirements ADD COLUMN releasable_to TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE reports ADD COLUMN owner_cell TEXT NOT NULL DEFAULT 'white';
  ALTER TABLE reports ADD COLUMN releasable_to TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE rfis ADD COLUMN owner_cell TEXT NOT NULL DEFAULT 'white';
  ALTER TABLE rfis ADD COLUMN releasable_to TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE tracks ADD COLUMN owner_cell TEXT NOT NULL DEFAULT 'white';
  ALTER TABLE tracks ADD COLUMN releasable_to TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE collectors ADD COLUMN owner_cell TEXT NOT NULL DEFAULT 'white';
  ALTER TABLE collectors ADD COLUMN releasable_to TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE taskings ADD COLUMN owner_cell TEXT NOT NULL DEFAULT 'white';
  ALTER TABLE taskings ADD COLUMN releasable_to TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE intsums ADD COLUMN owner_cell TEXT NOT NULL DEFAULT 'white';
  ALTER TABLE intsums ADD COLUMN releasable_to TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE nais ADD COLUMN owner_cell TEXT NOT NULL DEFAULT 'white';
  ALTER TABLE nais ADD COLUMN releasable_to TEXT NOT NULL DEFAULT '[]';

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    fired_at TEXT NOT NULL,
    owner_cell TEXT NOT NULL DEFAULT 'white',
    releasable_to TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  DROP TABLE roster;
  `,
  // `activity` gains the same visibility columns, populated by `mutate()`
  // from whatever cell-owned row (if any) the mutation touched: NULL
  // `owner_cell` means a global (non-cell) change, visible to everyone,
  // same as it always was; a non-NULL value is filtered by `canSee` like
  // any other cell-owned row, so Blue's activity log never mentions a Red
  // item it can't otherwise see.
  `
  ALTER TABLE activity ADD COLUMN owner_cell TEXT;
  ALTER TABLE activity ADD COLUMN releasable_to TEXT NOT NULL DEFAULT '[]';
  `,
  // Item-scoped requests (docs/adr/0002-item-scoped-requests.md): an
  // evidence link is a part of the *requirement* it supports, not of the
  // report it cites (CONTEXT.md), so it needs the same `requirement_id`
  // parent column every other part of a requirement carries (sirs,
  // indicators). Backfilled from `target_id` directly for a
  // `target_kind = 'requirement'` link, or via the cited SIR's own
  // `requirement_id` for a `target_kind = 'sir'` one. A handful of rows
  // whose `target_id` no longer names a live requirement/SIR (possible
  // before this migration, since `target_id` was never foreign-keyed) have
  // no parent left to attach to and are dropped — they were already
  // unreachable through any route.
  //
  // `report_id` deliberately loses its `ON DELETE CASCADE`: deleting a
  // report used to delete every link that cited it; now the link survives
  // as a dangling `report_id` and the report shows as "withdrawn" (never
  // counted toward fulfillment) instead of disappearing. The link's own
  // lifecycle now cascades from `requirement_id` instead. This needs a
  // rebuild (SQLite can't drop a column's `REFERENCES` in place).
  {
    rebuild: true,
    sql: `
    DELETE FROM evidence_links WHERE
      (target_kind = 'requirement' AND target_id NOT IN (SELECT id FROM requirements))
      OR (target_kind = 'sir' AND target_id NOT IN (SELECT id FROM sirs));

    CREATE TABLE evidence_links_new (
      id INTEGER PRIMARY KEY,
      report_id INTEGER NOT NULL,
      requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('requirement', 'sir')),
      target_id INTEGER NOT NULL,
      relation TEXT NOT NULL CHECK (relation IN ('confirms', 'denies', 'partial', 'context')),
      note TEXT,
      created_at TEXT NOT NULL
    );

    INSERT INTO evidence_links_new (id, report_id, requirement_id, target_kind, target_id, relation, note, created_at)
    SELECT
      el.id,
      el.report_id,
      CASE WHEN el.target_kind = 'requirement' THEN el.target_id
           ELSE (SELECT s.requirement_id FROM sirs s WHERE s.id = el.target_id) END,
      el.target_kind,
      el.target_id,
      el.relation,
      el.note,
      el.created_at
    FROM evidence_links el;

    DROP TABLE evidence_links;
    ALTER TABLE evidence_links_new RENAME TO evidence_links;

    CREATE INDEX evidence_links_report ON evidence_links(report_id);
    CREATE INDEX evidence_links_target ON evidence_links(target_kind, target_id);
    CREATE INDEX evidence_links_requirement ON evidence_links(requirement_id);
    `,
  },
  // Same parent column for indicators, backfilled through the SIR they
  // already belong to — a plain `ADD COLUMN` suffices here (no existing
  // constraint to drop), so this stays an ordinary migration.
  `
  ALTER TABLE indicators ADD COLUMN requirement_id INTEGER REFERENCES requirements(id) ON DELETE CASCADE;
  UPDATE indicators SET requirement_id = (SELECT s.requirement_id FROM sirs s WHERE s.id = indicators.sir_id);
  CREATE INDEX indicators_requirement ON indicators(requirement_id);
  `,
];
