import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// `IPB_STATE_ROOT` must be set before anything imports `./exerciseLifecycle.js`
// or `./api.js` (directly or transitively): each computes its state
// directory from the env var once, at module load (`server/state.js`'s
// `stateDirectory`). A dynamic `import()` after setting it is what makes
// that load happen at the right time, so this suite never touches a real
// `modules/*/state/*.db`.
let stateRoot;
let createExerciseLifecycle;
let createApiMiddleware;
let openAuthStore;

beforeAll(async () => {
  stateRoot = mkdtempSync(path.join(os.tmpdir(), 'ipb-exercise-lifecycle-test-'));
  process.env.IPB_STATE_ROOT = stateRoot;
  ({ createExerciseLifecycle } = await import('./exerciseLifecycle.js'));
  ({ createApiMiddleware } = await import('./api.js'));
  ({ openAuthStore } = await import('./auth.js'));
});

afterAll(() => {
  delete process.env.IPB_STATE_ROOT;
  rmSync(stateRoot, { recursive: true, force: true });
});

/** A real `off`-mode HTTP server (LOCAL_USER: White admin) — used both to
 * seed real ipb/exercise/orbat data through the actual module code and to
 * prove those modules reopen empty (or restored) afterwards, exactly how a
 * browser would see it. */
function startServer() {
  const { dispatch, close } = createApiMiddleware('off');
  const server = http.createServer((request, response) => dispatch(request, response, () => {
    response.statusCode = 404;
    response.end();
  }));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        async stop() {
          close();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

async function postJson(origin, pathname, body) {
  const response = await fetch(origin + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function getJson(origin, pathname) {
  const response = await fetch(origin + pathname);
  return { status: response.status, json: await response.json().catch(() => null) };
}

/** Seeds one row in each of ipb/exercise/orbat's real state databases
 * through the real HTTP server, so a reset/restore round-trip is proven
 * against actual module data, not a stand-in. */
async function seedExerciseData(origin) {
  const study = await postJson(origin, '/api/ipb/studies', { name: 'Seeded study' });
  expect(study.status).toBe(200);
  const orbat = await postJson(origin, '/api/orbat/orbats', { name: 'Seeded orbat' });
  expect(orbat.status).toBe(200);
  const requirement = await postJson(origin, '/api/exercise/requirements', {
    kind: 'PIR',
    text: 'Seeded requirement',
  });
  expect(requirement.status).toBe(200);
}

async function countRows(origin) {
  const [studies, orbats, requirements] = await Promise.all([
    getJson(origin, '/api/ipb/studies'),
    getJson(origin, '/api/orbat/orbats'),
    getJson(origin, '/api/exercise/requirements'),
  ]);
  return {
    studies: studies.json.items.length,
    orbats: orbats.json.length,
    requirements: requirements.json.length,
  };
}

describe('exercise lifecycle (C6)', () => {
  let server;
  let authFile;
  let authStore;
  let lifecycle;

  beforeAll(async () => {
    server = await startServer();
    authFile = path.join(stateRoot, 'auth', 'auth.db');
    // A second, independent connection to the same auth.db (SQLite's WAL
    // mode makes that safe — see `openAuthStore`'s own doc comment): the
    // server's own middleware already opened one lazily to audit the seed
    // requests above.
    authStore = openAuthStore(authFile);
    lifecycle = createExerciseLifecycle({ getAuthStore: () => authStore });
  });

  afterAll(async () => {
    authStore.close();
    await server.stop();
  });

  test('getExercise starts with a default name and zero members', () => {
    const exercise = lifecycle.getExercise();
    expect(exercise.name).toEqual(expect.any(String));
    expect(exercise.members).toBe(0);
  });

  test('setExerciseName renames it', () => {
    const updated = lifecycle.setExerciseName('Exercise Bold Falcon');
    expect(updated.name).toBe('Exercise Bold Falcon');
    expect(lifecycle.getExercise().name).toBe('Exercise Bold Falcon');
  });

  test('archive snapshots the three module databases and meta.json; listArchives reports it', async () => {
    await authStore.createUser('blue1', 'blue member password');
    authStore.setMembership('blue1', { cell: 'blue', role: 'analyst' });
    await seedExerciseData(server.origin);

    const archived = await lifecycle.archive({ note: 'manual checkpoint' });
    expect(archived.id).toEqual(expect.any(String));
    expect(archived.note).toBe('manual checkpoint');
    expect(archived.sizes.ipb).toBeGreaterThan(0);
    expect(archived.sizes.exercise).toBeGreaterThan(0);
    expect(archived.sizes.orbat).toBeGreaterThan(0);

    const list = await lifecycle.listArchives();
    const found = list.find((a) => a.id === archived.id);
    expect(found).toBeTruthy();
    expect(found.name).toBe('Exercise Bold Falcon');

    // Archiving is non-destructive: the live data is still there.
    const counts = await countRows(server.origin);
    expect(counts).toEqual({ studies: 1, orbats: 1, requirements: 1 });
  });

  test('reset requires the typed confirmation to match the current exercise name', async () => {
    await expect(
      lifecycle.reset({ name: 'New Exercise', confirm: 'not the right name' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test('reset locks concurrent calls (same-tick: isLocked() is true the instant reset starts, false once it settles)', async () => {
    const current = lifecycle.getExercise().name;
    const promise = lifecycle.reset({ name: 'Exercise During Lock', confirm: current });
    expect(lifecycle.isLocked()).toBeTruthy();
    expect(lifecycle.isLocked()).toMatch(/reset/i);
    await promise;
    expect(lifecycle.isLocked()).toBeFalsy();
  });

  test('reset archives first, then empties ipb/exercise/orbat, clears memberships, and renames the exercise', async () => {
    // Reseed (the previous test's reset already emptied everything).
    await authStore.createUser('blue2', 'blue member password 2');
    authStore.setMembership('blue2', { cell: 'blue', role: 'analyst' });
    await seedExerciseData(server.origin);
    expect(lifecycle.getExercise().members).toBeGreaterThan(0);

    const before = await lifecycle.listArchives();
    const current = lifecycle.getExercise().name;

    const result = await lifecycle.reset({ name: 'Exercise 2', confirm: current });
    expect(result.name).toBe('Exercise 2');
    expect(result.members).toBe(0);
    expect(result.archived.name).toBe(current);

    // A new archive exists, capturing the pre-reset state.
    const after = await lifecycle.listArchives();
    expect(after.length).toBe(before.length + 1);

    // The exercise record itself is renamed.
    expect(lifecycle.getExercise().name).toBe('Exercise 2');

    // Memberships are cleared.
    expect(authStore.listMembers().every((m) => !m.cell)).toBe(true);

    // The stores reopen empty and keep working (GET succeeds, count is zero).
    const counts = await countRows(server.origin);
    expect(counts).toEqual({ studies: 0, orbats: 0, requirements: 0 });

    // ...and still accept new writes after reopening.
    const created = await postJson(server.origin, '/api/orbat/orbats', { name: 'Post-reset orbat' });
    expect(created.status).toBe(200);
  });

  test('restore round-trips real data: archives current, swaps files, reapplies memberships for existing users only', async () => {
    // Start from a clean, known state.
    const current = lifecycle.getExercise().name;
    await lifecycle.reset({ name: 'Exercise Before Restore Test', confirm: current });

    await authStore.createUser('willStay', 'password for willStay');
    await authStore.createUser('willBeRemoved', 'password for willBeRemoved');
    authStore.setMembership('willStay', { cell: 'blue', role: 'analyst' });
    authStore.setMembership('willBeRemoved', { cell: 'red', role: 'observer' });
    await seedExerciseData(server.origin);

    const archived = await lifecycle.archive({ note: 'before restore' });

    // Remove one member's account entirely, then mutate state further, so
    // the restore has something real to undo.
    authStore.removeUser('willBeRemoved');
    await postJson(server.origin, '/api/ipb/studies', { name: 'Should disappear on restore' });
    const beforeRestoreCounts = await countRows(server.origin);
    expect(beforeRestoreCounts.studies).toBe(2);

    const restored = await lifecycle.restore({ archive: archived.id });
    expect(restored.name).toBe('Exercise Before Restore Test');

    // The data from the archived point in time is back.
    const counts = await countRows(server.origin);
    expect(counts).toEqual({ studies: 1, orbats: 1, requirements: 1 });

    // The still-existing user's membership is restored...
    const members = Object.fromEntries(authStore.listMembers().map((m) => [m.name, m]));
    expect(members.willStay).toMatchObject({ cell: 'blue', role: 'analyst' });
    // ...but the removed user obviously isn't reanimated, and doesn't
    // block the rest of the restore.
    expect(members.willBeRemoved).toBeUndefined();
  });

  test('a damaged archive is refused before anything is archived, emptied or swapped', async () => {
    await postJson(server.origin, '/api/ipb/studies', { name: 'Survives a bad restore' });
    const before = await countRows(server.origin);
    const archived = await lifecycle.archive({ note: 'to be damaged' });
    writeFileSync(path.join(stateRoot, 'archives', archived.id, 'orbat.db'), 'not a database');
    const archivesBefore = (await lifecycle.listArchives()).length;
    await expect(lifecycle.restore({ archive: archived.id })).rejects.toMatchObject({ status: 422 });
    expect(await countRows(server.origin)).toEqual(before);
    expect(await lifecycle.listArchives()).toHaveLength(archivesBefore);
    expect(lifecycle.isLocked()).toBeFalsy();
    rmSync(path.join(stateRoot, 'archives', archived.id), { recursive: true });
  });

  test('restore 404s on an unknown archive id', async () => {
    await expect(lifecycle.restore({ archive: 'no-such-archive' })).rejects.toMatchObject({
      status: 404,
    });
  });

  test('restore refuses an archive id that is a path, before touching any state', async () => {
    for (const archive of ['../..', '../../etc', 'a/../../b', '/tmp']) {
      await expect(lifecycle.restore({ archive })).rejects.toMatchObject({ status: 400 });
    }
    expect(lifecycle.isLocked()).toBeFalsy();
  });

  test('restore locks too: isLocked() is true the instant it starts', async () => {
    const archives = await lifecycle.listArchives();
    const promise = lifecycle.restore({ archive: archives[0].id });
    expect(lifecycle.isLocked()).toBeTruthy();
    expect(lifecycle.isLocked()).toMatch(/restor/i);
    await promise;
    expect(lifecycle.isLocked()).toBeFalsy();
  });
});
