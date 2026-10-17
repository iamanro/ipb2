import type { SQLInputValue } from 'node:sqlite';
// Requests for information and their state machine.

import type { Access, Owner } from '../../../../server/dispatch.ts';
import { fieldsOf, HttpError, type Json } from '../../../../server/http.ts';
import { normalizeRelease, releasableArray } from '../../../../server/policy.ts';
import { num, type Row } from '../../../../server/state.ts';
import { canTransition } from '../rfiMachine.ts';

import { database } from './connection.ts';
import { readReport, readRfi, readSir } from './rows.ts';
import {
  cellsOf,
  existingRow,
  mutate,
  now,
  optionalString,
  requireEnum,
  requireInteger,
  requireString,
  touchRequirementRevision,
  touchRequirementsForReport,
  visibleRows,
} from './shared.ts';

const RFI_PRIORITIES = ['routine', 'priority', 'immediate'];

export function shapeRfi(raw: Row) {
  const rfi = readRfi(raw);
  return { ...rfi, releasable_to: releasableArray(rfi.releasable_to) };
}

export function listRfis(access: Access) {
  return visibleRows(access, 'rfi', 'rfis', 'created_at DESC, id DESC').map(shapeRfi);
}

export function createRfi(owner: Owner, input: Json, access: Access) {
  const { requester, requirement_id, sir_id, question, priority, nlt } = fieldsOf(input);
  const requirementId =
    requirement_id === undefined || requirement_id === null
      ? null
      : requireInteger(requirement_id, 'requirement_id');
  const sirId = sir_id === undefined || sir_id === null ? null : requireInteger(sir_id, 'sir_id');
  const cleanQuestion = requireString(question, 'question');
  const cleanPriority =
    priority === undefined ? 'routine' : requireEnum(priority, 'priority', RFI_PRIORITIES);
  if (requirementId !== null) access.see('requirement', requirementId);
  if (sirId !== null) access.see('sir', sirId);
  const timestamp = now();
  return mutate(
    'rfi:create',
    () => cleanQuestion,
    cellsOf(owner),
    () => {
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO rfis (requester, requirement_id, sir_id, question, priority, nlt, state, owner_cell, releasable_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
        )
        .run(
          optionalString(requester, 'requester'),
          requirementId,
          sirId,
          cleanQuestion,
          cleanPriority,
          optionalString(nlt, 'nlt'),
          owner.owner_cell,
          JSON.stringify(owner.releasable_to),
          timestamp,
          timestamp,
        );
      return shapeRfi(existingRow('rfis', Number(lastInsertRowid)));
    },
  );
}

export function updateRfi(item: Row, input: Json) {
  const patch = fieldsOf(input);
  const itemId = num(item, 'id');
  const fields: string[] = [];
  const params: SQLInputValue[] = [];
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
  return mutate('rfi:update', String(itemId), cellsOf(item), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database.prepare(`UPDATE rfis SET ${fields.join(', ')} WHERE id = ?`).run(...params, itemId);
    }
    return shapeRfi(existingRow('rfis', itemId));
  });
}

/**
 * The one path that changes RFI state. The owner cell may make every
 * transition except `answered`, which needs White (docs/adr/0002 + CONTEXT.md:
 * White coordinates collection across cells, so the requester answering
 * their own RFI isn't sensible). Answering can create the evidence link
 * that closes the loop back to the requirement/SIR it was raised against,
 * in the same transaction as the state change. When White answers a
 * non-White RFI, the answer report is automatically released to the
 * requesting cell — otherwise the requester couldn't see their own answer.
 */
export function transitionRfi(item: Row, input: Json, access: Access) {
  const { state, answer_report_id, relation } = fieldsOf(input);
  const rfi = readRfi(item);
  const toState = typeof state === 'string' ? state : JSON.stringify(state ?? null);
  if (!canTransition(rfi.state, toState)) {
    throw new HttpError(409, `Cannot move an RFI from ${rfi.state} to ${toState}.`);
  }
  if (toState === 'answered' && !access.white) {
    throw new HttpError(403, 'Only White may answer an RFI.');
  }
  const answerReportId =
    typeof answer_report_id === 'number' && Number.isInteger(answer_report_id)
      ? answer_report_id
      : null;
  const relationName = optionalString(relation, 'relation') ?? 'confirms';
  let answerReport = null;
  if (toState === 'answered') {
    if (answerReportId === null) {
      throw new HttpError(400, 'answer_report_id is required to answer an RFI.');
    }
    answerReport = readReport(access.see('report', answerReportId));
  }
  return mutate('rfi:transition', `${rfi.state}->${toState}`, cellsOf(item), () => {
    database
      .prepare(
        'UPDATE rfis SET state = ?, answer_report_id = COALESCE(?, answer_report_id), updated_at = ? WHERE id = ?',
      )
      .run(toState, answerReportId, now(), rfi.id);
    if (answerReport && (rfi.requirement_id || rfi.sir_id)) {
      const targetKind = rfi.sir_id ? 'sir' : 'requirement';
      const targetId = rfi.sir_id ?? rfi.requirement_id;
      const requirementId = rfi.sir_id
        ? readSir(existingRow('sirs', rfi.sir_id)).requirement_id
        : num(item, 'requirement_id');
      database
        .prepare(
          `INSERT INTO evidence_links (report_id, requirement_id, target_kind, target_id, relation, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          answerReport.id,
          requirementId,
          targetKind,
          targetId,
          relationName,
          'Auto-linked from RFI answer.',
          now(),
        );
      touchRequirementRevision(requirementId);
    }
    if (answerReport && answerReport.owner_cell !== rfi.owner_cell) {
      const released = normalizeRelease(
        [...releasableArray(answerReport.releasable_to), rfi.owner_cell],
        answerReport.owner_cell,
      );
      database
        .prepare(
          'UPDATE reports SET releasable_to = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
        )
        .run(JSON.stringify(released), now(), answerReport.id);
      touchRequirementsForReport(answerReport.id);
    }
    return shapeRfi(existingRow('rfis', rfi.id));
  });
}

export function deleteRfi(item: Row) {
  const itemId = num(item, 'id');
  return mutate('rfi:delete', String(itemId), cellsOf(item), () => {
    database.prepare('DELETE FROM rfis WHERE id = ?').run(itemId);
    return { deleted: true };
  });
}
