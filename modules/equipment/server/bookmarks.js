import { HttpError } from '../../../server/http.js';
import { openState, transact } from '../../../server/state.js';
import { MIGRATIONS } from './schema.js';

const NOTE_MAX_LENGTH = 2000;

let database;

// -- validation ---------------------------------------------------------

function validateIdentifier(identifier) {
  if (typeof identifier !== 'string' || !identifier.trim()) {
    throw new HttpError(400, 'identifier is required.');
  }
  return identifier.trim();
}

function validateNote(note) {
  if (note === undefined) return undefined;
  if (typeof note !== 'string') throw new HttpError(400, 'note must be a string.');
  if (note.length > NOTE_MAX_LENGTH) {
    throw new HttpError(400, `note must be at most ${NOTE_MAX_LENGTH} characters.`);
  }
  return note;
}

// -- rows -----------------------------------------------------------------

function toBookmark(row) {
  return {
    id: row.id,
    identifier: row.card_identifier,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function readRow(id) {
  return database.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id) ?? null;
}

function assertBookmarkExists(id) {
  const row = readRow(id);
  if (!row) throw new HttpError(404, 'Bookmark not found.');
  return row;
}

// -- the single write path ---------------------------------------------------

/** Every mutation appends one activity row, inside the same transaction. */
function mutate(action, target, work) {
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
  return database.prepare('SELECT * FROM bookmarks ORDER BY created_at DESC').all().map(toBookmark);
}

function create({ identifier }) {
  const cardIdentifier = validateIdentifier(identifier);
  const now = new Date().toISOString();
  try {
    return mutate('bookmark', cardIdentifier, () => {
      const { lastInsertRowid } = database
        .prepare(
          'INSERT INTO bookmarks (card_identifier, note, created_at, updated_at) VALUES (?, ?, ?, ?)',
        )
        .run(cardIdentifier, '', now, now);
      return toBookmark(readRow(Number(lastInsertRowid)));
    });
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) {
      throw new HttpError(409, 'This card is already bookmarked.');
    }
    throw error;
  }
}

function update(id, { note }) {
  const row = assertBookmarkExists(id);
  const nextNote = validateNote(note) ?? row.note;
  return mutate('annotate', row.card_identifier, () => {
    database
      .prepare('UPDATE bookmarks SET note = ?, updated_at = ? WHERE id = ?')
      .run(nextNote, new Date().toISOString(), id);
    return toBookmark(readRow(id));
  });
}

function remove(id) {
  const row = assertBookmarkExists(id);
  mutate('unbookmark', row.card_identifier, () => {
    database.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  });
}

export function openBookmarks(file) {
  database = openState(file, MIGRATIONS);
  return {
    list,
    create,
    update,
    remove,
    close: () => {
      database.close();
      database = undefined;
    },
  };
}
