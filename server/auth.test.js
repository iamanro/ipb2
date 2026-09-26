import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { SESSION_ABSOLUTE_TTL_MS, SESSION_TTL_MS, openAuthStore } from './auth.js';

function tempFile() {
  return path.join(
    os.tmpdir(),
    `auth-store-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function removeDatabaseFiles(file) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
}

async function expectStatus(promise, status) {
  await expect(promise).rejects.toMatchObject({ status });
}

let file;
let store;

beforeEach(() => {
  file = tempFile();
  store = openAuthStore(file);
});

afterEach(() => {
  store.close();
  removeDatabaseFiles(file);
  vi.useRealTimers();
});

describe('users', () => {
  test('has no users, then has one after creating it', async () => {
    expect(store.hasUsers()).toBe(false);
    await store.createUser('alice', 'correct horse');
    expect(store.hasUsers()).toBe(true);
    expect(store.listUsers()).toEqual([
      { name: 'alice', admin: false, created_at: expect.any(String) },
    ]);
  });

  test('createUser({ admin: true }) flags the global admin bit', async () => {
    await store.createUser('root', 'correct horse battery', { admin: true });
    expect(store.listUsers()).toEqual([
      { name: 'root', admin: true, created_at: expect.any(String) },
    ]);
  });

  test('a new user has no membership until one is set', async () => {
    await store.createUser('alice', 'correct horse battery');
    const [row] = store.listUsersDetailed();
    expect(row.cell).toBeNull();
    expect(row.role).toBeNull();
  });

  test('rejects a duplicate name', async () => {
    await store.createUser('alice', 'correct horse');
    await expectStatus(store.createUser('alice', 'another password'), 409);
  });

  test('rejects an invalid name or short password', async () => {
    await expectStatus(store.createUser('a l!ce', 'correct horse'), 400);
    await expectStatus(store.createUser('alice', 'short'), 400);
  });

  test('setAdmin and setPassword change an existing user; removeUser drops them', async () => {
    await store.createUser('alice', 'correct horse');
    await store.createUser('other-admin', 'correct horse battery', { admin: true });
    store.setAdmin('alice', true);
    expect(store.listUsers().find((u) => u.name === 'alice').admin).toBe(true);
    await store.setPassword('alice', 'new correct horse');
    await expectStatus(store.login({ name: 'alice', password: 'correct horse', ip: '1.1.1.1' }), 401);
    const result = await store.login({ name: 'alice', password: 'new correct horse', ip: '1.1.1.1' });
    expect(result.user.name).toBe('alice');
    store.removeUser('alice');
    expect(store.listUsers().map((u) => u.name)).toEqual(['other-admin']);
  });

  test('setAdmin/setPassword/removeUser 404 on an unknown name', async () => {
    expect(() => store.setAdmin('ghost', true)).toThrow(expect.objectContaining({ status: 404 }));
    await expectStatus(store.setPassword('ghost', 'correct horse'), 404);
    expect(() => store.removeUser('ghost')).toThrow(expect.objectContaining({ status: 404 }));
  });

  test('setPassword revokes every existing session of theirs (IPB-AUTH-004)', async () => {
    await store.createUser('alice', 'correct horse battery');
    const { token } = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    expect(store.resolveSession(token)).not.toBeNull();
    await store.setPassword('alice', 'a brand new password');
    expect(store.resolveSession(token)).toBeNull();
  });

  test('removeUser cascades: sessions and any membership are gone with it', async () => {
    await store.createUser('alice', 'correct horse battery');
    store.setMembership('alice', { cell: 'blue', role: 'analyst' });
    const { token } = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    store.removeUser('alice');
    expect(store.resolveSession(token)).toBeNull();
    expect(store.listMembers()).toEqual([]);
  });
});

describe('membership (C2/C6)', () => {
  beforeEach(async () => {
    await store.createUser('alice', 'correct horse battery');
  });

  test('setMembership assigns a cell and role; listMembers reports it', () => {
    store.setMembership('alice', { cell: 'blue', role: 'analyst' });
    expect(store.listMembers()).toEqual([
      { name: 'alice', admin: false, cell: 'blue', role: 'analyst' },
    ]);
  });

  test('setMembership on an existing membership replaces it, not adds a second row', () => {
    store.setMembership('alice', { cell: 'blue', role: 'observer' });
    store.setMembership('alice', { cell: 'red', role: 'game-master' });
    expect(store.listMembers()).toEqual([
      { name: 'alice', admin: false, cell: 'red', role: 'game-master' },
    ]);
  });

  test('setMembership rejects an unknown cell or role', () => {
    expect(() => store.setMembership('alice', { cell: 'purple', role: 'analyst' })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => store.setMembership('alice', { cell: 'blue', role: 'commander' })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  test('setMembership rejects a membership role of "admin": that is the separate global flag', () => {
    expect(() => store.setMembership('alice', { cell: 'blue', role: 'admin' })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  test('setMembership/removeMembership 404 on an unknown user', () => {
    expect(() => store.setMembership('ghost', { cell: 'blue', role: 'analyst' })).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => store.removeMembership('ghost')).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  test('removeMembership is idempotent for a user with no membership', () => {
    expect(() => store.removeMembership('alice')).not.toThrow();
  });

  test('removeMembership clears it; listMembers still lists the user with null cell/role', () => {
    store.setMembership('alice', { cell: 'blue', role: 'analyst' });
    store.removeMembership('alice');
    expect(store.listMembers()).toEqual([{ name: 'alice', admin: false, cell: null, role: null }]);
  });

  test('clearMemberships empties the roster without touching the users', () => {
    store.setMembership('alice', { cell: 'blue', role: 'analyst' });
    store.clearMemberships();
    expect(store.listMembers()).toEqual([{ name: 'alice', admin: false, cell: null, role: null }]);
    expect(store.hasUsers()).toBe(true);
  });
});

describe('the current exercise record (C6)', () => {
  test('getExercise starts with a default name, now-ish started_at, and zero members', () => {
    const exercise = store.getExercise();
    expect(exercise.name).toEqual(expect.any(String));
    expect(exercise.name.length).toBeGreaterThan(0);
    expect(exercise.started_at).toEqual(expect.any(String));
    expect(exercise.members).toBe(0);
  });

  test('getExercise.members counts current memberships', async () => {
    await store.createUser('alice', 'correct horse battery');
    store.setMembership('alice', { cell: 'blue', role: 'analyst' });
    expect(store.getExercise().members).toBe(1);
  });

  test('setExerciseName renames it without touching started_at', () => {
    const before = store.getExercise();
    store.setExerciseName('Exercise Bold Falcon');
    const after = store.getExercise();
    expect(after.name).toBe('Exercise Bold Falcon');
    expect(after.started_at).toBe(before.started_at);
  });

  test('setExerciseName rejects an empty or oversized name', () => {
    expect(() => store.setExerciseName('')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => store.setExerciseName('   ')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => store.setExerciseName('x'.repeat(200))).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  test('resetExercise renames and restarts the clock', () => {
    vi.useFakeTimers();
    const before = store.getExercise();
    vi.advanceTimersByTime(60000);
    store.resetExercise('Exercise 2');
    const after = store.getExercise();
    expect(after.name).toBe('Exercise 2');
    expect(after.started_at).not.toBe(before.started_at);
  });
});

describe('login', () => {
  beforeEach(async () => {
    await store.createUser('alice', 'correct horse battery');
  });

  test('a correct password returns a token and the C1-shaped user', async () => {
    const result = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    expect(result.token).toEqual(expect.any(String));
    expect(result.user).toEqual({
      name: 'alice',
      admin: false,
      cell: null,
      role: null,
      must_change_password: false,
    });
  });

  test('a member logs in with their cell and role, no "effective" flag', async () => {
    store.setMembership('alice', { cell: 'red', role: 'collection-manager' });
    const result = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    expect(result.user).toEqual({
      name: 'alice',
      admin: false,
      cell: 'red',
      role: 'collection-manager',
      must_change_password: false,
    });
  });

  test('an admin with no membership logs in as white/game-master, marked effective', async () => {
    store.setAdmin('alice', true);
    const result = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    expect(result.user).toEqual({
      name: 'alice',
      admin: true,
      cell: 'white',
      role: 'game-master',
      must_change_password: false,
      effective: true,
    });
  });

  test('an admin with a real membership uses it, not the effective default', async () => {
    store.setAdmin('alice', true);
    store.setMembership('alice', { cell: 'blue', role: 'observer' });
    const result = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    expect(result.user).toEqual({
      name: 'alice',
      admin: true,
      cell: 'blue',
      role: 'observer',
      must_change_password: false,
    });
  });

  test('a wrong password, or an unknown name, is rejected the same way', async () => {
    await expectStatus(store.login({ name: 'alice', password: 'wrong', ip: '1.1.1.1' }), 401);
    await expectStatus(store.login({ name: 'ghost', password: 'whatever', ip: '1.1.1.1' }), 401);
  });

  test('an unknown name still costs a real password hash (IPB-AUTH-008 timing oracle closed)', async () => {
    // A short-circuit (no user found → skip verifyPassword) returns in well
    // under a millisecond; scrypt at this store's cost parameter takes tens
    // of milliseconds. This is a floor, not a comparison between two runs
    // (which would be flaky) — proof the dummy-hash path actually hashes.
    const start = performance.now();
    await expectStatus(store.login({ name: 'nosuchuser', password: 'whatever1', ip: '1.1.1.1' }), 401);
    expect(performance.now() - start).toBeGreaterThan(5);
  });

  test('rejects a syntactically invalid name or an oversized/non-string password before checking credentials', async () => {
    await expectStatus(store.login({ name: 'a l!ce', password: 'whatever1', ip: '1.1.1.1' }), 400);
    await expectStatus(store.login({ name: 'alice', password: 'x'.repeat(2000), ip: '1.1.1.1' }), 400);
    await expectStatus(store.login({ name: 'alice', password: 123, ip: '1.1.1.1' }), 400);
    await expectStatus(store.login({ name: 'alice', password: '', ip: '1.1.1.1' }), 400);
  });

  test('validation rejections never touch the rate-limit maps (IPB-AUTH-002)', async () => {
    for (let i = 0; i < 50; i += 1) {
      await expectStatus(
        store.login({ name: `bad name ${i}!`, password: 'x'.repeat(2000), ip: `10.0.0.${i}` }),
        400,
      );
    }
    expect(store.rateLimitMapSizes()).toEqual({ ip: 0, name: 0 });
  });

  test('rate-limits repeated failures from the same address for the same name', async () => {
    for (let i = 0; i < 10; i += 1) {
      await expectStatus(store.login({ name: 'alice', password: 'wrong', ip: '9.9.9.9' }), 401);
    }
    // The 11th attempt, even with the correct password, is throttled.
    await expectStatus(
      store.login({ name: 'alice', password: 'correct horse battery', ip: '9.9.9.9' }),
      429,
    );
    // A different address is unaffected.
    const result = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '8.8.8.8',
    });
    expect(result.user.name).toBe('alice');
  });

  test('a successful login clears prior failures for that address + name', async () => {
    for (let i = 0; i < 5; i += 1) {
      await expectStatus(store.login({ name: 'alice', password: 'wrong', ip: '9.9.9.9' }), 401);
    }
    await store.login({ name: 'alice', password: 'correct horse battery', ip: '9.9.9.9' });
    for (let i = 0; i < 9; i += 1) {
      await expectStatus(store.login({ name: 'alice', password: 'wrong', ip: '9.9.9.9' }), 401);
    }
    // Only 9 failures since the reset: the 10th still isn't rate-limited.
    await expectStatus(store.login({ name: 'alice', password: 'wrong', ip: '9.9.9.9' }), 401);
  });

  test('a per-account limit catches failures spread across many distinct addresses (IPB-AUTH-003)', async () => {
    // 20 failures from 20 different IPv4 addresses: each address alone is
    // far under its own 10-failure budget, but the account-wide budget
    // (independent of address) is exhausted.
    for (let i = 0; i < 20; i += 1) {
      await expectStatus(store.login({ name: 'alice', password: 'wrong', ip: `203.0.113.${i}` }), 401);
    }
    await expectStatus(
      store.login({ name: 'alice', password: 'correct horse battery', ip: '203.0.113.99' }),
      429,
    );
  });

  test('IPv6 addresses in the same /64 share one rate-limit bucket', async () => {
    // fe80::1 and fe80::2 are both fe80:0:0:0::/64 — 5 failures each should
    // exhaust the *shared* 10-failure budget for that block.
    for (let i = 0; i < 5; i += 1) {
      await expectStatus(store.login({ name: 'alice', password: 'wrong', ip: 'fe80::1' }), 401);
      await expectStatus(store.login({ name: 'alice', password: 'wrong', ip: 'fe80::2' }), 401);
    }
    // A third address in the same /64: blocked, despite never having failed itself.
    await expectStatus(
      store.login({ name: 'alice', password: 'correct horse battery', ip: 'fe80::3' }),
      429,
    );
    // A clearly different /64 is its own bucket.
    const result = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '2001:db8::1',
    });
    expect(result.user.name).toBe('alice');
  });
});

describe('sessions', () => {
  beforeEach(async () => {
    await store.createUser('alice', 'correct horse battery');
  });

  test('resolveSession returns the C1-shaped user for a live token, null for none', async () => {
    expect(store.resolveSession(null)).toBeNull();
    expect(store.resolveSession('bogus-token')).toBeNull();
    const { token } = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    expect(store.resolveSession(token)).toEqual({
      name: 'alice',
      admin: false,
      cell: null,
      role: null,
      must_change_password: false,
    });
  });

  test('expires after the sliding TTL and is gone even from a fresh resolve', async () => {
    vi.useFakeTimers();
    const { token } = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    vi.advanceTimersByTime(SESSION_TTL_MS + 1000);
    expect(store.resolveSession(token)).toBeNull();
    // The expired row was cleaned up, not just hidden.
    expect(store.resolveSession(token)).toBeNull();
  });

  test('sliding expiry: resolving before the TTL pushes it back out', async () => {
    vi.useFakeTimers();
    const { token } = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    vi.advanceTimersByTime(SESSION_TTL_MS - 1000);
    expect(store.resolveSession(token)).not.toBeNull(); // still valid, and slides expiry forward
    vi.advanceTimersByTime(SESSION_TTL_MS - 1000);
    // Without sliding this would be well past the original TTL and expired.
    expect(store.resolveSession(token)).not.toBeNull();
  });

  test('an absolute cap ends the session even while continuously sliding it (IPB-AUTH-004)', async () => {
    vi.useFakeTimers();
    const { token } = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    // Every gap here is well under the 12h sliding TTL on its own, so
    // sliding alone would keep this session alive forever; only the
    // absolute cap can end it.
    const step = 11 * 60 * 60 * 1000;
    let elapsed = 0;
    while (elapsed + step < SESSION_ABSOLUTE_TTL_MS) {
      vi.advanceTimersByTime(step);
      elapsed += step;
      expect(store.resolveSession(token)).not.toBeNull();
    }
    // One more small (sliding-TTL-safe) step pushes the *absolute* age past the cap.
    vi.advanceTimersByTime(step);
    expect(store.resolveSession(token)).toBeNull();
  });

  test('logout invalidates the token', async () => {
    const { token } = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    store.logout(token);
    expect(store.resolveSession(token)).toBeNull();
  });

  test('removeUser revokes every session of theirs', async () => {
    const { token } = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    store.removeUser('alice');
    expect(store.resolveSession(token)).toBeNull();
  });
});

describe('audit', () => {
  test('records rows in reverse-chronological order and paginates', () => {
    for (let i = 0; i < 3; i += 1) {
      store.audit({
        user: 'alice',
        method: 'POST',
        path: `/api/orbat/orbats/${i}`,
        status: 201,
        client: 'c1',
      });
    }
    const { items, total } = store.listAudit({ limit: 2, offset: 0 });
    expect(total).toBe(3);
    expect(items).toHaveLength(2);
    expect(items[0].path).toBe('/api/orbat/orbats/2');
    expect(items[1].path).toBe('/api/orbat/orbats/1');
    const { items: page2 } = store.listAudit({ limit: 2, offset: 2 });
    expect(page2).toHaveLength(1);
    expect(page2[0].path).toBe('/api/orbat/orbats/0');
  });
});

describe('user management (admin flag)', () => {
  test('createUser can flag must_change_password; login and resolveSession report it', async () => {
    await store.createUser('alice', 'correct horse battery', { mustChangePassword: true });
    const { token, user } = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    expect(user.must_change_password).toBe(true);
    expect(store.resolveSession(token).must_change_password).toBe(true);
  });

  test('listUsersDetailed reports admin, membership, disabled, must_change_password and session_count', async () => {
    await store.createUser('alice', 'correct horse battery', { admin: true });
    store.setMembership('alice', { cell: 'red', role: 'game-master' });
    const { token } = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    const [row] = store.listUsersDetailed();
    expect(row).toMatchObject({
      name: 'alice',
      admin: true,
      cell: 'red',
      role: 'game-master',
      disabled: false,
      must_change_password: false,
      session_count: 1,
    });
    expect(row.last_login_at).toEqual(expect.any(String));
    store.logout(token);
  });

  test('a disabled user cannot log in, even with the right password', async () => {
    await store.createUser('alice', 'correct horse battery');
    store.setDisabled('alice', true);
    await expectStatus(
      store.login({ name: 'alice', password: 'correct horse battery', ip: '1.1.1.1' }),
      401,
    );
  });

  test('disabling a user revokes every session of theirs immediately', async () => {
    await store.createUser('alice', 'correct horse battery');
    const { token } = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    expect(store.resolveSession(token)).not.toBeNull();
    store.setDisabled('alice', true);
    expect(store.resolveSession(token)).toBeNull();
  });

  test('re-enabling a disabled user lets them log in again', async () => {
    await store.createUser('alice', 'correct horse battery');
    store.setDisabled('alice', true);
    store.setDisabled('alice', false);
    const result = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    expect(result.user.name).toBe('alice');
  });

  test('resetPassword changes the password, revokes sessions and forces a change', async () => {
    await store.createUser('alice', 'correct horse battery');
    const { token } = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    await store.resetPassword('alice', 'a new admin-chosen password');
    expect(store.resolveSession(token)).toBeNull();
    const result = await store.login({
      name: 'alice',
      password: 'a new admin-chosen password',
      ip: '1.1.1.1',
    });
    expect(result.user.must_change_password).toBe(true);
  });

  test('changePassword verifies the current password and keeps the calling session alive', async () => {
    await store.createUser('alice', 'correct horse battery');
    const { token: keep } = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    const { token: other } = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '2.2.2.2',
    });
    await expectStatus(
      store.changePassword('alice', 'wrong current', 'brand new password here', keep),
      401,
    );
    await store.changePassword('alice', 'correct horse battery', 'brand new password here', keep);
    expect(store.resolveSession(keep)).not.toBeNull();
    expect(store.resolveSession(keep).must_change_password).toBe(false);
    expect(store.resolveSession(other)).toBeNull();
    await expectStatus(
      store.login({ name: 'alice', password: 'correct horse battery', ip: '1.1.1.1' }),
      401,
    );
  });

  test('revokeSessions ends every session of a user without touching their password', async () => {
    await store.createUser('alice', 'correct horse battery');
    const { token } = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    store.revokeSessions('alice');
    expect(store.resolveSession(token)).toBeNull();
    const result = await store.login({
      name: 'alice',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    expect(result.user.name).toBe('alice');
  });

  test('the last enabled admin cannot be demoted, disabled or deleted', async () => {
    await store.createUser('root', 'correct horse battery', { admin: true });
    expect(() => store.setAdmin('root', false)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(() => store.setDisabled('root', true)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(() => store.removeUser('root')).toThrow(expect.objectContaining({ status: 409 }));
  });

  test('a second enabled admin makes the guard release', async () => {
    await store.createUser('root', 'correct horse battery', { admin: true });
    await store.createUser('root2', 'another admin password', { admin: true });
    // With two enabled admins, demoting/disabling/deleting one is fine.
    expect(() => store.setAdmin('root', false)).not.toThrow();
  });
});

test('two independent stores against the same file do not clobber each other', async () => {
  const second = openAuthStore(file);
  await store.createUser('alice', 'correct horse battery');
  expect(second.hasUsers()).toBe(true);
  expect(second.listUsers()[0].name).toBe('alice');
  second.close();
});

describe('legacy migration: role column -> admin flag + memberships (C1)', () => {
  /** Builds a database shaped exactly like the pre-Phase-1 schema (the
   * first two migrations only: a `role` column, no `admin`, no
   * `memberships`, no `exercise`), the way a real deployed `auth.db`
   * predating this change looks on disk. */
  function seedLegacyDatabase(legacyFile) {
    const db = new DatabaseSync(legacyFile);
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        user TEXT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status INTEGER NOT NULL,
        client TEXT
      );
      ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN last_login_at TEXT;
      PRAGMA user_version = 2;
    `);
    const insert = db.prepare(
      'INSERT INTO users (name, password, role, created_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('root', 'irrelevant-hash', 'admin', '2024-01-01T00:00:00.000Z');
    insert.run('gm', 'irrelevant-hash', 'game-master', '2024-01-01T00:00:00.000Z');
    insert.run('obs', 'irrelevant-hash', 'observer', '2024-01-01T00:00:00.000Z');
    insert.run('cm', 'irrelevant-hash', 'collection-manager', '2024-01-01T00:00:00.000Z');
    db.close();
  }

  test('an admin migrates to admin=true with no membership; other roles get a membership', () => {
    const legacyFile = tempFile();
    seedLegacyDatabase(legacyFile);
    const migrated = openAuthStore(legacyFile);
    try {
      const members = Object.fromEntries(migrated.listMembers().map((m) => [m.name, m]));
      expect(members.root).toEqual({ name: 'root', admin: true, cell: null, role: null });
      // game-master migrates into the white cell; every other role into blue.
      expect(members.gm).toEqual({ name: 'gm', admin: false, cell: 'white', role: 'game-master' });
      expect(members.obs).toEqual({ name: 'obs', admin: false, cell: 'blue', role: 'observer' });
      expect(members.cm).toEqual({
        name: 'cm',
        admin: false,
        cell: 'blue',
        role: 'collection-manager',
      });
    } finally {
      migrated.close();
      removeDatabaseFiles(legacyFile);
    }
  });

  test('every migrated user keeps a working account: same password, new C1-shaped session', async () => {
    const legacyFile = tempFile();
    seedLegacyDatabase(legacyFile);
    // Real passwords, hashed the same way the store would.
    const seed = openAuthStore(legacyFile);
    await seed.setPassword('obs', 'observer password 123');
    seed.close();

    const migrated = openAuthStore(legacyFile);
    try {
      const result = await migrated.login({
        name: 'obs',
        password: 'observer password 123',
        ip: '1.1.1.1',
      });
      expect(result.user).toEqual({
        name: 'obs',
        admin: false,
        cell: 'blue',
        role: 'observer',
        must_change_password: false,
      });
    } finally {
      migrated.close();
      removeDatabaseFiles(legacyFile);
    }
  });

  test('the migrated database has a default current-exercise record', () => {
    const legacyFile = tempFile();
    seedLegacyDatabase(legacyFile);
    const migrated = openAuthStore(legacyFile);
    try {
      const exercise = migrated.getExercise();
      expect(exercise.name).toEqual(expect.any(String));
      expect(exercise.members).toBe(3); // gm, obs, cm — root (admin) got none
    } finally {
      migrated.close();
      removeDatabaseFiles(legacyFile);
    }
  });
});
