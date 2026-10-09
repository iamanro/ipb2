import { fieldsOf, HttpError, isJsonObject, type Json } from '../../../server/http.ts';

export type PlannedNai = {
  source: string;
  feature_id: number;
  study_id: number;
  kind: string;
  label: string;
  geometry: Json;
};
export type PlannedRequirement = { source: string; text: string };
export type PlannedSir = {
  source: string;
  requirementSource: string;
  text: string;
  naiSource: string | null;
};
export type PlannedIndicator = {
  source: string;
  sirSource: string;
  description: string;
  observed: boolean;
};
export type IpbImportPlan = ReturnType<typeof planIpbImport>;

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
 * `{ study: { id, name }, coas: [{ id, name, kind }],
 *    nais: [{ id, label, kind, geometry }],
 *    events: [{ id, coa_id, nai_feature_id, indicator, expected_time, observed_status }] }`.
 * `nais[].kind` ('nai'|'tai') and `.geometry` (a GeoJSON geometry) are
 * optional for backwards compatibility with older callers: a missing kind
 * defaults to 'nai', a missing geometry stores NULL (the row still gets
 * created so SIRs can reference it, it just never auto-matches a report).
 * `input.decision_points`, if present, is accepted but not yet used here.
 * Pure: no database, no clock.
 */

const COA_KIND_LABELS: Record<string, string> = {
  'most-likely': 'most likely',
  'most-dangerous': 'most dangerous',
};
const NAI_KINDS = new Set(['nai', 'tai']);

export function ipbSourcePrefix(studyId: number) {
  return `ipb:${studyId}:`;
}

function requireArray(value: Json | undefined, name: string): Json[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${name} must be an array.`);
  return value;
}

function requireId(value: Json | undefined, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new HttpError(400, `${name} must be an integer id.`);
  return value;
}

function requireText(value: Json | undefined, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${name} is required.`);
  return value.trim();
}

function isGeometryLike(value: Json): boolean {
  return isJsonObject(value) && typeof value.type === 'string' && Array.isArray(value.coordinates);
}

/**
 * How an imported area reads in SIR and SOR text: "NAI 1" stays "NAI 1",
 * a bare "Bridge" becomes "NAI Bridge" (or "TAI …" for a TAI).
 */
export function areaName(kind: string | undefined, label: string) {
  const prefix = kind === 'tai' ? 'TAI' : 'NAI';
  return new RegExp(`^${prefix}\\b`, 'i').test(label) ? label : `${prefix} ${label}`;
}

export function planIpbImport(input: Json) {
  if (!isJsonObject(input)) throw new HttpError(400, 'Body must be an object.');
  const study = fieldsOf(input.study);
  const studyId = requireId(study.id, 'study.id');
  const studyName = requireText(study.name, 'study.name');
  const prefix = ipbSourcePrefix(studyId);

  const naiInputs = requireArray(input.nais, 'nais').map((nai) => fieldsOf(nai));
  const naiLabels = new Map(
    naiInputs.map((nai) => {
      const id = requireId(nai.id, 'nais[].id');
      const label = typeof nai.label === 'string' && nai.label.trim() ? nai.label.trim() : `#${id}`;
      return [id, label];
    }),
  );
  const nais = naiInputs.map((nai): PlannedNai => {
    const id = requireId(nai.id, 'nais[].id');
    const geometry = nai.geometry ?? null;
    if (geometry !== null && !isGeometryLike(geometry)) {
      throw new HttpError(400, `nais[${id}].geometry must be a GeoJSON geometry or null.`);
    }
    return {
      source: `${prefix}nai:${id}`,
      feature_id: id,
      study_id: studyId,
      kind: typeof nai.kind === 'string' && NAI_KINDS.has(nai.kind) ? nai.kind : 'nai',
      label: naiLabels.get(id) ?? `#${id}`,
      geometry,
    };
  });

  const requirements: PlannedRequirement[] = [];
  const coaById = new Map<number, { name: string; source: string }>();
  for (const coa of requireArray(input.coas, 'coas').map((value) => fieldsOf(value))) {
    const id = requireId(coa.id, 'coas[].id');
    const name = requireText(coa.name, 'coas[].name');
    const kind = typeof coa.kind === 'string' ? COA_KIND_LABELS[coa.kind] : undefined;
    const source = `${prefix}coa:${id}`;
    coaById.set(id, { name, source });
    requirements.push({
      source,
      text: `${studyName}: is the enemy executing ${name}${kind ? ` (${kind} COA)` : ''}?`,
    });
  }

  const sirs = new Map<string, PlannedSir>();
  const indicators: PlannedIndicator[] = [];
  for (const event of requireArray(input.events, 'events').map((value) => fieldsOf(value))) {
    const id = requireId(event.id, 'events[].id');
    const coaId = event.coa_id;
    const coa = typeof coaId === 'number' ? coaById.get(coaId) : undefined;
    if (!coa)
      throw new HttpError(400, `Event ${id} references unknown COA ${JSON.stringify(coaId)}.`);
    const naiFeatureId = event.nai_feature_id;
    const naiId =
      typeof naiFeatureId === 'number' && Number.isInteger(naiFeatureId) ? naiFeatureId : null;
    const sirSource = `${coa.source}:nai:${naiId ?? 'none'}`;
    if (!sirs.has(sirSource)) {
      const area = nais.find((nai) => nai.feature_id === naiId);
      const where =
        naiId === null
          ? 'No NAI assigned'
          : areaName(area?.kind, naiLabels.get(naiId) ?? `#${naiId}`);
      sirs.set(sirSource, {
        source: sirSource,
        requirementSource: coa.source,
        text: `${where}: indicators of ${coa.name}`,
        naiSource: naiId === null ? null : `${prefix}nai:${naiId}`,
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

  return { studyName, prefix, requirements, sirs: [...sirs.values()], indicators, nais };
}
