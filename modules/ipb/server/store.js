/**
 * IPB state store. Item-scoped requests (docs/adr/0002-item-scoped-requests.md):
 * `server/dispatch.ts` resolves the study (and, for a part route, the part)
 * named in the URL, checks the member's role and cell access, and only then
 * calls in here with the resolved id(s) and the domain input. Nothing in
 * this file sees the requesting user, imports `server/policy.ts`, or
 * composes an ownership check: a study/child id that reaches a function
 * below is already known to exist for a route that needs no further access
 * decision (see/change), or the dispatcher wants a plain 404 for "unknown"
 * on a lookup a caller drives directly (`access.see`, list filters).
 *
 * `CHILDREN` is the whole point of the module: a new field or child
 * resource is a data change here, not a new handler. `routes.js` reads
 * `CHILDREN` to build the module's `parts` declaration and its per-kind
 * route set.
 */
import {
  DEFAULT_SIDC,
  defaultThreatSidc,
  formatSidc,
  parseSidc,
  withAffiliation,
} from '../../../src/symbols/sidc.js';
import { unitPropertiesProblem } from '../../../src/symbols/unitProperties.js';
import { areaPolygonProblem } from '../../../src/areaPolygon.js';
import { HttpError } from '../../../server/http.ts';
import { openState, transact } from '../../../server/state.ts';
import { sanitizeFilename, toGeoJson, toKml } from './export.js';
import { MIGRATIONS } from './schema.js';

// 'threat' is gone: the migration folds any existing rows into 'unit', and
// threats are no longer drawn from a feature layer at all.
const LAYERS = [
  'aoi',
  'mcoo',
  'key-terrain',
  'avenue',
  'obstacle',
  'nai',
  'tai',
  'coa',
  'note',
  'unit',
  'graphic',
  'range-ring',
];
const FEATURE_KINDS = ['point', 'line', 'polygon', 'symbol', 'graphic', 'range-ring'];
const COA_KINDS = ['most-likely', 'most-dangerous'];
const OBSERVED_STATUSES = ['expected', 'observed', 'not-observed'];
const ANALYSIS_KINDS = ['mobility', 'viewshed', 'line-of-sight'];
const NOTE_STEPS = new Set(['step1', 'step2', 'step3', 'step4']);
const STUDY_PATCH_FIELDS = new Set([
  'name',
  'bounds',
  'ao',
  'aoi',
  'notes',
  'weather_point',
  'h_hour',
  'classification',
  'weather_thresholds',
  'checked',
]);
/** A study create body may carry the ownership fields `server/dispatch.ts`
 * itself reads (`owner_cell`, `releasable_to`) — resolved into `owner`
 * before this module ever sees them, so they're recognized here but never
 * read off `body`. */
const STUDY_CREATE_FIELDS = new Set(['name', 'bounds', 'owner_cell', 'releasable_to']);

/** `properties.graphic` → the geometry GeoJSON must have (C5's TACTICAL_GRAPHICS,
 * duplicated here as a server-side constant so this module never imports
 * `src/tactical.js`, which pulls in OpenLayers). */
const GRAPHIC_GEOMETRY = {
  'phase-line': 'line',
  boundary: 'line',
  'axis-of-advance': 'line',
  'direction-of-attack': 'line',
  objective: 'polygon',
  'assembly-area': 'polygon',
  'battle-position': 'polygon',
  'engagement-area': 'polygon',
  minefield: 'polygon',
  'obstacle-line': 'line',
  block: 'line',
  fix: 'line',
  turn: 'line',
  disrupt: 'line',
};
const GRAPHIC_KEYS = Object.keys(GRAPHIC_GEOMETRY);

const ASCOPE_VALUES = ['areas', 'structures', 'capabilities', 'organizations', 'people', 'events'];
const PMESII_VALUES = [
  'political',
  'military',
  'economic',
  'social',
  'information',
  'infrastructure',
  'physical-environment',
  'time',
];
const CELLS = ['white', 'blue', 'red'];
const CELL_STUDY_NAMES = {
  white: 'White Cell IPB',
  blue: 'Blue Cell IPB',
  red: 'Red Cell IPB',
};

const MAX_BULK_FEATURES = 2000;
const MAX_RANGE_RING_RADII = 8;
const MAX_RANGE_RING_METRES = 100_000;

/**
 * One entry per study part. `routes.js` turns this straight into the
 * module's `parts` declaration (`table`/`label`, plus `item: 'study'` and
 * `column: 'study_id'`, the same for every one), its per-kind route set
 * (create, patch/delete by `:part`, reorder when `ordinal` is true), and
 * `analyses`' one exception (immutable: no PATCH route).
 */
export const CHILDREN = {
  features: {
    table: 'features',
    label: 'Feature',
    ordinal: false,
    columns: {
      layer: { type: 'enum', values: LAYERS, required: true },
      kind: { type: 'enum', values: FEATURE_KINDS, required: true },
      label: { type: 'string', required: false, default: '' },
      geometry: { type: 'geometry', required: true, storage: 'json' },
      properties: { type: 'json', required: false, default: {}, storage: 'json' },
    },
  },
  threats: {
    table: 'threats',
    label: 'Threat',
    ordinal: true,
    columns: {
      name: { type: 'string', required: true },
      echelon: { type: 'string', required: false, nullable: true },
      role: { type: 'string', required: false, nullable: true },
      equipment_identifier: { type: 'string', required: false, nullable: true },
      hvt: { type: 'boolean', required: false, default: false, storage: 'bool' },
      sidc: {
        type: 'sidc',
        required: false,
        nullable: true,
        computeDefault: (values) => defaultThreatSidcFor(values.echelon),
      },
      orbat_unit_id: { type: 'loose-ref', required: false, nullable: true },
      hpt: { type: 'boolean', required: false, default: false, storage: 'bool' },
      notes: { type: 'string', required: false, nullable: true },
    },
  },
  coas: {
    table: 'coas',
    label: 'COA',
    ordinal: true,
    columns: {
      name: { type: 'string', required: true },
      kind: { type: 'enum', values: COA_KINDS, required: true },
      narrative: { type: 'string', required: false, nullable: true },
    },
  },
  events: {
    table: 'events',
    label: 'Event',
    ordinal: true,
    columns: {
      coa_id: { type: 'reference', table: 'coas', required: true },
      nai_feature_id: { type: 'reference', table: 'features', required: false, nullable: true },
      tai_feature_id: { type: 'reference', table: 'features', required: false, nullable: true },
      decision_point_id: {
        type: 'reference',
        table: 'decision_points',
        required: false,
        nullable: true,
      },
      indicator: { type: 'string', required: true },
      // At most one of these is set; validated in `validateEventTimePair`.
      expected_at: { type: 'datetime', required: false, nullable: true },
      expected_offset: { type: 'integer', required: false, nullable: true },
      observed_status: {
        type: 'enum',
        values: OBSERVED_STATUSES,
        required: false,
        default: 'expected',
      },
      note: { type: 'string', required: false, nullable: true },
    },
  },
  analyses: {
    table: 'analyses',
    label: 'Analysis',
    ordinal: false,
    hasUpdatedAt: false,
    columns: {
      kind: { type: 'enum', values: ANALYSIS_KINDS, required: true },
      params: { type: 'json-value', required: true, storage: 'json' },
      summary: { type: 'json-value', required: true, storage: 'json' },
    },
  },
  /** The analyst's own layers; deleting one deletes its points (FK cascade). */
  layers: {
    table: 'layers',
    label: 'Layer',
    ordinal: true,
    columns: {
      name: { type: 'string', required: true, nonEmpty: true },
      color: { type: 'string', required: false, default: '#d35400', pattern: /^#[0-9a-f]{6}$/i },
      visible: { type: 'boolean', required: false, default: true, storage: 'bool' },
    },
  },
  points: {
    table: 'points',
    label: 'Point',
    ordinal: true,
    columns: {
      layer_id: { type: 'reference', table: 'layers', required: true },
      name: { type: 'string', required: true, nonEmpty: true },
      note: { type: 'string', required: false, nullable: true },
      lon: { type: 'number', required: true, min: -180, max: 180 },
      lat: { type: 'number', required: true, min: -90, max: 90 },
    },
  },
  phases: {
    table: 'phases',
    label: 'Phase',
    ordinal: true,
    columns: {
      name: { type: 'string', required: true, nonEmpty: true },
      start_offset: { type: 'integer', required: true },
      end_offset: { type: 'integer', required: false, nullable: true },
    },
  },
  /** kind key uses the endpoint's spelling; the table is `decision_points`. */
  'decision-points': {
    table: 'decision_points',
    label: 'Decision point',
    ordinal: true,
    columns: {
      name: { type: 'string', required: true, nonEmpty: true },
      description: { type: 'string', required: false, nullable: true },
      coa_id: { type: 'reference', table: 'coas', required: false, nullable: true },
      nai_feature_id: { type: 'reference', table: 'features', required: false, nullable: true },
      tai_feature_id: { type: 'reference', table: 'features', required: false, nullable: true },
      // At most one of each pair is set; validated in `validateDecisionPointTimes`.
      earliest_at: { type: 'datetime', required: false, nullable: true },
      earliest_offset: { type: 'integer', required: false, nullable: true },
      latest_at: { type: 'datetime', required: false, nullable: true },
      latest_offset: { type: 'integer', required: false, nullable: true },
      decision: { type: 'string', required: false, nullable: true },
    },
  },
  /** One upserted cell per (ascope, pmesii); see `createChild`'s special case. */
  'civil-considerations': {
    table: 'civil_considerations',
    label: 'Civil consideration',
    ordinal: false,
    columns: {
      ascope: { type: 'enum', values: ASCOPE_VALUES, required: true },
      pmesii: { type: 'enum', values: PMESII_VALUES, required: true },
      text: { type: 'string', required: false, default: '' },
    },
  },
};

let database;

// -- lifecycle --------------------------------------------------------------

export function openStore(file) {
  database = openState(file, MIGRATIONS);
  ensureCellStudies();
  return {
    database: () => database,
    listStudies,
    readCellStudy,
    createStudy,
    readStudy,
    updateStudy,
    deleteStudy,
    createChild,
    updateChild,
    deleteChild,
    reorderChild,
    bulkCreateFeatures,
    exportGeoJson,
    exportKml,
    recordOwnershipChange,
    close,
  };
}

function close() {
  database?.close();
  database = undefined;
}

// -- shared validation helpers ------------------------------------------------

function isGeometry(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.type === 'string' &&
    Array.isArray(value.coordinates)
  );
}

function validateBounds(value) {
  if (value === null || value === undefined) return null;
  const isNumberArray =
    Array.isArray(value) && value.length === 4 && value.every((n) => Number.isFinite(n));
  if (!isNumberArray) {
    throw new HttpError(400, 'bounds must be four finite numbers [west, south, east, north].');
  }
  const [west, south, east, north] = value;
  if (!(west < east) || !(south < north)) {
    throw new HttpError(400, 'bounds must satisfy west < east and south < north.');
  }
  return value;
}

const MAX_CHECKED_TASKS = 60;
const TASK_ID = /^[a-z0-9-]{1,40}$/;

/** The guide's hand-checked task ids: distinct short slugs, sorted. */
function validateChecked(value) {
  if (
    !Array.isArray(value) ||
    value.length > MAX_CHECKED_TASKS ||
    !value.every((id) => typeof id === 'string' && TASK_ID.test(id))
  ) {
    throw new HttpError(
      400,
      `checked must be an array of at most ${MAX_CHECKED_TASKS} task ids (a-z, 0-9, -).`,
    );
  }
  // Task ids are ASCII slugs: code-unit order, as plain sort() gave.
  return [...new Set(value)].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `{ lon, lat }` in range, or null for "derive from the AOI". */
function validateWeatherPoint(value) {
  if (value === null) return null;
  const valid =
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    Number.isFinite(value.lon) &&
    Number.isFinite(value.lat) &&
    Math.abs(value.lon) <= 180 &&
    Math.abs(value.lat) <= 90;
  if (!valid) {
    throw new HttpError(400, 'weather_point must be {lon, lat} in degrees, or null.');
  }
  return { lon: value.lon, lat: value.lat };
}

function validateNotes(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'notes must be a JSON object.');
  }
  for (const [key, text] of Object.entries(value)) {
    if (!NOTE_STEPS.has(key)) throw new HttpError(400, `Unknown notes field: ${key}.`);
    if (typeof text !== 'string') throw new HttpError(400, `notes.${key} must be a string.`);
  }
  return value;
}

function childConfig(kind) {
  const config = CHILDREN[kind];
  if (!config) throw new HttpError(400, `Unknown resource kind: ${kind}.`);
  return config;
}

function validateFieldValue(name, value, spec) {
  if (value === null) {
    if (spec.required && !spec.nullable) throw new HttpError(400, `${name} must not be null.`);
    return null;
  }
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string.`);
      if (spec.nonEmpty && !value.trim()) throw new HttpError(400, `${name} must not be empty.`);
      if (spec.pattern && !spec.pattern.test(value)) {
        throw new HttpError(400, `${name} is not in the expected format.`);
      }
      return value;
    case 'number':
      if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
        throw new HttpError(400, `${name} must be a number from ${spec.min} to ${spec.max}.`);
      }
      return value;
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        throw new HttpError(400, `${name} must be one of: ${spec.values.join(', ')}.`);
      }
      return value;
    case 'boolean':
      return Boolean(value);
    case 'json':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new HttpError(400, `${name} must be a JSON object.`);
      }
      return value;
    case 'json-value':
      // Analysis payloads are whatever the analysis returned: object or array.
      if (typeof value !== 'object' || value === null) {
        throw new HttpError(400, `${name} must be a JSON object or array.`);
      }
      return value;
    case 'geometry':
      if (!isGeometry(value)) {
        throw new HttpError(400, `${name} must be a GeoJSON geometry with type and coordinates.`);
      }
      return value;
    case 'reference':
      if (!Number.isInteger(value)) throw new HttpError(400, `${name} must be an integer id.`);
      return value;
    case 'sidc': {
      const normalized = normalizeSidc(value);
      if (!normalized) throw new HttpError(400, `${name} must be a 20-digit SIDC.`);
      return normalized;
    }
    case 'loose-ref':
      // An id from another module's own database: stored, never dereferenced.
      if (typeof value === 'number' && Number.isInteger(value)) return String(value);
      if (typeof value === 'string' && value.trim()) return value;
      throw new HttpError(400, `${name} must be a non-empty string or integer id.`);
    case 'datetime':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        throw new HttpError(400, `${name} must be an ISO 8601 date-time string.`);
      }
      return value;
    case 'integer':
      if (!Number.isInteger(value)) throw new HttpError(400, `${name} must be an integer.`);
      if (spec.min !== undefined && value < spec.min) {
        throw new HttpError(400, `${name} must be at least ${spec.min}.`);
      }
      if (spec.max !== undefined && value > spec.max) {
        throw new HttpError(400, `${name} must be at most ${spec.max}.`);
      }
      return value;
    default:
      return value;
  }
}

/** `text` (with optional space/dash separators) as a canonical 20-digit SIDC, or null. */
function normalizeSidc(value) {
  const parts = parseSidc(value);
  return parts ? formatSidc(parts) : null;
}

/** A threat's default SIDC: hostile, at `echelon` when that's a known IPB echelon name. */
function defaultThreatSidcFor(echelon) {
  if (typeof echelon === 'string' && echelon) {
    try {
      return defaultThreatSidc(echelon);
    } catch {
      // Not one of the amplifier-code echelon names: fall through.
    }
  }
  return withAffiliation(DEFAULT_SIDC, 'hostile');
}

/** Validate a child body against its kind's column table. `partial` skips required checks. */
function validateBody(kind, body, partial) {
  const config = childConfig(kind);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'A JSON object body is required.');
  }
  const values = {};
  for (const [name, value] of Object.entries(body)) {
    const spec = config.columns[name];
    if (!spec) throw new HttpError(400, `Unknown field: ${name}.`);
    values[name] = validateFieldValue(name, value, spec);
  }
  if (!partial) {
    for (const [name, spec] of Object.entries(config.columns)) {
      if (name in values) continue;
      if (spec.required) throw new HttpError(400, `${name} is required.`);
      if ('default' in spec) values[name] = spec.default;
      else if (spec.computeDefault) values[name] = spec.computeDefault(values);
    }
  }
  return values;
}

function storeValue(spec, value) {
  if (value === null || value === undefined) return null;
  if (spec.storage === 'json') return JSON.stringify(value);
  if (spec.storage === 'bool') return value ? 1 : 0;
  return value;
}

function readValue(spec, raw) {
  if (raw === null || raw === undefined) return spec.storage === 'bool' ? false : null;
  if (spec.storage === 'json') return JSON.parse(raw);
  if (spec.storage === 'bool') return Boolean(raw);
  return raw;
}

function assertReference(spec, value, studyId) {
  const row = database.prepare(`SELECT study_id FROM ${spec.table} WHERE id = ?`).get(value);
  if (!row) throw new HttpError(400, `Unknown ${spec.table} id ${value}.`);
  if (row.study_id !== studyId) {
    throw new HttpError(400, `Referenced ${spec.table} id ${value} belongs to a different study.`);
  }
}

function nextOrdinal(table, studyId) {
  return database
    .prepare(`SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM ${table} WHERE study_id = ?`)
    .get(studyId).next;
}

/** The study row, or a 404 — the dispatcher already resolved and access-checked
 * the study for any route that names one; this is the plain existence check a
 * direct (test, or cross-study-reference) lookup still needs. */
function getStudyRow(id) {
  const row = database.prepare('SELECT * FROM studies WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, `Study ${id} not found.`);
  return row;
}

/** A child row, or a 404 — see `getStudyRow`. */
function getChildRow(kind, id) {
  const config = childConfig(kind);
  const row = database.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, `Unknown ${kind} id ${id}.`);
  return row;
}

// -- kind-specific validation ------------------------------------------------
//
// The column table in `CHILDREN` covers uniform per-field checks; a few
// resources also need cross-field or nested-JSON rules. `runPostValidate`
// runs last, against the *effective* row (existing values merged with the
// patch, for updates) so a PATCH that only touches one side of an invariant
// is still checked against the whole row.
//
// The legacy free-text `expected_time` input (parsed into `expected_at`/
// `expected_offset` server-side) has been removed: wave 2 clients send
// `expected_at`/`expected_offset` directly, and `expected_time` is now an
// unknown field like any other (rejected by `validateBody`).

function matchesGeometryKind(geometry, expectedKind) {
  if (!geometry || typeof geometry.type !== 'string') return false;
  if (expectedKind === 'line')
    return geometry.type === 'LineString' || geometry.type === 'MultiLineString';
  return geometry.type === 'Polygon' || geometry.type === 'MultiPolygon';
}

function validateRadii(radii) {
  if (!Array.isArray(radii) || radii.length < 1 || radii.length > MAX_RANGE_RING_RADII) {
    throw new HttpError(
      400,
      `properties.radii must be an array of 1 to ${MAX_RANGE_RING_RADII} numbers.`,
    );
  }
  let previous = 0;
  for (const radius of radii) {
    if (!Number.isFinite(radius) || radius <= previous || radius > MAX_RANGE_RING_METRES) {
      throw new HttpError(
        400,
        `properties.radii must be ascending positive metres, each at most ${MAX_RANGE_RING_METRES}.`,
      );
    }
    previous = radius;
  }
}

/**
 * `unit`/`graphic`/`range-ring` layers each need their `properties` and
 * geometry to match their kind; any feature's `properties.coa_id` (the
 * SITEMP layering) must name a COA in the same study.
 */
function validateFeatureSemantics(studyId, effective) {
  const { layer, kind, geometry, properties } = effective;
  const props = properties && typeof properties === 'object' ? properties : {};
  if (layer === 'unit') {
    if (kind !== 'symbol') throw new HttpError(400, 'A unit feature must have kind "symbol".');
    const canonicalSidc = typeof props.sidc === 'string' ? normalizeSidc(props.sidc) : null;
    if (!canonicalSidc) {
      throw new HttpError(400, 'A unit feature requires a valid properties.sidc.');
    }
    // Canonicalize (e.g. a grouped/dashed SIDC copied from elsewhere) so
    // every reader — the map, exports, other clients — sees one dense
    // 20-digit form regardless of how it was typed.
    props.sidc = canonicalSidc;
    const problem = unitPropertiesProblem(props);
    if (problem) throw new HttpError(400, problem);
  } else if (layer === 'graphic') {
    if (kind !== 'graphic') {
      throw new HttpError(400, 'A graphic feature must have kind "graphic".');
    }
    const geometryKind = GRAPHIC_GEOMETRY[props.graphic];
    if (!geometryKind) {
      throw new HttpError(400, `properties.graphic must be one of: ${GRAPHIC_KEYS.join(', ')}.`);
    }
    if (!matchesGeometryKind(geometry, geometryKind)) {
      throw new HttpError(400, `A "${props.graphic}" graphic must be a ${geometryKind}.`);
    }
  } else if (layer === 'range-ring') {
    if (kind !== 'range-ring') {
      throw new HttpError(400, 'A range-ring feature must have kind "range-ring".');
    }
    if (!geometry || geometry.type !== 'Point') {
      throw new HttpError(400, 'A range-ring feature must be a Point.');
    }
    validateRadii(props.radii);
  }
  if (props.coa_id !== undefined && props.coa_id !== null) {
    if (!Number.isInteger(props.coa_id)) {
      throw new HttpError(400, 'properties.coa_id must be an integer id.');
    }
    assertReference({ table: 'coas' }, props.coa_id, studyId);
  }
}

// A field absent from a create body (no default, unset) and one explicitly
// patched to null both mean "unset": loose equality treats undefined the same.
function validateEventTimePair(effective) {
  if (effective.expected_at != null && effective.expected_offset != null) {
    throw new HttpError(400, 'An event may have expected_at or expected_offset, not both.');
  }
}

function validateDecisionPointTimes(effective) {
  if (effective.earliest_at != null && effective.earliest_offset != null) {
    throw new HttpError(400, 'A decision point may have earliest_at or earliest_offset, not both.');
  }
  if (effective.latest_at != null && effective.latest_offset != null) {
    throw new HttpError(400, 'A decision point may have latest_at or latest_offset, not both.');
  }
}

function runPostValidate(kind, effective, studyId) {
  if (kind === 'features') validateFeatureSemantics(studyId, effective);
  else if (kind === 'events') validateEventTimePair(effective);
  else if (kind === 'decision-points') validateDecisionPointTimes(effective);
}

/** The full row a PATCH would produce: `row`'s decoded columns, overwritten by `values`. */
function mergeEffective(kind, row, values) {
  const config = CHILDREN[kind];
  const effective = {};
  for (const [name, spec] of Object.entries(config.columns)) {
    effective[name] = name in values ? values[name] : readValue(spec, row[name]);
  }
  return effective;
}

// -- the single write path ---------------------------------------------------

/**
 * Every mutation goes through here: it bumps the parent study's revision and
 * `updated_at`, appends one activity row, and commits atomically. No exported
 * function touches the database outside this helper (or `createStudy`, which
 * has no parent study to bump yet, or `recordOwnershipChange`, which runs
 * inside the dispatcher's own release/reassign transaction).
 */
function mutate(studyId, action, target, work, finalize) {
  return transact(database, () => {
    work();
    const timestamp = new Date().toISOString();
    database
      .prepare('UPDATE studies SET revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(timestamp, studyId);
    const targetLabel = typeof target === 'function' ? target() : target;
    database
      .prepare('INSERT INTO activity (study_id, at, action, target, detail) VALUES (?, ?, ?, ?, ?)')
      .run(studyId, timestamp, action, targetLabel, null);
    return finalize();
  });
}

// -- studies ------------------------------------------------------------------

function requireCell(cell) {
  if (!CELLS.includes(cell)) throw new HttpError(400, `Unknown cell: ${cell}`);
  return cell;
}

function insertCellStudy(cell) {
  const timestamp = new Date().toISOString();
  const info = database
    .prepare(
      `INSERT INTO studies
         (name, bounds, aoi, notes, revision, created_at, updated_at, owner_cell, releasable_to,
          cell_study_cell)
       VALUES (?, NULL, NULL, '{}', 1, ?, ?, ?, '[]', ?)`,
    )
    .run(CELL_STUDY_NAMES[cell], timestamp, timestamp, cell, cell);
  const id = info.lastInsertRowid;
  database
    .prepare('INSERT INTO activity (study_id, at, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .run(id, timestamp, 'create', `study:${id}`, JSON.stringify({ automatic: true, cell }));
  return id;
}

function ensureCellStudyInside(cell) {
  requireCell(cell);
  const current = database.prepare('SELECT * FROM studies WHERE cell_study_cell = ?').get(cell);
  if (current?.owner_cell === cell) return current.id;
  if (current) {
    database.prepare('UPDATE studies SET cell_study_cell = NULL WHERE id = ?').run(current.id);
  }

  const candidate = database
    .prepare(
      `SELECT id FROM studies
       WHERE owner_cell = ? AND cell_study_cell IS NULL
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
    )
    .get(cell);
  if (candidate) {
    database.prepare('UPDATE studies SET cell_study_cell = ? WHERE id = ?').run(cell, candidate.id);
    return candidate.id;
  }
  return insertCellStudy(cell);
}

function ensureCellStudies() {
  transact(database, () => {
    for (const cell of CELLS) ensureCellStudyInside(cell);
  });
}

/** A raw studies row, decoded — the study half of `readStudy`'s aggregate,
 * and the shape `routes.js` hands the dispatcher as `items.study.shape` for
 * its generated release/reassign responses. */
export function shapeStudy(row) {
  return {
    id: row.id,
    name: row.name,
    bounds: row.bounds ? JSON.parse(row.bounds) : null,
    ao: row.ao ? JSON.parse(row.ao) : null,
    checked: JSON.parse(row.checked ?? '[]'),
    aoi: row.aoi ? JSON.parse(row.aoi) : null,
    notes: JSON.parse(row.notes),
    weather_point: row.weather_point ? JSON.parse(row.weather_point) : null,
    h_hour: row.h_hour ?? null,
    classification: row.classification,
    weather_thresholds: row.weather_thresholds ? JSON.parse(row.weather_thresholds) : null,
    owner_cell: row.owner_cell,
    releasable_to: JSON.parse(row.releasable_to),
    cell_study_cell: row.cell_study_cell ?? null,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function readStudyRow(id) {
  return shapeStudy(getStudyRow(id));
}

function readCellStudy(cell) {
  const id = transact(database, () => ensureCellStudyInside(cell));
  return readStudy(id);
}

/** `access` is the dispatcher's per-request capability; direct callers (tests)
 * that don't care about visibility get the "see everything" default — this
 * is a data default, not a policy one: it composes no cell/role decision. */
function listStudies(
  access = { white: true, cell: 'white', visible: () => ({ sql: '1=1', params: [] }) },
) {
  const { sql, params } = access.visible('study', { alias: 's' });
  const ordinaryCellOnly = !access.white;
  const cellStudySql = ordinaryCellOnly ? ' AND s.cell_study_cell = ?' : '';
  const rows = database
    .prepare(
      `SELECT s.id, s.name, s.bounds, s.updated_at, s.owner_cell, s.releasable_to,
              s.cell_study_cell,
              (SELECT count(*) FROM features WHERE study_id = s.id) AS feature_count,
              (SELECT count(*) FROM coas WHERE study_id = s.id) AS coa_count
       FROM studies AS s
       WHERE ${sql}${cellStudySql}
       ORDER BY s.updated_at DESC, s.id DESC`,
    )
    .all(...params, ...(ordinaryCellOnly ? [access.cell] : []));
  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      bounds: row.bounds ? JSON.parse(row.bounds) : null,
      updated_at: row.updated_at,
      owner_cell: row.owner_cell,
      releasable_to: JSON.parse(row.releasable_to),
      cell_study_cell: row.cell_study_cell ?? null,
      feature_count: row.feature_count,
      coa_count: row.coa_count,
    })),
  };
}

/** `owner` is `{ owner_cell, releasable_to }`, already resolved and validated
 * by the dispatcher (verb `create`): stored exactly as given. Direct callers
 * (tests) that don't care about ownership get White/unreleased — a data
 * default, not a policy one: it composes no cell/role decision. */
function createStudy(body, owner = { owner_cell: 'white', releasable_to: [] }) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'A JSON object body is required.');
  }
  for (const key of Object.keys(body)) {
    if (!STUDY_CREATE_FIELDS.has(key)) throw new HttpError(400, `Unknown field: ${key}.`);
  }
  if (typeof body.name !== 'string' || !body.name.trim()) {
    throw new HttpError(400, 'name is required.');
  }
  const bounds = validateBounds(body.bounds ?? null);
  return transact(database, () => {
    const timestamp = new Date().toISOString();
    const info = database
      .prepare(
        `INSERT INTO studies
           (name, bounds, aoi, notes, revision, created_at, updated_at, owner_cell, releasable_to)
         VALUES (?, ?, NULL, '{}', 1, ?, ?, ?, ?)`,
      )
      .run(
        body.name,
        bounds ? JSON.stringify(bounds) : null,
        timestamp,
        timestamp,
        owner.owner_cell,
        JSON.stringify(owner.releasable_to),
      );
    const id = info.lastInsertRowid;
    database
      .prepare('INSERT INTO activity (study_id, at, action, target, detail) VALUES (?, ?, ?, ?, ?)')
      .run(id, timestamp, 'create', `study:${id}`, null);
    return readStudyRow(id);
  });
}

function validateStudyPatch(patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new HttpError(400, 'A JSON object body is required.');
  }
  const fields = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!STUDY_PATCH_FIELDS.has(key)) throw new HttpError(400, `Unknown field: ${key}.`);
    if (key === 'name') {
      if (typeof value !== 'string' || !value.trim()) {
        throw new HttpError(400, 'name must be a non-empty string.');
      }
      fields.name = value;
    } else if (key === 'bounds') {
      fields.bounds = validateBounds(value);
    } else if (key === 'ao' || key === 'aoi') {
      const problem = value === null ? null : areaPolygonProblem(value);
      if (problem) throw new HttpError(400, `${key} ${problem}.`);
      fields[key] = value === null ? null : { type: 'Polygon', coordinates: value.coordinates };
    } else if (key === 'notes') {
      fields.notes = validateNotes(value);
    } else if (key === 'weather_point') {
      fields.weather_point = validateWeatherPoint(value);
    } else if (key === 'h_hour') {
      if (value !== null && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
        throw new HttpError(400, 'h_hour must be an ISO 8601 date-time string, or null.');
      }
      fields.h_hour = value;
    } else if (key === 'classification') {
      if (typeof value !== 'string') throw new HttpError(400, 'classification must be a string.');
      fields.classification = value;
    } else if (key === 'checked') {
      fields.checked = validateChecked(value);
    } else if (key === 'weather_thresholds') {
      if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
        throw new HttpError(400, 'weather_thresholds must be a JSON object, or null.');
      }
      fields.weather_thresholds = value;
    }
  }
  return fields;
}

function applyStudyPatch(id, fields) {
  const assignments = [];
  const params = [];
  if ('name' in fields) {
    assignments.push('name = ?');
    params.push(fields.name);
  }
  if ('bounds' in fields) {
    assignments.push('bounds = ?');
    params.push(fields.bounds ? JSON.stringify(fields.bounds) : null);
  }
  for (const key of ['ao', 'aoi']) {
    if (!(key in fields)) continue;
    assignments.push(`${key} = ?`);
    params.push(fields[key] ? JSON.stringify(fields[key]) : null);
  }
  if ('notes' in fields) {
    assignments.push('notes = ?');
    params.push(JSON.stringify(fields.notes));
  }
  if ('weather_point' in fields) {
    assignments.push('weather_point = ?');
    params.push(fields.weather_point ? JSON.stringify(fields.weather_point) : null);
  }
  if ('h_hour' in fields) {
    assignments.push('h_hour = ?');
    params.push(fields.h_hour);
  }
  if ('classification' in fields) {
    assignments.push('classification = ?');
    params.push(fields.classification);
  }
  if ('checked' in fields) {
    assignments.push('checked = ?');
    params.push(JSON.stringify(fields.checked));
  }
  if ('weather_thresholds' in fields) {
    assignments.push('weather_thresholds = ?');
    params.push(fields.weather_thresholds ? JSON.stringify(fields.weather_thresholds) : null);
  }
  if (!assignments.length) return;
  database.prepare(`UPDATE studies SET ${assignments.join(', ')} WHERE id = ?`).run(...params, id);
}

function updateStudy(id, patch) {
  const fields = validateStudyPatch(patch);
  return mutate(
    id,
    'update',
    `study:${id}`,
    () => {
      getStudyRow(id);
      applyStudyPatch(id, fields);
    },
    () => readStudyRow(id),
  );
}

function deleteStudy(id) {
  let deleted;
  return mutate(
    id,
    'delete',
    `study:${id}`,
    () => {
      deleted = getStudyRow(id);
      database.prepare('DELETE FROM studies WHERE id = ?').run(id);
      if (deleted.cell_study_cell) ensureCellStudyInside(deleted.cell_study_cell);
    },
    () => ({ deleted: true }),
  );
}

/**
 * Runs inside `server/dispatch.ts`'s own release/reassign transaction (it
 * has already written `owner_cell`/`releasable_to`): bumps the study's
 * revision/`updated_at` — mutating `after` in place, since that's the exact
 * object the dispatcher shapes into its response — and appends one activity
 * row, the same bookkeeping every other mutation gets via `mutate()`.
 */
function recordOwnershipChange({ action, before, after }) {
  const timestamp = new Date().toISOString();
  if (action === 'reassign' && before.cell_study_cell) {
    database.prepare('UPDATE studies SET cell_study_cell = NULL WHERE id = ?').run(after.id);
    after.cell_study_cell = null;
    ensureCellStudyInside(before.cell_study_cell);
  }
  database
    .prepare('UPDATE studies SET revision = revision + 1, updated_at = ? WHERE id = ?')
    .run(timestamp, after.id);
  after.revision += 1;
  after.updated_at = timestamp;
  database
    .prepare('INSERT INTO activity (study_id, at, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .run(after.id, timestamp, action, `study:${after.id}`, null);
}

// -- study aggregate ------------------------------------------------------------

function shapeChildRow(kind, row) {
  const config = CHILDREN[kind];
  const result = { id: row.id, study_id: row.study_id };
  for (const [name, spec] of Object.entries(config.columns)) {
    result[name] = readValue(spec, row[name]);
  }
  if (config.ordinal) result.ordinal = row.ordinal;
  result.created_at = row.created_at;
  if (config.hasUpdatedAt !== false) result.updated_at = row.updated_at;
  return result;
}

function listChildren(kind, studyId) {
  const config = CHILDREN[kind];
  const order = config.ordinal ? 'ordinal, id' : 'id';
  const rows = database
    .prepare(`SELECT * FROM ${config.table} WHERE study_id = ? ORDER BY ${order}`)
    .all(studyId);
  return rows.map((row) => shapeChildRow(kind, row));
}

function readStudy(id) {
  const study = readStudyRow(id);
  return {
    study,
    features: listChildren('features', id),
    threats: listChildren('threats', id),
    coas: listChildren('coas', id),
    events: listChildren('events', id),
    analyses: listChildren('analyses', id),
    layers: listChildren('layers', id),
    points: listChildren('points', id),
    phases: listChildren('phases', id),
    decision_points: listChildren('decision-points', id),
    civil_considerations: listChildren('civil-considerations', id),
  };
}

function readChildRow(kind, id) {
  const config = CHILDREN[kind];
  const row = database.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(id);
  return row ? shapeChildRow(kind, row) : null;
}

// -- children -------------------------------------------------------------------

/**
 * Insert one already-validated row: reference and kind-specific semantic
 * checks, then the INSERT. Shared by `createChild` and the bulk feature
 * import, so a bulk request validates and inserts each feature exactly the
 * way a single `POST` would.
 */
function insertChildRow(kind, studyId, values) {
  const config = CHILDREN[kind];
  for (const [name, spec] of Object.entries(config.columns)) {
    if (spec.type === 'reference' && values[name] !== null && values[name] !== undefined) {
      assertReference(spec, values[name], studyId);
    }
  }
  runPostValidate(kind, values, studyId);
  const columnNames = Object.keys(config.columns);
  const timestamp = new Date().toISOString();
  const insertColumns = [
    'study_id',
    ...columnNames,
    ...(config.ordinal ? ['ordinal'] : []),
    'created_at',
    ...(config.hasUpdatedAt !== false ? ['updated_at'] : []),
  ];
  const params = [
    studyId,
    ...columnNames.map((name) => storeValue(config.columns[name], values[name])),
    ...(config.ordinal ? [nextOrdinal(config.table, studyId)] : []),
    timestamp,
    ...(config.hasUpdatedAt !== false ? [timestamp] : []),
  ];
  const info = database
    .prepare(
      `INSERT INTO ${config.table} (${insertColumns.join(', ')})
       VALUES (${insertColumns.map(() => '?').join(', ')})`,
    )
    .run(...params);
  return info.lastInsertRowid;
}

/** civil-considerations has no independent id namespace worth exposing: `POST` upserts the cell. */
function upsertCivilConsiderationRow(studyId, values) {
  const config = CHILDREN['civil-considerations'];
  const existing = database
    .prepare(`SELECT id FROM ${config.table} WHERE study_id = ? AND ascope = ? AND pmesii = ?`)
    .get(studyId, values.ascope, values.pmesii);
  const timestamp = new Date().toISOString();
  if (existing) {
    database
      .prepare(`UPDATE ${config.table} SET text = ?, updated_at = ? WHERE id = ?`)
      .run(values.text, timestamp, existing.id);
    return existing.id;
  }
  const info = database
    .prepare(
      `INSERT INTO ${config.table} (study_id, ascope, pmesii, text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(studyId, values.ascope, values.pmesii, values.text, timestamp, timestamp);
  return info.lastInsertRowid;
}

function createChild(kind, studyId, body) {
  childConfig(kind);
  getStudyRow(studyId);
  const values = validateBody(kind, body, false);
  let resultId;
  return mutate(
    studyId,
    'create',
    () => `${kind}:${resultId}`,
    () => {
      resultId =
        kind === 'civil-considerations'
          ? upsertCivilConsiderationRow(studyId, values)
          : insertChildRow(kind, studyId, values);
    },
    () => readChildRow(kind, resultId),
  );
}

function updateChild(kind, id, patch) {
  const config = childConfig(kind);
  const row = getChildRow(kind, id);
  const values = validateBody(kind, patch, true);
  for (const [name, spec] of Object.entries(config.columns)) {
    if (spec.type === 'reference' && name in values && values[name] !== null) {
      assertReference(spec, values[name], row.study_id);
    }
  }
  runPostValidate(kind, mergeEffective(kind, row, values), row.study_id);
  return mutate(
    row.study_id,
    'update',
    `${kind}:${id}`,
    () => {
      const names = Object.keys(values);
      if (!names.length) return;
      const assignments = names.map((name) => `${name} = ?`);
      const params = names.map((name) => storeValue(config.columns[name], values[name]));
      if (config.hasUpdatedAt !== false) {
        assignments.push('updated_at = ?');
        params.push(new Date().toISOString());
      }
      database
        .prepare(`UPDATE ${config.table} SET ${assignments.join(', ')} WHERE id = ?`)
        .run(...params, id);
    },
    () => readChildRow(kind, id),
  );
}

/** `POST studies/:id/features/bulk`: validated like single creates, all or nothing. */
function bulkCreateFeatures(studyId, items) {
  getStudyRow(studyId);
  if (!Array.isArray(items)) throw new HttpError(400, 'features must be an array.');
  if (!items.length) throw new HttpError(400, 'features must not be empty.');
  if (items.length > MAX_BULK_FEATURES) {
    throw new HttpError(400, `features must not exceed ${MAX_BULK_FEATURES} items.`);
  }
  const prepared = items.map((body) => validateBody('features', body, false));
  const insertedIds = [];
  return mutate(
    studyId,
    'create',
    () => `features:bulk:${insertedIds.length}`,
    () => {
      for (const values of prepared) {
        insertedIds.push(insertChildRow('features', studyId, values));
      }
    },
    () => ({ items: insertedIds.map((id) => readChildRow('features', id)) }),
  );
}

function exportGeoJson(studyId) {
  const study = readStudyRow(studyId);
  const features = listChildren('features', studyId);
  return {
    body: JSON.stringify(toGeoJson(study, features), null, 2),
    filename: `${sanitizeFilename(study.name)}.geojson`,
  };
}

function exportKml(studyId) {
  const study = readStudyRow(studyId);
  const features = listChildren('features', studyId);
  return { body: toKml(study, features), filename: `${sanitizeFilename(study.name)}.kml` };
}

/**
 * Swap an ordinal-kind row with its immediate sibling. There is no unique
 * constraint on `ordinal`, so a plain two-row swap is safe: nothing else
 * reads ordinals except `ORDER BY ordinal, id`.
 */
function reorderChild(kind, id, direction) {
  const config = childConfig(kind);
  if (!config.ordinal) throw new HttpError(400, `${kind} does not support reordering.`);
  if (direction !== 'up' && direction !== 'down') {
    throw new HttpError(400, 'direction must be "up" or "down".');
  }
  const row = getChildRow(kind, id);

  const comparator = direction === 'up' ? '<' : '>';
  const order = direction === 'up' ? 'DESC' : 'ASC';
  const neighbor = database
    .prepare(
      `SELECT id, ordinal FROM ${config.table}
       WHERE study_id = ? AND ordinal ${comparator} ?
       ORDER BY ordinal ${order} LIMIT 1`,
    )
    .get(row.study_id, row.ordinal);
  // Already first or last: a no-op, not an error.
  if (!neighbor) return { items: listChildren(kind, row.study_id) };

  return mutate(
    row.study_id,
    'reorder',
    `${kind}:${id}`,
    () => {
      database
        .prepare(`UPDATE ${config.table} SET ordinal = ? WHERE id = ?`)
        .run(neighbor.ordinal, row.id);
      database
        .prepare(`UPDATE ${config.table} SET ordinal = ? WHERE id = ?`)
        .run(row.ordinal, neighbor.id);
    },
    () => ({ items: listChildren(kind, row.study_id) }),
  );
}

function deleteChild(kind, id) {
  const config = childConfig(kind);
  const row = getChildRow(kind, id);
  return mutate(
    row.study_id,
    'delete',
    `${kind}:${id}`,
    () => {
      database.prepare(`DELETE FROM ${config.table} WHERE id = ?`).run(id);
    },
    () => ({ deleted: true }),
  );
}
