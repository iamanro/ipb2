// The collection plan: collectors, taskings and their conflicts.

import { formatDtg } from '../../../../src/dtg.js';
import { HttpError } from '../../../../server/http.ts';
import { areaName } from '../ipbImport.js';

import { database } from './connection.js';
import {
  cellsOf,
  fetchRow,
  mutate,
  now,
  optionalString,
  requireEnum,
  requireString,
  resolveNaiId,
  visibleRows,
} from './shared.js';
import { requireTimestamp } from './tracks.js';

const DISCIPLINES = [
  'HUMINT',
  'SIGINT',
  'IMINT',
  'GEOINT',
  'OSINT',
  'MASINT',
  'UAS',
  'RECCE',
  'OP',
  'OTHER',
];

const TASKING_STATUSES = ['planned', 'tasked', 'active', 'complete', 'cancelled'];

export function shapeCollector(row) {
  return { ...row, releasable_to: JSON.parse(row.releasable_to) };
}

export function listCollectors(access) {
  return visibleRows(access, 'collector', 'collectors', 'name, id').map(shapeCollector);
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

export function createCollector(
  owner,
  {
    name,
    discipline,
    unit,
    range_km: rangeKm,
    available_from: availableFrom,
    available_to: availableTo,
    notes,
  },
) {
  const validName = requireString(name, 'name');
  const validDiscipline = requireEnum(discipline, 'discipline', DISCIPLINES);
  const validUnit = optionalString(unit, 'unit');
  const validRange = requirePositiveNumberOrNull(rangeKm, 'range_km');
  const { validFrom, validTo } = validateAvailability(availableFrom, availableTo);
  const validNotes = optionalString(notes, 'notes');
  return mutate(
    'collector:create',
    () => validName,
    cellsOf(owner),
    () => {
      const timestamp = now();
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO collectors (name, discipline, unit, range_km, available_from, available_to, notes, owner_cell, releasable_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          validName,
          validDiscipline,
          validUnit,
          validRange,
          validFrom,
          validTo,
          validNotes,
          owner.owner_cell,
          JSON.stringify(owner.releasable_to),
          timestamp,
          timestamp,
        );
      return shapeCollector(fetchRow('collectors', Number(lastInsertRowid)));
    },
  );
}

export function updateCollector(item, patch) {
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
    const from = 'available_from' in patch ? patch.available_from : item.available_from;
    const to = 'available_to' in patch ? patch.available_to : item.available_to;
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
  return mutate('collector:update', String(item.id), cellsOf(item), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database
        .prepare(`UPDATE collectors SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, item.id);
    }
    return shapeCollector(fetchRow('collectors', item.id));
  });
}

export function deleteCollector(item) {
  return mutate('collector:delete', String(item.id), cellsOf(item), () => {
    database.prepare('DELETE FROM collectors WHERE id = ?').run(item.id);
    return { deleted: true };
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

export function shapeTasking(row) {
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

export function listTaskings(access) {
  return visibleRows(access, 'tasking', 'taskings', 'start_at, id').map(shapeTasking);
}

function validateTaskingWindow(startAt, endAt) {
  const start = requireTimestamp(startAt, 'start_at');
  const end = requireTimestamp(endAt, 'end_at');
  if (new Date(start).getTime() >= new Date(end).getTime()) {
    throw new HttpError(400, 'start_at must be before end_at.');
  }
  return { start, end };
}

/** Taskings read the collector and the SIR's requirement via `access.see`
 * (docs/adr/0002 rule 1: ids of other items arriving in a body). */
function requireCollectorId(value, access) {
  if (!Number.isInteger(value)) throw new HttpError(400, 'collector_id must be an integer.');
  access.see('collector', value);
  return value;
}

function requireSirId(value, access) {
  if (!Number.isInteger(value)) throw new HttpError(400, 'sir_id must be an integer.');
  access.see('sir', value);
  return value;
}

function resolveTaskingReportId(value, access) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) throw new HttpError(400, 'report_id must be an integer.');
  access.see('report', value);
  return value;
}

export function createTasking(
  owner,
  {
    collector_id: collectorId,
    sir_id: sirId,
    nai_id: naiId,
    start_at: startAt,
    end_at: endAt,
    status,
    report_id: reportId,
    notes,
  },
  access,
) {
  const validCollectorId = requireCollectorId(collectorId, access);
  const validSirId = requireSirId(sirId, access);
  const validNaiId = naiId === undefined ? null : resolveNaiId(naiId, null, null, access);
  const { start, end } = validateTaskingWindow(startAt, endAt);
  const validStatus = requireEnum(status ?? 'planned', 'status', TASKING_STATUSES);
  const validReportId = resolveTaskingReportId(reportId, access);
  const validNotes = optionalString(notes, 'notes');
  return mutate(
    'tasking:create',
    () => `collector:${validCollectorId} sir:${validSirId}`,
    cellsOf(owner),
    () => {
      const timestamp = now();
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO taskings (collector_id, sir_id, nai_id, start_at, end_at, status, report_id, notes, owner_cell, releasable_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          owner.owner_cell,
          JSON.stringify(owner.releasable_to),
          timestamp,
          timestamp,
        );
      return shapeTasking(fetchRow('taskings', Number(lastInsertRowid)));
    },
  );
}

export function updateTasking(item, patch, access) {
  const fields = [];
  const params = [];
  if ('collector_id' in patch) {
    fields.push('collector_id = ?');
    params.push(requireCollectorId(patch.collector_id, access));
  }
  if ('sir_id' in patch) {
    fields.push('sir_id = ?');
    params.push(requireSirId(patch.sir_id, access));
  }
  if ('nai_id' in patch) {
    fields.push('nai_id = ?');
    params.push(resolveNaiId(patch.nai_id, null, null, access));
  }
  const startAt = 'start_at' in patch ? patch.start_at : item.start_at;
  const endAt = 'end_at' in patch ? patch.end_at : item.end_at;
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
    params.push(resolveTaskingReportId(patch.report_id, access));
  }
  if ('notes' in patch) {
    fields.push('notes = ?');
    params.push(optionalString(patch.notes, 'notes'));
  }
  return mutate('tasking:update', String(item.id), cellsOf(item), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database
        .prepare(`UPDATE taskings SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, item.id);
    }
    return shapeTasking(fetchRow('taskings', item.id));
  });
}

export function deleteTasking(item) {
  return mutate('tasking:delete', String(item.id), cellsOf(item), () => {
    database.prepare('DELETE FROM taskings WHERE id = ?').run(item.id);
    return { deleted: true };
  });
}

/**
 * Two kinds of conflict: two taskings of the same collector that overlap in
 * time, and a tasking scheduled outside its collector's availability
 * window. Read-only, so no activity entry. Only draws on taskings/collectors
 * the requester can currently see (docs/adr/0002: per-viewer reads).
 */
export function listCollectionConflicts(access) {
  const taskings = visibleRows(access, 'tasking', 'taskings', 'collector_id, start_at').map(
    shapeTasking,
  );
  const collectors = new Map(
    visibleRows(access, 'collector', 'collectors', 'id').map((c) => [c.id, c]),
  );

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
        if (
          new Date(a.start_at) < new Date(b.end_at) &&
          new Date(b.start_at) < new Date(a.end_at)
        ) {
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
      outside.push({
        kind: 'unavailable',
        collector_id: tasking.collector_id,
        tasking_id: tasking.id,
      });
    }
  }

  return { overlaps, outside };
}
