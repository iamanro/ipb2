// NAIs/TAIs imported from an IPB study, and the NAI list.

import { planIpbImport } from '../ipbImport.js';

import { database } from './connection.js';
import { cellsOf, mutate, now, touchRequirementRevision, visibleRows } from './shared.js';

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
  const bumpRevision = table === 'requirements' ? ', revision = revision + 1' : '';
  database
    .prepare(
      `UPDATE ${table} SET ${changed.map((name) => `${name} = ?`).join(', ')}, updated_at = ?${bumpRevision} WHERE id = ?`,
    )
    .run(...changed.map((name) => derived[name]), timestamp, row.id);
  return { id: row.id, outcome: 'updated' };
}

/**
 * Import (or refresh) an IPB study's event matrix as PIR/SIR/indicator rows,
 * all owned by `owner` (the dispatcher's create-verb owner: exactly what it
 * resolved from the actor/body, stored as-is). Never deletes: rows that
 * came from this study but are no longer in it are returned by text under
 * `stale` and left for the collection manager to remove, since they may
 * already carry evidence links and observations.
 */
export function importIpbStudy(owner, input) {
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
  return mutate('ipb:import', plan.studyName, cellsOf(owner), () => {
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
        { owner_cell: owner.owner_cell, releasable_to: JSON.stringify(owner.releasable_to) },
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
        {
          kind: 'PIR',
          priority: 0,
          owner_cell: owner.owner_cell,
          releasable_to: JSON.stringify(owner.releasable_to),
        },
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
      if (outcome !== 'unchanged')
        touchRequirementRevision(requirementIds.get(sir.requirementSource));
      tally('sirs', outcome);
    }
    for (const indicator of plan.indicators) {
      const sirId = sirIds.get(indicator.sirSource);
      const requirementId =
        database.prepare('SELECT requirement_id FROM sirs WHERE id = ?').get(sirId)
          ?.requirement_id ?? null;
      const { outcome } = upsertBySource(
        'indicators',
        indicator.source,
        {
          sir_id: sirId,
          requirement_id: requirementId,
          description: indicator.description,
        },
        { observed: indicator.observed ? 1 : 0 },
      );
      if (outcome !== 'unchanged') touchRequirementRevision(requirementId);
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
    return summary;
  });
}

export function shapeNai(row) {
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

export function listNais(access) {
  return visibleRows(access, 'nai', 'nais', 'id').map(shapeNai);
}
