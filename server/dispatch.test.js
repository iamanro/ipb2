import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { announce, createDispatcher, EXERCISE_CONTROL } from './dispatch.js';
import { sweepRoutes } from './routeSweep.js';

const WHITE = { name: 'w', admin: false, cell: 'white', role: 'game-master' };
const ADMIN = { name: 'a', admin: true, cell: 'white', role: 'game-master', effective: true };
const BLUE = { name: 'b', admin: false, cell: 'blue', role: 'analyst' };
const BLUE_OBSERVER = { name: 'bo', admin: false, cell: 'blue', role: 'observer' };
const RED = { name: 'r', admin: false, cell: 'red', role: 'analyst' };

let database;
let events;
let audits;
let dispatcher;
let connected;

/** A toy module: notes (items) with lines (parts), a global counter, a read-via-POST search. */
function toyModule() {
  const shape = (row) => ({
    id: row.id,
    text: row.text,
    owner_cell: row.owner_cell,
    releasable_to: JSON.parse(row.releasable_to),
  });
  return {
    id: 'toy',
    database: () => database,
    close() {},
    connect({ runAs }) {
      connected = runAs;
    },
    items: {
      note: {
        table: 'notes',
        path: 'notes',
        label: 'Note',
        shape,
        onOwnership: ({ action, after }) =>
          database.prepare('INSERT INTO log (entry) VALUES (?)').run(`${action}:${after.id}`),
      },
    },
    parts: { line: { table: 'lines', item: 'note', column: 'note_id', label: 'Line' } },
    routes: [
      {
        method: 'GET',
        path: 'notes',
        verb: 'list',
        handler: ({ access }) => {
          const { sql, params } = access.visible('note');
          return database
            .prepare(`SELECT * FROM notes WHERE ${sql} ORDER BY id`)
            .all(...params)
            .map(shape);
        },
      },
      {
        method: 'POST',
        path: 'notes',
        verb: 'create',
        item: 'note',
        handler: ({ body, owner }) => {
          const cell = body.store_wrong_owner ? 'red' : owner.owner_cell;
          const { lastInsertRowid } = database
            .prepare('INSERT INTO notes (text, owner_cell, releasable_to) VALUES (?, ?, ?)')
            .run(body.text, cell, JSON.stringify(owner.releasable_to));
          return shape(database.prepare('SELECT * FROM notes WHERE id = ?').get(lastInsertRowid));
        },
      },
      {
        method: 'GET',
        path: 'notes/:item',
        verb: 'see',
        item: 'note',
        handler: ({ item }) => shape(item),
      },
      {
        method: 'PATCH',
        path: 'notes/:item',
        verb: 'change',
        item: 'note',
        handler: ({ item, body }) => {
          database.prepare('UPDATE notes SET text = ? WHERE id = ?').run(body.text, item.id);
          return { ok: true };
        },
      },
      {
        method: 'GET',
        path: 'notes/:item/lines/:part',
        verb: 'see',
        item: 'note',
        part: 'line',
        handler: ({ part }) => part,
      },
      {
        method: 'POST',
        path: 'notes/:item/cite',
        verb: 'change',
        item: 'note',
        handler: ({ body, access }) => ({ cited: access.see('note', body.other).id }),
      },
      {
        method: 'PATCH',
        path: 'counter',
        verb: 'none',
        role: 'game-master',
        reach: 'everyone',
        handler: () => ({ ok: true }),
      },
      {
        method: 'POST',
        path: 'secret',
        verb: 'none',
        role: 'game-master',
        handler: () => ({ ok: true }),
      },
      {
        method: 'POST',
        path: 'search',
        verb: 'none',
        role: 'observer',
        changes: false,
        handler: ({ body }) => ({ q: body.q }),
      },
      {
        method: 'POST',
        path: 'fire',
        verb: 'none',
        role: 'game-master',
        reach: 'handler',
        handler: ({ body }) =>
          body?.forget ? { fired: true } : announce({ fired: true }, ['white', 'red']),
      },
      {
        method: 'GET',
        path: /^tiles\/(?<z>\d+)\.png$/,
        verb: 'none',
        handler: ({ params }) => ({ z: params.z }),
      },
    ],
  };
}

function insertNote(text, owner, released = []) {
  const { lastInsertRowid } = database
    .prepare('INSERT INTO notes (text, owner_cell, releasable_to) VALUES (?, ?, ?)')
    .run(text, owner, JSON.stringify(released));
  return Number(lastInsertRowid);
}

const call = (actor, method, route, body) => dispatcher.runAs(actor, 'toy', method, route, body);

beforeEach(() => {
  database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT, owner_cell TEXT NOT NULL, releasable_to TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE lines (id INTEGER PRIMARY KEY, note_id INTEGER NOT NULL, text TEXT);
    CREATE TABLE log (entry TEXT);
  `);
  events = [];
  audits = [];
  dispatcher = createDispatcher([toyModule()], {
    publish: (event) => events.push(event),
    audit: (entry) => audits.push(entry),
  });
});

afterEach(() => database.close());

describe('seeing an item', () => {
  test("another cell's unreleased item looks exactly like a missing one", async () => {
    const red = insertNote('red plan', 'red');
    await expect(call(BLUE, 'GET', `notes/${red}`)).rejects.toMatchObject({
      status: 404,
      message: `Note ${red} not found.`,
    });
    await expect(call(BLUE, 'GET', 'notes/999')).rejects.toMatchObject({
      status: 404,
      message: 'Note 999 not found.',
    });
    await expect(call(BLUE, 'GET', 'notes/abc')).rejects.toMatchObject({ status: 404 });
  });

  test('owner, the cells it is released to, White and an admin see it', async () => {
    const red = insertNote('red plan', 'red', ['blue']);
    for (const actor of [RED, BLUE, WHITE, ADMIN]) {
      await expect(call(actor, 'GET', `notes/${red}`)).resolves.toMatchObject({ text: 'red plan' });
    }
  });

  test('a part is reached only through its own item', async () => {
    const mine = insertNote('blue', 'blue');
    const theirs = insertNote('red', 'red');
    database
      .prepare('INSERT INTO lines (id, note_id, text) VALUES (1, ?, ?), (2, ?, ?)')
      .run(mine, 'a', theirs, 'b');
    await expect(call(BLUE, 'GET', `notes/${mine}/lines/1`)).resolves.toMatchObject({ text: 'a' });
    // Red's line addressed through Blue's note: 404, not Red's data.
    await expect(call(BLUE, 'GET', `notes/${mine}/lines/2`)).rejects.toMatchObject({
      status: 404,
      message: 'Line 2 not found.',
    });
    await expect(call(BLUE, 'GET', `notes/${theirs}/lines/2`)).rejects.toMatchObject({
      status: 404,
      message: `Note ${theirs} not found.`,
    });
  });

  test('lists hold only what the member can see', async () => {
    insertNote('blue', 'blue');
    insertNote('red', 'red');
    insertNote('red released', 'red', ['blue']);
    expect((await call(BLUE, 'GET', 'notes')).map((note) => note.text)).toEqual([
      'blue',
      'red released',
    ]);
    expect(await call(WHITE, 'GET', 'notes')).toHaveLength(3);
  });

  test('reading another item from inside a handler hides what the member cannot see', async () => {
    const mine = insertNote('blue', 'blue');
    const released = insertNote('red released', 'red', ['blue']);
    const hidden = insertNote('red', 'red');
    await expect(call(BLUE, 'POST', `notes/${mine}/cite`, { other: released })).resolves.toEqual({
      cited: released,
    });
    await expect(call(BLUE, 'POST', `notes/${mine}/cite`, { other: hidden })).rejects.toMatchObject(
      { status: 404 },
    );
  });
});

describe('changing an item', () => {
  test('release is read-only: the cell it was released to gets 403, the owner and White succeed', async () => {
    const red = insertNote('red plan', 'red', ['blue']);
    await expect(call(BLUE, 'PATCH', `notes/${red}`, { text: 'x' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(call(RED, 'PATCH', `notes/${red}`, { text: 'red 2' })).resolves.toEqual({
      ok: true,
    });
    await expect(call(WHITE, 'PATCH', `notes/${red}`, { text: 'white' })).resolves.toEqual({
      ok: true,
    });
  });

  test("a change is announced to the item's cells", async () => {
    const red = insertNote('red plan', 'red', ['blue']);
    await call(RED, 'PATCH', `notes/${red}`, { text: 'red 2' });
    expect(events.at(-1)).toMatchObject({
      module: 'toy',
      route: `notes/${red}`,
      user: 'r',
      cells: ['red', 'blue'],
    });
  });

  test("the role comes from the route: an observer cannot change even their own cell's item", async () => {
    const blue = insertNote('blue', 'blue');
    await expect(
      call(BLUE_OBSERVER, 'PATCH', `notes/${blue}`, { text: 'x' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(call(BLUE_OBSERVER, 'GET', `notes/${blue}`)).resolves.toMatchObject({
      text: 'blue',
    });
  });
});

describe('creating an item', () => {
  test('a member creates in their own cell; White chooses; nobody else can pick another cell', async () => {
    await expect(call(BLUE, 'POST', 'notes', { text: 'b' })).resolves.toMatchObject({
      owner_cell: 'blue',
    });
    await expect(
      call(BLUE, 'POST', 'notes', { text: 'b', owner_cell: 'red' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      call(WHITE, 'POST', 'notes', { text: 'w', owner_cell: 'red' }),
    ).resolves.toMatchObject({ owner_cell: 'red' });
    await expect(
      call(EXERCISE_CONTROL, 'POST', 'notes', { text: 'inject', releasable_to: ['blue'] }),
    ).resolves.toMatchObject({
      owner_cell: 'white',
      releasable_to: ['blue'],
    });
    expect(events.at(-1)).toMatchObject({ user: 'scenario clock', cells: ['white', 'blue'] });
  });

  test('an observer creates nothing, not even in their own cell', async () => {
    await expect(call(BLUE_OBSERVER, 'POST', 'notes', { text: 'b' })).rejects.toMatchObject({
      status: 403,
    });
  });

  test('a handler that stores a different owner than it was given fails loudly', async () => {
    await expect(
      call(BLUE, 'POST', 'notes', { text: 'b', store_wrong_owner: true }),
    ).rejects.toThrow(/stored owner_cell "red"/);
  });
});

describe('release and reassign (generated for every item kind)', () => {
  test("the owner's analyst releases; the answer is the shaped item and both old and new readers hear of it", async () => {
    const red = insertNote('red plan', 'red', ['white']);
    const shaped = await call(RED, 'POST', `notes/${red}/release`, { cells: ['blue', 'red'] });
    expect(shaped).toEqual({
      id: red,
      text: 'red plan',
      owner_cell: 'red',
      releasable_to: ['blue'],
    });
    expect(events.at(-1).cells.sort()).toEqual(['blue', 'red', 'white']);
    expect(database.prepare('SELECT entry FROM log').all()).toEqual([{ entry: `release:${red}` }]);
    await expect(call(BLUE, 'GET', `notes/${red}`)).resolves.toBeTruthy();
  });

  test('a cell it was released to, and an observer of the owner cell, may not release', async () => {
    const red = insertNote('red plan', 'red', ['blue']);
    await expect(call(BLUE, 'POST', `notes/${red}/release`, { cells: [] })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      call({ ...RED, role: 'observer' }, 'POST', `notes/${red}/release`, { cells: [] }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      call(RED, 'POST', `notes/${red}/release`, { cells: ['green'] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test('only White reassigns, and the new owner leaves the released-to list', async () => {
    const red = insertNote('red plan', 'red', ['blue']);
    await expect(
      call(RED, 'PATCH', `notes/${red}/owner`, { owner_cell: 'blue' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      call(WHITE, 'PATCH', `notes/${red}/owner`, { owner_cell: 'blue' }),
    ).resolves.toMatchObject({
      owner_cell: 'blue',
      releasable_to: [],
    });
    expect(events.at(-1).cells.sort()).toEqual(['blue', 'red']);
  });
});

describe('routes about no item', () => {
  test('a global change reaches everyone; an undeclared one only White; a read via POST is not announced', async () => {
    await call(WHITE, 'PATCH', 'counter');
    expect(events.at(-1)).not.toHaveProperty('cells');
    await call(WHITE, 'POST', 'secret');
    expect(events.at(-1).cells).toEqual(['white']);
    const before = events.length;
    await expect(call(BLUE_OBSERVER, 'POST', 'search', { q: 'T-72' })).resolves.toEqual({
      q: 'T-72',
    });
    expect(events).toHaveLength(before);
  });

  test('a change only its handler can place (firing an inject) reaches the cells the handler names', async () => {
    await expect(connected(EXERCISE_CONTROL, 'POST', 'fire')).resolves.toEqual({ fired: true });
    expect(events.at(-1)).toMatchObject({
      route: 'fire',
      user: 'scenario clock',
      cells: ['white', 'red'],
    });
    await expect(call(WHITE, 'POST', 'fire', { forget: true })).rejects.toThrow(
      /must return announce/,
    );
  });

  test('RegExp paths give their named groups as params', async () => {
    await expect(call(BLUE, 'GET', 'tiles/12.png')).resolves.toEqual({ z: '12' });
  });

  test('an unknown route is 404, a known path with the wrong method 405', async () => {
    await expect(call(BLUE, 'GET', 'nothing')).rejects.toMatchObject({ status: 404 });
    await expect(call(BLUE, 'DELETE', 'counter')).rejects.toMatchObject({ status: 405 });
  });
});

test('a declaration mistake fails when the dispatcher is created, not on a request', () => {
  const broken = {
    ...toyModule(),
    parts: { line: { table: 'lines', item: 'nope', column: 'x', label: 'Line' } },
  };
  expect(() => createDispatcher([broken])).toThrow(/unknown item "nope"/);
  const noVerb = { ...toyModule(), routes: [{ method: 'GET', path: 'x', handler: () => 1 }] };
  expect(() => createDispatcher([noVerb])).toThrow(/no valid verb/);
  const changeAsRead = {
    ...toyModule(),
    routes: [
      { method: 'DELETE', path: 'notes/:item', verb: 'see', item: 'note', handler: () => 1 },
    ],
  };
  expect(() => createDispatcher([changeAsRead])).toThrow(/can't be declared 'see'/);
  const undeclaredItem = {
    ...toyModule(),
    routes: [{ method: 'DELETE', path: 'notes/:item', verb: 'none', handler: () => 1 }],
  };
  expect(() => createDispatcher([undeclaredItem])).toThrow(/declares no item kind/);
});

test('over HTTP: the body is read once, the answer sent, and the change announced and audited after it succeeds', async () => {
  const red = insertNote('red plan', 'red');
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    dispatcher
      .handle({
        moduleId: 'toy',
        route: url.pathname.slice(1),
        url,
        request,
        response,
        actor: RED,
        client: 'c',
        rawClient: 'raw',
      })
      .catch((error) => {
        response.writeHead(error.status ?? 500);
        response.end(error.message);
      });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/notes/${red}`, {
      method: 'PATCH',
      body: JSON.stringify({ text: 'via http' }),
    });
    expect(await ok.json()).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.at(-1)).toMatchObject({ route: `notes/${red}`, cells: ['red'], client: 'c' });
    expect(audits.at(-1)).toMatchObject({
      user: 'r',
      method: 'PATCH',
      path: `/notes/${red}`,
      status: 200,
      client: 'raw',
    });

    const before = events.length;
    const refused = await fetch(`${base}/notes/${red}`, { method: 'PATCH', body: 'not json' });
    expect(refused.status).toBe(400);
    expect(events).toHaveLength(before);
  } finally {
    server.close();
  }
});

test('the generated sweep passes for a module that holds the line, and reports an item kind it cannot sweep', async () => {
  const hidden = insertNote('red', 'red');
  const released = insertNote('red released', 'red', ['blue']);
  database
    .prepare('INSERT INTO lines (id, note_id, text) VALUES (1, ?, ?), (2, ?, ?)')
    .run(hidden, 'a', released, 'b');
  const fixtures = {
    note: {
      hidden: { item: hidden, parts: { line: 1 } },
      released: { item: released, parts: { line: 2 } },
    },
  };
  expect(await sweepRoutes({ dispatcher, moduleId: 'toy', actor: BLUE, fixtures })).toEqual([]);

  // A new item kind without fixtures is reported, not silently skipped.
  expect(await sweepRoutes({ dispatcher, moduleId: 'toy', actor: BLUE, fixtures: {} })).toContain(
    'GET notes/:item: no fixture for item kind "note"',
  );
});
