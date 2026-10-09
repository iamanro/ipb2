import type { SQLInputValue } from 'node:sqlite';
// The collection plan: collectors, taskings and their conflicts.

import { formatDtg } from '../../../../src/dtg.js';
import type { Access, Owner } from '../../../../server/dispatch.ts';
import { fieldsOf, HttpError, type Json } from '../../../../server/http.ts';
import { releasableArray } from '../../../../server/policy.ts';
import { num, textOrNull, type Row } from '../../../../server/state.ts';
import { areaName } from '../ipbImport.ts';

import { database } from './connection.ts';
import {
  readCollector,
  readNai,
  readRequirement,
  readSir,
  readTasking,
  type TaskingRow,
} from './rows.ts';
import {
  cellsOf,
  existingRow,
  fetchRow,
  mutate,
  now,
  optionalString,
  requireEnum,
  requireString,
  resolveNaiId,
  visibleRows,
} from './shared.ts';
import { requireTimestamp } from './tracks.ts';

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

export function shapeCollector(raw: Row) {
  const collector = readCollector(raw);
  return { ...collector, releasable_to: releasableArray(collector.releasable_to) };
}

export function listCollectors(access: Access) {
  return visibleRows(access, 'collector', 'collectors', 'name, id').map(shapeCollector);
}

function requirePositiveNumberOrNull(value: Json | undefined, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, `${name} must be a positive number.`);
  }
  return value;
}

/** `available_from`/`available_to` are each optional, but if both are given the first must precede the second. */
function validateAvailability(from: Json | undefined, to: Json | undefined) {
  const validFrom = optionalString(from, 'available_from');
  const validTo = optionalString(to, 'available_to');
  if (validFrom && validTo && new Date(validFrom).getTime() >= new Date(validTo).getTime()) {
    throw new HttpError(400, 'available_from must be before available_to.');
  }
  return { validFrom, validTo };
}

export function createCollector(owner: Owner, input: Json) {
  const {
    name,
    discipline,
    unit,
    range_km: rangeKm,
    available_from: availableFrom,
    available_to: availableTo,
    notes,
  } = fieldsOf(input);
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
      return shapeCollector(existingRow('collectors', Number(lastInsertRowid)));
    },
  );
}

export function updateCollector(item: Row, input: Json) {
  const patch = fieldsOf(input);
  const itemId = num(item, 'id');
  const fields: string[] = [];
  const params: SQLInputValue[] = [];
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
    const from =
      'available_from' in patch ? patch.available_from : textOrNull(item, 'available_from');
    const to = 'available_to' in patch ? patch.available_to : textOrNull(item, 'available_to');
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
  return mutate('collector:update', String(itemId), cellsOf(item), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database
        .prepare(`UPDATE collectors SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, itemId);
    }
    return shapeCollector(existingRow('collectors', itemId));
  });
}

export function deleteCollector(item: Row) {
  const itemId = num(item, 'id');
  return mutate('collector:delete', String(itemId), cellsOf(item), () => {
    database.prepare('DELETE FROM collectors WHERE id = ?').run(itemId);
    return { deleted: true };
  });
}

/** "COLLECTOR x: collect SIR y at NAI z from DTG to DTG; report NLT LTIOV". */
function generateSor(
  row: TaskingRow,
  collector: Row | null,
  sirRow: Row | null,
  naiRow: Row | null,
) {
  const sir = sirRow && readSir(sirRow);
  const nai = naiRow && readNai(naiRow);
  const collectorName = collector
    ? readCollector(collector).name
    : `Collector #${row.collector_id}`;
  const sirText = sir ? sir.text : `SIR #${row.sir_id}`;
  const area = nai ? areaName(nai.kind, nai.label) : 'no NAI';
  const start = formatDtg(new Date(row.start_at).getTime());
  const end = formatDtg(new Date(row.end_at).getTime());
  const requirementRow = sir ? fetchRow('requirements', sir.requirement_id) : null;
  const ltiovText = requirementRow ? readRequirement(requirementRow).ltiov : null;
  const ltiov = ltiovText ? formatDtg(new Date(ltiovText).getTime()) : 'unset';
  return `${collectorName}: collect ${sirText} at ${area} from ${start} to ${end}; report NLT ${ltiov}`;
}

export function shapeTasking(raw: Row) {
  const row = readTasking(raw);
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
    releasable_to: releasableArray(row.releasable_to),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listTaskings(access: Access) {
  return visibleRows(access, 'tasking', 'taskings', 'start_at, id').map(shapeTasking);
}

function validateTaskingWindow(startAt: Json | undefined, endAt: Json | undefined) {
  const start = requireTimestamp(startAt, 'start_at');
  const end = requireTimestamp(endAt, 'end_at');
  if (new Date(start).getTime() >= new Date(end).getTime()) {
    throw new HttpError(400, 'start_at must be before end_at.');
  }
  return { start, end };
}

/** Taskings read the collector and the SIR's requirement via `access.see`
 * (docs/adr/0002 rule 1: ids of other items arriving in a body). */
function requireCollectorId(value: Json | undefined, access: Access): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new HttpError(400, 'collector_id must be an integer.');
  access.see('collector', value);
  return value;
}

function requireSirId(value: Json | undefined, access: Access): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new HttpError(400, 'sir_id must be an integer.');
  access.see('sir', value);
  return value;
}

function resolveTaskingReportId(value: Json | undefined, access: Access): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new HttpError(400, 'report_id must be an integer.');
  access.see('report', value);
  return value;
}

export function createTasking(owner: Owner, input: Json, access: Access) {
  const {
    collector_id: collectorId,
    sir_id: sirId,
    nai_id: naiId,
    start_at: startAt,
    end_at: endAt,
    status,
    report_id: reportId,
    notes,
  } = fieldsOf(input);
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
      return shapeTasking(existingRow('taskings', Number(lastInsertRowid)));
    },
  );
}

export function updateTasking(item: Row, input: Json, access: Access) {
  const patch = fieldsOf(input);
  const itemId = num(item, 'id');
  const fields: string[] = [];
  const params: SQLInputValue[] = [];
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
  const startAt = 'start_at' in patch ? patch.start_at : textOrNull(item, 'start_at');
  const endAt = 'end_at' in patch ? patch.end_at : textOrNull(item, 'end_at');
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
  return mutate('tasking:update', String(itemId), cellsOf(item), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database
        .prepare(`UPDATE taskings SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, itemId);
    }
    return shapeTasking(existingRow('taskings', itemId));
  });
}

export function deleteTasking(item: Row) {
  const itemId = num(item, 'id');
  return mutate('tasking:delete', String(itemId), cellsOf(item), () => {
    database.prepare('DELETE FROM taskings WHERE id = ?').run(itemId);
    return { deleted: true };
  });
}

/**
 * Two kinds of conflict: two taskings of the same collector that overlap in
 * time, and a tasking scheduled outside its collector's availability
 * window. Read-only, so no activity entry. Only draws on taskings/collectors
 * the requester can currently see (docs/adr/0002: per-viewer reads).
 */
export function listCollectionConflicts(access: Access) {
  const taskings = visibleRows(access, 'tasking', 'taskings', 'collector_id, start_at').map(
    shapeTasking,
  );
  const collectors = new Map(
    visibleRows(access, 'collector', 'collectors', 'id')
      .map(readCollector)
      .map((collector) => [collector.id, collector]),
  );

  const byCollector = new Map<number, typeof taskings>();
  for (const tasking of taskings) {
    const list = byCollector.get(tasking.collector_id) ?? [];
    list.push(tasking);
    byCollector.set(tasking.collector_id, list);
  }
  const ms = (timestamp: string) => new Date(timestamp).getTime();
  const overlaps: { kind: 'overlap'; collector_id: number; tasking_ids: number[] }[] = [];
  for (const [collectorId, list] of byCollector) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (ms(a.start_at) < ms(b.end_at) && ms(b.start_at) < ms(a.end_at)) {
          overlaps.push({ kind: 'overlap', collector_id: collectorId, tasking_ids: [a.id, b.id] });
        }
      }
    }
  }

  const outside: { kind: 'unavailable'; collector_id: number; tasking_id: number }[] = [];
  for (const tasking of taskings) {
    const collector = collectors.get(tasking.collector_id);
    if (!collector) continue;
    const from = collector.available_from ? ms(collector.available_from) : null;
    const to = collector.available_to ? ms(collector.available_to) : null;
    const start = ms(tasking.start_at);
    const end = ms(tasking.end_at);
    if ((from !== null && start < from) || (to !== null && end > to)) {
      outside.push({
        kind: 'unavailable',
        collector_id: tasking.collector_id,
        tasking_id: tasking.id,
      });
    }
  }

  return { overlaps, outside };
}
