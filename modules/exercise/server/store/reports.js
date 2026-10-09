// Reports: type, structured fields, SIDC, location, evidence.

import { database } from './connection.js';
import { shapeEvidenceLinkBase } from './requirements.js';
import {
  assertRevision,
  cellsOf,
  fetchRow,
  findMatchingNaiId,
  mutate,
  now,
  optionalString,
  requireEnum,
  requireString,
  resolveNaiId,
  resolveTrackId,
  touchRequirementsForReport,
  validateFields,
  validateLocation,
  validateSidc,
  visibleRows,
} from './shared.js';

const RELIABILITY = ['A', 'B', 'C', 'D', 'E', 'F'];
const CREDIBILITY = [1, 2, 3, 4, 5, 6];
const REPORT_TYPES = ['free', 'spotrep', 'salute'];

export function shapeReport(row) {
  const links = database
    .prepare('SELECT * FROM evidence_links WHERE report_id = ? ORDER BY created_at, id')
    .all(row.id)
    .map(shapeEvidenceLinkBase);
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
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listReports(access) {
  return visibleRows(access, 'report', 'reports', 'created_at DESC, id DESC').map(shapeReport);
}

/**
 * Validates and shapes report fields; does not touch the database. Shared
 * by `createReport`/`updateReport` and by `createScenarioEvent`, which
 * validates a `report`-kind inject's payload the same way at schedule time
 * so a malformed inject fails immediately instead of hours later when the
 * clock reaches it.
 */
export function validateReportInput({
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
 * point) and `track_id` (explicit only, read with `access.see`). Used by
 * both `createReport` and `fireOne`, so a report created by a scenario
 * inject gets the same auto-NAI treatment as one entered by hand.
 */
export function prepareReportFields(input, access) {
  const fields = validateReportInput(input);
  return {
    ...fields,
    nai_id: resolveNaiId(input.nai_id, fields.lon, fields.lat, access),
    track_id: resolveTrackId(input.track_id, access),
  };
}

/**
 * The raw insert, with no transaction of its own: `fireOne` calls this from
 * inside an already-open transaction (this `transact` helper does not
 * support nesting), while `createReport` wraps it in `mutate` for the normal
 * write path. `fields` is the output of `prepareReportFields`.
 */
export function insertReportRow(fields, ownerCell, releasableTo) {
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

export function createReport(owner, input, access) {
  const fields = prepareReportFields(input, access);
  return mutate(
    'report:create',
    () => fields.text,
    cellsOf(owner),
    () => insertReportRow(fields, owner.owner_cell, owner.releasable_to),
  );
}

export function updateReport(item, patch, access) {
  assertRevision('Report', item, patch);
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
  if ('author' in patch) {
    fields.push('author = ?');
    params.push(optionalString(patch.author, 'author'));
  }
  if ('occurred_at' in patch) {
    fields.push('occurred_at = ?');
    params.push(optionalString(patch.occurred_at, 'occurred_at'));
  }

  let reportType = item.report_type;
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
  let lon = item.lon;
  let lat = item.lat;
  if (locationChanged) {
    const location = validateLocation(
      'lon' in patch ? patch.lon : item.lon,
      'lat' in patch ? patch.lat : item.lat,
    );
    lon = location.lon;
    lat = location.lat;
    fields.push('lon = ?', 'lat = ?');
    params.push(lon, lat);
  }

  // Re-run the auto-NAI match on a location change, unless the caller is
  // setting nai_id explicitly in the same request.
  if ('nai_id' in patch) {
    fields.push('nai_id = ?');
    params.push(resolveNaiId(patch.nai_id, lon, lat, access));
  } else if (locationChanged) {
    fields.push('nai_id = ?');
    params.push(findMatchingNaiId(lon, lat));
  }

  if ('track_id' in patch) {
    fields.push('track_id = ?');
    params.push(resolveTrackId(patch.track_id, access));
  }

  return mutate('report:update', String(item.id), cellsOf(item), () => {
    if (fields.length) {
      fields.push('revision = revision + 1', 'updated_at = ?');
      params.push(now());
      database
        .prepare(`UPDATE reports SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, item.id);
      touchRequirementsForReport(item.id);
    }
    return shapeReport(fetchRow('reports', item.id));
  });
}

/** Deleting a report never deletes the evidence links citing it (no
 * cascading FK on `report_id`, docs/adr/0002 + schema.js): they simply
 * point at a `report_id` that no longer resolves, and read back
 * `withdrawn: true` wherever they're shown. */
export function deleteReport(item, input) {
  assertRevision('Report', item, input);
  return mutate('report:delete', String(item.id), cellsOf(item), () => {
    touchRequirementsForReport(item.id);
    database.prepare('DELETE FROM reports WHERE id = ?').run(item.id);
    return { deleted: true };
  });
}
