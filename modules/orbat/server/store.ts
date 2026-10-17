import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import type { Access, Owner } from '../../../server/dispatch.ts';
import { fieldsOf, HttpError, isJsonObject, type Json } from '../../../server/http.ts';
import { releasableArray } from '../../../server/policy.ts';
import {
  countRows,
  num,
  numOrNull,
  openState,
  text,
  textOrNull,
  transact,
  type Row,
} from '../../../server/state.ts';
import { MIGRATIONS } from './schema.ts';

type OrbatRow = {
  id: number;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  owner_cell: string;
  releasable_to: string | null;
};
type UnitRow = {
  id: number;
  orbat_id: number;
  parent_id: number | null;
  position: number;
  sidc: string;
  name: string;
  designation: string;
  higher_formation: string;
  reinforced: string;
  additional: string;
  notes: string;
};
/** A unit's editable fields, as the API names them. */
type UnitFields = {
  sidc: string;
  name: string;
  designation: string;
  higherFormation: string;
  reinforced: string;
  additional: string;
  notes: string;
};
/** Each API field of a unit and its column. */
const UNIT_COLUMNS: [keyof UnitFields, string][] = [
  ['sidc', 'sidc'],
  ['name', 'name'],
  ['designation', 'designation'],
  ['higherFormation', 'higher_formation'],
  ['reinforced', 'reinforced'],
  ['additional', 'additional'],
  ['notes', 'notes'],
];
/** One node of an ORBAT export/import document. */
type UnitNode = UnitFields & { children: UnitNode[] };

function readOrbat(row: Row): OrbatRow {
  return {
    id: num(row, 'id'),
    name: text(row, 'name'),
    description: text(row, 'description'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
    owner_cell: text(row, 'owner_cell'),
    releasable_to: textOrNull(row, 'releasable_to'),
  };
}

function readUnit(row: Row): UnitRow {
  return {
    id: num(row, 'id'),
    orbat_id: num(row, 'orbat_id'),
    parent_id: numOrNull(row, 'parent_id'),
    position: num(row, 'position'),
    sidc: text(row, 'sidc'),
    name: text(row, 'name'),
    designation: text(row, 'designation'),
    higher_formation: text(row, 'higher_formation'),
    reinforced: text(row, 'reinforced'),
    additional: text(row, 'additional'),
    notes: text(row, 'notes'),
  };
}

/** Mirrors `client/sidc.js`'s DEFAULT_SIDC: a friendly land infantry unit, no echelon. */
const DEFAULT_SIDC = '10031000001211000000';
const SIDC_PATTERN = /^\d{20}$/;
const REINFORCED_VALUES = new Set(['', '(+)', '(-)', '(±)']);
const MAX_UNITS_PER_IMPORT = 2000;
const MAX_DEPTH = 24;

let database: DatabaseSync;

/**
 * Opens (or reopens) this module's state. Cell access is decided entirely
 * by `server/dispatch.ts` before any of these functions run: they take an
 * already-resolved orbat/unit row (or, for creation, the `owner` the
 * dispatcher computed) and never see the user.
 */
export function openStore(file: string) {
  database = openState(file, MIGRATIONS);
  return {
    database,
    orbatRow: (id: number) => findOrbat(id),
    unitRow: (id: number) => findUnit(id),
    documentFor,
    listOrbats,
    createOrbat,
    updateOrbat,
    deleteOrbat,
    addUnit,
    updateUnit,
    deleteUnit,
    duplicateUnit,
    exportOrbat,
    importOrbat,
    close,
  };
}

function close() {
  database?.close();
}

// -- shared helpers -----------------------------------------------------------

function now() {
  return new Date().toISOString();
}

function findOrbat(id: number): OrbatRow | null {
  const row = database.prepare('SELECT * FROM orbats WHERE id = ?').get(id);
  return row ? readOrbat(row) : null;
}

function findUnit(id: number): UnitRow | null {
  const row = database.prepare('SELECT * FROM units WHERE id = ?').get(id);
  return row ? readUnit(row) : null;
}

function requireOrbatName(value: Json | undefined): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'name is required.');
  const trimmed = value.trim();
  if (trimmed.length > 120) throw new HttpError(400, 'name must be 120 characters or fewer.');
  return trimmed;
}

/** A free-text field: '' when absent, validated for type and length when present. */
function limitedString(value: Json | undefined, name: string, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string.`);
  if (value.length > maxLength)
    throw new HttpError(400, `${name} must be ${maxLength} characters or fewer.`);
  return value;
}

function validateReinforced(value: Json | undefined, name = 'reinforced'): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || !REINFORCED_VALUES.has(value)) {
    throw new HttpError(400, `${name} must be one of: '', '(+)', '(-)', '(±)'.`);
  }
  return value;
}

function validateSidcValue(value: Json | undefined, name = 'sidc'): string {
  if (typeof value !== 'string' || !SIDC_PATTERN.test(value)) {
    throw new HttpError(400, `${name} must be a 20-digit code.`);
  }
  return value;
}

function clampInt(value: Json | undefined, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new HttpError(400, `${name} must be an integer.`);
  return Math.min(Math.max(value, min), max);
}

function normalizeParentId(value: Json | undefined, name = 'parentId'): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw new HttpError(400, `${name} must be an integer id or null.`);
}

// -- shaping ----------------------------------------------------------------

function countUnits(orbatId: number) {
  return countRows(database, 'SELECT COUNT(*) AS n FROM units WHERE orbat_id = ?', orbatId);
}

/** Shapes an `orbats` row for API responses (list, document, and the
 * generated release/reassign endpoints). */
export function shapeOrbat(row: Row) {
  const orbat = readOrbat(row);
  return {
    id: orbat.id,
    name: orbat.name,
    description: orbat.description,
    createdAt: orbat.created_at,
    updatedAt: orbat.updated_at,
    unitCount: countUnits(orbat.id),
    owner_cell: orbat.owner_cell,
    releasable_to: releasableArray(orbat.releasable_to),
  };
}

function shapeUnit(row: UnitRow) {
  return {
    id: row.id,
    orbatId: row.orbat_id,
    parentId: row.parent_id,
    position: row.position,
    sidc: row.sidc,
    name: row.name,
    designation: row.designation,
    higherFormation: row.higher_formation,
    reinforced: row.reinforced,
    additional: row.additional,
    notes: row.notes,
  };
}

/** All units of an ORBAT, flattened depth-first (parent before children, siblings by position). */
function orderedUnits(orbatId: number): UnitRow[] {
  const rows = database
    .prepare('SELECT * FROM units WHERE orbat_id = ? ORDER BY position, id')
    .all(orbatId)
    .map(readUnit);
  const byParent = new Map<number | null, UnitRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.parent_id);
    if (siblings) siblings.push(row);
    else byParent.set(row.parent_id, [row]);
  }
  const ordered: UnitRow[] = [];
  const walk = (parentKey: number | null) => {
    for (const row of byParent.get(parentKey) ?? []) {
      ordered.push(row);
      walk(row.id);
    }
  };
  walk(null);
  return ordered;
}

/** `{ orbat, units }`, the shape `GET orbats/:item` and every unit mutation answers with. */
function documentFor(orbatRow: Row) {
  return { orbat: shapeOrbat(orbatRow), units: orderedUnits(num(orbatRow, 'id')).map(shapeUnit) };
}

/** The document of an ORBAT by id (after a write). */
function documentById(orbatId: number) {
  const row = database.prepare('SELECT * FROM orbats WHERE id = ?').get(orbatId);
  if (!row) throw new Error(`ORBAT ${orbatId} does not exist.`);
  return documentFor(row);
}

function touchOrbat(orbatId: number) {
  database.prepare('UPDATE orbats SET updated_at = ? WHERE id = ?').run(now(), orbatId);
}

// -- sibling-list bookkeeping -------------------------------------------------
//
// `position` is kept contiguous (0..n-1) per (orbat, parent) at all times, so
// every operation below is a local shift around the index it touches rather
// than a full renumbering pass.

function parentClause(parentId: number | null) {
  return parentId === null ? 'parent_id IS NULL' : 'parent_id = ?';
}

function parentParams(parentId: number | null): number[] {
  return parentId === null ? [] : [parentId];
}

function siblingCount(orbatId: number, parentId: number | null) {
  return countRows(
    database,
    `SELECT COUNT(*) AS n FROM units WHERE orbat_id = ? AND ${parentClause(parentId)}`,
    orbatId,
    ...parentParams(parentId),
  );
}

function shiftPositions(
  orbatId: number,
  parentId: number | null,
  fromInclusive: number,
  delta: number,
) {
  database
    .prepare(
      `UPDATE units SET position = position + ? WHERE orbat_id = ? AND ${parentClause(parentId)} AND position >= ?`,
    )
    .run(delta, orbatId, ...parentParams(parentId), fromInclusive);
}

// -- orbats -------------------------------------------------------------------

/** `access.visible('orbat')` limits the list to what the requester can see;
 * `list.orbats` in `server/routes.js` supplies `access`. */
function listOrbats(access: Access) {
  const { sql, params } = access.visible('orbat');
  return database
    .prepare(`SELECT * FROM orbats WHERE ${sql} ORDER BY updated_at DESC, id DESC`)
    .all(...params)
    .map(shapeOrbat);
}

/** `owner` is `{ owner_cell, releasable_to }`, computed by the dispatcher
 * (`ownerCellForCreate`/`normalizeRelease`) and stored exactly as given. */
function createOrbat(owner: Owner, body: Json) {
  const fields = fieldsOf(body);
  const name = requireOrbatName(fields.name);
  const description = limitedString(fields.description, 'description', 2000);
  return transact(database, () => {
    const timestamp = now();
    const { lastInsertRowid } = database
      .prepare(
        `INSERT INTO orbats (name, description, created_at, updated_at, owner_cell, releasable_to)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        description,
        timestamp,
        timestamp,
        owner.owner_cell,
        JSON.stringify(owner.releasable_to),
      );
    return documentById(Number(lastInsertRowid));
  });
}

function updateOrbat(orbat: Row, body: Json) {
  const patch = fieldsOf(body);
  const orbatId = num(orbat, 'id');
  const sets: string[] = [];
  const params: SQLInputValue[] = [];
  if ('name' in patch) {
    sets.push('name = ?');
    params.push(requireOrbatName(patch.name));
  }
  if ('description' in patch) {
    sets.push('description = ?');
    params.push(limitedString(patch.description, 'description', 2000));
  }
  return transact(database, () => {
    if (sets.length) {
      sets.push('updated_at = ?');
      params.push(now());
      database.prepare(`UPDATE orbats SET ${sets.join(', ')} WHERE id = ?`).run(...params, orbatId);
    }
    return documentById(orbatId);
  });
}

function deleteOrbat(orbat: Row) {
  return transact(database, () => {
    database.prepare('DELETE FROM orbats WHERE id = ?').run(num(orbat, 'id'));
    return { deleted: true };
  });
}

// -- units ----------------------------------------------------------------

function addUnit(orbatRow: Row, input: Json) {
  if (!isJsonObject(input) || !('parentId' in input))
    throw new HttpError(400, 'parentId is required.');
  const body = input;
  const orbat = { id: num(orbatRow, 'id') };
  const parentId = normalizeParentId(body.parentId);
  if (parentId !== null) {
    const parentRow = findUnit(parentId);
    if (!parentRow || parentRow.orbat_id !== orbat.id) {
      throw new HttpError(400, 'parentId must reference a unit in this ORBAT.');
    }
  }
  const sidc = 'sidc' in body ? validateSidcValue(body.sidc) : DEFAULT_SIDC;
  const name = limitedString(body.name, 'name', 120);
  const designation = limitedString(body.designation, 'designation', 40);
  const higherFormation = limitedString(body.higherFormation, 'higherFormation', 40);
  const reinforced = validateReinforced(body.reinforced);
  const additional = limitedString(body.additional, 'additional', 80);
  const notes = limitedString(body.notes, 'notes', 4000);

  return transact(database, () => {
    const count = siblingCount(orbat.id, parentId);
    const position = 'position' in body ? clampInt(body.position, 'position', 0, count) : count;
    shiftPositions(orbat.id, parentId, position, 1);
    const { lastInsertRowid } = database
      .prepare(
        `INSERT INTO units
           (orbat_id, parent_id, position, sidc, name, designation, higher_formation, reinforced, additional, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        orbat.id,
        parentId,
        position,
        sidc,
        name,
        designation,
        higherFormation,
        reinforced,
        additional,
        notes,
      );
    touchOrbat(orbat.id);
    return {
      ...documentById(orbat.id),
      unitId: Number(lastInsertRowid),
    };
  });
}

/**
 * A move target must be a real unit in the same ORBAT, not the unit itself,
 * and not one of the unit's own descendants (which would disconnect the
 * subtree from the tree). All three are the same class of problem — the
 * request names a syntactically valid unit id that is semantically wrong for
 * this move — so all three are reported as 409, matching the self/descendant
 * cases the contract specifies explicitly (including a target unit that
 * simply doesn't exist, or belongs to another ORBAT).
 */
function validateMoveTarget(unit: UnitRow, newParentId: number | null) {
  if (newParentId === null) return;
  if (newParentId === unit.id) throw new HttpError(409, 'A unit cannot become its own parent.');
  const parentRow = findUnit(newParentId);
  if (!parentRow || parentRow.orbat_id !== unit.orbat_id) {
    throw new HttpError(409, 'parentId must reference a unit in the same ORBAT.');
  }
  let cursor: UnitRow | null = parentRow;
  while (cursor && cursor.parent_id !== null) {
    if (cursor.parent_id === unit.id) {
      throw new HttpError(409, 'A unit cannot move under its own descendant.');
    }
    cursor = findUnit(cursor.parent_id);
  }
}

function moveUnitRow(
  unit: UnitRow,
  newParentId: number | null,
  explicitPosition: Json | undefined,
) {
  const oldParentId = unit.parent_id;
  shiftPositions(unit.orbat_id, oldParentId, unit.position + 1, -1);
  const rawCount = siblingCount(unit.orbat_id, newParentId);
  const effectiveCount = newParentId === oldParentId ? rawCount - 1 : rawCount;
  const target =
    explicitPosition === undefined
      ? effectiveCount
      : clampInt(explicitPosition, 'position', 0, effectiveCount);
  shiftPositions(unit.orbat_id, newParentId, target, 1);
  database
    .prepare('UPDATE units SET parent_id = ?, position = ? WHERE id = ?')
    .run(newParentId, target, unit.id);
}

function updateUnit(unitRow: Row, body: Json) {
  const unit = readUnit(unitRow);
  const patch = fieldsOf(body);
  const fieldUpdates: Partial<UnitFields> = {};
  if ('sidc' in patch) fieldUpdates.sidc = validateSidcValue(patch.sidc);
  if ('name' in patch) fieldUpdates.name = limitedString(patch.name, 'name', 120);
  if ('designation' in patch)
    fieldUpdates.designation = limitedString(patch.designation, 'designation', 40);
  if ('higherFormation' in patch) {
    fieldUpdates.higherFormation = limitedString(patch.higherFormation, 'higherFormation', 40);
  }
  if ('reinforced' in patch) fieldUpdates.reinforced = validateReinforced(patch.reinforced);
  if ('additional' in patch)
    fieldUpdates.additional = limitedString(patch.additional, 'additional', 80);
  if ('notes' in patch) fieldUpdates.notes = limitedString(patch.notes, 'notes', 4000);

  const isMove = 'parentId' in patch || 'position' in patch;
  const newParentId = 'parentId' in patch ? normalizeParentId(patch.parentId) : unit.parent_id;
  if (isMove) validateMoveTarget(unit, newParentId);

  return transact(database, () => {
    if (isMove) moveUnitRow(unit, newParentId, patch.position);
    const updates = UNIT_COLUMNS.flatMap(([key, column]) => {
      const value = fieldUpdates[key];
      return value === undefined ? [] : [{ column, value }];
    });
    if (updates.length) {
      const sets = updates.map(({ column }) => `${column} = ?`);
      const params = updates.map(({ value }) => value);
      database.prepare(`UPDATE units SET ${sets.join(', ')} WHERE id = ?`).run(...params, unit.id);
    }
    touchOrbat(unit.orbat_id);
    return documentById(unit.orbat_id);
  });
}

function deleteUnit(unitRow: Row) {
  const unit = readUnit(unitRow);
  return transact(database, () => {
    database.prepare('DELETE FROM units WHERE id = ?').run(unit.id); // cascades to descendants
    shiftPositions(unit.orbat_id, unit.parent_id, unit.position + 1, -1);
    touchOrbat(unit.orbat_id);
    return documentById(unit.orbat_id);
  });
}

function cloneSubtree(sourceRow: UnitRow, parentId: number | null, position: number): number {
  const { lastInsertRowid } = database
    .prepare(
      `INSERT INTO units
         (orbat_id, parent_id, position, sidc, name, designation, higher_formation, reinforced, additional, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sourceRow.orbat_id,
      parentId,
      position,
      sourceRow.sidc,
      sourceRow.name,
      sourceRow.designation,
      sourceRow.higher_formation,
      sourceRow.reinforced,
      sourceRow.additional,
      sourceRow.notes,
    );
  const newId = Number(lastInsertRowid);
  const children = database
    .prepare('SELECT * FROM units WHERE parent_id = ? ORDER BY position, id')
    .all(sourceRow.id)
    .map(readUnit);
  children.forEach((child, index) => cloneSubtree(child, newId, index));
  return newId;
}

function duplicateUnit(unitRow: Row) {
  const unit = readUnit(unitRow);
  // Unlike an import that creates a brand-new document owned by the
  // caller's own cell, a duplicate is inserted into the *same* ORBAT under
  // its existing owner: it is a structural edit, not a read-only copy.
  return transact(database, () => {
    shiftPositions(unit.orbat_id, unit.parent_id, unit.position + 1, 1);
    const newId = cloneSubtree(unit, unit.parent_id, unit.position + 1);
    touchOrbat(unit.orbat_id);
    return {
      ...documentById(unit.orbat_id),
      unitId: newId,
    };
  });
}

// -- export / import ---------------------------------------------------------

function exportChildren(orbatId: number, parentId: number | null): UnitNode[] {
  const rows = database
    .prepare(
      `SELECT * FROM units WHERE orbat_id = ? AND ${parentClause(parentId)} ORDER BY position, id`,
    )
    .all(orbatId, ...parentParams(parentId))
    .map(readUnit);
  return rows.map((row) => ({
    sidc: row.sidc,
    name: row.name,
    designation: row.designation,
    higherFormation: row.higher_formation,
    reinforced: row.reinforced,
    additional: row.additional,
    notes: row.notes,
    children: exportChildren(orbatId, row.id),
  }));
}

function exportOrbat(orbatRow: Row) {
  const orbat = {
    id: num(orbatRow, 'id'),
    name: text(orbatRow, 'name'),
    description: text(orbatRow, 'description'),
  };
  return {
    format: 'orbat',
    version: 1,
    name: orbat.name,
    description: orbat.description,
    units: exportChildren(orbat.id, null),
  };
}

/**
 * Validates one imported unit node (and its subtree) purely in memory —
 * nothing is written here — so a bad node anywhere aborts the whole import
 * before any database work starts. `path` names the node the way the error
 * should read, e.g. `units[2].children[0]`.
 */
function validateImportNode(
  node: Json,
  path: string,
  depth: number,
  counters: { count: number },
): UnitNode {
  if (!isJsonObject(node)) {
    throw new HttpError(400, `${path} must be an object.`);
  }
  counters.count += 1;
  if (counters.count > MAX_UNITS_PER_IMPORT) {
    throw new HttpError(400, `Import exceeds the maximum of ${MAX_UNITS_PER_IMPORT} units.`);
  }
  if (depth > MAX_DEPTH) {
    throw new HttpError(400, `${path} exceeds the maximum depth of ${MAX_DEPTH}.`);
  }
  const fields: UnitFields = {
    sidc: validateSidcValue(node.sidc, `${path}.sidc`),
    name: limitedString(node.name, `${path}.name`, 120),
    designation: limitedString(node.designation, `${path}.designation`, 40),
    higherFormation: limitedString(node.higherFormation, `${path}.higherFormation`, 40),
    reinforced: validateReinforced(node.reinforced, `${path}.reinforced`),
    additional: limitedString(node.additional, `${path}.additional`, 80),
    notes: limitedString(node.notes, `${path}.notes`, 4000),
  };
  const childrenRaw = node.children === undefined ? [] : node.children;
  if (!Array.isArray(childrenRaw)) throw new HttpError(400, `${path}.children must be an array.`);
  return {
    ...fields,
    children: childrenRaw.map((child, index) =>
      validateImportNode(child, `${path}.children[${index}]`, depth + 1, counters),
    ),
  };
}

function insertImportedNode(
  orbatId: number,
  parentId: number | null,
  position: number,
  node: UnitNode,
) {
  const { lastInsertRowid } = database
    .prepare(
      `INSERT INTO units
         (orbat_id, parent_id, position, sidc, name, designation, higher_formation, reinforced, additional, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      orbatId,
      parentId,
      position,
      node.sidc,
      node.name,
      node.designation,
      node.higherFormation,
      node.reinforced,
      node.additional,
      node.notes,
    );
  const newId = Number(lastInsertRowid);
  node.children.forEach((child, index) => insertImportedNode(orbatId, newId, index, child));
}

/** `owner` is `{ owner_cell, releasable_to }`, computed by the dispatcher —
 * an import always lands in the importer's own cell because the client
 * never sends `owner_cell`/`releasable_to` on import (see `client/`). */
function importOrbat(owner: Owner, body: Json) {
  if (!isJsonObject(body)) {
    throw new HttpError(400, 'Body must be an object.');
  }
  if (body.format !== 'orbat') throw new HttpError(400, "format must be 'orbat'.");
  if (body.version !== 1) throw new HttpError(400, 'version must be 1.');
  const name = requireOrbatName(body.name);
  const description = limitedString(body.description, 'description', 2000);
  if (!Array.isArray(body.units)) throw new HttpError(400, 'units must be an array.');

  const counters = { count: 0 };
  const units: Json[] = body.units;
  const validated = units.map((node, index) =>
    validateImportNode(node, `units[${index}]`, 1, counters),
  );

  return transact(database, () => {
    const timestamp = now();
    const { lastInsertRowid } = database
      .prepare(
        `INSERT INTO orbats (name, description, created_at, updated_at, owner_cell, releasable_to)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        description,
        timestamp,
        timestamp,
        owner.owner_cell,
        JSON.stringify(owner.releasable_to),
      );
    const orbatId = Number(lastInsertRowid);
    validated.forEach((node, index) => insertImportedNode(orbatId, null, index, node));
    return documentById(orbatId);
  });
}
