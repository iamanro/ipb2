import { HttpError } from '../../../server/http.js';
import { openState, transact } from '../../../server/state.js';
import { computePirFulfillment } from './fulfillment.js';
import { canTransition } from './rfiMachine.js';
import { MIGRATIONS } from './schema.js';
import { dueEvents, reanchor, scenarioNowMs } from './scenarioClock.js';

const ROLES = ['analyst', 'collection-manager', 'game-master'];
const REQUIREMENT_KINDS = ['PIR', 'FFIR'];
const RELIABILITY = ['A', 'B', 'C', 'D', 'E', 'F'];
const CREDIBILITY = [1, 2, 3, 4, 5, 6];
const TARGET_KINDS = ['requirement', 'sir'];
const RELATIONS = ['confirms', 'denies', 'partial', 'context'];
const RFI_PRIORITIES = ['routine', 'priority', 'immediate'];
const SCENARIO_EVENT_KINDS = ['message', 'report'];

let database;

export function openStore(file) {
  database = openState(file, MIGRATIONS);
  return {
    listRoster,
    createRosterMember,
    deleteRosterMember,
    listRequirements,
    createRequirement,
    updateRequirement,
    deleteRequirement,
    createSir,
    updateSir,
    deleteSir,
    createIndicator,
    updateIndicator,
    deleteIndicator,
    listReports,
    createReport,
    updateReport,
    deleteReport,
    createEvidenceLink,
    deleteEvidenceLink,
    listRfis,
    createRfi,
    updateRfi,
    transitionRfi,
    deleteRfi,
    readClock,
    patchClock,
    listScenarioEvents,
    createScenarioEvent,
    cancelScenarioEvent,
    fireScenarioEvent,
    tickScenario,
    listActivity,
    close,
  };
}

function close() {
  database?.close();
  database = undefined;
}

// -- shared helpers -----------------------------------------------------------

function now() {
  return new Date().toISOString();
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${name} is required.`);
  }
  return value.trim();
}

function optionalString(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string.`);
  return value;
}

function requireEnum(value, name, values) {
  if (!values.includes(value))
    throw new HttpError(400, `${name} must be one of: ${values.join(', ')}.`);
  return value;
}

/**
 * Every mutation appends one activity row, inside the same transaction.
 * `target` may be a function to defer reading a value (such as an inserted
 * id) that only exists after `work()` runs.
 */
function mutate(action, target, work) {
  return transact(database, () => {
    const result = work();
    const targetLabel = typeof target === 'function' ? target() : target;
    database
      .prepare('INSERT INTO activity (at, action, target, detail) VALUES (?, ?, ?, ?)')
      .run(now(), action, targetLabel, null);
    return result;
  });
}

function fetchRow(table, id) {
  return database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) ?? null;
}

function assertExists(table, id, label) {
  if (!fetchRow(table, id)) throw new HttpError(404, `${label} ${id} not found.`);
}

// -- roster ---------------------------------------------------------------

function listRoster() {
  return database.prepare('SELECT * FROM roster ORDER BY created_at, id').all();
}

function createRosterMember({ name, role }) {
  const cleanName = requireString(name, 'name');
  requireEnum(role, 'role', ROLES);
  try {
    return mutate('roster:add', cleanName, () => {
      const { lastInsertRowid } = database
        .prepare('INSERT INTO roster (name, role, created_at) VALUES (?, ?, ?)')
        .run(cleanName, role, now());
      return fetchRow('roster', Number(lastInsertRowid));
    });
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) {
      throw new HttpError(409, `${cleanName} is already on the roster.`);
    }
    throw error;
  }
}

function deleteRosterMember(id) {
  assertExists('roster', id, 'Roster member');
  mutate('roster:remove', String(id), () => {
    database.prepare('DELETE FROM roster WHERE id = ?').run(id);
  });
}

// -- requirements tree ------------------------------------------------------

function shapeIndicator(row) {
  return {
    id: row.id,
    sir_id: row.sir_id,
    description: row.description,
    observed: Boolean(row.observed),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sirFulfillment(sirId) {
  const links = database
    .prepare(
      `SELECT el.relation, r.credibility
       FROM evidence_links el JOIN reports r ON r.id = el.report_id
       WHERE el.target_kind = 'sir' AND el.target_id = ?`,
    )
    .all(sirId)
    .map((row) => ({ sirId, relation: row.relation, credibility: row.credibility }));
  return computePirFulfillment([sirId], links);
}

function shapeSir(row) {
  const indicators = database
    .prepare('SELECT * FROM indicators WHERE sir_id = ? ORDER BY created_at, id')
    .all(row.id)
    .map(shapeIndicator);
  return {
    id: row.id,
    requirement_id: row.requirement_id,
    text: row.text,
    time_window_start: row.time_window_start,
    time_window_end: row.time_window_end,
    indicators,
    fulfillment: sirFulfillment(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function requirementFulfillment(requirementId, sirIds) {
  const blanket = database
    .prepare(
      `SELECT el.relation, r.credibility
       FROM evidence_links el JOIN reports r ON r.id = el.report_id
       WHERE el.target_kind = 'requirement' AND el.target_id = ?`,
    )
    .all(requirementId)
    .map((row) => ({ sirId: null, relation: row.relation, credibility: row.credibility }));
  const perSir = sirIds.length
    ? database
        .prepare(
          `SELECT el.target_id AS sir_id, el.relation, r.credibility
           FROM evidence_links el JOIN reports r ON r.id = el.report_id
           WHERE el.target_kind = 'sir' AND el.target_id IN (${sirIds.map(() => '?').join(',')})`,
        )
        .all(...sirIds)
        .map((row) => ({ sirId: row.sir_id, relation: row.relation, credibility: row.credibility }))
    : [];
  return computePirFulfillment(sirIds, [...blanket, ...perSir]);
}

function shapeRequirement(row) {
  const sirs = database
    .prepare('SELECT * FROM sirs WHERE requirement_id = ? ORDER BY created_at, id')
    .all(row.id)
    .map(shapeSir);
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    decision_point: row.decision_point,
    ltiov: row.ltiov,
    priority: row.priority,
    sirs,
    fulfillment: requirementFulfillment(
      row.id,
      sirs.map((sir) => sir.id),
    ),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listRequirements() {
  return database
    .prepare('SELECT * FROM requirements ORDER BY priority DESC, created_at, id')
    .all()
    .map(shapeRequirement);
}

function createRequirement({ kind, text, decision_point: decisionPoint, ltiov, priority }) {
  requireEnum(kind, 'kind', REQUIREMENT_KINDS);
  const cleanText = requireString(text, 'text');
  const timestamp = now();
  return mutate(
    'requirement:create',
    () => cleanText,
    () => {
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO requirements (kind, text, decision_point, ltiov, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          kind,
          cleanText,
          optionalString(decisionPoint, 'decision_point'),
          optionalString(ltiov, 'ltiov'),
          Number.isInteger(priority) ? priority : 0,
          timestamp,
          timestamp,
        );
      return shapeRequirement(fetchRow('requirements', Number(lastInsertRowid)));
    },
  );
}

function updateRequirement(id, patch) {
  assertExists('requirements', id, 'Requirement');
  const fields = [];
  const params = [];
  if ('text' in patch) {
    fields.push('text = ?');
    params.push(requireString(patch.text, 'text'));
  }
  if ('decision_point' in patch) {
    fields.push('decision_point = ?');
    params.push(optionalString(patch.decision_point, 'decision_point'));
  }
  if ('ltiov' in patch) {
    fields.push('ltiov = ?');
    params.push(optionalString(patch.ltiov, 'ltiov'));
  }
  if ('priority' in patch) {
    if (!Number.isInteger(patch.priority)) throw new HttpError(400, 'priority must be an integer.');
    fields.push('priority = ?');
    params.push(patch.priority);
  }
  return mutate('requirement:update', String(id), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database
        .prepare(`UPDATE requirements SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, id);
    }
    return shapeRequirement(fetchRow('requirements', id));
  });
}

function deleteRequirement(id) {
  assertExists('requirements', id, 'Requirement');
  mutate('requirement:delete', String(id), () => {
    database.prepare('DELETE FROM requirements WHERE id = ?').run(id);
  });
}

function createSir(requirementId, { text, time_window_start: start, time_window_end: end }) {
  assertExists('requirements', requirementId, 'Requirement');
  const cleanText = requireString(text, 'text');
  const timestamp = now();
  return mutate(
    'sir:create',
    () => cleanText,
    () => {
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO sirs (requirement_id, text, time_window_start, time_window_end, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          requirementId,
          cleanText,
          optionalString(start, 'time_window_start'),
          optionalString(end, 'time_window_end'),
          timestamp,
          timestamp,
        );
      return shapeSir(fetchRow('sirs', Number(lastInsertRowid)));
    },
  );
}

function updateSir(id, patch) {
  const row = fetchRow('sirs', id);
  if (!row) throw new HttpError(404, `SIR ${id} not found.`);
  const fields = [];
  const params = [];
  if ('text' in patch) {
    fields.push('text = ?');
    params.push(requireString(patch.text, 'text'));
  }
  if ('time_window_start' in patch) {
    fields.push('time_window_start = ?');
    params.push(optionalString(patch.time_window_start, 'time_window_start'));
  }
  if ('time_window_end' in patch) {
    fields.push('time_window_end = ?');
    params.push(optionalString(patch.time_window_end, 'time_window_end'));
  }
  return mutate('sir:update', String(id), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database.prepare(`UPDATE sirs SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return shapeSir(fetchRow('sirs', id));
  });
}

function deleteSir(id) {
  assertExists('sirs', id, 'SIR');
  mutate('sir:delete', String(id), () => {
    database.prepare('DELETE FROM sirs WHERE id = ?').run(id);
  });
}

function createIndicator(sirId, { description }) {
  assertExists('sirs', sirId, 'SIR');
  const cleanDescription = requireString(description, 'description');
  const timestamp = now();
  return mutate(
    'indicator:create',
    () => cleanDescription,
    () => {
      const { lastInsertRowid } = database
        .prepare(
          'INSERT INTO indicators (sir_id, description, observed, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
        )
        .run(sirId, cleanDescription, timestamp, timestamp);
      return shapeIndicator(fetchRow('indicators', Number(lastInsertRowid)));
    },
  );
}

function updateIndicator(id, patch) {
  const row = fetchRow('indicators', id);
  if (!row) throw new HttpError(404, `Indicator ${id} not found.`);
  const fields = [];
  const params = [];
  if ('description' in patch) {
    fields.push('description = ?');
    params.push(requireString(patch.description, 'description'));
  }
  if ('observed' in patch) {
    fields.push('observed = ?');
    params.push(patch.observed ? 1 : 0);
  }
  return mutate('indicator:update', String(id), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database
        .prepare(`UPDATE indicators SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, id);
    }
    return shapeIndicator(fetchRow('indicators', id));
  });
}

function deleteIndicator(id) {
  assertExists('indicators', id, 'Indicator');
  mutate('indicator:delete', String(id), () => {
    database.prepare('DELETE FROM indicators WHERE id = ?').run(id);
  });
}

// -- reports & evidence -------------------------------------------------------

function shapeEvidenceLink(row) {
  return {
    id: row.id,
    report_id: row.report_id,
    target_kind: row.target_kind,
    target_id: row.target_id,
    relation: row.relation,
    note: row.note,
    created_at: row.created_at,
  };
}

function shapeReport(row) {
  const links = database
    .prepare('SELECT * FROM evidence_links WHERE report_id = ? ORDER BY created_at, id')
    .all(row.id)
    .map(shapeEvidenceLink);
  return {
    id: row.id,
    text: row.text,
    occurred_at: row.occurred_at,
    source: row.source,
    author: row.author,
    reliability: row.reliability,
    credibility: row.credibility,
    links,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listReports() {
  return database
    .prepare('SELECT * FROM reports ORDER BY created_at DESC, id DESC')
    .all()
    .map(shapeReport);
}

/** Validates and shapes report fields; does not touch the database. */
function validateReportInput({
  text,
  occurred_at: occurredAt,
  source,
  author,
  reliability,
  credibility,
}) {
  return {
    text: requireString(text, 'text'),
    occurred_at: optionalString(occurredAt, 'occurred_at'),
    source: optionalString(source, 'source'),
    author: optionalString(author, 'author'),
    reliability: requireEnum(reliability, 'reliability', RELIABILITY),
    credibility: requireEnum(credibility, 'credibility', CREDIBILITY),
  };
}

/**
 * The raw insert, with no transaction of its own: `fireOne` calls this from
 * inside an already-open transaction (this `transact` helper does not
 * support nesting), while `createReport` wraps it in `mutate` for the normal
 * write path.
 */
function insertReportRow(fields) {
  const timestamp = now();
  const { lastInsertRowid } = database
    .prepare(
      `INSERT INTO reports (text, occurred_at, source, author, reliability, credibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fields.text,
      fields.occurred_at,
      fields.source,
      fields.author,
      fields.reliability,
      fields.credibility,
      timestamp,
      timestamp,
    );
  return shapeReport(fetchRow('reports', Number(lastInsertRowid)));
}

function createReport(input) {
  const fields = validateReportInput(input);
  return mutate(
    'report:create',
    () => fields.text,
    () => insertReportRow(fields),
  );
}

function updateReport(id, patch) {
  const row = fetchRow('reports', id);
  if (!row) throw new HttpError(404, `Report ${id} not found.`);
  const fields = [];
  const params = [];
  if ('text' in patch) {
    fields.push('text = ?');
    params.push(requireString(patch.text, 'text'));
  }
  if ('reliability' in patch) {
    fields.push('reliability = ?');
    params.push(requireEnum(patch.reliability, 'reliability', RELIABILITY));
  }
  if ('credibility' in patch) {
    fields.push('credibility = ?');
    params.push(requireEnum(patch.credibility, 'credibility', CREDIBILITY));
  }
  if ('source' in patch) {
    fields.push('source = ?');
    params.push(optionalString(patch.source, 'source'));
  }
  return mutate('report:update', String(id), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database.prepare(`UPDATE reports SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return shapeReport(fetchRow('reports', id));
  });
}

function deleteReport(id) {
  assertExists('reports', id, 'Report');
  mutate('report:delete', String(id), () => {
    database.prepare('DELETE FROM reports WHERE id = ?').run(id);
  });
}

function assertEvidenceTarget(targetKind, targetId) {
  const table = targetKind === 'requirement' ? 'requirements' : 'sirs';
  if (!fetchRow(table, targetId)) {
    throw new HttpError(400, `Unknown ${targetKind} id ${targetId}.`);
  }
}

function createEvidenceLink(
  reportId,
  { target_kind: targetKind, target_id: targetId, relation, note },
) {
  assertExists('reports', reportId, 'Report');
  requireEnum(targetKind, 'target_kind', TARGET_KINDS);
  if (!Number.isInteger(targetId)) throw new HttpError(400, 'target_id must be an integer.');
  assertEvidenceTarget(targetKind, targetId);
  requireEnum(relation, 'relation', RELATIONS);
  return mutate('evidence:link', `report:${reportId}`, () => {
    const { lastInsertRowid } = database
      .prepare(
        `INSERT INTO evidence_links (report_id, target_kind, target_id, relation, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(reportId, targetKind, targetId, relation, optionalString(note, 'note'), now());
    return shapeEvidenceLink(fetchRow('evidence_links', Number(lastInsertRowid)));
  });
}

function deleteEvidenceLink(id) {
  assertExists('evidence_links', id, 'Evidence link');
  mutate('evidence:unlink', String(id), () => {
    database.prepare('DELETE FROM evidence_links WHERE id = ?').run(id);
  });
}

// -- RFI --------------------------------------------------------------------

function shapeRfi(row) {
  return { ...row };
}

function listRfis() {
  return database
    .prepare('SELECT * FROM rfis ORDER BY created_at DESC, id DESC')
    .all()
    .map(shapeRfi);
}

function createRfi({
  requester,
  requirement_id: requirementId,
  sir_id: sirId,
  question,
  priority,
  nlt,
}) {
  const cleanQuestion = requireString(question, 'question');
  const cleanPriority =
    priority === undefined ? 'routine' : requireEnum(priority, 'priority', RFI_PRIORITIES);
  if (requirementId !== undefined && requirementId !== null) {
    assertExists('requirements', requirementId, 'Requirement');
  }
  if (sirId !== undefined && sirId !== null) {
    assertExists('sirs', sirId, 'SIR');
  }
  const timestamp = now();
  return mutate(
    'rfi:create',
    () => cleanQuestion,
    () => {
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO rfis (requester, requirement_id, sir_id, question, priority, nlt, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        )
        .run(
          optionalString(requester, 'requester'),
          requirementId ?? null,
          sirId ?? null,
          cleanQuestion,
          cleanPriority,
          optionalString(nlt, 'nlt'),
          timestamp,
          timestamp,
        );
      return shapeRfi(fetchRow('rfis', Number(lastInsertRowid)));
    },
  );
}

function updateRfi(id, patch) {
  const row = fetchRow('rfis', id);
  if (!row) throw new HttpError(404, `RFI ${id} not found.`);
  const fields = [];
  const params = [];
  if ('assignee' in patch) {
    fields.push('assignee = ?');
    params.push(optionalString(patch.assignee, 'assignee'));
  }
  if ('question' in patch) {
    fields.push('question = ?');
    params.push(requireString(patch.question, 'question'));
  }
  if ('priority' in patch) {
    fields.push('priority = ?');
    params.push(requireEnum(patch.priority, 'priority', RFI_PRIORITIES));
  }
  if ('nlt' in patch) {
    fields.push('nlt = ?');
    params.push(optionalString(patch.nlt, 'nlt'));
  }
  return mutate('rfi:update', String(id), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database.prepare(`UPDATE rfis SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return shapeRfi(fetchRow('rfis', id));
  });
}

/**
 * The one path that changes RFI state. Answering can create the evidence
 * link that closes the loop back to the requirement/SIR it was raised
 * against, in the same transaction as the state change.
 */
function transitionRfi(id, toState, { answer_report_id: answerReportId, relation } = {}) {
  const row = fetchRow('rfis', id);
  if (!row) throw new HttpError(404, `RFI ${id} not found.`);
  if (!canTransition(row.state, toState)) {
    throw new HttpError(409, `Cannot move an RFI from ${row.state} to ${toState}.`);
  }
  if (toState === 'answered') {
    if (!Number.isInteger(answerReportId)) {
      throw new HttpError(400, 'answer_report_id is required to answer an RFI.');
    }
    assertExists('reports', answerReportId, 'Report');
  }
  return mutate('rfi:transition', `${row.state}->${toState}`, () => {
    database
      .prepare(
        'UPDATE rfis SET state = ?, answer_report_id = COALESCE(?, answer_report_id), updated_at = ? WHERE id = ?',
      )
      .run(toState, answerReportId ?? null, now(), id);
    if (toState === 'answered' && (row.requirement_id || row.sir_id)) {
      const targetKind = row.sir_id ? 'sir' : 'requirement';
      const targetId = row.sir_id ?? row.requirement_id;
      database
        .prepare(
          `INSERT INTO evidence_links (report_id, target_kind, target_id, relation, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          answerReportId,
          targetKind,
          targetId,
          relation ?? 'confirms',
          'Auto-linked from RFI answer.',
          now(),
        );
    }
    return shapeRfi(fetchRow('rfis', id));
  });
}

function deleteRfi(id) {
  assertExists('rfis', id, 'RFI');
  mutate('rfi:delete', String(id), () => {
    database.prepare('DELETE FROM rfis WHERE id = ?').run(id);
  });
}

// -- scenario clock & events --------------------------------------------------

function readClockRow() {
  const row = fetchRow('scenario_clock', 1);
  if (row) return row;
  const timestamp = now();
  database
    .prepare(
      'INSERT INTO scenario_clock (id, base_real_ts, base_scenario_ts, rate, paused) VALUES (1, ?, ?, 1, 1)',
    )
    .run(timestamp, timestamp);
  return fetchRow('scenario_clock', 1);
}

function readClock() {
  const row = readClockRow();
  return { ...row, paused: Boolean(row.paused), now: new Date(scenarioNowMs(row)).toISOString() };
}

function patchClock({ rate, paused, jump_to: jumpTo }) {
  if (rate !== undefined && !(typeof rate === 'number' && rate > 0)) {
    throw new HttpError(400, 'rate must be a positive number.');
  }
  if (paused !== undefined && typeof paused !== 'boolean') {
    throw new HttpError(400, 'paused must be a boolean.');
  }
  let jumpToMs;
  if (jumpTo !== undefined) {
    jumpToMs = new Date(jumpTo).getTime();
    if (Number.isNaN(jumpToMs)) throw new HttpError(400, 'jump_to must be a valid timestamp.');
  }
  return mutate('scenario:clock', 'clock', () => {
    const current = readClockRow();
    const next = reanchor(current, { rate, paused, jumpToMs });
    database
      .prepare(
        'UPDATE scenario_clock SET base_real_ts = ?, base_scenario_ts = ?, rate = ?, paused = ? WHERE id = 1',
      )
      .run(next.base_real_ts, next.base_scenario_ts, next.rate, next.paused ? 1 : 0);
    return readClock();
  });
}

function shapeScenarioEvent(row) {
  return { ...row, payload: JSON.parse(row.payload) };
}

function listScenarioEvents() {
  return database
    .prepare('SELECT * FROM scenario_events ORDER BY trigger_at, id')
    .all()
    .map(shapeScenarioEvent);
}

function createScenarioEvent({ trigger_at: triggerAt, kind, payload }) {
  const triggerMs = new Date(triggerAt).getTime();
  if (Number.isNaN(triggerMs)) throw new HttpError(400, 'trigger_at must be a valid timestamp.');
  requireEnum(kind, 'kind', SCENARIO_EVENT_KINDS);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new HttpError(400, 'payload must be a JSON object.');
  }
  if (kind === 'message' && typeof payload.text !== 'string') {
    throw new HttpError(400, 'A message event needs a payload.text string.');
  }
  // A malformed report inject should fail now, when the Game Master can fix
  // it, not hours later when the clock reaches it mid-exercise.
  if (kind === 'report') {
    validateReportInput({
      text: payload.text,
      reliability: payload.reliability ?? 'F',
      credibility: payload.credibility ?? 6,
    });
  }
  const timestamp = now();
  return mutate(
    'scenario:schedule',
    () => kind,
    () => {
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO scenario_events (trigger_at, kind, payload, state, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          new Date(triggerMs).toISOString(),
          kind,
          JSON.stringify(payload),
          timestamp,
          timestamp,
        );
      return shapeScenarioEvent(fetchRow('scenario_events', Number(lastInsertRowid)));
    },
  );
}

function assertPendingEvent(id) {
  const row = fetchRow('scenario_events', id);
  if (!row) throw new HttpError(404, `Scenario event ${id} not found.`);
  if (row.state !== 'pending') throw new HttpError(409, `Event ${id} is already ${row.state}.`);
  return row;
}

function cancelScenarioEvent(id) {
  assertPendingEvent(id);
  mutate('scenario:cancel', String(id), () => {
    database
      .prepare("UPDATE scenario_events SET state = 'cancelled', updated_at = ? WHERE id = ?")
      .run(now(), id);
  });
}

/**
 * Fires one event: for a report inject, creates the report from the
 * payload. Always called from inside another mutation's transaction
 * (`fireScenarioEvent` or `tickScenario`), so this inserts the report row
 * directly rather than through `createReport`, which would try to open a
 * second, nested transaction.
 */
function fireOne(row) {
  const timestamp = now();
  let createdReportId = null;
  if (row.kind === 'report') {
    const payload = JSON.parse(row.payload);
    const fields = validateReportInput({
      text: payload.text,
      occurred_at: payload.occurred_at ?? row.trigger_at,
      source: payload.source ?? 'Scenario inject',
      author: payload.author ?? 'Game Master',
      reliability: payload.reliability ?? 'F',
      credibility: payload.credibility ?? 6,
    });
    createdReportId = insertReportRow(fields).id;
  }
  database
    .prepare(
      "UPDATE scenario_events SET state = 'fired', fired_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(timestamp, timestamp, row.id);
  return createdReportId;
}

function fireScenarioEvent(id) {
  const row = assertPendingEvent(id);
  return mutate('scenario:fire', String(id), () => {
    fireOne(row);
    return shapeScenarioEvent(fetchRow('scenario_events', id));
  });
}

/** Fires every event whose trigger time has arrived. Idempotent: refiring
 * finds nothing pending left to fire. */
function tickScenario() {
  const clock = readClockRow();
  const nowMs = scenarioNowMs(clock);
  const pending = database.prepare("SELECT * FROM scenario_events WHERE state = 'pending'").all();
  const due = dueEvents(pending, nowMs);
  if (!due.length) return { fired: [] };
  return mutate('scenario:tick', `${due.length} event(s)`, () => {
    const fired = due.map((row) => ({ id: row.id, reportId: fireOne(row) }));
    return { fired };
  });
}

// -- AAR ----------------------------------------------------------------------

function listActivity() {
  return database.prepare('SELECT * FROM activity ORDER BY id DESC').all();
}
