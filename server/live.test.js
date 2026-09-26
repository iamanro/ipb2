import { EventEmitter } from 'node:events';

import { afterEach, expect, test, vi } from 'vitest';

import {
  closeAllSubscribers,
  closeStreamsForToken,
  closeStreamsForUser,
  handleLive,
  publish,
  subscriberCount,
} from './live.js';

/** A minimal stand-in for `http.IncomingMessage`/`ServerResponse`: just
 * enough event-emitting and header/write bookkeeping for `live.js`. */
function fakeConnection() {
  const request = new EventEmitter();
  const response = new EventEmitter();
  response.headers = null;
  response.written = [];
  response.ended = false;
  response.writeHead = (status, headers) => {
    response.statusCode = status;
    response.headers = headers;
  };
  response.write = (chunk) => {
    response.written.push(chunk);
  };
  response.end = (chunk) => {
    if (chunk) response.written.push(chunk);
    response.ended = true;
  };
  return { request, response };
}

afterEach(() => {
  closeAllSubscribers();
  vi.useRealTimers();
});

test('handleLive opens an SSE stream and registers the connection', () => {
  const { request, response } = fakeConnection();
  const before = subscriberCount();
  handleLive(request, response, { user: 'alice' });
  expect(response.statusCode).toBe(200);
  expect(response.headers['Content-Type']).toBe('text/event-stream');
  expect(response.written[0]).toMatch(/^: /); // an opening comment, not a data event
  expect(subscriberCount()).toBe(before + 1);
});

test('publish delivers to every open connection as an SSE data event', () => {
  const a = fakeConnection();
  const b = fakeConnection();
  handleLive(a.request, a.response, { user: 'alice' });
  handleLive(b.request, b.response, { user: 'bob' });
  const event = {
    module: 'orbat',
    method: 'POST',
    route: 'orbats',
    client: 'c1',
    user: 'alice',
    at: 'now',
  };
  publish(event);
  for (const response of [a.response, b.response]) {
    const dataLine = response.written.find((chunk) => chunk.startsWith('data: '));
    expect(JSON.parse(dataLine.slice('data: '.length))).toEqual(event);
  }
});

test('publish with no subscribers is a harmless no-op', () => {
  expect(() => publish({ module: 'ipb' })).not.toThrow();
});

test('a closed connection is cleaned up and stops receiving events', () => {
  const { request, response } = fakeConnection();
  handleLive(request, response, { user: 'alice' });
  const before = subscriberCount();
  request.emit('close');
  expect(subscriberCount()).toBe(before - 1);
  publish({ module: 'ipb' });
  expect(response.written.some((chunk) => chunk.startsWith('data: '))).toBe(false);
});

test('a closed response is cleaned up the same way', () => {
  const { request, response } = fakeConnection();
  handleLive(request, response, { user: 'alice' });
  const before = subscriberCount();
  response.emit('close');
  expect(subscriberCount()).toBe(before - 1);
});

test('sends a keep-alive comment on an interval, without ending the stream, while the session stays valid', () => {
  vi.useFakeTimers();
  const { request, response } = fakeConnection();
  handleLive(request, response, { user: 'alice', revalidate: () => true });
  const initialWrites = response.written.length;
  vi.advanceTimersByTime(30000);
  expect(response.written.length).toBeGreaterThan(initialWrites);
  expect(response.written.at(-1)).toMatch(/^: /);
  expect(response.ended).toBe(false);
});

test('a keep-alive tick that finds the session gone ends the stream instead (IPB-AUTH-005)', () => {
  vi.useFakeTimers();
  const { request, response } = fakeConnection();
  let valid = true;
  handleLive(request, response, { user: 'alice', revalidate: () => valid });
  const before = subscriberCount();
  valid = false; // e.g. the user logged out, was removed, or changed their password elsewhere
  vi.advanceTimersByTime(30000);
  expect(response.ended).toBe(true);
  expect(subscriberCount()).toBe(before - 1);
});

test('bounds the number of concurrent subscribers, across many distinct users', () => {
  const connections = [];
  let opened = 0;
  let rejectedStatus = null;
  for (let i = 0; i < 200 && rejectedStatus === null; i += 1) {
    const connection = fakeConnection();
    try {
      handleLive(connection.request, connection.response, { user: `user-${i}` });
      connections.push(connection);
      opened += 1;
    } catch (error) {
      rejectedStatus = error.status;
    }
  }
  expect(rejectedStatus).toBe(503);
  expect(opened).toBeGreaterThan(0);
  expect(opened).toBeLessThan(200);
});

test('bounds the number of concurrent subscribers for one user (IPB-AUTH-005)', () => {
  const connections = [];
  for (let i = 0; i < 8; i += 1) {
    const connection = fakeConnection();
    handleLive(connection.request, connection.response, { user: 'alice' });
    connections.push(connection);
  }
  const ninth = fakeConnection();
  expect(() => handleLive(ninth.request, ninth.response, { user: 'alice' })).toThrow(
    expect.objectContaining({ status: 503 }),
  );
  // A different user is unaffected by alice's cap.
  const bob = fakeConnection();
  expect(() => handleLive(bob.request, bob.response, { user: 'bob' })).not.toThrow();
});

test('closeStreamsForToken ends only the stream opened with that token, leaving others open', () => {
  const a = fakeConnection();
  const b = fakeConnection();
  handleLive(a.request, a.response, { user: 'alice', tokenHash: 'hash-a' });
  handleLive(b.request, b.response, { user: 'alice', tokenHash: 'hash-b' });
  const before = subscriberCount();
  closeStreamsForToken('hash-a');
  expect(a.response.ended).toBe(true);
  expect(b.response.ended).toBe(false);
  expect(subscriberCount()).toBe(before - 1);
});

test('closeStreamsForToken with a falsy hash is a no-op', () => {
  const { request, response } = fakeConnection();
  handleLive(request, response, { user: 'alice' });
  expect(() => closeStreamsForToken(null)).not.toThrow();
  expect(response.ended).toBe(false);
});

test('closeStreamsForUser ends every stream for that user, leaving others open', () => {
  const a = fakeConnection();
  const b = fakeConnection();
  const c = fakeConnection();
  handleLive(a.request, a.response, { user: 'alice', tokenHash: 'hash-a' });
  handleLive(b.request, b.response, { user: 'alice', tokenHash: 'hash-b' });
  handleLive(c.request, c.response, { user: 'bob', tokenHash: 'hash-c' });
  closeStreamsForUser('alice');
  expect(a.response.ended).toBe(true);
  expect(b.response.ended).toBe(true);
  expect(c.response.ended).toBe(false);
  expect(subscriberCount()).toBe(1);
});

test('C4: an event with no cells (a global change) reaches every stream regardless of cell', () => {
  const white = fakeConnection();
  const blue = fakeConnection();
  const red = fakeConnection();
  handleLive(white.request, white.response, { user: 'w', cell: 'white' });
  handleLive(blue.request, blue.response, { user: 'b', cell: 'blue' });
  handleLive(red.request, red.response, { user: 'r', cell: 'red' });
  publish({ module: 'exercise', route: 'clock' });
  for (const { response } of [white, blue, red]) {
    expect(response.written.some((chunk) => chunk.startsWith('data: '))).toBe(true);
  }
});

test('C4: a cell-owned event only reaches White/admin and cells it lists', () => {
  const white = fakeConnection();
  const admin = fakeConnection();
  const blue = fakeConnection();
  const red = fakeConnection();
  handleLive(white.request, white.response, { user: 'w', cell: 'white' });
  handleLive(admin.request, admin.response, { user: 'a', cell: null, admin: true });
  handleLive(blue.request, blue.response, { user: 'b', cell: 'blue' });
  handleLive(red.request, red.response, { user: 'r', cell: 'red' });
  publish({ module: 'ipb', route: 'studies', cells: ['red', 'blue'] });
  for (const { response } of [white, admin, blue, red]) {
    expect(response.written.some((chunk) => chunk.startsWith('data: '))).toBe(true);
  }
});

test('C4: a cell-owned event does not reach a cell not listed, or a user with no cell', () => {
  const blue = fakeConnection();
  const red = fakeConnection();
  const none = fakeConnection();
  handleLive(blue.request, blue.response, { user: 'b', cell: 'blue' });
  handleLive(red.request, red.response, { user: 'r', cell: 'red' });
  handleLive(none.request, none.response, { user: 'n', cell: null });
  publish({ module: 'ipb', route: 'studies', cells: ['red'] });
  expect(blue.response.written.some((chunk) => chunk.startsWith('data: '))).toBe(false);
  expect(red.response.written.some((chunk) => chunk.startsWith('data: '))).toBe(true);
  expect(none.response.written.some((chunk) => chunk.startsWith('data: '))).toBe(false);
});

test('C4: the keep-alive tick closes the stream when the membership cell changed', () => {
  vi.useFakeTimers();
  const { request, response } = fakeConnection();
  let membership = { cell: 'blue', role: 'analyst', admin: false };
  handleLive(request, response, {
    user: 'alice',
    cell: 'blue',
    role: 'analyst',
    revalidate: () => membership,
  });
  const before = subscriberCount();
  membership = { cell: 'red', role: 'analyst', admin: false }; // reassigned to a different cell
  vi.advanceTimersByTime(30000);
  expect(response.ended).toBe(true);
  expect(subscriberCount()).toBe(before - 1);
});

test('C4: the keep-alive tick closes the stream when the membership role changed', () => {
  vi.useFakeTimers();
  const { request, response } = fakeConnection();
  let membership = { cell: 'blue', role: 'observer', admin: false };
  handleLive(request, response, {
    user: 'alice',
    cell: 'blue',
    role: 'observer',
    revalidate: () => membership,
  });
  membership = { cell: 'blue', role: 'game-master', admin: false }; // promoted, same cell
  vi.advanceTimersByTime(30000);
  expect(response.ended).toBe(true);
});

test('C4: the keep-alive tick closes the stream when the admin flag changed', () => {
  vi.useFakeTimers();
  const { request, response } = fakeConnection();
  let membership = { cell: 'white', role: 'game-master', admin: true };
  handleLive(request, response, {
    user: 'root',
    cell: 'white',
    role: 'game-master',
    admin: true,
    revalidate: () => membership,
  });
  membership = { cell: 'white', role: 'game-master', admin: false }; // admin flag removed
  vi.advanceTimersByTime(30000);
  expect(response.ended).toBe(true);
});

test('C4: an unchanged membership on the keep-alive tick just sends the comment, stream stays open', () => {
  vi.useFakeTimers();
  const { request, response } = fakeConnection();
  const membership = { cell: 'blue', role: 'analyst', admin: false };
  handleLive(request, response, {
    user: 'alice',
    cell: 'blue',
    role: 'analyst',
    revalidate: () => membership,
  });
  const initialWrites = response.written.length;
  vi.advanceTimersByTime(30000);
  expect(response.ended).toBe(false);
  expect(response.written.length).toBeGreaterThan(initialWrites);
  expect(subscriberCount()).toBe(1);
});

test('closeAllSubscribers ends every open stream', () => {
  const a = fakeConnection();
  const b = fakeConnection();
  handleLive(a.request, a.response, { user: 'alice' });
  handleLive(b.request, b.response, { user: 'bob' });
  closeAllSubscribers();
  expect(a.response.ended).toBe(true);
  expect(b.response.ended).toBe(true);
  expect(subscriberCount()).toBe(0);
});
