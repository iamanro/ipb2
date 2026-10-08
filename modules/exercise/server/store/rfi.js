// Requests for information and their state machine.

import { HttpError } from '../../../../server/http.ts';
import { normalizeRelease } from '../../../../server/policy.ts';
import { canTransition } from '../rfiMachine.js';

import { database } from './connection.js';
import {
  cellsOf,
  fetchRow,
  mutate,
  now,
  optionalString,
  requireEnum,
  requireString,
  touchRequirementRevision,
  touchRequirementsForReport,
  visibleRows,
} from './shared.js';

const RFI_PRIORITIES = ['routine', 'priority', 'immediate'];

export function shapeRfi(row) {
  return { ...row, releasable_to: JSON.parse(row.releasable_to) };
}

export function listRfis(access) {
  return visibleRows(access, 'rfi', 'rfis', 'created_at DESC, id DESC').map(shapeRfi);
}

export function createRfi(
  owner,
  { requester, requirement_id: requirementId, sir_id: sirId, question, priority, nlt },
  access,
) {
  const cleanQuestion = requireString(question, 'question');
  const cleanPriority =
    priority === undefined ? 'routine' : requireEnum(priority, 'priority', RFI_PRIORITIES);
  if (requirementId !== undefined && requirementId !== null) {
    access.see('requirement', requirementId);
  }
  if (sirId !== undefined && sirId !== null) {
    access.see('sir', sirId);
  }
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
          requirementId ?? null,
          sirId ?? null,
          cleanQuestion,
          cleanPriority,
          optionalString(nlt, 'nlt'),
          owner.owner_cell,
          JSON.stringify(owner.releasable_to),
          timestamp,
          timestamp,
        );
      return shapeRfi(fetchRow('rfis', Number(lastInsertRowid)));
    },
  );
}

export function updateRfi(item, patch) {
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
  return mutate('rfi:update', String(item.id), cellsOf(item), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database.prepare(`UPDATE rfis SET ${fields.join(', ')} WHERE id = ?`).run(...params, item.id);
    }
    return shapeRfi(fetchRow('rfis', item.id));
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
export function transitionRfi(
  item,
  { state: toState, answer_report_id: answerReportId, relation },
  access,
) {
  if (!canTransition(item.state, toState)) {
    throw new HttpError(409, `Cannot move an RFI from ${item.state} to ${toState}.`);
  }
  if (toState === 'answered' && !access.white) {
    throw new HttpError(403, 'Only White may answer an RFI.');
  }
  let answerReport = null;
  if (toState === 'answered') {
    if (!Number.isInteger(answerReportId)) {
      throw new HttpError(400, 'answer_report_id is required to answer an RFI.');
    }
    answerReport = access.see('report', answerReportId);
  }
  return mutate('rfi:transition', `${item.state}->${toState}`, cellsOf(item), () => {
    database
      .prepare(
        'UPDATE rfis SET state = ?, answer_report_id = COALESCE(?, answer_report_id), updated_at = ? WHERE id = ?',
      )
      .run(toState, answerReportId ?? null, now(), item.id);
    if (toState === 'answered' && (item.requirement_id || item.sir_id)) {
      const targetKind = item.sir_id ? 'sir' : 'requirement';
      const targetId = item.sir_id ?? item.requirement_id;
      const requirementId = item.sir_id
        ? fetchRow('sirs', item.sir_id).requirement_id
        : item.requirement_id;
      database
        .prepare(
          `INSERT INTO evidence_links (report_id, requirement_id, target_kind, target_id, relation, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          answerReportId,
          requirementId,
          targetKind,
          targetId,
          relation ?? 'confirms',
          'Auto-linked from RFI answer.',
          now(),
        );
      touchRequirementRevision(requirementId);
    }
    if (toState === 'answered' && answerReport && answerReport.owner_cell !== item.owner_cell) {
      const released = normalizeRelease(
        [...JSON.parse(answerReport.releasable_to), item.owner_cell],
        answerReport.owner_cell,
      );
      database
        .prepare(
          'UPDATE reports SET releasable_to = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
        )
        .run(JSON.stringify(released), now(), answerReportId);
      touchRequirementsForReport(answerReportId);
    }
    return shapeRfi(fetchRow('rfis', item.id));
  });
}

export function deleteRfi(item) {
  return mutate('rfi:delete', String(item.id), cellsOf(item), () => {
    database.prepare('DELETE FROM rfis WHERE id = ?').run(item.id);
    return { deleted: true };
  });
}
