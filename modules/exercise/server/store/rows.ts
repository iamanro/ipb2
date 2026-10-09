// Typed rows of every exercise table, read column by column (server/state.ts
// readers check each value). Nullability follows the migrated schema.
import { num, numOrNull, text, textOrNull, type Row } from '../../../../server/state.ts';

/** Every cell-owned table carries these. `releasable_to` is JSON text. */
type Owned = { owner_cell: string; releasable_to: string };

function owned(row: Row): Owned {
  return { owner_cell: text(row, 'owner_cell'), releasable_to: text(row, 'releasable_to') };
}

export type RequirementRow = Owned & {
  id: number;
  kind: string;
  text: string;
  decision_point: string | null;
  ltiov: string | null;
  priority: number;
  source: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};
export function readRequirement(row: Row): RequirementRow {
  return {
    ...owned(row),
    id: num(row, 'id'),
    kind: text(row, 'kind'),
    text: text(row, 'text'),
    decision_point: textOrNull(row, 'decision_point'),
    ltiov: textOrNull(row, 'ltiov'),
    priority: num(row, 'priority'),
    source: textOrNull(row, 'source'),
    revision: num(row, 'revision'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export type SirRow = {
  id: number;
  requirement_id: number;
  text: string;
  time_window_start: string | null;
  time_window_end: string | null;
  nai_id: number | null;
  source: string | null;
  created_at: string;
  updated_at: string;
};
export function readSir(row: Row): SirRow {
  return {
    id: num(row, 'id'),
    requirement_id: num(row, 'requirement_id'),
    text: text(row, 'text'),
    time_window_start: textOrNull(row, 'time_window_start'),
    time_window_end: textOrNull(row, 'time_window_end'),
    nai_id: numOrNull(row, 'nai_id'),
    source: textOrNull(row, 'source'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export type IndicatorRow = {
  id: number;
  sir_id: number;
  requirement_id: number | null;
  description: string;
  observed: number;
  source: string | null;
  created_at: string;
  updated_at: string;
};
export function readIndicator(row: Row): IndicatorRow {
  return {
    id: num(row, 'id'),
    sir_id: num(row, 'sir_id'),
    requirement_id: numOrNull(row, 'requirement_id'),
    description: text(row, 'description'),
    observed: num(row, 'observed'),
    source: textOrNull(row, 'source'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export type EvidenceLinkRow = {
  id: number;
  report_id: number;
  requirement_id: number;
  target_kind: string;
  target_id: number;
  relation: string;
  note: string | null;
  created_at: string;
};
export function readEvidenceLink(row: Row): EvidenceLinkRow {
  return {
    id: num(row, 'id'),
    report_id: num(row, 'report_id'),
    requirement_id: num(row, 'requirement_id'),
    target_kind: text(row, 'target_kind'),
    target_id: num(row, 'target_id'),
    relation: text(row, 'relation'),
    note: textOrNull(row, 'note'),
    created_at: text(row, 'created_at'),
  };
}

export type ReportRow = Owned & {
  id: number;
  text: string;
  occurred_at: string | null;
  source: string | null;
  author: string | null;
  reliability: string;
  credibility: number;
  lon: number | null;
  lat: number | null;
  report_type: string;
  /** JSON text of the structured SALUTE/SPOTREP fields. */
  fields: string;
  sidc: string | null;
  nai_id: number | null;
  track_id: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
};
export function readReport(row: Row): ReportRow {
  return {
    ...owned(row),
    id: num(row, 'id'),
    text: text(row, 'text'),
    occurred_at: textOrNull(row, 'occurred_at'),
    source: textOrNull(row, 'source'),
    author: textOrNull(row, 'author'),
    reliability: text(row, 'reliability'),
    credibility: num(row, 'credibility'),
    lon: numOrNull(row, 'lon'),
    lat: numOrNull(row, 'lat'),
    report_type: text(row, 'report_type'),
    fields: text(row, 'fields'),
    sidc: textOrNull(row, 'sidc'),
    nai_id: numOrNull(row, 'nai_id'),
    track_id: numOrNull(row, 'track_id'),
    revision: num(row, 'revision'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export type NaiRow = Owned & {
  id: number;
  source: string | null;
  study_id: number | null;
  feature_id: number | null;
  kind: string;
  label: string;
  /** JSON text of a GeoJSON geometry. */
  geometry: string | null;
  created_at: string;
  updated_at: string;
};
export function readNai(row: Row): NaiRow {
  return {
    ...owned(row),
    id: num(row, 'id'),
    source: textOrNull(row, 'source'),
    study_id: numOrNull(row, 'study_id'),
    feature_id: numOrNull(row, 'feature_id'),
    kind: text(row, 'kind'),
    label: text(row, 'label'),
    geometry: textOrNull(row, 'geometry'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export type TrackRow = Owned & {
  id: number;
  sidc: string;
  designation: string | null;
  status: string;
  lon: number;
  lat: number;
  observed_at: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};
export function readTrack(row: Row): TrackRow {
  return {
    ...owned(row),
    id: num(row, 'id'),
    sidc: text(row, 'sidc'),
    designation: textOrNull(row, 'designation'),
    status: text(row, 'status'),
    lon: num(row, 'lon'),
    lat: num(row, 'lat'),
    observed_at: text(row, 'observed_at'),
    notes: textOrNull(row, 'notes'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export type TrackPositionRow = {
  id: number;
  track_id: number;
  lon: number;
  lat: number;
  observed_at: string;
  report_id: number | null;
  created_at: string;
};
export function readTrackPosition(row: Row): TrackPositionRow {
  return {
    id: num(row, 'id'),
    track_id: num(row, 'track_id'),
    lon: num(row, 'lon'),
    lat: num(row, 'lat'),
    observed_at: text(row, 'observed_at'),
    report_id: numOrNull(row, 'report_id'),
    created_at: text(row, 'created_at'),
  };
}

export type CollectorRow = Owned & {
  id: number;
  name: string;
  discipline: string;
  unit: string | null;
  range_km: number | null;
  available_from: string | null;
  available_to: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};
export function readCollector(row: Row): CollectorRow {
  return {
    ...owned(row),
    id: num(row, 'id'),
    name: text(row, 'name'),
    discipline: text(row, 'discipline'),
    unit: textOrNull(row, 'unit'),
    range_km: numOrNull(row, 'range_km'),
    available_from: textOrNull(row, 'available_from'),
    available_to: textOrNull(row, 'available_to'),
    notes: textOrNull(row, 'notes'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export type TaskingRow = Owned & {
  id: number;
  collector_id: number;
  sir_id: number;
  nai_id: number | null;
  start_at: string;
  end_at: string;
  status: string;
  report_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};
export function readTasking(row: Row): TaskingRow {
  return {
    ...owned(row),
    id: num(row, 'id'),
    collector_id: num(row, 'collector_id'),
    sir_id: num(row, 'sir_id'),
    nai_id: numOrNull(row, 'nai_id'),
    start_at: text(row, 'start_at'),
    end_at: text(row, 'end_at'),
    status: text(row, 'status'),
    report_id: numOrNull(row, 'report_id'),
    notes: textOrNull(row, 'notes'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export type IntsumRow = Owned & {
  id: number;
  period_start: string;
  period_end: string;
  dtg: string;
  author: string | null;
  /** JSON text of the section bodies. */
  sections: string;
  created_at: string;
  updated_at: string;
};
export function readIntsum(row: Row): IntsumRow {
  return {
    ...owned(row),
    id: num(row, 'id'),
    period_start: text(row, 'period_start'),
    period_end: text(row, 'period_end'),
    dtg: text(row, 'dtg'),
    author: textOrNull(row, 'author'),
    sections: text(row, 'sections'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export type RfiRow = Owned & {
  id: number;
  requester: string | null;
  assignee: string | null;
  requirement_id: number | null;
  sir_id: number | null;
  question: string;
  priority: string;
  nlt: string | null;
  state: string;
  answer_report_id: number | null;
  created_at: string;
  updated_at: string;
};
export function readRfi(row: Row): RfiRow {
  return {
    ...owned(row),
    id: num(row, 'id'),
    requester: textOrNull(row, 'requester'),
    assignee: textOrNull(row, 'assignee'),
    requirement_id: numOrNull(row, 'requirement_id'),
    sir_id: numOrNull(row, 'sir_id'),
    question: text(row, 'question'),
    priority: text(row, 'priority'),
    nlt: textOrNull(row, 'nlt'),
    state: text(row, 'state'),
    answer_report_id: numOrNull(row, 'answer_report_id'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export type MessageRow = Owned & {
  id: number;
  text: string;
  fired_at: string;
  created_at: string;
};
export function readMessage(row: Row): MessageRow {
  return {
    ...owned(row),
    id: num(row, 'id'),
    text: text(row, 'text'),
    fired_at: text(row, 'fired_at'),
    created_at: text(row, 'created_at'),
  };
}

export type ScenarioEventRow = {
  id: number;
  trigger_at: string;
  kind: string;
  /** JSON text of the inject's payload. */
  payload: string;
  state: string;
  fired_at: string | null;
  situation_id: number | null;
  delivery_mode: string;
  created_at: string;
  updated_at: string;
};
export function readScenarioEvent(row: Row): ScenarioEventRow {
  return {
    id: num(row, 'id'),
    trigger_at: text(row, 'trigger_at'),
    kind: text(row, 'kind'),
    payload: text(row, 'payload'),
    state: text(row, 'state'),
    fired_at: textOrNull(row, 'fired_at'),
    situation_id: numOrNull(row, 'situation_id'),
    delivery_mode: text(row, 'delivery_mode'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export type ClockRow = {
  id: number;
  base_real_ts: string;
  base_scenario_ts: string;
  rate: number;
  paused: number;
};
export function readClock(row: Row): ClockRow {
  return {
    id: num(row, 'id'),
    base_real_ts: text(row, 'base_real_ts'),
    base_scenario_ts: text(row, 'base_scenario_ts'),
    rate: num(row, 'rate'),
    paused: num(row, 'paused'),
  };
}

export type StoryRow = {
  id: number;
  title: string;
  briefing: string;
  objectives: string;
  instructor_notes: string;
  updated_at: string;
};
export function readStory(row: Row): StoryRow {
  return {
    id: num(row, 'id'),
    title: text(row, 'title'),
    briefing: text(row, 'briefing'),
    objectives: text(row, 'objectives'),
    instructor_notes: text(row, 'instructor_notes'),
    updated_at: text(row, 'updated_at'),
  };
}

export type SituationRow = {
  id: number;
  title: string;
  ground_truth: string;
  expected_response: string;
  status: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};
export function readSituation(row: Row): SituationRow {
  return {
    id: num(row, 'id'),
    title: text(row, 'title'),
    ground_truth: text(row, 'ground_truth'),
    expected_response: text(row, 'expected_response'),
    status: text(row, 'status'),
    sort_order: num(row, 'sort_order'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export type ScenarioRow = {
  id: number;
  name: string;
  active: number;
  example: number;
  created_at: string;
  updated_at: string;
};
export function readScenario(row: Row): ScenarioRow {
  return {
    id: num(row, 'id'),
    name: text(row, 'name'),
    active: num(row, 'active'),
    example: num(row, 'example'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export type CountryRow = {
  id: number;
  scenario_id: number;
  name: string;
  affiliation: string;
  color: string;
  /** JSON text of the region ids. */
  regions: string;
  /** JSON text of a GeoJSON geometry. */
  geometry: string | null;
  position: number;
  created_at: string;
  updated_at: string;
};
export function readCountry(row: Row): CountryRow {
  return {
    id: num(row, 'id'),
    scenario_id: num(row, 'scenario_id'),
    name: text(row, 'name'),
    affiliation: text(row, 'affiliation'),
    color: text(row, 'color'),
    regions: text(row, 'regions'),
    geometry: textOrNull(row, 'geometry'),
    position: num(row, 'position'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export type PlaceRow = {
  id: number;
  scenario_id: number;
  real_name: string;
  kind: string;
  lon: number;
  lat: number;
  name: string;
  created_at: string;
  updated_at: string;
};
export function readPlace(row: Row): PlaceRow {
  return {
    id: num(row, 'id'),
    scenario_id: num(row, 'scenario_id'),
    real_name: text(row, 'real_name'),
    kind: text(row, 'kind'),
    lon: num(row, 'lon'),
    lat: num(row, 'lat'),
    name: text(row, 'name'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export type ActivityRow = {
  id: number;
  at: string;
  action: string;
  target: string;
  detail: string | null;
  owner_cell: string | null;
  releasable_to: string;
};
export function readActivity(row: Row): ActivityRow {
  return {
    id: num(row, 'id'),
    at: text(row, 'at'),
    action: text(row, 'action'),
    target: text(row, 'target'),
    detail: textOrNull(row, 'detail'),
    owner_cell: textOrNull(row, 'owner_cell'),
    releasable_to: text(row, 'releasable_to'),
  };
}
