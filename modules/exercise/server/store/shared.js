// Validation and write helpers every exercise store file uses: input checks,
// row fetch, cell-scoped mutation logging, revision checks.

import { formatSidc, parseSidc } from '../../../../src/symbols/sidc.js';
import { HttpError } from '../../../../server/http.js';
import { transact } from '../../../../server/state.js';
import { geometryContains } from '../geoMatch.js';

import { database } from './connection.js';

const SALUTE_FIELDS = ['size', 'activity', 'location', 'unit', 'time', 'equipment'];
const SPOTREP_FIELDS = [...SALUTE_FIELDS, 'remarks'];
const FIELDS_BY_TYPE = { free: [], spotrep: SPOTREP_FIELDS, salute: SALUTE_FIELDS };
const MAX_FIELD_LENGTH = 500;

export function now() {
  return new Date().toISOString();
}

export function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${name} is required.`);
  }
  return value.trim();
}

export function optionalString(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string.`);
  return value;
}

export function requireEnum(value, name, values) {
  if (!values.includes(value))
    throw new HttpError(400, `${name} must be one of: ${values.join(', ')}.`);
  return value;
}

export function requireInteger(value, name) {
  if (!Number.isInteger(value)) throw new HttpError(400, `${name} must be an integer.`);
  return value;
}

/** A trimmed, non-empty string of at most `maxLength` characters (scenario, country and place names). */
export function requireBoundedString(value, name, maxLength) {
  const trimmed = requireString(value, name);
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${name} must be ${maxLength} characters or fewer.`);
  }
  return trimmed;
}

export function requireLongitude(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -180 || value > 180) {
    throw new HttpError(400, 'lon must be a finite number between -180 and 180.');
  }
  return value;
}

export function requireLatitude(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -90 || value > 90) {
    throw new HttpError(400, 'lat must be a finite number between -90 and 90.');
  }
  return value;
}

/** lon/lat travel together: both present and in range, or both absent. */
export function validateLocation(lon, lat) {
  const hasLon = lon !== undefined && lon !== null;
  const hasLat = lat !== undefined && lat !== null;
  if (hasLon !== hasLat) throw new HttpError(400, 'lon and lat must be provided together.');
  if (!hasLon) return { lon: null, lat: null };
  return { lon: requireLongitude(lon), lat: requireLatitude(lat) };
}

/** `null` for an absent SIDC, else its canonical 20-digit form (see src/symbols/sidc.js). */
export function validateSidc(sidc) {
  if (sidc === undefined || sidc === null || sidc === '') return null;
  const parts = typeof sidc === 'string' ? parseSidc(sidc) : null;
  if (!parts) throw new HttpError(400, 'sidc must be a 20-digit SIDC.');
  return formatSidc(parts);
}

export function requireSidc(sidc) {
  const validated = validateSidc(sidc);
  if (validated === null) throw new HttpError(400, 'sidc is required.');
  return validated;
}

/** `fields` restricted to the keys `reportType` allows, each a string of at most 500 characters. */
export function validateFields(reportType, fields) {
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

/** The first NAI (by id) whose geometry contains the point, or null. Reads
 * every NAI's raw geometry regardless of visibility — matching a point
 * against a shape is not "reading another item", it never exposes more
 * than the numeric id an existing report/SIR/tasking could already carry. */
export function findMatchingNaiId(lon, lat) {
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
 * A report's `nai_id`: an explicit id (read with `access.see`, 404 if
 * hidden), explicit `null` to clear it, or — when not given at all — the
 * auto-match against the point.
 */
export function resolveNaiId(explicit, lon, lat, access) {
  if (explicit !== undefined) {
    if (explicit === null) return null;
    if (!Number.isInteger(explicit)) throw new HttpError(400, 'nai_id must be an integer.');
    access.see('nai', explicit);
    return explicit;
  }
  return findMatchingNaiId(lon, lat);
}

export function resolveTrackId(value, access) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) throw new HttpError(400, 'track_id must be an integer.');
  access.see('track', value);
  return value;
}

export function fetchRow(table, id) {
  return database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) ?? null;
}

/** `row.owner_cell`/`releasable_to` (a JSON string) or a dispatcher-given
 * `owner` (`releasable_to` already an array) — either way, what the
 * activity log needs for one mutation. `null` for a global change. */
export function cellsOf(source) {
  if (!source) return null;
  return {
    owner_cell: source.owner_cell,
    releasable_to: Array.isArray(source.releasable_to)
      ? source.releasable_to
      : JSON.parse(source.releasable_to),
  };
}

/**
 * Every mutation appends one activity row, inside the same transaction.
 * `target` may be a function to defer reading a value (such as an inserted
 * id) that only exists after `work()` runs. `cells` (from `cellsOf`) is the
 * item the mutation touched, or null for a change with no single cell-owned
 * subject (the scenario clock, scenario/country/place management).
 */
export function mutate(action, target, cells, work) {
  return transact(database, () => {
    const result = work();
    const targetLabel = typeof target === 'function' ? target() : target;
    database
      .prepare(
        'INSERT INTO activity (at, action, target, detail, owner_cell, releasable_to) VALUES (?, ?, ?, NULL, ?, ?)',
      )
      .run(
        now(),
        action,
        targetLabel,
        cells ? cells.owner_cell : null,
        JSON.stringify(cells ? cells.releasable_to : []),
      );
    return result;
  });
}

/** Every row of a cell-owned table the requester can see, in `orderBy` order. */
export function visibleRows(access, kind, table, orderBy) {
  const { sql, params } = access.visible(kind, {});
  return database.prepare(`SELECT * FROM ${table} WHERE ${sql} ORDER BY ${orderBy}`).all(...params);
}

export function assertRevision(label, item, input) {
  if (!Number.isInteger(input?.revision))
    throw new HttpError(400, `${label} revision is required.`);
  if (input.revision !== item.revision) {
    throw new HttpError(409, `${label} ${item.id} changed; reload latest before saving.`, {
      code: 'stale_revision',
      current_revision: item.revision,
    });
  }
}

export function touchRequirementRevision(id) {
  database
    .prepare('UPDATE requirements SET revision = revision + 1, updated_at = ? WHERE id = ?')
    .run(now(), id);
}

export function touchRequirementsForReport(reportId) {
  const ids = database
    .prepare('SELECT DISTINCT requirement_id FROM evidence_links WHERE report_id = ?')
    .all(reportId)
    .map((row) => row.requirement_id);
  ids.forEach((id) => touchRequirementRevision(id));
}
