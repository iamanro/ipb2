import { HttpError } from '../../../server/http.js';
import { openState, transact } from '../../../server/state.js';
import { MIGRATIONS } from './schema.js';

const LAYERS = [
  'aoi',
  'mcoo',
  'key-terrain',
  'avenue',
  'obstacle',
  'nai',
  'tai',
  'coa',
  'threat',
  'note',
];
const FEATURE_KINDS = ['point', 'line', 'polygon', 'symbol'];
const COA_KINDS = ['most-likely', 'most-dangerous'];
const OBSERVED_STATUSES = ['expected', 'observed', 'not-observed'];
const ANALYSIS_KINDS = ['mobility', 'viewshed', 'line-of-sight'];
const NOTE_STEPS = ['step1', 'step2', 'step3', 'step4'];
const STUDY_PATCH_FIELDS = ['name', 'bounds', 'aoi', 'notes'];

/**
 * One entry per child resource. This table is the whole point of the module:
 * a new field or resource is a data change here, not a new handler.
 */
const CHILDREN = {
  features: {
    table: 'features',
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
    ordinal: true,
    columns: {
      name: { type: 'string', required: true },
      echelon: { type: 'string', required: false, nullable: true },
      role: { type: 'string', required: false, nullable: true },
      equipment_identifier: { type: 'string', required: false, nullable: true },
      hvt: { type: 'boolean', required: false, default: false, storage: 'bool' },
      notes: { type: 'string', required: false, nullable: true },
    },
  },
  coas: {
    table: 'coas',
    ordinal: true,
    columns: {
      name: { type: 'string', required: true },
      kind: { type: 'enum', values: COA_KINDS, required: true },
      narrative: { type: 'string', required: false, nullable: true },
    },
  },
  events: {
    table: 'events',
    ordinal: true,
    columns: {
      coa_id: { type: 'reference', table: 'coas', required: true },
      nai_feature_id: { type: 'reference', table: 'features', required: false, nullable: true },
      indicator: { type: 'string', required: true },
      expected_time: { type: 'string', required: false, nullable: true },
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
    ordinal: false,
    hasUpdatedAt: false,
    columns: {
      kind: { type: 'enum', values: ANALYSIS_KINDS, required: true },
      params: { type: 'json-value', required: true, storage: 'json' },
      summary: { type: 'json-value', required: true, storage: 'json' },
    },
  },
};

let database;

// -- lifecycle --------------------------------------------------------------

export function openStore(file) {
  database = openState(file, MIGRATIONS);
  return {
    listStudies,
    createStudy,
    readStudy,
    updateStudy,
    deleteStudy,
    createChild,
    updateChild,
    deleteChild,
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

function validateNotes(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'notes must be a JSON object.');
  }
  for (const [key, text] of Object.entries(value)) {
    if (!NOTE_STEPS.includes(key)) throw new HttpError(400, `Unknown notes field: ${key}.`);
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
    default:
      return value;
  }
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

function assertStudyExists(id) {
  if (!database.prepare('SELECT 1 FROM studies WHERE id = ?').get(id)) {
    throw new HttpError(404, `Study ${id} not found.`);
  }
}

// -- the single write path ---------------------------------------------------

/**
 * Every mutation goes through here: it bumps the parent study's revision and
 * `updated_at`, appends one activity row, and commits atomically. No exported
 * function touches the database outside this helper (or `createStudy`, which
 * has no parent study to bump yet).
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

function readStudyRow(id) {
  const row = database.prepare('SELECT * FROM studies WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    bounds: row.bounds ? JSON.parse(row.bounds) : null,
    aoi: row.aoi ? JSON.parse(row.aoi) : null,
    notes: JSON.parse(row.notes),
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listStudies() {
  const rows = database
    .prepare(
      `SELECT s.id, s.name, s.bounds, s.updated_at,
              (SELECT count(*) FROM features WHERE study_id = s.id) AS feature_count,
              (SELECT count(*) FROM coas WHERE study_id = s.id) AS coa_count
       FROM studies AS s
       ORDER BY s.updated_at DESC, s.id DESC`,
    )
    .all();
  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      bounds: row.bounds ? JSON.parse(row.bounds) : null,
      updated_at: row.updated_at,
      feature_count: row.feature_count,
      coa_count: row.coa_count,
    })),
  };
}

function createStudy(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'A JSON object body is required.');
  }
  for (const key of Object.keys(body)) {
    if (!['name', 'bounds'].includes(key)) throw new HttpError(400, `Unknown field: ${key}.`);
  }
  if (typeof body.name !== 'string' || !body.name.trim()) {
    throw new HttpError(400, 'name is required.');
  }
  const bounds = validateBounds(body.bounds ?? null);
  return transact(database, () => {
    const timestamp = new Date().toISOString();
    const info = database
      .prepare(
        `INSERT INTO studies (name, bounds, aoi, notes, revision, created_at, updated_at)
         VALUES (?, ?, NULL, '{}', 1, ?, ?)`,
      )
      .run(body.name, bounds ? JSON.stringify(bounds) : null, timestamp, timestamp);
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
    if (!STUDY_PATCH_FIELDS.includes(key)) throw new HttpError(400, `Unknown field: ${key}.`);
    if (key === 'name') {
      if (typeof value !== 'string' || !value.trim()) {
        throw new HttpError(400, 'name must be a non-empty string.');
      }
      fields.name = value;
    } else if (key === 'bounds') {
      fields.bounds = validateBounds(value);
    } else if (key === 'aoi') {
      if (value !== null && !isGeometry(value)) {
        throw new HttpError(400, 'aoi must be a GeoJSON geometry with type and coordinates.');
      }
      fields.aoi = value;
    } else if (key === 'notes') {
      fields.notes = validateNotes(value);
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
  if ('aoi' in fields) {
    assignments.push('aoi = ?');
    params.push(fields.aoi ? JSON.stringify(fields.aoi) : null);
  }
  if ('notes' in fields) {
    assignments.push('notes = ?');
    params.push(JSON.stringify(fields.notes));
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
      assertStudyExists(id);
      applyStudyPatch(id, fields);
    },
    () => readStudyRow(id),
  );
}

function deleteStudy(id) {
  return mutate(
    id,
    'delete',
    `study:${id}`,
    () => {
      assertStudyExists(id);
      database.prepare('DELETE FROM studies WHERE id = ?').run(id);
    },
    () => ({ deleted: true }),
  );
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
  if (!study) throw new HttpError(404, `Study ${id} not found.`);
  return {
    study,
    features: listChildren('features', id),
    threats: listChildren('threats', id),
    coas: listChildren('coas', id),
    events: listChildren('events', id),
    analyses: listChildren('analyses', id),
  };
}

function readChildRow(kind, id) {
  const config = CHILDREN[kind];
  const row = database.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(id);
  return row ? shapeChildRow(kind, row) : null;
}

// -- children -------------------------------------------------------------------

function createChild(kind, studyId, body) {
  const config = childConfig(kind);
  const values = validateBody(kind, body, false);
  let insertedId;
  return mutate(
    studyId,
    'create',
    () => `${kind}:${insertedId}`,
    () => {
      assertStudyExists(studyId);
      for (const [name, spec] of Object.entries(config.columns)) {
        if (spec.type === 'reference' && values[name] !== null && values[name] !== undefined) {
          assertReference(spec, values[name], studyId);
        }
      }
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
      insertedId = info.lastInsertRowid;
    },
    () => readChildRow(kind, insertedId),
  );
}

function updateChild(kind, id, patch) {
  const config = childConfig(kind);
  const row = database.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, `Unknown ${kind} id ${id}.`);
  const values = validateBody(kind, patch, true);
  for (const [name, spec] of Object.entries(config.columns)) {
    if (spec.type === 'reference' && name in values && values[name] !== null) {
      assertReference(spec, values[name], row.study_id);
    }
  }
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

function deleteChild(kind, id) {
  const config = childConfig(kind);
  const row = database.prepare(`SELECT study_id FROM ${config.table} WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, `Unknown ${kind} id ${id}.`);
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
