import type { SQLInputValue } from 'node:sqlite';
// Products: INTSUMs and their drafts.

import { formatDtg } from '../../../../src/dtg.js';
import { formatMgrs } from '../../../../src/geo.js';
import type { Access, Owner } from '../../../../server/dispatch.ts';
import {
  fieldsOf,
  HttpError,
  isJsonObject,
  type Json,
  type JsonObject,
} from '../../../../server/http.ts';
import { releasableArray } from '../../../../server/policy.ts';
import { num, type Row } from '../../../../server/state.ts';

import { database } from './connection.ts';
import { readIntsum, readReport, readRequirement, readTrack } from './rows.ts';
import { requirementFulfillment } from './requirements.ts';
import {
  cellsOf,
  existingRow,
  mutate,
  now,
  optionalString,
  requireString,
  visibleRows,
} from './shared.ts';
import { requireTimestamp } from './tracks.ts';

const INTSUM_SECTIONS = [
  'situation',
  'significant_activity',
  'pir_status',
  'assessment',
  'outlook',
];

export function shapeIntsum(raw: Row) {
  const intsum = readIntsum(raw);
  const sections: Json = JSON.parse(intsum.sections);
  return { ...intsum, sections, releasable_to: releasableArray(intsum.releasable_to) };
}

export function listIntsums(access: Access) {
  return visibleRows(access, 'intsum', 'intsums', 'period_start DESC, id DESC').map(shapeIntsum);
}

function validateSectionKeys(sections: Json | undefined): JsonObject {
  if (!isJsonObject(sections)) {
    throw new HttpError(400, 'sections must be a JSON object.');
  }
  for (const key of Object.keys(sections)) {
    if (!INTSUM_SECTIONS.includes(key)) throw new HttpError(400, `Unknown INTSUM section ${key}.`);
  }
  return sections;
}

/** A full `sections` object for create: unspecified keys default to an empty string. */
function validateSections(sections: Json | undefined): JsonObject {
  const result: JsonObject = Object.fromEntries(INTSUM_SECTIONS.map((key) => [key, '']));
  if (sections === undefined || sections === null) return result;
  const given = validateSectionKeys(sections);
  for (const key of INTSUM_SECTIONS) {
    if (key in given) result[key] = given[key];
  }
  return result;
}

/** A patch of `sections` for update: only the given keys change. */
function mergeSections(existing: Json, patchSections: Json | undefined): JsonObject {
  const patch = validateSectionKeys(patchSections);
  const merged: JsonObject = isJsonObject(existing) ? { ...existing } : {};
  for (const key of Object.keys(patch)) merged[key] = patch[key];
  return merged;
}

export function createIntsum(owner: Owner, input: Json) {
  const {
    period_start: periodStart,
    period_end: periodEnd,
    dtg,
    author,
    sections,
  } = fieldsOf(input);
  const start = requireTimestamp(periodStart, 'period_start');
  const end = requireTimestamp(periodEnd, 'period_end');
  const validDtg = optionalString(dtg, 'dtg') ?? formatDtg(Date.now());
  const validAuthor = optionalString(author, 'author');
  const validSections = validateSections(sections);
  return mutate(
    'intsum:create',
    () => validDtg,
    cellsOf(owner),
    () => {
      const timestamp = now();
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO intsums (period_start, period_end, dtg, author, sections, owner_cell, releasable_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          start,
          end,
          validDtg,
          validAuthor,
          JSON.stringify(validSections),
          owner.owner_cell,
          JSON.stringify(owner.releasable_to),
          timestamp,
          timestamp,
        );
      return shapeIntsum(existingRow('intsums', Number(lastInsertRowid)));
    },
  );
}

export function updateIntsum(item: Row, input: Json) {
  const patch = fieldsOf(input);
  const intsum = readIntsum(item);
  const fields: string[] = [];
  const params: SQLInputValue[] = [];
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
    const existing: Json = JSON.parse(intsum.sections);
    params.push(JSON.stringify(mergeSections(existing, patch.sections)));
  }
  return mutate('intsum:update', String(intsum.id), cellsOf(item), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database
        .prepare(`UPDATE intsums SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, intsum.id);
    }
    return shapeIntsum(existingRow('intsums', intsum.id));
  });
}

export function deleteIntsum(item: Row) {
  const itemId = num(item, 'id');
  return mutate('intsum:delete', String(itemId), cellsOf(item), () => {
    database.prepare('DELETE FROM intsums WHERE id = ?').run(itemId);
    return { deleted: true };
  });
}

/**
 * The auto-filled INTSUM draft over `[from, to]`: situation from the current
 * tracks, significant activity from reports in the window, PIR status from
 * `fulfillment.js`. Assessment/outlook are left for the analyst. Read-only,
 * so no activity entry — nothing is saved until `createIntsum`. Draws only
 * on what the requester can currently see (docs/adr/0002: per-viewer reads).
 */
export function draftIntsum(access: Access, fromIso: string | null, toIso: string | null) {
  if (typeof fromIso !== 'string' || !fromIso) throw new HttpError(400, 'from is required.');
  if (typeof toIso !== 'string' || !toIso) throw new HttpError(400, 'to is required.');
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  if (Number.isNaN(fromMs)) throw new HttpError(400, 'from must be a valid timestamp.');
  if (Number.isNaN(toMs)) throw new HttpError(400, 'to must be a valid timestamp.');
  if (fromMs > toMs) throw new HttpError(400, 'from must not be after to.');
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();

  const situation = visibleRows(access, 'track', 'tracks', 'designation, id').map((raw) => {
    const track = readTrack(raw);
    const mgrs = formatMgrs(track.lon, track.lat);
    const dtg = formatDtg(new Date(track.observed_at).getTime());
    const label = track.designation || track.sidc;
    return `${label}: ${track.status.toUpperCase()} at ${mgrs}, last seen ${dtg}`;
  });

  const { sql: reportVisSql, params: reportVisParams } = access.visible('report', {});
  const significantActivity = database
    .prepare(
      `SELECT * FROM reports WHERE occurred_at IS NOT NULL AND occurred_at >= ? AND occurred_at <= ? AND ${reportVisSql} ORDER BY occurred_at, id`,
    )
    .all(from, to, ...reportVisParams)
    .map(readReport)
    .map((report) => {
      const dtg = formatDtg(new Date(report.occurred_at ?? '').getTime());
      const mgrs = formatMgrs(report.lon, report.lat);
      return `${dtg} \u2013 ${report.report_type.toUpperCase()} \u2013 ${mgrs} \u2013 ${report.text} (Admiralty ${report.reliability}${report.credibility})`;
    });

  const pirStatus = visibleRows(access, 'requirement', 'requirements', 'priority DESC, id').map(
    (raw) => {
      const requirement = readRequirement(raw);
      const sirIds = database
        .prepare('SELECT id FROM sirs WHERE requirement_id = ?')
        .all(requirement.id)
        .map((sir) => num(sir, 'id'));
      const fulfillment = requirementFulfillment(requirement.id, sirIds, access);
      return { requirement_id: requirement.id, text: requirement.text, ...fulfillment };
    },
  );

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
