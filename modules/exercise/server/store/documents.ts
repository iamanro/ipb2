// Scenario documents: uploaded files (OPLAN, annexes, plans) a cell owns and releases.

import type { SQLInputValue } from 'node:sqlite';

import type { Access, Owner } from '../../../../server/dispatch.ts';
import { fieldsOf, HttpError, type Json, type JsonObject } from '../../../../server/http.ts';
import { releasableArray } from '../../../../server/policy.ts';
import { num, text, type Row } from '../../../../server/state.ts';

import { database } from './connection.ts';
import { cellsOf, existingRow, mutate, now, requireBoundedString, visibleRows } from './shared.ts';

/** Decoded file size cap; the route's body limit allows for base64 on top. */
export const MAX_DOCUMENT_BYTES = 25 << 20;

export function shapeDocument(row: Row) {
  return {
    id: num(row, 'id'),
    title: text(row, 'title'),
    filename: text(row, 'filename'),
    content_type: text(row, 'content_type'),
    size: num(row, 'size'),
    version: num(row, 'version'),
    owner_cell: text(row, 'owner_cell'),
    releasable_to: releasableArray(text(row, 'releasable_to')),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

export function listDocuments(access: Access) {
  return visibleRows(access, 'document', 'documents', 'title COLLATE NOCASE, id').map(
    shapeDocument,
  );
}

/** `{ filename, content_type, data }` (data base64) -> the columns a file sets. */
function readFile(input: JsonObject) {
  const filename = requireBoundedString(input.filename, 'filename', 255);
  const contentType =
    typeof input.content_type === 'string' && input.content_type
      ? input.content_type.slice(0, 100)
      : 'application/octet-stream';
  if (typeof input.data !== 'string' || !input.data) {
    throw new HttpError(400, 'data (the file, base64) is required.');
  }
  const bytes = Buffer.from(input.data, 'base64');
  if (!bytes.length) throw new HttpError(400, 'The file is empty.');
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    throw new HttpError(413, `The file is larger than ${MAX_DOCUMENT_BYTES >> 20} MB.`);
  }
  return { filename, contentType, bytes };
}

export function createDocument(owner: Owner, input: Json) {
  const fields = fieldsOf(input);
  const file = readFile(fields);
  const title =
    fields.title === undefined || fields.title === ''
      ? file.filename
      : requireBoundedString(fields.title, 'title', 200);
  const timestamp = now();
  return mutate('document:create', title, cellsOf(owner), () => {
    const { lastInsertRowid } = database
      .prepare(
        `INSERT INTO documents (title, filename, content_type, size, owner_cell, releasable_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        title,
        file.filename,
        file.contentType,
        file.bytes.length,
        owner.owner_cell,
        JSON.stringify(owner.releasable_to),
        timestamp,
        timestamp,
      );
    const id = Number(lastInsertRowid);
    database
      .prepare('INSERT INTO document_files (document_id, data) VALUES (?, ?)')
      .run(id, file.bytes);
    return shapeDocument(existingRow('documents', id));
  });
}

/** Rename, and/or replace the file with a new version (same id, same release). */
export function updateDocument(item: Row, input: Json) {
  const patch = fieldsOf(input);
  const id = num(item, 'id');
  const fields: string[] = [];
  const params: SQLInputValue[] = [];
  if ('title' in patch) {
    fields.push('title = ?');
    params.push(requireBoundedString(patch.title, 'title', 200));
  }
  const file = 'data' in patch ? readFile(patch) : null;
  if (file) {
    fields.push('filename = ?', 'content_type = ?', 'size = ?', 'version = version + 1');
    params.push(file.filename, file.contentType, file.bytes.length);
  }
  return mutate(file ? 'document:version' : 'document:update', String(id), cellsOf(item), () => {
    if (fields.length) {
      database
        .prepare(`UPDATE documents SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...params, now(), id);
    }
    if (file) {
      database
        .prepare('UPDATE document_files SET data = ? WHERE document_id = ?')
        .run(file.bytes, id);
    }
    return shapeDocument(existingRow('documents', id));
  });
}

export function deleteDocument(item: Row) {
  const id = num(item, 'id');
  mutate('document:delete', String(id), cellsOf(item), () => {
    database.prepare('DELETE FROM document_files WHERE document_id = ?').run(id);
    database.prepare('DELETE FROM documents WHERE id = ?').run(id);
  });
}

export function readDocumentFile(item: Row) {
  const row = database
    .prepare('SELECT data FROM document_files WHERE document_id = ?')
    .get(num(item, 'id'));
  const data = row?.data;
  if (!(data instanceof Uint8Array)) throw new HttpError(404, 'The document has no file.');
  return { ...shapeDocument(item), data };
}
