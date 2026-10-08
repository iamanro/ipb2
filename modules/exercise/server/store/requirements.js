// PIRs/FFIRs with their SIRs, indicators and evidence links, and how far each
// is answered.

import { HttpError } from '../../../../server/http.ts';
import { computePirFulfillment } from '../fulfillment.js';

import { database } from './connection.js';
import {
  assertRevision,
  cellsOf,
  fetchRow,
  mutate,
  now,
  optionalString,
  requireEnum,
  requireString,
  resolveNaiId,
  touchRequirementRevision,
  visibleRows,
} from './shared.js';

// Duplicated from `server/policy.ts`, not imported (docs/adr/0002 rule 4: a
// store takes no user and imports nothing from policy.js) — the same reason
// `src/release.js` keeps its own copy for the browser bundle. This is the
// only place the store still needs the literal cell list, to validate an
// inject's `release_to`.

const REQUIREMENT_KINDS = ['PIR', 'FFIR'];
const TARGET_KINDS = ['requirement', 'sir'];
const RELATIONS = ['confirms', 'denies', 'partial', 'context'];

function shapeIndicator(row) {
  return {
    id: row.id,
    sir_id: row.sir_id,
    requirement_id: row.requirement_id,
    description: row.description,
    observed: Boolean(row.observed),
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function shapeEvidenceLinkBase(row) {
  return {
    id: row.id,
    report_id: row.report_id,
    requirement_id: row.requirement_id,
    target_kind: row.target_kind,
    target_id: row.target_id,
    relation: row.relation,
    note: row.note,
    created_at: row.created_at,
  };
}

/** A light citation preview — never the full shaped report (no need for its
 * own nested links), and only when the viewer can still see it. */
function reportSummary(row) {
  return {
    id: row.id,
    text: row.text,
    occurred_at: row.occurred_at,
    reliability: row.reliability,
    credibility: row.credibility,
    owner_cell: row.owner_cell,
  };
}

/**
 * An evidence link as shown on the requirement/SIR it supports: the cited
 * report, or — deleting a report never deletes the links citing it (see
 * `docs/adr/0002`, schema.js) — `report: null, withdrawn: true` once it's
 * gone. A report that still exists but the *viewer* can no longer see
 * (reassigned away since the link was made) shows neither: `report: null`,
 * `withdrawn: false`, same as any other row this viewer isn't shown.
 */
function shapeEvidenceLinkWithReport(row, access) {
  const reportRow = fetchRow('reports', row.report_id);
  let report = null;
  if (reportRow) {
    try {
      access.see('report', row.report_id);
      report = reportSummary(reportRow);
    } catch {
      report = null;
    }
  }
  return { ...shapeEvidenceLinkBase(row), report, withdrawn: !reportRow };
}

/** A SIR's fulfillment counts only evidence from reports the requester can
 * currently see (docs/adr/0002 rule: fulfillment is per viewer). */
function sirFulfillment(sirId, access) {
  const { sql, params } = access.visible('report', { alias: 'r' });
  const links = database
    .prepare(
      `SELECT el.relation, r.credibility
       FROM evidence_links el JOIN reports r ON r.id = el.report_id
       WHERE el.target_kind = 'sir' AND el.target_id = ? AND ${sql}`,
    )
    .all(sirId, ...params)
    .map((row) => ({ sirId, relation: row.relation, credibility: row.credibility }));
  return computePirFulfillment([sirId], links);
}

function shapeSir(row, access) {
  const indicators = database
    .prepare('SELECT * FROM indicators WHERE sir_id = ? ORDER BY created_at, id')
    .all(row.id)
    .map(shapeIndicator);
  const links = database
    .prepare(
      "SELECT * FROM evidence_links WHERE target_kind = 'sir' AND target_id = ? ORDER BY created_at, id",
    )
    .all(row.id)
    .map((link) => shapeEvidenceLinkWithReport(link, access));
  return {
    id: row.id,
    requirement_id: row.requirement_id,
    text: row.text,
    time_window_start: row.time_window_start,
    time_window_end: row.time_window_end,
    nai_id: row.nai_id,
    indicators,
    links,
    fulfillment: sirFulfillment(row.id, access),
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function requirementFulfillment(requirementId, sirIds, access) {
  const { sql, params } = access.visible('report', { alias: 'r' });
  const blanket = database
    .prepare(
      `SELECT el.relation, r.credibility
       FROM evidence_links el JOIN reports r ON r.id = el.report_id
       WHERE el.target_kind = 'requirement' AND el.target_id = ? AND ${sql}`,
    )
    .all(requirementId, ...params)
    .map((row) => ({ sirId: null, relation: row.relation, credibility: row.credibility }));
  const perSir = sirIds.length
    ? database
        .prepare(
          `SELECT el.target_id AS sir_id, el.relation, r.credibility
           FROM evidence_links el JOIN reports r ON r.id = el.report_id
           WHERE el.target_kind = 'sir' AND el.target_id IN (${sirIds.map(() => '?').join(',')}) AND ${sql}`,
        )
        .all(...sirIds, ...params)
        .map((row) => ({ sirId: row.sir_id, relation: row.relation, credibility: row.credibility }))
    : [];
  return computePirFulfillment(sirIds, [...blanket, ...perSir]);
}

export function shapeRequirement(row, { access }) {
  const sirs = database
    .prepare('SELECT * FROM sirs WHERE requirement_id = ? ORDER BY created_at, id')
    .all(row.id)
    .map((sir) => shapeSir(sir, access));
  const links = database
    .prepare(
      "SELECT * FROM evidence_links WHERE target_kind = 'requirement' AND target_id = ? ORDER BY created_at, id",
    )
    .all(row.id)
    .map((link) => shapeEvidenceLinkWithReport(link, access));
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    decision_point: row.decision_point,
    ltiov: row.ltiov,
    priority: row.priority,
    sirs,
    links,
    fulfillment: requirementFulfillment(
      row.id,
      sirs.map((sir) => sir.id),
      access,
    ),
    source: row.source,
    owner_cell: row.owner_cell,
    releasable_to: JSON.parse(row.releasable_to),
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listRequirements(access) {
  return visibleRows(access, 'requirement', 'requirements', 'priority DESC, created_at, id').map(
    (row) => shapeRequirement(row, { access }),
  );
}

export function createRequirement(
  owner,
  { kind, text, decision_point: decisionPoint, ltiov, priority },
  access,
) {
  requireEnum(kind, 'kind', REQUIREMENT_KINDS);
  const cleanText = requireString(text, 'text');
  const timestamp = now();
  return mutate(
    'requirement:create',
    () => cleanText,
    cellsOf(owner),
    () => {
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO requirements (kind, text, decision_point, ltiov, priority, owner_cell, releasable_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          kind,
          cleanText,
          optionalString(decisionPoint, 'decision_point'),
          optionalString(ltiov, 'ltiov'),
          Number.isInteger(priority) ? priority : 0,
          owner.owner_cell,
          JSON.stringify(owner.releasable_to),
          timestamp,
          timestamp,
        );
      return shapeRequirement(fetchRow('requirements', Number(lastInsertRowid)), { access });
    },
  );
}

export function updateRequirement(item, patch, access) {
  assertRevision('Requirement', item, patch);
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
  return mutate('requirement:update', String(item.id), cellsOf(item), () => {
    if (fields.length) {
      fields.push('revision = revision + 1', 'updated_at = ?');
      params.push(now());
      database
        .prepare(`UPDATE requirements SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, item.id);
    }
    return shapeRequirement(fetchRow('requirements', item.id), { access });
  });
}

export function deleteRequirement(item, input) {
  assertRevision('Requirement', item, input);
  return mutate('requirement:delete', String(item.id), cellsOf(item), () => {
    database.prepare('DELETE FROM requirements WHERE id = ?').run(item.id);
    return { deleted: true };
  });
}

export function createSir(item, input, access) {
  assertRevision('Requirement', item, input);
  const { text, time_window_start: start, time_window_end: end, nai_id: naiId } = input;
  const cleanText = requireString(text, 'text');
  const validNaiId = naiId === undefined ? null : resolveNaiId(naiId, null, null, access);
  const timestamp = now();
  return mutate(
    'sir:create',
    () => cleanText,
    cellsOf(item),
    () => {
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO sirs (requirement_id, text, time_window_start, time_window_end, nai_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          cleanText,
          optionalString(start, 'time_window_start'),
          optionalString(end, 'time_window_end'),
          validNaiId,
          timestamp,
          timestamp,
        );
      touchRequirementRevision(item.id);
      return shapeSir(fetchRow('sirs', Number(lastInsertRowid)), access);
    },
  );
}

export function updateSir(item, part, patch, access) {
  assertRevision('Requirement', item, patch);
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
    params.push(resolveNaiId(patch.nai_id, null, null, access));
  }
  return mutate('sir:update', String(part.id), cellsOf(item), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database.prepare(`UPDATE sirs SET ${fields.join(', ')} WHERE id = ?`).run(...params, part.id);
      touchRequirementRevision(item.id);
    }
    return shapeSir(fetchRow('sirs', part.id), access);
  });
}

export function deleteSir(item, part, input) {
  assertRevision('Requirement', item, input);
  return mutate('sir:delete', String(part.id), cellsOf(item), () => {
    database.prepare('DELETE FROM sirs WHERE id = ?').run(part.id);
    touchRequirementRevision(item.id);
    return { deleted: true };
  });
}

export function createIndicator(item, input) {
  assertRevision('Requirement', item, input);
  const { sir_id: sirId, description } = input;
  if (!Number.isInteger(sirId)) throw new HttpError(400, 'sir_id must be an integer.');
  const sir = fetchRow('sirs', sirId);
  if (!sir || sir.requirement_id !== item.id) {
    throw new HttpError(400, `sir_id ${sirId} does not belong to this requirement.`);
  }
  const cleanDescription = requireString(description, 'description');
  const timestamp = now();
  return mutate(
    'indicator:create',
    () => cleanDescription,
    cellsOf(item),
    () => {
      const { lastInsertRowid } = database
        .prepare(
          'INSERT INTO indicators (sir_id, requirement_id, description, observed, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
        )
        .run(sirId, item.id, cleanDescription, timestamp, timestamp);
      touchRequirementRevision(item.id);
      return shapeIndicator(fetchRow('indicators', Number(lastInsertRowid)));
    },
  );
}

export function updateIndicator(item, part, patch) {
  assertRevision('Requirement', item, patch);
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
  return mutate('indicator:update', String(part.id), cellsOf(item), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database
        .prepare(`UPDATE indicators SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, part.id);
      touchRequirementRevision(item.id);
    }
    return shapeIndicator(fetchRow('indicators', part.id));
  });
}

export function deleteIndicator(item, part, input) {
  assertRevision('Requirement', item, input);
  return mutate('indicator:delete', String(part.id), cellsOf(item), () => {
    database.prepare('DELETE FROM indicators WHERE id = ?').run(part.id);
    touchRequirementRevision(item.id);
    return { deleted: true };
  });
}

/** Evidence links are parts of the requirement they support (CONTEXT.md):
 * `item` is that requirement, already resolved and `canEdit`-checked by the
 * dispatcher. `target_kind: 'requirement'` defaults `target_id` to `item`
 * itself; `'sir'` needs a `target_id` that is actually one of its SIRs. The
 * cited report is read with `access.see`, exactly the contract's "creating
 * a link changes its target, not the report" rule. */
export function createEvidenceLink(item, input, access) {
  assertRevision('Requirement', item, input);
  const {
    report_id: reportId,
    target_kind: targetKind,
    target_id: targetId,
    relation,
    note,
  } = input;
  requireEnum(targetKind, 'target_kind', TARGET_KINDS);
  let cleanTargetId;
  if (targetKind === 'requirement') {
    cleanTargetId = targetId ?? item.id;
    if (cleanTargetId !== item.id) throw new HttpError(400, 'target_id must be this requirement.');
  } else {
    if (!Number.isInteger(targetId)) throw new HttpError(400, 'target_id must be an integer.');
    const sir = fetchRow('sirs', targetId);
    if (!sir || sir.requirement_id !== item.id) {
      throw new HttpError(400, `target_id ${targetId} is not a SIR of this requirement.`);
    }
    cleanTargetId = targetId;
  }
  if (!Number.isInteger(reportId)) throw new HttpError(400, 'report_id must be an integer.');
  const report = access.see('report', reportId);
  requireEnum(relation, 'relation', RELATIONS);
  return mutate('evidence:link', `report:${report.id}`, cellsOf(item), () => {
    const { lastInsertRowid } = database
      .prepare(
        `INSERT INTO evidence_links (report_id, requirement_id, target_kind, target_id, relation, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.id,
        item.id,
        targetKind,
        cleanTargetId,
        relation,
        optionalString(note, 'note'),
        now(),
      );
    touchRequirementRevision(item.id);
    return shapeEvidenceLinkWithReport(fetchRow('evidence_links', Number(lastInsertRowid)), access);
  });
}

export function deleteEvidenceLink(item, part, input) {
  assertRevision('Requirement', item, input);
  return mutate('evidence:unlink', String(part.id), cellsOf(item), () => {
    database.prepare('DELETE FROM evidence_links WHERE id = ?').run(part.id);
    touchRequirementRevision(item.id);
    return { deleted: true };
  });
}
