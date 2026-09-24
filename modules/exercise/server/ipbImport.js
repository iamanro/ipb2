import { HttpError } from '../../../server/http.js';

/**
 * Turns an IPB study's event matrix into the collection requirements it
 * implies, as rows keyed by a stable `source` so a re-import updates instead
 * of duplicating:
 *
 *   COA                    -> PIR        "Is the enemy executing <COA>?"
 *   (COA, NAI)             -> SIR        "NAI <label>: indicators of <COA>"
 *   event-matrix row       -> indicator  "<indicator> (expected <time>)"
 *
 * One PIR per COA means the PIRs' fulfillment, side by side, is the answer to
 * "which COA is the enemy on?". Events without an NAI still need collecting,
 * so they share one per-COA "no NAI" SIR rather than being dropped.
 *
 * `expected_time` is free text in IPB (H+4, 0600Z, …), so it stays in the
 * indicator wording instead of being forced into the SIR's time window.
 *
 * Input is the subset of GET /api/ipb/studies/:id the client sends:
 * `{ study: { id, name }, coas: [{ id, name, kind }], nais: [{ id, label }],
 *    events: [{ id, coa_id, nai_feature_id, indicator, expected_time, observed_status }] }`.
 * Pure: no database, no clock.
 */

const COA_KIND_LABELS = { 'most-likely': 'most likely', 'most-dangerous': 'most dangerous' };

export function ipbSourcePrefix(studyId) {
  return `ipb:${studyId}:`;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new HttpError(400, `${name} must be an array.`);
  return value;
}

function requireId(value, name) {
  if (!Number.isInteger(value)) throw new HttpError(400, `${name} must be an integer id.`);
  return value;
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${name} is required.`);
  return value.trim();
}

export function planIpbImport(input) {
  if (typeof input !== 'object' || input === null)
    throw new HttpError(400, 'Body must be an object.');
  const studyId = requireId(input.study?.id, 'study.id');
  const studyName = requireText(input.study?.name, 'study.name');
  const prefix = ipbSourcePrefix(studyId);

  const naiLabels = new Map(
    requireArray(input.nais, 'nais').map((nai) => [
      requireId(nai.id, 'nais[].id'),
      typeof nai.label === 'string' && nai.label.trim() ? nai.label.trim() : `#${nai.id}`,
    ]),
  );

  const requirements = [];
  const coaById = new Map();
  for (const coa of requireArray(input.coas, 'coas')) {
    const id = requireId(coa.id, 'coas[].id');
    const name = requireText(coa.name, 'coas[].name');
    const kind = COA_KIND_LABELS[coa.kind];
    const source = `${prefix}coa:${id}`;
    coaById.set(id, { name, source });
    requirements.push({
      source,
      text: `${studyName}: is the enemy executing ${name}${kind ? ` (${kind} COA)` : ''}?`,
    });
  }

  const sirs = new Map();
  const indicators = [];
  for (const event of requireArray(input.events, 'events')) {
    const id = requireId(event.id, 'events[].id');
    const coa = coaById.get(event.coa_id);
    if (!coa) throw new HttpError(400, `Event ${id} references unknown COA ${event.coa_id}.`);
    const naiId = Number.isInteger(event.nai_feature_id) ? event.nai_feature_id : null;
    const sirSource = `${coa.source}:nai:${naiId ?? 'none'}`;
    if (!sirs.has(sirSource)) {
      const where =
        naiId === null ? 'No NAI assigned' : `NAI ${naiLabels.get(naiId) ?? `#${naiId}`}`;
      sirs.set(sirSource, {
        source: sirSource,
        requirementSource: coa.source,
        text: `${where}: indicators of ${coa.name}`,
      });
    }
    const indicator = requireText(event.indicator, `events[${id}].indicator`);
    const expected =
      typeof event.expected_time === 'string' && event.expected_time.trim()
        ? ` (expected ${event.expected_time.trim()})`
        : '';
    indicators.push({
      source: `${prefix}event:${id}`,
      sirSource,
      description: `${indicator}${expected}`,
      observed: event.observed_status === 'observed',
    });
  }

  return { studyName, prefix, requirements, sirs: [...sirs.values()], indicators };
}
