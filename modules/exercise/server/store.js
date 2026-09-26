import { readFileSync } from 'node:fs';

import { formatDtg } from '../../../src/dtg.js';
import { formatMgrs } from '../../../src/geo.js';
import { formatSidc, parseSidc } from '../../../src/symbols/sidc.js';
import { HttpError } from '../../../server/http.js';
import {
  assertCanEdit,
  CELLS,
  canRelease,
  canSee,
  isWhite,
  liveCellsFor,
  normalizeRelease,
  ownerCellForCreate,
  visibilitySql,
} from '../../../server/policy.js';
import { referenceFile } from '../../../server/reference.js';
import { openState, transact } from '../../../server/state.js';
import { computePirFulfillment } from './fulfillment.js';
import { geometryContains } from './geoMatch.js';
import { areaName, planIpbImport } from './ipbImport.js';
import { canTransition } from './rfiMachine.js';
import {
  AFFILIATIONS,
  DEFAULT_COLORS,
  normalizeGeometry,
  normalizeRegionIds,
  planExampleScenario,
  requireColor,
  requirePlaceKind,
} from './scenarioGeography.js';
import { MIGRATIONS } from './schema.js';
import { dueEvents, reanchor, scenarioNowMs } from './scenarioClock.js';

const REQUIREMENT_KINDS = ['PIR', 'FFIR'];
const RELIABILITY = ['A', 'B', 'C', 'D', 'E', 'F'];
const CREDIBILITY = [1, 2, 3, 4, 5, 6];
const TARGET_KINDS = ['requirement', 'sir'];
const RELATIONS = ['confirms', 'denies', 'partial', 'context'];
const RFI_PRIORITIES = ['routine', 'priority', 'immediate'];
const SCENARIO_EVENT_KINDS = ['message', 'report'];

// -- reports: type, structured fields, SIDC, location ------------------------
const REPORT_TYPES = ['free', 'spotrep', 'salute'];
const SALUTE_FIELDS = ['size', 'activity', 'location', 'unit', 'time', 'equipment'];
const SPOTREP_FIELDS = [...SALUTE_FIELDS, 'remarks'];
const FIELDS_BY_TYPE = { free: [], spotrep: SPOTREP_FIELDS, salute: SALUTE_FIELDS };
const MAX_FIELD_LENGTH = 500;

// -- the current situation: tracks --------------------------------------------
const TRACK_STATUSES = ['confirmed', 'suspected', 'destroyed', 'lost'];

// -- collection plan -----------------------------------------------------------
const DISCIPLINES = [
  'HUMINT', 'SIGINT', 'IMINT', 'GEOINT', 'OSINT', 'MASINT', 'UAS', 'RECCE', 'OP', 'OTHER',
];
const TASKING_STATUSES = ['planned', 'tasked', 'active', 'complete', 'cancelled'];

// -- products -------------------------------------------------------------------
const INTSUM_SECTIONS = ['situation', 'significant_activity', 'pir_status', 'assessment', 'outlook'];

let database;
let regionsReference;

export function openStore(file, { regionsFile } = {}) {
  database = openState(file, MIGRATIONS);
  regionsReference = regionsFile
    ? referenceFile(regionsFile, (path) => ({
        data: JSON.parse(readFileSync(path, 'utf8')),
        close() {},
      }))
    : null;
  return {
    listRequirements,
    createRequirement,
    updateRequirement,
    deleteRequirement,
    releaseRequirement,
    createSir,
    updateSir,
    deleteSir,
    createIndicator,
    updateIndicator,
    deleteIndicator,
    importIpbStudy,
    listNais,
    listReports,
    createReport,
    updateReport,
    deleteReport,
    releaseReport,
    createEvidenceLink,
    deleteEvidenceLink,
    listTracks,
    createTrack,
    updateTrack,
    deleteTrack,
    releaseTrack,
    addTrackPosition,
    listCollectors,
    createCollector,
    updateCollector,
    deleteCollector,
    listTaskings,
    createTasking,
    updateTasking,
    deleteTasking,
    listCollectionConflicts,
    listIntsums,
    createIntsum,
    updateIntsum,
    deleteIntsum,
    releaseIntsum,
    draftIntsum,
    listRfis,
    createRfi,
    updateRfi,
    transitionRfi,
    deleteRfi,
    releaseRfi,
    listMessages,
    readClock,
    patchClock,
    listScenarioEvents,
    createScenarioEvent,
    cancelScenarioEvent,
    fireScenarioEvent,
    tickScenario,
    getRegions,
    listScenarios,
    createScenario,
    createExampleScenario,
    getScenario,
    updateScenario,
    deleteScenario,
    duplicateScenario,
    getActiveScenario,
    createCountry,
    updateCountry,
    deleteCountry,
    createPlace,
    updatePlace,
    deletePlace,
    listActivity,
    close,
  };
}

function close() {
  database?.close();
  database = undefined;
  regionsReference?.close();
  regionsReference = undefined;
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

/** A trimmed, non-empty string of at most `maxLength` characters (scenario, country and place names). */
function requireBoundedString(value, name, maxLength) {
  const trimmed = requireString(value, name);
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${name} must be ${maxLength} characters or fewer.`);
  }
  return trimmed;
}

function requireLongitude(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -180 || value > 180) {
    throw new HttpError(400, 'lon must be a finite number between -180 and 180.');
  }
  return value;
}

function requireLatitude(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -90 || value > 90) {
    throw new HttpError(400, 'lat must be a finite number between -90 and 90.');
  }
  return value;
}

/** lon/lat travel together: both present and in range, or both absent. */
function validateLocation(lon, lat) {
  const hasLon = lon !== undefined && lon !== null;
  const hasLat = lat !== undefined && lat !== null;
  if (hasLon !== hasLat) throw new HttpError(400, 'lon and lat must be provided together.');
  if (!hasLon) return { lon: null, lat: null };
  return { lon: requireLongitude(lon), lat: requireLatitude(lat) };
}

/** `null` for an absent SIDC, else its canonical 20-digit form (see src/symbols/sidc.js). */
function validateSidc(sidc) {
  if (sidc === undefined || sidc === null || sidc === '') return null;
  const parts = typeof sidc === 'string' ? parseSidc(sidc) : null;
  if (!parts) throw new HttpError(400, 'sidc must be a 20-digit SIDC.');
  return formatSidc(parts);
}

function requireSidc(sidc) {
  const validated = validateSidc(sidc);
  if (validated === null) throw new HttpError(400, 'sidc is required.');
  return validated;
}

/** `fields` restricted to the keys `reportType` allows, each a string of at most 500 characters. */
function validateFields(reportType, fields) {
  if (fields === undefined || fields === null) return {};
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    throw new HttpError(400, 'fields must be a JSON object.');
  }
  const allowed = FIELDS_BY_TYPE[reportType];
  const result = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) {
      throw new HttpError(400, `fields.${key} is not valid for report_type ${reportType}.`);
    }
    if (typeof value !== 'string') throw new HttpError(400, `fields.${key} must be a string.`);
    if (value.length > MAX_FIELD_LENGTH) {
      throw new HttpError(400, `fields.${key} must be ${MAX_FIELD_LENGTH} characters or fewer.`);
    }
    result[key] = value;
  }
  return result;
}

/** The first NAI (by id) whose geometry contains the point, or null. */
function findMatchingNaiId(lon, lat) {
  if (lon === null || lat === null) return null;
  const candidates = database
    .prepare('SELECT id, geometry FROM nais WHERE geometry IS NOT NULL ORDER BY id')
    .all();
  for (const candidate of candidates) {
    if (geometryContains(JSON.parse(candidate.geometry), lon, lat)) return candidate.id;
  }
  return null;
}

/**
 * A report's `nai_id`: an explicit id (validated), explicit `null` to
 * clear it, or — when not given at all — the auto-match against the point.
 */
function resolveNaiId(explicit, lon, lat) {
  if (explicit !== undefined) {
    if (explicit === null) return null;
    if (!Number.isInteger(explicit)) throw new HttpError(400, 'nai_id must be an integer.');
    assertExists('nais', explicit, 'NAI');
    return explicit;
  }
  return findMatchingNaiId(lon, lat);
}

function resolveTrackId(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) throw new HttpError(400, 'track_id must be an integer.');
  assertExists('tracks', value, 'Track');
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
    // `liveCells` (attached by `withCells`/`deletedWithCells`/the child
    // helpers) is `[owner_cell, ...releasable_to]` (see `liveCellsFor`); a
    // mutation of a non-cell-owned row leaves it absent, so the activity
    // row stays global (`owner_cell` NULL).
    const cells = Array.isArray(result?.liveCells) ? result.liveCells : null;
    const ownerCell = cells ? cells[0] : null;
    const releasableTo = cells ? cells.slice(1) : [];
    database
      .prepare(
        'INSERT INTO activity (at, action, target, detail, owner_cell, releasable_to) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(now(), action, targetLabel, null, ownerCell, JSON.stringify(releasableTo));
    return result;
  });
}

function fetchRow(table, id) {
  return database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) ?? null;
}

function assertExists(table, id, label) {
  if (!fetchRow(table, id)) throw new HttpError(404, `${label} ${id} not found.`);
}

// -- cells (docs/phase1-access.md C2/C3/C4) ------------------------------
//
// Every cell-owned table (requirements, reports, rfis, tracks, collectors,
// taskings, intsums, nais, messages) is filtered by `visibilitySql`/`canSee`
// on every read, stamped by `ownerCellForCreate` on create, and exposes a
// release/reassign path. Child rows (sirs, indicators, evidence_links,
// track_positions) carry no columns of their own: their visibility and live
// cells come from the ancestor cell-owned row.
//
// A mutation of a cell-owned row (directly or through a child) attaches a
// `liveCells` array to what it returns; routes.js lifts that onto
// `request.liveCells` and strips the key before sending the response, so
// server/api.js can publish the right `cells` on the live event (C4).

/** A cell-owned row visible to `user`, or a 404 (never a 403: an invisible
 * row must look the same as a nonexistent one). */
function fetchVisibleRow(user, table, id, label) {
  const row = fetchRow(table, id);
  if (!row || !canSee(user, row)) throw new HttpError(404, `${label} ${id} not found.`);
  return row;
}

/** Every row of a cell-owned table visible to `user`, in `orderBy` order. */
function listVisible(user, table, orderBy) {
  const { sql, params } = visibilitySql(user, { alias: undefined });
  return database.prepare(`SELECT * FROM ${table} WHERE ${sql} ORDER BY ${orderBy}`).all(...params);
}

/** Attaches `liveCells` (C4) to a shaped cell-owned row for routes.js to lift off. */
function withCells(shaped) {
  return { ...shaped, liveCells: liveCellsFor(shaped) };
}

/** Same, but for a delete (`{ deleted: true }` plus the cells the deleted row reached). */
function deletedWithCells(row) {
  return { deleted: true, liveCells: liveCellsFor(row) };
}

/** A `release<Table>(user, id, cells)` closure for the five releasable
 * resources (C3): requirements, reports, tracks, intsums, rfis. */
function makeRelease(table, label, shapeFn) {
  return (user, id, cells) => {
    const row = fetchVisibleRow(user, table, id, label);
    if (!canRelease(user, row)) throw new HttpError(403, `You cannot release this ${label.toLowerCase()}.`);
    const normalized = normalizeRelease(cells, row.owner_cell);
    return mutate(`${table}:release`, String(id), () => {
      database
        .prepare(`UPDATE ${table} SET releasable_to = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(normalized), now(), id);
      return withCells(shapeFn(fetchRow(table, id)));
    });
  };
}

/** White may reassign a cell-owned row's `owner_cell`; a patch's
 * `owner_cell` field is handled uniformly by every update* below. */
function ownerReassignField(user, patch) {
  if (!('owner_cell' in patch)) return null;
  if (!isWhite(user)) throw new HttpError(403, 'Only White may reassign the owning cell.');
  return requireEnum(patch.owner_cell, 'owner_cell', CELLS);
}

// -- requirements tree ------------------------------------------------------

function shapeIndicator(row) {
  return {
    id: row.id,
    sir_id: row.sir_id,
    description: row.description,
    observed: Boolean(row.observed),
    source: row.source,
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
    nai_id: row.nai_id,
    indicators,
    fulfillment: sirFulfillment(row.id),
    source: row.source,
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
    source: row.source,
    owner_cell: row.owner_cell,
    releasable_to: JSON.parse(row.releasable_to),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listRequirements(user) {
  return listVisible(user, 'requirements', 'priority DESC, created_at, id').map(shapeRequirement);
}

function createRequirement(user, { kind, text, decision_point: decisionPoint, ltiov, priority, owner_cell: ownerCell }) {
  requireEnum(kind, 'kind', REQUIREMENT_KINDS);
  const cleanText = requireString(text, 'text');
  const cleanOwner = ownerCellForCreate(user, ownerCell);
  const timestamp = now();
  return mutate(
    'requirement:create',
    () => cleanText,
    () => {
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO requirements (kind, text, decision_point, ltiov, priority, owner_cell, releasable_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
        )
        .run(
          kind,
          cleanText,
          optionalString(decisionPoint, 'decision_point'),
          optionalString(ltiov, 'ltiov'),
          Number.isInteger(priority) ? priority : 0,
          cleanOwner,
          timestamp,
          timestamp,
        );
      return withCells(shapeRequirement(fetchRow('requirements', Number(lastInsertRowid))));
    },
  );
}

function updateRequirement(user, id, patch) {
  const existing = fetchVisibleRow(user, 'requirements', id, 'Requirement');
  assertCanEdit(user, existing);
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
  const reassign = ownerReassignField(user, patch);
  if (reassign) {
    fields.push('owner_cell = ?');
    params.push(reassign);
  }
  return mutate('requirement:update', String(id), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database
        .prepare(`UPDATE requirements SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, id);
    }
    return withCells(shapeRequirement(fetchRow('requirements', id)));
  });
}

function deleteRequirement(user, id) {
  const row = fetchVisibleRow(user, 'requirements', id, 'Requirement');
  assertCanEdit(user, row);
  return mutate('requirement:delete', String(id), () => {
    database.prepare('DELETE FROM requirements WHERE id = ?').run(id);
    return deletedWithCells(row);
  });
}

const releaseRequirement = makeRelease('requirements', 'Requirement', shapeRequirement);

/** The requirement a SIR belongs to, for visibility inheritance — null if
 * the SIR (or its requirement) doesn't exist. */
function requirementForSir(sirId) {
  const sir = fetchRow('sirs', sirId);
  if (!sir) return null;
  return fetchRow('requirements', sir.requirement_id);
}

/** The requirement an indicator belongs to (via its SIR), for visibility inheritance. */
function requirementForIndicator(indicatorId) {
  const indicator = fetchRow('indicators', indicatorId);
  if (!indicator) return null;
  return requirementForSir(indicator.sir_id);
}

function assertSirVisible(user, sirId) {
  const requirement = requirementForSir(sirId);
  if (!requirement || !canSee(user, requirement)) throw new HttpError(404, `SIR ${sirId} not found.`);
  return requirement;
}

function assertIndicatorVisible(user, indicatorId) {
  const requirement = requirementForIndicator(indicatorId);
  if (!requirement || !canSee(user, requirement)) {
    throw new HttpError(404, `Indicator ${indicatorId} not found.`);
  }
  return requirement;
}

function createSir(
  user,
  requirementId,
  { text, time_window_start: start, time_window_end: end, nai_id: naiId },
) {
  const requirement = fetchVisibleRow(user, 'requirements', requirementId, 'Requirement');
  assertCanEdit(user, requirement);
  const cleanText = requireString(text, 'text');
  const validNaiId = naiId === undefined ? null : resolveNaiId(naiId, null, null);
  const timestamp = now();
  return mutate(
    'sir:create',
    () => cleanText,
    () => {
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO sirs (requirement_id, text, time_window_start, time_window_end, nai_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          requirementId,
          cleanText,
          optionalString(start, 'time_window_start'),
          optionalString(end, 'time_window_end'),
          validNaiId,
          timestamp,
          timestamp,
        );
      return { ...shapeSir(fetchRow('sirs', Number(lastInsertRowid))), liveCells: liveCellsFor(requirement) };
    },
  );
}

function updateSir(user, id, patch) {
  const requirement = assertSirVisible(user, id);
  assertCanEdit(user, requirement);
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
  if ('nai_id' in patch) {
    fields.push('nai_id = ?');
    params.push(resolveNaiId(patch.nai_id, null, null));
  }
  return mutate('sir:update', String(id), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database.prepare(`UPDATE sirs SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return { ...shapeSir(fetchRow('sirs', id)), liveCells: liveCellsFor(requirement) };
  });
}

function deleteSir(user, id) {
  const requirement = assertSirVisible(user, id);
  assertCanEdit(user, requirement);
  return mutate('sir:delete', String(id), () => {
    database.prepare('DELETE FROM sirs WHERE id = ?').run(id);
    return deletedWithCells(requirement);
  });
}

function createIndicator(user, sirId, { description }) {
  const requirement = assertSirVisible(user, sirId);
  assertCanEdit(user, requirement);
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
      return {
        ...shapeIndicator(fetchRow('indicators', Number(lastInsertRowid))),
        liveCells: liveCellsFor(requirement),
      };
    },
  );
}

function updateIndicator(user, id, patch) {
  const requirement = assertIndicatorVisible(user, id);
  assertCanEdit(user, requirement);
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
    return { ...shapeIndicator(fetchRow('indicators', id)), liveCells: liveCellsFor(requirement) };
  });
}

function deleteIndicator(user, id) {
  const requirement = assertIndicatorVisible(user, id);
  assertCanEdit(user, requirement);
  return mutate('indicator:delete', String(id), () => {
    database.prepare('DELETE FROM indicators WHERE id = ?').run(id);
    return deletedWithCells(requirement);
  });
}

// -- IPB import -----------------------------------------------------------------

/**
 * Upsert one derived row by `source`. `derived` holds the columns IPB owns
 * (rewritten on every import); `initial` holds columns set only on insert,
 * because the exercise owns them afterwards (e.g. an indicator's `observed`).
 * Returns the row id and whether it was created, changed, or left alone.
 */
function upsertBySource(table, source, derived, initial = {}) {
  const row = database.prepare(`SELECT * FROM ${table} WHERE source = ?`).get(source);
  const timestamp = now();
  if (!row) {
    const columns = {
      ...derived,
      ...initial,
      source,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const names = Object.keys(columns);
    const { lastInsertRowid } = database
      .prepare(
        `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      )
      .run(...Object.values(columns));
    return { id: Number(lastInsertRowid), outcome: 'created' };
  }
  const changed = Object.keys(derived).filter((name) => row[name] !== derived[name]);
  if (!changed.length) return { id: row.id, outcome: 'unchanged' };
  database
    .prepare(
      `UPDATE ${table} SET ${changed.map((name) => `${name} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    )
    .run(...changed.map((name) => derived[name]), timestamp, row.id);
  return { id: row.id, outcome: 'updated' };
}

/**
 * Import (or refresh) an IPB study's event matrix as PIR/SIR/indicator rows.
 * Never deletes: rows that came from this study but are no longer in it are
 * returned by text under `stale` and left for the collection manager to
 * remove, since they may already carry evidence links and observations.
 */
function importIpbStudy(user, input) {
  const ownerCell = ownerCellForCreate(user, input?.owner_cell);
  const plan = planIpbImport(input);
  const summary = Object.fromEntries(
    ['requirements', 'sirs', 'indicators', 'nais'].map((table) => [
      table,
      { created: 0, updated: 0, unchanged: 0, stale: [] },
    ]),
  );
  const tally = (table, outcome) => {
    summary[table][outcome] += 1;
  };
  return mutate('ipb:import', plan.studyName, () => {
    const naiIds = new Map();
    for (const nai of plan.nais) {
      const { id, outcome } = upsertBySource(
        'nais',
        nai.source,
        {
          study_id: nai.study_id,
          feature_id: nai.feature_id,
          kind: nai.kind,
          label: nai.label,
          geometry: nai.geometry === null ? null : JSON.stringify(nai.geometry),
        },
        { owner_cell: ownerCell, releasable_to: '[]' },
      );
      naiIds.set(nai.source, id);
      tally('nais', outcome);
    }
    const requirementIds = new Map();
    for (const requirement of plan.requirements) {
      const { id, outcome } = upsertBySource(
        'requirements',
        requirement.source,
        { text: requirement.text },
        { kind: 'PIR', priority: 0, owner_cell: ownerCell, releasable_to: '[]' },
      );
      requirementIds.set(requirement.source, id);
      tally('requirements', outcome);
    }
    const sirIds = new Map();
    for (const sir of plan.sirs) {
      const { id, outcome } = upsertBySource('sirs', sir.source, {
        requirement_id: requirementIds.get(sir.requirementSource),
        text: sir.text,
        nai_id: sir.naiSource ? (naiIds.get(sir.naiSource) ?? null) : null,
      });
      sirIds.set(sir.source, id);
      tally('sirs', outcome);
    }
    for (const indicator of plan.indicators) {
      const { outcome } = upsertBySource(
        'indicators',
        indicator.source,
        { sir_id: sirIds.get(indicator.sirSource), description: indicator.description },
        { observed: indicator.observed ? 1 : 0 },
      );
      tally('indicators', outcome);
    }
    for (const [table, textColumn, current] of [
      ['requirements', 'text', plan.requirements],
      ['sirs', 'text', plan.sirs],
      ['indicators', 'description', plan.indicators],
      ['nais', 'label', plan.nais],
    ]) {
      const live = new Set(current.map((row) => row.source));
      summary[table].stale = database
        .prepare(
          `SELECT source, ${textColumn} AS text FROM ${table} WHERE substr(source, 1, ?) = ? ORDER BY id`,
        )
        .all(plan.prefix.length, plan.prefix)
        .filter((row) => !live.has(row.source))
        .map((row) => row.text);
    }
    return { ...summary, liveCells: liveCellsFor({ owner_cell: ownerCell, releasable_to: [] }) };
  });
}

function shapeNai(row) {
  return {
    id: row.id,
    source: row.source,
    study_id: row.study_id,
    feature_id: row.feature_id,
    kind: row.kind,
    label: row.label,
    geometry: row.geometry ? JSON.parse(row.geometry) : null,
    owner_cell: row.owner_cell,
    releasable_to: JSON.parse(row.releasable_to),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listNais(user) {
  return listVisible(user, 'nais', 'id').map(shapeNai);
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
    lon: row.lon,
    lat: row.lat,
    report_type: row.report_type,
    fields: JSON.parse(row.fields),
    sidc: row.sidc,
    nai_id: row.nai_id,
    track_id: row.track_id,
    links,
    owner_cell: row.owner_cell,
    releasable_to: JSON.parse(row.releasable_to),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listReports(user) {
  return listVisible(user, 'reports', 'created_at DESC, id DESC').map(shapeReport);
}

/**
 * Validates and shapes report fields; does not touch the database. Shared
 * by `createReport`/`updateReport` and by `createScenarioEvent`, which
 * validates a `report`-kind inject's payload the same way at schedule time
 * (see docs/staff-plan.md C7) so a malformed inject fails immediately
 * instead of hours later when the clock reaches it.
 */
function validateReportInput({
  text,
  occurred_at: occurredAt,
  source,
  author,
  reliability,
  credibility,
  lon,
  lat,
  report_type: reportType = 'free',
  fields,
  sidc,
}) {
  const type = requireEnum(reportType, 'report_type', REPORT_TYPES);
  const location = validateLocation(lon, lat);
  return {
    text: requireString(text, 'text'),
    occurred_at: optionalString(occurredAt, 'occurred_at'),
    source: optionalString(source, 'source'),
    author: optionalString(author, 'author'),
    reliability: requireEnum(reliability, 'reliability', RELIABILITY),
    credibility: requireEnum(credibility, 'credibility', CREDIBILITY),
    lon: location.lon,
    lat: location.lat,
    report_type: type,
    fields: validateFields(type, fields),
    sidc: validateSidc(sidc),
  };
}

/**
 * `validateReportInput` plus the database-touching parts: resolving
 * `nai_id` (explicit, or auto point-in-polygon/point-radius against the
 * point) and `track_id` (explicit only). Used by both `createReport` and
 * `fireOne`, so a report created by a scenario inject gets the same
 * auto-NAI treatment as one entered by hand.
 */
function prepareReportFields(input) {
  const fields = validateReportInput(input);
  return {
    ...fields,
    nai_id: resolveNaiId(input.nai_id, fields.lon, fields.lat),
    track_id: resolveTrackId(input.track_id),
  };
}

/**
 * The raw insert, with no transaction of its own: `fireOne` calls this from
 * inside an already-open transaction (this `transact` helper does not
 * support nesting), while `createReport` wraps it in `mutate` for the normal
 * write path. `fields` is the output of `prepareReportFields`.
 * `owner_cell`/`releasable_to` default to White/none for a hand-entered
 * report and are overridden by `fireOne` for a fired inject.
 */
function insertReportRow(fields, { ownerCell = 'white', releasableTo = [] } = {}) {
  const timestamp = now();
  const { lastInsertRowid } = database
    .prepare(
      `INSERT INTO reports
         (text, occurred_at, source, author, reliability, credibility,
          lon, lat, report_type, fields, sidc, nai_id, track_id, owner_cell, releasable_to, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fields.text,
      fields.occurred_at,
      fields.source,
      fields.author,
      fields.reliability,
      fields.credibility,
      fields.lon,
      fields.lat,
      fields.report_type,
      JSON.stringify(fields.fields),
      fields.sidc,
      fields.nai_id,
      fields.track_id,
      ownerCell,
      JSON.stringify(releasableTo),
      timestamp,
      timestamp,
    );
  return shapeReport(fetchRow('reports', Number(lastInsertRowid)));
}

function createReport(user, input) {
  const ownerCell = ownerCellForCreate(user, input.owner_cell);
  const fields = prepareReportFields(input);
  return mutate(
    'report:create',
    () => fields.text,
    () => withCells(insertReportRow(fields, { ownerCell })),
  );
}

function updateReport(user, id, patch) {
  const row = fetchVisibleRow(user, 'reports', id, 'Report');
  assertCanEdit(user, row);
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

  let reportType = row.report_type;
  if ('report_type' in patch) {
    reportType = requireEnum(patch.report_type, 'report_type', REPORT_TYPES);
    fields.push('report_type = ?');
    params.push(reportType);
  }
  if ('fields' in patch) {
    fields.push('fields = ?');
    params.push(JSON.stringify(validateFields(reportType, patch.fields)));
  }
  if ('sidc' in patch) {
    fields.push('sidc = ?');
    params.push(validateSidc(patch.sidc));
  }

  const locationChanged = 'lon' in patch || 'lat' in patch;
  let lon = row.lon;
  let lat = row.lat;
  if (locationChanged) {
    const location = validateLocation('lon' in patch ? patch.lon : row.lon, 'lat' in patch ? patch.lat : row.lat);
    lon = location.lon;
    lat = location.lat;
    fields.push('lon = ?', 'lat = ?');
    params.push(lon, lat);
  }

  // Re-run the auto-NAI match on a location change, unless the caller is
  // setting nai_id explicitly in the same request.
  if ('nai_id' in patch) {
    fields.push('nai_id = ?');
    params.push(resolveNaiId(patch.nai_id, lon, lat));
  } else if (locationChanged) {
    fields.push('nai_id = ?');
    params.push(findMatchingNaiId(lon, lat));
  }

  if ('track_id' in patch) {
    fields.push('track_id = ?');
    params.push(resolveTrackId(patch.track_id));
  }
  const reassign = ownerReassignField(user, patch);
  if (reassign) {
    fields.push('owner_cell = ?');
    params.push(reassign);
  }

  return mutate('report:update', String(id), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database.prepare(`UPDATE reports SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return withCells(shapeReport(fetchRow('reports', id)));
  });
}

function deleteReport(user, id) {
  const row = fetchVisibleRow(user, 'reports', id, 'Report');
  assertCanEdit(user, row);
  return mutate('report:delete', String(id), () => {
    database.prepare('DELETE FROM reports WHERE id = ?').run(id);
    return deletedWithCells(row);
  });
}

const releaseReport = makeRelease('reports', 'Report', shapeReport);

function assertEvidenceTarget(targetKind, targetId) {
  const table = targetKind === 'requirement' ? 'requirements' : 'sirs';
  if (!fetchRow(table, targetId)) {
    throw new HttpError(400, `Unknown ${targetKind} id ${targetId}.`);
  }
}

function createEvidenceLink(
  user,
  reportId,
  { target_kind: targetKind, target_id: targetId, relation, note },
) {
  // C2b: an evidence link needs canSee on the report (it's cited, not
  // changed) but canEdit on the target — the requirement or SIR the link
  // actually mutates (gains an inbound link). This is how a cell can cite
  // a report merely released to it (e.g. a White inject) as evidence for
  // its own PIR, while still being unable to attach evidence to a PIR it
  // doesn't own.
  const report = fetchVisibleRow(user, 'reports', reportId, 'Report');
  requireEnum(targetKind, 'target_kind', TARGET_KINDS);
  if (!Number.isInteger(targetId)) throw new HttpError(400, 'target_id must be an integer.');
  assertEvidenceTarget(targetKind, targetId);
  const targetOwner = targetKind === 'requirement' ? fetchRow('requirements', targetId) : requirementForSir(targetId);
  assertCanEdit(user, targetOwner);
  requireEnum(relation, 'relation', RELATIONS);
  return mutate('evidence:link', `report:${reportId}`, () => {
    const { lastInsertRowid } = database
      .prepare(
        `INSERT INTO evidence_links (report_id, target_kind, target_id, relation, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(reportId, targetKind, targetId, relation, optionalString(note, 'note'), now());
    return {
      ...shapeEvidenceLink(fetchRow('evidence_links', Number(lastInsertRowid))),
      liveCells: liveCellsFor(report),
    };
  });
}

function deleteEvidenceLink(user, id) {
  const link = fetchRow('evidence_links', id);
  const report = link ? fetchRow('reports', link.report_id) : null;
  if (!link || !report || !canSee(user, report)) {
    throw new HttpError(404, `Evidence link ${id} not found.`);
  }
  // C2b: deleting a link changes its target (the requirement/SIR loses an
  // inbound link), so it needs canEdit on the target, not the report.
  const target =
    link.target_kind === 'requirement' ? fetchRow('requirements', link.target_id) : requirementForSir(link.target_id);
  assertCanEdit(user, target);
  return mutate('evidence:unlink', String(id), () => {
    database.prepare('DELETE FROM evidence_links WHERE id = ?').run(id);
    return deletedWithCells(report);
  });
}

// -- the current situation: tracks --------------------------------------------
//
// `tracks` holds the head (most recent) position; `track_positions` is the
// full history. The head only ever moves forward in `observed_at` — an
// out-of-order report still gets recorded, but cannot move it backwards.

function shapeTrackPosition(row) {
  return {
    id: row.id,
    lon: row.lon,
    lat: row.lat,
    observed_at: row.observed_at,
    report_id: row.report_id,
  };
}

function shapeTrack(row) {
  const history = database
    .prepare('SELECT * FROM track_positions WHERE track_id = ? ORDER BY observed_at, id')
    .all(row.id)
    .map(shapeTrackPosition);
  return {
    id: row.id,
    sidc: row.sidc,
    designation: row.designation,
    status: row.status,
    lon: row.lon,
    lat: row.lat,
    observed_at: row.observed_at,
    notes: row.notes,
    history,
    owner_cell: row.owner_cell,
    releasable_to: JSON.parse(row.releasable_to),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listTracks(user) {
  return listVisible(user, 'tracks', 'observed_at DESC, id DESC').map(shapeTrack);
}

function getTrack(id) {
  const row = fetchRow('tracks', id);
  if (!row) throw new HttpError(404, `Track ${id} not found.`);
  return shapeTrack(row);
}


function requireTimestamp(value, name) {
  const text = requireString(value, name);
  if (Number.isNaN(new Date(text).getTime())) {
    throw new HttpError(400, `${name} must be a valid timestamp.`);
  }
  return text;
}

function createTrack(user, { sidc, designation, status, lon, lat, observed_at: observedAt, notes, owner_cell: ownerCell }) {
  const validSidc = requireSidc(sidc);
  const validStatus = requireEnum(status ?? 'confirmed', 'status', TRACK_STATUSES);
  const validLon = requireLongitude(lon);
  const validLat = requireLatitude(lat);
  const validObserved = requireTimestamp(observedAt, 'observed_at');
  const validDesignation = optionalString(designation, 'designation');
  const validNotes = optionalString(notes, 'notes');
  const cleanOwner = ownerCellForCreate(user, ownerCell);
  return mutate(
    'track:create',
    () => validDesignation ?? validSidc,
    () => {
      const timestamp = now();
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO tracks (sidc, designation, status, lon, lat, observed_at, notes, owner_cell, releasable_to, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
        )
        .run(
          validSidc,
          validDesignation,
          validStatus,
          validLon,
          validLat,
          validObserved,
          validNotes,
          cleanOwner,
          timestamp,
          timestamp,
        );
      const id = Number(lastInsertRowid);
      database
        .prepare(
          `INSERT INTO track_positions (track_id, lon, lat, observed_at, report_id, created_at)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .run(id, validLon, validLat, validObserved, timestamp);
      return withCells(getTrack(id));
    },
  );
}

function updateTrack(user, id, patch) {
  const existing = fetchVisibleRow(user, 'tracks', id, 'Track');
  assertCanEdit(user, existing);
  const fields = [];
  const params = [];
  if ('sidc' in patch) {
    fields.push('sidc = ?');
    params.push(requireSidc(patch.sidc));
  }
  if ('designation' in patch) {
    fields.push('designation = ?');
    params.push(optionalString(patch.designation, 'designation'));
  }
  if ('status' in patch) {
    fields.push('status = ?');
    params.push(requireEnum(patch.status, 'status', TRACK_STATUSES));
  }
  if ('notes' in patch) {
    fields.push('notes = ?');
    params.push(optionalString(patch.notes, 'notes'));
  }
  const reassign = ownerReassignField(user, patch);
  if (reassign) {
    fields.push('owner_cell = ?');
    params.push(reassign);
  }
  return mutate('track:update', String(id), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database.prepare(`UPDATE tracks SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return withCells(getTrack(id));
  });
}

function deleteTrack(user, id) {
  const row = fetchVisibleRow(user, 'tracks', id, 'Track');
  assertCanEdit(user, row);
  return mutate('track:delete', String(id), () => {
    database.prepare('DELETE FROM tracks WHERE id = ?').run(id);
    return deletedWithCells(row);
  });
}

const releaseTrack = makeRelease('tracks', 'Track', (row) => getTrack(row.id));

/**
 * Appends a position to a track's history. The head (`tracks.lon/lat/observed_at`)
 * only moves when the new position is at least as recent as the current
 * head, so a late-arriving, out-of-order report enriches history without
 * dragging the map picture backwards. When `report_id` is given, that
 * report is linked back to this track.
 */
function addTrackPosition(user, trackId, { lon, lat, observed_at: observedAt, report_id: reportId }) {
  const track = fetchRow('tracks', trackId);
  if (!track || !canSee(user, track)) throw new HttpError(404, `Track ${trackId} not found.`);
  assertCanEdit(user, track);
  const validLon = requireLongitude(lon);
  const validLat = requireLatitude(lat);
  const validObserved = requireTimestamp(observedAt, 'observed_at');
  const validReportId = resolveTrackReportId(user, reportId);
  return mutate('track:position', String(trackId), () => {
    const timestamp = now();
    database
      .prepare(
        `INSERT INTO track_positions (track_id, lon, lat, observed_at, report_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(trackId, validLon, validLat, validObserved, validReportId, timestamp);
    if (new Date(validObserved).getTime() >= new Date(track.observed_at).getTime()) {
      database
        .prepare('UPDATE tracks SET lon = ?, lat = ?, observed_at = ?, updated_at = ? WHERE id = ?')
        .run(validLon, validLat, validObserved, timestamp, trackId);
    }
    if (validReportId !== null) {
      database.prepare('UPDATE reports SET track_id = ? WHERE id = ?').run(trackId, validReportId);
    }
    return { ...getTrack(trackId), liveCells: liveCellsFor(track) };
  });
}

function resolveTrackReportId(user, reportId) {
  if (reportId === undefined || reportId === null) return null;
  if (!Number.isInteger(reportId)) throw new HttpError(400, 'report_id must be an integer.');
  fetchVisibleRow(user, 'reports', reportId, 'Report');
  return reportId;
}

// -- collection plan: collectors + taskings ------------------------------------

function shapeCollector(row) {
  return { ...row, releasable_to: JSON.parse(row.releasable_to) };
}

function listCollectors(user) {
  return listVisible(user, 'collectors', 'name, id').map(shapeCollector);
}

function requirePositiveNumberOrNull(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, `${name} must be a positive number.`);
  }
  return value;
}

/** `available_from`/`available_to` are each optional, but if both are given the first must precede the second. */
function validateAvailability(from, to) {
  const validFrom = optionalString(from, 'available_from');
  const validTo = optionalString(to, 'available_to');
  if (validFrom && validTo && new Date(validFrom).getTime() >= new Date(validTo).getTime()) {
    throw new HttpError(400, 'available_from must be before available_to.');
  }
  return { validFrom, validTo };
}

function createCollector(user, {
  name,
  discipline,
  unit,
  range_km: rangeKm,
  available_from: availableFrom,
  available_to: availableTo,
  notes,
  owner_cell: ownerCell,
}) {
  const validName = requireString(name, 'name');
  const validDiscipline = requireEnum(discipline, 'discipline', DISCIPLINES);
  const validUnit = optionalString(unit, 'unit');
  const validRange = requirePositiveNumberOrNull(rangeKm, 'range_km');
  const { validFrom, validTo } = validateAvailability(availableFrom, availableTo);
  const validNotes = optionalString(notes, 'notes');
  const cleanOwner = ownerCellForCreate(user, ownerCell);
  return mutate('collector:create', () => validName, () => {
    const timestamp = now();
    const { lastInsertRowid } = database
      .prepare(
        `INSERT INTO collectors (name, discipline, unit, range_km, available_from, available_to, notes, owner_cell, releasable_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      )
      .run(
        validName,
        validDiscipline,
        validUnit,
        validRange,
        validFrom,
        validTo,
        validNotes,
        cleanOwner,
        timestamp,
        timestamp,
      );
    return withCells(shapeCollector(fetchRow('collectors', Number(lastInsertRowid))));
  });
}

function updateCollector(user, id, patch) {
  const row = fetchVisibleRow(user, 'collectors', id, 'Collector');
  assertCanEdit(user, row);
  const fields = [];
  const params = [];
  if ('name' in patch) {
    fields.push('name = ?');
    params.push(requireString(patch.name, 'name'));
  }
  if ('discipline' in patch) {
    fields.push('discipline = ?');
    params.push(requireEnum(patch.discipline, 'discipline', DISCIPLINES));
  }
  if ('unit' in patch) {
    fields.push('unit = ?');
    params.push(optionalString(patch.unit, 'unit'));
  }
  if ('range_km' in patch) {
    fields.push('range_km = ?');
    params.push(requirePositiveNumberOrNull(patch.range_km, 'range_km'));
  }
  if ('available_from' in patch || 'available_to' in patch) {
    const from = 'available_from' in patch ? patch.available_from : row.available_from;
    const to = 'available_to' in patch ? patch.available_to : row.available_to;
    const validated = validateAvailability(from, to);
    if ('available_from' in patch) {
      fields.push('available_from = ?');
      params.push(validated.validFrom);
    }
    if ('available_to' in patch) {
      fields.push('available_to = ?');
      params.push(validated.validTo);
    }
  }
  if ('notes' in patch) {
    fields.push('notes = ?');
    params.push(optionalString(patch.notes, 'notes'));
  }
  const reassign = ownerReassignField(user, patch);
  if (reassign) {
    fields.push('owner_cell = ?');
    params.push(reassign);
  }
  return mutate('collector:update', String(id), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database.prepare(`UPDATE collectors SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return withCells(shapeCollector(fetchRow('collectors', id)));
  });
}

function deleteCollector(user, id) {
  const row = fetchVisibleRow(user, 'collectors', id, 'Collector');
  assertCanEdit(user, row);
  return mutate('collector:delete', String(id), () => {
    database.prepare('DELETE FROM collectors WHERE id = ?').run(id);
    return deletedWithCells(row);
  });
}

/** "COLLECTOR x: collect SIR y at NAI z from DTG to DTG; report NLT LTIOV". */
function generateSor(row, collector, sir, nai) {
  const collectorName = collector ? collector.name : `Collector #${row.collector_id}`;
  const sirText = sir ? sir.text : `SIR #${row.sir_id}`;
  const area = nai ? areaName(nai.kind, nai.label) : 'no NAI';
  const start = formatDtg(new Date(row.start_at).getTime());
  const end = formatDtg(new Date(row.end_at).getTime());
  const requirement = sir ? fetchRow('requirements', sir.requirement_id) : null;
  const ltiov = requirement?.ltiov ? formatDtg(new Date(requirement.ltiov).getTime()) : 'unset';
  return `${collectorName}: collect ${sirText} at ${area} from ${start} to ${end}; report NLT ${ltiov}`;
}

function shapeTasking(row) {
  const collector = fetchRow('collectors', row.collector_id);
  const sir = fetchRow('sirs', row.sir_id);
  const nai = row.nai_id ? fetchRow('nais', row.nai_id) : null;
  return {
    id: row.id,
    collector_id: row.collector_id,
    sir_id: row.sir_id,
    nai_id: row.nai_id,
    start_at: row.start_at,
    end_at: row.end_at,
    status: row.status,
    report_id: row.report_id,
    notes: row.notes,
    sor: generateSor(row, collector, sir, nai),
    owner_cell: row.owner_cell,
    releasable_to: JSON.parse(row.releasable_to),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listTaskings(user) {
  return listVisible(user, 'taskings', 'start_at, id').map(shapeTasking);
}

function validateTaskingWindow(startAt, endAt) {
  const start = requireTimestamp(startAt, 'start_at');
  const end = requireTimestamp(endAt, 'end_at');
  if (new Date(start).getTime() >= new Date(end).getTime()) {
    throw new HttpError(400, 'start_at must be before end_at.');
  }
  return { start, end };
}

function requireCollectorId(user, value) {
  if (!Number.isInteger(value)) throw new HttpError(400, 'collector_id must be an integer.');
  fetchVisibleRow(user, 'collectors', value, 'Collector');
  return value;
}

function requireSirId(user, value) {
  if (!Number.isInteger(value)) throw new HttpError(400, 'sir_id must be an integer.');
  assertSirVisible(user, value);
  return value;
}

function resolveTaskingReportId(user, value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) throw new HttpError(400, 'report_id must be an integer.');
  fetchVisibleRow(user, 'reports', value, 'Report');
  return value;
}

function createTasking(user, {
  collector_id: collectorId,
  sir_id: sirId,
  nai_id: naiId,
  start_at: startAt,
  end_at: endAt,
  status,
  report_id: reportId,
  notes,
  owner_cell: ownerCell,
}) {
  const validCollectorId = requireCollectorId(user, collectorId);
  const validSirId = requireSirId(user, sirId);
  const validNaiId = naiId === undefined ? null : resolveNaiId(naiId, null, null);
  const { start, end } = validateTaskingWindow(startAt, endAt);
  const validStatus = requireEnum(status ?? 'planned', 'status', TASKING_STATUSES);
  const validReportId = resolveTaskingReportId(user, reportId);
  const validNotes = optionalString(notes, 'notes');
  const cleanOwner = ownerCellForCreate(user, ownerCell);
  return mutate(
    'tasking:create',
    () => `collector:${validCollectorId} sir:${validSirId}`,
    () => {
      const timestamp = now();
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO taskings (collector_id, sir_id, nai_id, start_at, end_at, status, report_id, notes, owner_cell, releasable_to, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
        )
        .run(
          validCollectorId,
          validSirId,
          validNaiId,
          start,
          end,
          validStatus,
          validReportId,
          validNotes,
          cleanOwner,
          timestamp,
          timestamp,
        );
      return withCells(shapeTasking(fetchRow('taskings', Number(lastInsertRowid))));
    },
  );
}

function updateTasking(user, id, patch) {
  const row = fetchVisibleRow(user, 'taskings', id, 'Tasking');
  assertCanEdit(user, row);
  const fields = [];
  const params = [];
  if ('collector_id' in patch) {
    fields.push('collector_id = ?');
    params.push(requireCollectorId(user, patch.collector_id));
  }
  if ('sir_id' in patch) {
    fields.push('sir_id = ?');
    params.push(requireSirId(user, patch.sir_id));
  }
  if ('nai_id' in patch) {
    fields.push('nai_id = ?');
    params.push(resolveNaiId(patch.nai_id, null, null));
  }
  const startAt = 'start_at' in patch ? patch.start_at : row.start_at;
  const endAt = 'end_at' in patch ? patch.end_at : row.end_at;
  if ('start_at' in patch || 'end_at' in patch) {
    const { start, end } = validateTaskingWindow(startAt, endAt);
    if ('start_at' in patch) {
      fields.push('start_at = ?');
      params.push(start);
    }
    if ('end_at' in patch) {
      fields.push('end_at = ?');
      params.push(end);
    }
  }
  if ('status' in patch) {
    fields.push('status = ?');
    params.push(requireEnum(patch.status, 'status', TASKING_STATUSES));
  }
  if ('report_id' in patch) {
    fields.push('report_id = ?');
    params.push(resolveTaskingReportId(user, patch.report_id));
  }
  if ('notes' in patch) {
    fields.push('notes = ?');
    params.push(optionalString(patch.notes, 'notes'));
  }
  const reassign = ownerReassignField(user, patch);
  if (reassign) {
    fields.push('owner_cell = ?');
    params.push(reassign);
  }
  return mutate('tasking:update', String(id), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database.prepare(`UPDATE taskings SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return withCells(shapeTasking(fetchRow('taskings', id)));
  });
}

function deleteTasking(user, id) {
  const row = fetchVisibleRow(user, 'taskings', id, 'Tasking');
  assertCanEdit(user, row);
  return mutate('tasking:delete', String(id), () => {
    database.prepare('DELETE FROM taskings WHERE id = ?').run(id);
    return deletedWithCells(row);
  });
}

/**
 * Two kinds of conflict: two taskings of the same collector that overlap in
 * time, and a tasking scheduled outside its collector's availability
 * window. Read-only, so no activity entry.
 */
function listCollectionConflicts(user) {
  const taskings = listVisible(user, 'taskings', 'collector_id, start_at');
  const collectors = new Map(listVisible(user, 'collectors', 'id').map((c) => [c.id, c]));

  const byCollector = new Map();
  for (const tasking of taskings) {
    if (!byCollector.has(tasking.collector_id)) byCollector.set(tasking.collector_id, []);
    byCollector.get(tasking.collector_id).push(tasking);
  }
  const overlaps = [];
  for (const [collectorId, list] of byCollector) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (new Date(a.start_at) < new Date(b.end_at) && new Date(b.start_at) < new Date(a.end_at)) {
          overlaps.push({ kind: 'overlap', collector_id: collectorId, tasking_ids: [a.id, b.id] });
        }
      }
    }
  }

  const outside = [];
  for (const tasking of taskings) {
    const collector = collectors.get(tasking.collector_id);
    if (!collector) continue;
    const from = collector.available_from ? new Date(collector.available_from) : null;
    const to = collector.available_to ? new Date(collector.available_to) : null;
    const start = new Date(tasking.start_at);
    const end = new Date(tasking.end_at);
    if ((from && start < from) || (to && end > to)) {
      outside.push({ kind: 'unavailable', collector_id: tasking.collector_id, tasking_id: tasking.id });
    }
  }

  return { overlaps, outside };
}

// -- products: INTSUM -----------------------------------------------------------

function shapeIntsum(row) {
  return { ...row, sections: JSON.parse(row.sections), releasable_to: JSON.parse(row.releasable_to) };
}

function listIntsums(user) {
  return listVisible(user, 'intsums', 'period_start DESC, id DESC').map(shapeIntsum);
}

function validateSectionKeys(sections) {
  if (typeof sections !== 'object' || sections === null || Array.isArray(sections)) {
    throw new HttpError(400, 'sections must be a JSON object.');
  }
  for (const key of Object.keys(sections)) {
    if (!INTSUM_SECTIONS.includes(key)) throw new HttpError(400, `Unknown INTSUM section ${key}.`);
  }
}

/** A full `sections` object for create: unspecified keys default to an empty string. */
function validateSections(sections) {
  const result = Object.fromEntries(INTSUM_SECTIONS.map((key) => [key, '']));
  if (sections === undefined || sections === null) return result;
  validateSectionKeys(sections);
  for (const key of INTSUM_SECTIONS) {
    if (key in sections) result[key] = sections[key];
  }
  return result;
}

/** A patch of `sections` for update: only the given keys change. */
function mergeSections(existing, patchSections) {
  validateSectionKeys(patchSections);
  const merged = { ...existing };
  for (const key of Object.keys(patchSections)) merged[key] = patchSections[key];
  return merged;
}

function createIntsum(user, { period_start: periodStart, period_end: periodEnd, dtg, author, sections, owner_cell: ownerCell }) {
  const start = requireTimestamp(periodStart, 'period_start');
  const end = requireTimestamp(periodEnd, 'period_end');
  const validDtg = optionalString(dtg, 'dtg') ?? formatDtg(Date.now());
  const validAuthor = optionalString(author, 'author');
  const validSections = validateSections(sections);
  const cleanOwner = ownerCellForCreate(user, ownerCell);
  return mutate('intsum:create', () => validDtg, () => {
    const timestamp = now();
    const { lastInsertRowid } = database
      .prepare(
        `INSERT INTO intsums (period_start, period_end, dtg, author, sections, owner_cell, releasable_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      )
      .run(start, end, validDtg, validAuthor, JSON.stringify(validSections), cleanOwner, timestamp, timestamp);
    return withCells(shapeIntsum(fetchRow('intsums', Number(lastInsertRowid))));
  });
}

function updateIntsum(user, id, patch) {
  const row = fetchVisibleRow(user, 'intsums', id, 'INTSUM');
  assertCanEdit(user, row);
  const fields = [];
  const params = [];
  if ('period_start' in patch) {
    fields.push('period_start = ?');
    params.push(requireTimestamp(patch.period_start, 'period_start'));
  }
  if ('period_end' in patch) {
    fields.push('period_end = ?');
    params.push(requireTimestamp(patch.period_end, 'period_end'));
  }
  if ('dtg' in patch) {
    fields.push('dtg = ?');
    params.push(requireString(patch.dtg, 'dtg'));
  }
  if ('author' in patch) {
    fields.push('author = ?');
    params.push(optionalString(patch.author, 'author'));
  }
  if ('sections' in patch) {
    fields.push('sections = ?');
    params.push(JSON.stringify(mergeSections(JSON.parse(row.sections), patch.sections)));
  }
  const reassign = ownerReassignField(user, patch);
  if (reassign) {
    fields.push('owner_cell = ?');
    params.push(reassign);
  }
  return mutate('intsum:update', String(id), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database.prepare(`UPDATE intsums SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return withCells(shapeIntsum(fetchRow('intsums', id)));
  });
}

function deleteIntsum(user, id) {
  const row = fetchVisibleRow(user, 'intsums', id, 'INTSUM');
  assertCanEdit(user, row);
  return mutate('intsum:delete', String(id), () => {
    database.prepare('DELETE FROM intsums WHERE id = ?').run(id);
    return deletedWithCells(row);
  });
}

const releaseIntsum = makeRelease('intsums', 'INTSUM', shapeIntsum);

/**
 * The auto-filled INTSUM draft over `[from, to]`: situation from the current
 * tracks, significant activity from reports in the window, PIR status from
 * `fulfillment.js`. Assessment/outlook are left for the analyst. Read-only,
 * so no activity entry — nothing is saved until `createIntsum`.
 */
function draftIntsum(user, fromIso, toIso) {
  if (typeof fromIso !== 'string' || !fromIso) throw new HttpError(400, 'from is required.');
  if (typeof toIso !== 'string' || !toIso) throw new HttpError(400, 'to is required.');
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  if (Number.isNaN(fromMs)) throw new HttpError(400, 'from must be a valid timestamp.');
  if (Number.isNaN(toMs)) throw new HttpError(400, 'to must be a valid timestamp.');
  if (fromMs > toMs) throw new HttpError(400, 'from must not be after to.');
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();

  const situation = listVisible(user, 'tracks', 'designation, id')
    .map((track) => {
      const mgrs = formatMgrs(track.lon, track.lat);
      const dtg = formatDtg(new Date(track.observed_at).getTime());
      const label = track.designation || track.sidc;
      return `${label}: ${track.status.toUpperCase()} at ${mgrs}, last seen ${dtg}`;
    });

  const { sql: reportVisSql, params: reportVisParams } = visibilitySql(user);
  const significantActivity = database
    .prepare(
      `SELECT * FROM reports WHERE occurred_at IS NOT NULL AND occurred_at >= ? AND occurred_at <= ? AND ${reportVisSql} ORDER BY occurred_at, id`,
    )
    .all(from, to, ...reportVisParams)
    .map((report) => {
      const dtg = formatDtg(new Date(report.occurred_at).getTime());
      const mgrs = formatMgrs(report.lon, report.lat);
      return `${dtg} \u2013 ${report.report_type.toUpperCase()} \u2013 ${mgrs} \u2013 ${report.text} (Admiralty ${report.reliability}${report.credibility})`;
    });

  const pirStatus = listVisible(user, 'requirements', 'priority DESC, id')
    .map((requirement) => {
      const sirIds = database
        .prepare('SELECT id FROM sirs WHERE requirement_id = ?')
        .all(requirement.id)
        .map((sir) => sir.id);
      const blanket = database
        .prepare(
          `SELECT el.relation, r.credibility
           FROM evidence_links el JOIN reports r ON r.id = el.report_id
           WHERE el.target_kind = 'requirement' AND el.target_id = ?`,
        )
        .all(requirement.id)
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
      const fulfillment = computePirFulfillment(sirIds, [...blanket, ...perSir]);
      return { requirement_id: requirement.id, text: requirement.text, ...fulfillment };
    });

  return {
    period_start: from,
    period_end: to,
    sections: {
      situation,
      significant_activity: significantActivity,
      pir_status: pirStatus,
      assessment: '',
      outlook: '',
    },
  };
}

// -- RFI --------------------------------------------------------------------

function shapeRfi(row) {
  return { ...row, releasable_to: JSON.parse(row.releasable_to) };
}

function listRfis(user) {
  return listVisible(user, 'rfis', 'created_at DESC, id DESC').map(shapeRfi);
}

function createRfi(user, {
  requester,
  requirement_id: requirementId,
  sir_id: sirId,
  question,
  priority,
  nlt,
  owner_cell: ownerCell,
}) {
  const cleanQuestion = requireString(question, 'question');
  const cleanPriority =
    priority === undefined ? 'routine' : requireEnum(priority, 'priority', RFI_PRIORITIES);
  if (requirementId !== undefined && requirementId !== null) {
    fetchVisibleRow(user, 'requirements', requirementId, 'Requirement');
  }
  if (sirId !== undefined && sirId !== null) {
    assertSirVisible(user, sirId);
  }
  // The requester's cell owns the RFI (docs/phase1-access.md), same
  // ownership rule as everything else: White may pick any cell, everyone
  // else is pinned to their own.
  const cleanOwner = ownerCellForCreate(user, ownerCell);
  const timestamp = now();
  return mutate(
    'rfi:create',
    () => cleanQuestion,
    () => {
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO rfis (requester, requirement_id, sir_id, question, priority, nlt, state, owner_cell, releasable_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, '[]', ?, ?)`,
        )
        .run(
          optionalString(requester, 'requester'),
          requirementId ?? null,
          sirId ?? null,
          cleanQuestion,
          cleanPriority,
          optionalString(nlt, 'nlt'),
          cleanOwner,
          timestamp,
          timestamp,
        );
      return withCells(shapeRfi(fetchRow('rfis', Number(lastInsertRowid))));
    },
  );
}

function updateRfi(user, id, patch) {
  const existing = fetchVisibleRow(user, 'rfis', id, 'RFI');
  assertCanEdit(user, existing);
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
  const reassign = ownerReassignField(user, patch);
  if (reassign) {
    fields.push('owner_cell = ?');
    params.push(reassign);
  }
  return mutate('rfi:update', String(id), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database.prepare(`UPDATE rfis SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return withCells(shapeRfi(fetchRow('rfis', id)));
  });
}

/**
 * The one path that changes RFI state. Answering can create the evidence
 * link that closes the loop back to the requirement/SIR it was raised
 * against, in the same transaction as the state change. When White answers
 * a non-White RFI, the answer report is automatically released to the
 * requesting cell — otherwise the requester couldn't see their own answer.
 */
function transitionRfi(user, id, toState, { answer_report_id: answerReportId, relation } = {}) {
  const row = fetchVisibleRow(user, 'rfis', id, 'RFI');
  if (!canTransition(row.state, toState)) {
    throw new HttpError(409, `Cannot move an RFI from ${row.state} to ${toState}.`);
  }
  // C2b: release is read-only, so a cell an RFI was only released to can
  // never transition it. Every transition otherwise needs canEdit (White
  // or the owning cell) — except 'answered', which White alone may set:
  // White coordinates collection across cells, so the requester answering
  // their own RFI isn't a sensible transition.
  if (toState === 'answered') {
    if (!isWhite(user)) throw new HttpError(403, 'Only White may answer an RFI.');
  } else {
    assertCanEdit(user, row);
  }
  let answerReport = null;
  if (toState === 'answered') {
    if (!Number.isInteger(answerReportId)) {
      throw new HttpError(400, 'answer_report_id is required to answer an RFI.');
    }
    answerReport = fetchVisibleRow(user, 'reports', answerReportId, 'Report');
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
    if (
      toState === 'answered' &&
      isWhite(user) &&
      answerReport &&
      answerReport.owner_cell !== row.owner_cell
    ) {
      const released = normalizeRelease(
        [...JSON.parse(answerReport.releasable_to), row.owner_cell],
        answerReport.owner_cell,
      );
      database
        .prepare('UPDATE reports SET releasable_to = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(released), now(), answerReportId);
    }
    return withCells(shapeRfi(fetchRow('rfis', id)));
  });
}

function deleteRfi(user, id) {
  const row = fetchVisibleRow(user, 'rfis', id, 'RFI');
  assertCanEdit(user, row);
  return mutate('rfi:delete', String(id), () => {
    database.prepare('DELETE FROM rfis WHERE id = ?').run(id);
    return deletedWithCells(row);
  });
}

const releaseRfi = makeRelease('rfis', 'RFI', shapeRfi);

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
  // it, not hours later when the clock reaches it mid-exercise. Injects
  // carry the same report payload as a hand-entered report, including
  // location, so this runs the same validator.
  if (kind === 'report') {
    validateReportInput({
      text: payload.text,
      reliability: payload.reliability ?? 'F',
      credibility: payload.credibility ?? 6,
      lon: payload.lon,
      lat: payload.lat,
      report_type: payload.report_type,
      fields: payload.fields,
      sidc: payload.sidc,
    });
  }
  // The cells a fired inject reaches: both report and message injects are
  // White-owned (the game-master schedules them), released to `release_to`
  // (defaulting to Blue — the usual training audience) on firing.
  const releaseTo = normalizeRelease(payload.release_to ?? ['blue'], 'white');
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
          JSON.stringify({ ...payload, release_to: releaseTo }),
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

function shapeMessage(row) {
  return { ...row, releasable_to: JSON.parse(row.releasable_to) };
}

function listMessages(user) {
  return listVisible(user, 'messages', 'fired_at DESC, id DESC').map(shapeMessage);
}

function insertMessageRow(text, firedAt, releasableTo) {
  const { lastInsertRowid } = database
    .prepare(
      "INSERT INTO messages (text, fired_at, owner_cell, releasable_to, created_at) VALUES (?, ?, 'white', ?, ?)",
    )
    .run(text, firedAt, JSON.stringify(releasableTo), firedAt);
  return Number(lastInsertRowid);
}

/**
 * Fires one event: for a report inject, creates the report from the
 * payload, owned by White and released to `payload.release_to`; for a
 * message inject, inserts a `messages` row the same way. Always called
 * from inside another mutation's transaction (`fireScenarioEvent` or
 * `tickScenario`), so this inserts rows directly rather than through
 * `createReport`, which would try to open a second, nested transaction.
 * Returns the cells the fired item reaches, for the caller to publish.
 */
function fireOne(row) {
  const timestamp = now();
  const payload = JSON.parse(row.payload);
  const releaseTo = normalizeRelease(payload.release_to ?? ['blue'], 'white');
  let createdReportId = null;
  let createdMessageId = null;
  if (row.kind === 'report') {
    const fields = prepareReportFields({
      text: payload.text,
      occurred_at: payload.occurred_at ?? row.trigger_at,
      source: payload.source ?? 'Scenario inject',
      author: payload.author ?? 'Game Master',
      reliability: payload.reliability ?? 'F',
      credibility: payload.credibility ?? 6,
      lon: payload.lon,
      lat: payload.lat,
      report_type: payload.report_type,
      fields: payload.fields,
      sidc: payload.sidc,
      nai_id: payload.nai_id,
      track_id: payload.track_id,
    });
    createdReportId = insertReportRow(fields, { ownerCell: 'white', releasableTo: releaseTo }).id;
  } else {
    createdMessageId = insertMessageRow(payload.text, timestamp, releaseTo);
  }
  database
    .prepare(
      "UPDATE scenario_events SET state = 'fired', fired_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(timestamp, timestamp, row.id);
  return {
    reportId: createdReportId,
    messageId: createdMessageId,
    liveCells: liveCellsFor({ owner_cell: 'white', releasable_to: releaseTo }),
  };
}

function fireScenarioEvent(id) {
  const row = assertPendingEvent(id);
  return mutate('scenario:fire', String(id), () => {
    const { liveCells } = fireOne(row);
    return { ...shapeScenarioEvent(fetchRow('scenario_events', id)), liveCells };
  });
}

/** Fires every event whose trigger time has arrived. Idempotent: refiring
 * finds nothing pending left to fire. `liveCells` is the union of every
 * fired item's cells, so the one tick's live event reaches everyone who
 * received something without leaking which cell got which inject. */
function tickScenario() {
  const clock = readClockRow();
  const nowMs = scenarioNowMs(clock);
  const pending = database.prepare("SELECT * FROM scenario_events WHERE state = 'pending'").all();
  const due = dueEvents(pending, nowMs);
  if (!due.length) return { fired: [] };
  return mutate('scenario:tick', `${due.length} event(s)`, () => {
    const results = due.map((row) => ({ id: row.id, ...fireOne(row) }));
    const liveCells = [...new Set(results.flatMap((r) => r.liveCells))];
    return {
      fired: results.map(({ id, reportId, messageId }) => ({ id, reportId, messageId })),
      liveCells,
    };
  });
}

// -- exercise scenarios (fictional countries + renamed places over Czechia) ---
//
// One "scenario" holds every country and place the IPB and print maps draw
// when it is active. `regions.json` (built from kraje/okresy)
// is read through `referenceFile`, so a rebuild is picked up without a
// restart; countries/places are plain rows, with `geometry`/`regions` stored
// as JSON text and parsed back out when shaping a row for the API.

/** The current `regions.json` FeatureCollection, or null if it hasn't been built. */
function currentRegionsData() {
  if (!regionsReference) return null;
  try {
    return regionsReference.get()?.data ?? null;
  } catch {
    return null; // a malformed file on disk; treat as "not built yet" rather than 500
  }
}

function getRegions() {
  const data = currentRegionsData();
  if (!data) {
    throw new HttpError(
      503,
      'No regions data. Build modules/exercise/data/regions.json first (see README, "Building the reference data").',
    );
  }
  return data;
}

function readScenarioMeta() {
  const row = fetchRow('scenario_meta', 1);
  if (row) return row;
  database.prepare('INSERT INTO scenario_meta (id, example_seeded) VALUES (1, 0)').run();
  return fetchRow('scenario_meta', 1);
}

function markExampleSeeded() {
  readScenarioMeta();
  database.prepare('UPDATE scenario_meta SET example_seeded = 1 WHERE id = 1').run();
}

function shapeCountry(row) {
  return {
    id: row.id,
    scenario_id: row.scenario_id,
    name: row.name,
    affiliation: row.affiliation,
    color: row.color,
    regions: JSON.parse(row.regions),
    geometry: row.geometry ? JSON.parse(row.geometry) : null,
    position: row.position,
  };
}

function shapePlace(row) {
  return {
    id: row.id,
    scenario_id: row.scenario_id,
    real_name: row.real_name,
    kind: row.kind,
    lon: row.lon,
    lat: row.lat,
    name: row.name,
  };
}

function listCountries(scenarioId) {
  return database
    .prepare('SELECT * FROM scenario_countries WHERE scenario_id = ? ORDER BY position, id')
    .all(scenarioId)
    .map(shapeCountry);
}

function listPlaces(scenarioId) {
  return database
    .prepare('SELECT * FROM scenario_places WHERE scenario_id = ? ORDER BY id')
    .all(scenarioId)
    .map(shapePlace);
}

function shapeScenario(row) {
  return {
    id: row.id,
    name: row.name,
    active: Boolean(row.active),
    example: Boolean(row.example),
    created_at: row.created_at,
    updated_at: row.updated_at,
    countries: listCountries(row.id),
    places: listPlaces(row.id),
  };
}

function shapeScenarioSummary(row) {
  const countryCount = database
    .prepare('SELECT COUNT(*) AS n FROM scenario_countries WHERE scenario_id = ?')
    .get(row.id).n;
  const placeCount = database
    .prepare('SELECT COUNT(*) AS n FROM scenario_places WHERE scenario_id = ?')
    .get(row.id).n;
  return {
    id: row.id,
    name: row.name,
    active: Boolean(row.active),
    example: Boolean(row.example),
    country_count: countryCount,
    place_count: placeCount,
    updated_at: row.updated_at,
  };
}

function touchScenario(id, timestamp = now()) {
  database.prepare('UPDATE scenarios SET updated_at = ? WHERE id = ?').run(timestamp, id);
}

function insertScenarioRow({ name, example }) {
  const timestamp = now();
  const { lastInsertRowid } = database
    .prepare(
      'INSERT INTO scenarios (name, active, example, created_at, updated_at) VALUES (?, 0, ?, ?, ?)',
    )
    .run(name, example ? 1 : 0, timestamp, timestamp);
  return Number(lastInsertRowid);
}

function insertCountryRow(scenarioId, position, { name, affiliation, color, regions, geometry }) {
  const timestamp = now();
  const { lastInsertRowid } = database
    .prepare(
      `INSERT INTO scenario_countries
         (scenario_id, name, affiliation, color, regions, geometry, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scenarioId,
      name,
      affiliation,
      color,
      JSON.stringify(regions),
      geometry ? JSON.stringify(geometry) : null,
      position,
      timestamp,
      timestamp,
    );
  return Number(lastInsertRowid);
}

function insertPlaceRow(scenarioId, { real_name: realName, kind, lon, lat, name }) {
  const timestamp = now();
  const { lastInsertRowid } = database
    .prepare(
      `INSERT INTO scenario_places (scenario_id, real_name, kind, lon, lat, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(scenarioId, realName, kind, lon, lat, name, timestamp, timestamp);
  return Number(lastInsertRowid);
}

/** Inserts the EXAMPLE scenario built from `regionsData` and marks it seeded. */
function seedExampleScenario(regionsData) {
  return mutate('scenario:example', 'example', () => {
    const plan = planExampleScenario(regionsData);
    const scenarioId = insertScenarioRow({ name: plan.name, example: true });
    plan.countries.forEach((country, index) => insertCountryRow(scenarioId, index, country));
    plan.places.forEach((place) => insertPlaceRow(scenarioId, place));
    markExampleSeeded();
    return shapeScenario(fetchRow('scenarios', scenarioId));
  });
}

/** `POST scenarios/example`: (re)creates the example on demand, 503 without regions data. */
function createExampleScenario() {
  return seedExampleScenario(getRegions());
}

/**
 * Auto-seeds the EXAMPLE scenario the first time scenarios are listed, if it
 * has never been seeded before and regions data exists. Silent no-op
 * otherwise, so listing before the regions build finishes just tries again
 * next time.
 */
function maybeSeedExample() {
  if (readScenarioMeta().example_seeded) return;
  const regionsData = currentRegionsData();
  if (regionsData) seedExampleScenario(regionsData);
}

function listScenarios() {
  maybeSeedExample();
  return database
    .prepare('SELECT * FROM scenarios ORDER BY created_at, id')
    .all()
    .map(shapeScenarioSummary);
}

function createScenario({ name }) {
  const cleanName = requireBoundedString(name, 'name', 120);
  return mutate(
    'scenario:create',
    () => cleanName,
    () => {
      const id = insertScenarioRow({ name: cleanName, example: false });
      return shapeScenario(fetchRow('scenarios', id));
    },
  );
}

function getScenario(id) {
  const row = fetchRow('scenarios', id);
  if (!row) throw new HttpError(404, `Scenario ${id} not found.`);
  return shapeScenario(row);
}

function updateScenario(id, patch) {
  assertExists('scenarios', id, 'Scenario');
  if (patch.active !== undefined && typeof patch.active !== 'boolean') {
    throw new HttpError(400, 'active must be a boolean.');
  }
  const cleanName = 'name' in patch ? requireBoundedString(patch.name, 'name', 120) : undefined;
  return mutate('scenario:update', String(id), () => {
    const timestamp = now();
    // Deactivate every other scenario first, inside this transaction, so the
    // partial unique index on scenarios(active) never sees two active rows.
    if (patch.active === true) {
      database
        .prepare('UPDATE scenarios SET active = 0, updated_at = ? WHERE active = 1 AND id <> ?')
        .run(timestamp, id);
    }
    const fields = [];
    const params = [];
    if (cleanName !== undefined) {
      fields.push('name = ?');
      params.push(cleanName);
    }
    if (patch.active !== undefined) {
      fields.push('active = ?');
      params.push(patch.active ? 1 : 0);
    }
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(timestamp);
      database.prepare(`UPDATE scenarios SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return shapeScenario(fetchRow('scenarios', id));
  });
}

function deleteScenario(id) {
  assertExists('scenarios', id, 'Scenario');
  mutate('scenario:delete', String(id), () => {
    database.prepare('DELETE FROM scenarios WHERE id = ?').run(id); // cascades to countries/places
  });
}

function duplicateScenario(id) {
  const row = fetchRow('scenarios', id);
  if (!row) throw new HttpError(404, `Scenario ${id} not found.`);
  return mutate('scenario:duplicate', String(id), () => {
    const newId = insertScenarioRow({ name: `${row.name} (copy)`, example: false });
    for (const country of listCountries(id)) insertCountryRow(newId, country.position, country);
    for (const place of listPlaces(id)) insertPlaceRow(newId, place);
    return shapeScenario(fetchRow('scenarios', newId));
  });
}

function getActiveScenario() {
  const row = database.prepare('SELECT * FROM scenarios WHERE active = 1').get();
  return { scenario: row ? shapeScenario(row) : null };
}

function createCountry(scenarioId, { name, affiliation, color, regions, geometry }) {
  assertExists('scenarios', scenarioId, 'Scenario');
  const cleanName = requireBoundedString(name, 'name', 120);
  const cleanAffiliation = requireEnum(affiliation, 'affiliation', AFFILIATIONS);
  const cleanColor =
    color === undefined || color === null ? DEFAULT_COLORS[cleanAffiliation] : requireColor(color);
  const cleanRegions = normalizeRegionIds(regions);
  const cleanGeometry = normalizeGeometry(geometry);
  return mutate(
    'scenario-country:create',
    () => cleanName,
    () => {
      const position = database
        .prepare('SELECT COUNT(*) AS n FROM scenario_countries WHERE scenario_id = ?')
        .get(scenarioId).n;
      const id = insertCountryRow(scenarioId, position, {
        name: cleanName,
        affiliation: cleanAffiliation,
        color: cleanColor,
        regions: cleanRegions,
        geometry: cleanGeometry,
      });
      touchScenario(scenarioId);
      return shapeCountry(fetchRow('scenario_countries', id));
    },
  );
}

function updateCountry(id, patch) {
  const row = fetchRow('scenario_countries', id);
  if (!row) throw new HttpError(404, `Country ${id} not found.`);
  const fields = [];
  const params = [];
  if ('name' in patch) {
    fields.push('name = ?');
    params.push(requireBoundedString(patch.name, 'name', 120));
  }
  if ('affiliation' in patch) {
    fields.push('affiliation = ?');
    params.push(requireEnum(patch.affiliation, 'affiliation', AFFILIATIONS));
  }
  if ('color' in patch) {
    fields.push('color = ?');
    params.push(requireColor(patch.color));
  }
  if ('regions' in patch) {
    fields.push('regions = ?');
    params.push(JSON.stringify(normalizeRegionIds(patch.regions)));
  }
  if ('geometry' in patch) {
    const geometry = normalizeGeometry(patch.geometry);
    fields.push('geometry = ?');
    params.push(geometry ? JSON.stringify(geometry) : null);
  }
  if ('position' in patch) {
    if (!Number.isInteger(patch.position)) throw new HttpError(400, 'position must be an integer.');
    fields.push('position = ?');
    params.push(patch.position);
  }
  return mutate('scenario-country:update', String(id), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database
        .prepare(`UPDATE scenario_countries SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, id);
    }
    touchScenario(row.scenario_id);
    return shapeCountry(fetchRow('scenario_countries', id));
  });
}

function deleteCountry(id) {
  const row = fetchRow('scenario_countries', id);
  if (!row) throw new HttpError(404, `Country ${id} not found.`);
  mutate('scenario-country:delete', String(id), () => {
    database.prepare('DELETE FROM scenario_countries WHERE id = ?').run(id);
    touchScenario(row.scenario_id);
  });
}

function createPlace(scenarioId, { real_name: realName, kind, lon, lat, name }) {
  assertExists('scenarios', scenarioId, 'Scenario');
  const cleanRealName = requireBoundedString(realName, 'real_name', 120);
  const cleanKind = requirePlaceKind(kind);
  const cleanLon = requireLongitude(lon);
  const cleanLat = requireLatitude(lat);
  const cleanName = requireBoundedString(name, 'name', 120);
  return mutate(
    'scenario-place:create',
    () => cleanName,
    () => {
      const id = insertPlaceRow(scenarioId, {
        real_name: cleanRealName,
        kind: cleanKind,
        lon: cleanLon,
        lat: cleanLat,
        name: cleanName,
      });
      touchScenario(scenarioId);
      return shapePlace(fetchRow('scenario_places', id));
    },
  );
}

function updatePlace(id, patch) {
  const row = fetchRow('scenario_places', id);
  if (!row) throw new HttpError(404, `Place ${id} not found.`);
  const cleanName = 'name' in patch ? requireBoundedString(patch.name, 'name', 120) : undefined;
  return mutate('scenario-place:update', String(id), () => {
    if (cleanName !== undefined) {
      const timestamp = now();
      database
        .prepare('UPDATE scenario_places SET name = ?, updated_at = ? WHERE id = ?')
        .run(cleanName, timestamp, id);
      touchScenario(row.scenario_id, timestamp);
    }
    return shapePlace(fetchRow('scenario_places', id));
  });
}

function deletePlace(id) {
  const row = fetchRow('scenario_places', id);
  if (!row) throw new HttpError(404, `Place ${id} not found.`);
  mutate('scenario-place:delete', String(id), () => {
    database.prepare('DELETE FROM scenario_places WHERE id = ?').run(id);
    touchScenario(row.scenario_id);
  });
}

// -- AAR ----------------------------------------------------------------------

function listActivity(user) {
  return database
    .prepare('SELECT * FROM activity ORDER BY id DESC')
    .all()
    .filter((row) => row.owner_cell === null || canSee(user, row));
}
