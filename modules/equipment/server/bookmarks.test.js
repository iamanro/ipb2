import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openBookmarks } from './bookmarks.ts';

function tempFile() {
  return path.join(
    os.tmpdir(),
    `bookmarks-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function removeDatabaseFiles(file) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
}

describe('openBookmarks', () => {
  let file;
  let store;

  beforeEach(() => {
    file = tempFile();
    store = openBookmarks(file);
  });

  afterEach(() => {
    store.close();
    removeDatabaseFiles(file);
  });

  test('creates a bookmark with an empty note and matching timestamps', () => {
    const created = store.create({ identifier: 'weg:bmp-2' });
    expect(created).toMatchObject({ identifier: 'weg:bmp-2', note: '' });
    expect(created.created_at).toBe(created.updated_at);
  });

  test('bookmarking the same card twice is a conflict, not a second row', () => {
    store.create({ identifier: 'weg:bmp-2' });
    expect(() => store.create({ identifier: 'weg:bmp-2' })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(store.list()).toHaveLength(1);
  });

  test.each([undefined, null, '', '   ', 42, {}])(
    'rejects identifier %p with 400',
    (identifier) => {
      expect(() => store.create({ identifier })).toThrow(expect.objectContaining({ status: 400 }));
    },
  );

  test('lists newest first, even when two bookmarks share a millisecond', () => {
    // `created_at` alone cannot order two rows created in the same
    // millisecond; `id` must break the tie in true creation order.
    const first = store.create({ identifier: 'weg:bmp-2' });
    const second = store.create({ identifier: 'weg:t-72' });
    expect(store.list().map((row) => row.id)).toEqual([second.id, first.id]);
  });

  test('updates the note and advances updated_at without touching created_at', () => {
    const created = store.create({ identifier: 'weg:bmp-2' });
    const updated = store.update(created.id, { note: 'Recon priority.' });
    expect(updated.note).toBe('Recon priority.');
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.updated_at >= created.updated_at).toBe(true);
  });

  test('updating with no note keeps the existing one', () => {
    const created = store.create({ identifier: 'weg:bmp-2' });
    store.update(created.id, { note: 'Kept.' });
    const untouched = store.update(created.id, {});
    expect(untouched.note).toBe('Kept.');
  });

  test.each([42, 'x'.repeat(2001)])('rejects an invalid note (%p) with 400', (note) => {
    const created = store.create({ identifier: 'weg:bmp-2' });
    expect(() => store.update(created.id, { note })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  test('operating on an unknown id is a 404, for update, remove, and a second remove', () => {
    const missing = () => store.update(999999, { note: 'x' });
    expect(missing).toThrow(expect.objectContaining({ status: 404 }));

    const created = store.create({ identifier: 'weg:bmp-2' });
    store.remove(created.id);
    expect(store.list()).toHaveLength(0);
    expect(() => store.remove(created.id)).toThrow(expect.objectContaining({ status: 404 }));
  });

  test('every successful mutation appends exactly one activity row, rejected ones none', () => {
    const created = store.create({ identifier: 'weg:bmp-2' }); // bookmark
    store.update(created.id, { note: 'x' }); // annotate
    store.remove(created.id); // unbookmark
    try {
      store.remove(created.id); // rejected (404) — must not log
    } catch {
      // expected
    }

    // The store itself never exposes raw rows; read them back through a
    // second connection, exactly as the running server would after restart.
    const raw = new DatabaseSync(file, { readOnly: true });
    const rows = raw.prepare('SELECT action, target FROM activity ORDER BY id').all();
    raw.close();
    expect(rows).toEqual([
      { action: 'bookmark', target: 'weg:bmp-2' },
      { action: 'annotate', target: 'weg:bmp-2' },
      { action: 'unbookmark', target: 'weg:bmp-2' },
    ]);
  });
});
