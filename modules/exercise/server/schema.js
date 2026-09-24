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
];
