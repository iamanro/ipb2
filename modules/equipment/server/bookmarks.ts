import type { DatabaseSync } from 'node:sqlite';

import { errorMessage, fieldsOf, HttpError, type Json } from '../../../server/http.ts';
import { num, openState, text, transact, type Row } from '../../../server/state.ts';
import { MIGRATIONS } from './schema.ts';

const NOTE_MAX_LENGTH = 2000;

export type Bookmark = {
  id: number;
  identifier: string;
  note: string;
  created_at: string;
  updated_at: string;
};

let database: DatabaseSync;

// -- validation ---------------------------------------------------------

function validateIdentifier(identifier: Json | undefined): string {
  if (typeof identifier !== 'string' || !identifier.trim()) {
    throw new HttpError(400, 'identifier is required.');
  }
  return identifier.trim();
}

function validateNote(note: Json | undefined): string | undefined {
  if (note === undefined) return undefined;
  if (typeof note !== 'string') throw new HttpError(400, 'note must be a string.');
  if (note.length > NOTE_MAX_LENGTH) {
    throw new HttpError(400, `note must be at most ${NOTE_MAX_LENGTH} characters.`);
  }
  return note;
}

// -- rows -----------------------------------------------------------------

function toBookmark(row: Row): Bookmark {
  return {
    id: num(row, 'id'),
    identifier: text(row, 'card_identifier'),
    note: text(row, 'note'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
}

function readRow(id: number): Bookmark | null {
  const row = database.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
  return row ? toBookmark(row) : null;
}

function assertBookmarkExists(id: number): Bookmark {
  const bookmark = readRow(id);
  if (!bookmark) throw new HttpError(404, 'Bookmark not found.');
  return bookmark;
}

// -- the single write path ---------------------------------------------------

/** Every mutation appends one activity row, inside the same transaction. */
function mutate<T>(action: string, target: string, work: () => T): T {
  return transact(database, () => {
    const result = work();
    database
      .prepare('INSERT INTO activity (at, action, target) VALUES (?, ?, ?)')
      .run(new Date().toISOString(), action, target);
    return result;
  });
}

// -- public interface ---------------------------------------------------------

function list() {
  // `created_at` has millisecond resolution; two bookmarks created in the
  // same millisecond (a fast double-star) would otherwise sort arbitrarily.
  // `id` is monotonic, so it breaks the tie in true creation order.
  return database
    .prepare('SELECT * FROM bookmarks ORDER BY created_at DESC, id DESC')
    .all()
    .map(toBookmark);
}

function create(body: Json): Bookmark {
  const cardIdentifier = validateIdentifier(fieldsOf(body).identifier);
  const now = new Date().toISOString();
  try {
    return mutate('bookmark', cardIdentifier, () => {
      const { lastInsertRowid } = database
        .prepare(
          'INSERT INTO bookmarks (card_identifier, note, created_at, updated_at) VALUES (?, ?, ?, ?)',
        )
        .run(cardIdentifier, '', now, now);
      return assertBookmarkExists(Number(lastInsertRowid));
    });
  } catch (error) {
    if (errorMessage(error).includes('UNIQUE constraint failed')) {
      throw new HttpError(409, 'This card is already bookmarked.');
    }
    throw error;
  }
}

function update(id: number, body: Json): Bookmark {
  const bookmark = assertBookmarkExists(id);
  const nextNote = validateNote(fieldsOf(body).note) ?? bookmark.note;
  return mutate('annotate', bookmark.identifier, () => {
    database
      .prepare('UPDATE bookmarks SET note = ?, updated_at = ? WHERE id = ?')
      .run(nextNote, new Date().toISOString(), id);
    return assertBookmarkExists(id);
  });
}

function remove(id: number) {
  const bookmark = assertBookmarkExists(id);
  mutate('unbookmark', bookmark.identifier, () => {
    database.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  });
}

export function openBookmarks(file: string) {
  database = openState(file, MIGRATIONS);
  return {
    list,
    create,
    update,
    remove,
    close: () => {
      database.close();
    },
  };
}
