import crypto from 'node:crypto';
import { promisify } from 'node:util';

import authState from './authState.js';
import { HttpError } from './http.js';
import { CELLS, ROLES } from './policy.js';
import { openState, transact } from './state.js';

/** A session cookie is valid for this long since it was last used (sliding). */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** ...but never longer than this since it was created, sliding or not: a
 * stolen cookie that stays in continuous use (IPB-AUTH-004) still expires. */
export const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
/** Failures for one (address-group, name) pair. */
const IP_NAME_MAX_ATTEMPTS = 10;
/** Failures for one account, regardless of source address — a LAN attacker
 * rotating IPv6 addresses (IPB-AUTH-003) still hits this. Wider than the
 * per-address budget because it is shared by every legitimate source too. */
const NAME_MAX_ATTEMPTS = 20;
/** Bounds the rate-limit maps' memory regardless of how many distinct
 * (address, name) pairs are attempted (IPB-AUTH-002). */
const ATTEMPTS_MAP_CAP = 5000;
const SCRYPT_KEYLEN = 64;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const LOGIN_PASSWORD_MAX_LENGTH = 1024;
const EXERCISE_NAME_MAX_LENGTH = 80;
const DEFAULT_EXERCISE_NAME = 'Exercise 1';
/** A membership's role is one of the four exercise roles — never `admin`,
 * which is the separate global flag on `users` (C2/C1). */
const MEMBERSHIP_ROLES = ROLES.filter((role) => role !== 'admin');

const scrypt = promisify(crypto.scrypt);

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Only the session token's hash is stored: a stolen database row can't be
  -- replayed as a cookie, the way a stolen bcrypt-style hash still resists a
  -- stolen password. Sliding expiry means \`expires_at\` moves forward on
  -- every \`resolveSession\`, not just at login; \`created_at\` backs the
  -- absolute cap that sliding expiry alone doesn't give you.
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
  CREATE INDEX audit_at ON audit(id DESC);
  `,
  // Appended for user management (C3, admin role): `disabled` blocks login
  // and is checked nowhere else — an already-open session is deleted the
  // moment an admin disables its owner, so there is nothing left to check.
  // `must_change_password` is set by the first-admin bootstrap and by an
  // admin's reset-password, and cleared by the user's own password change.
  `
  ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN last_login_at TEXT;
  `,
  // Phase 1 (docs/phase1-access.md, C1): `admin` becomes a global flag,
  // independent of any per-exercise role — `role = 'admin'` migrates to
  // `admin = 1`. `memberships` is the current exercise's roster: every
  // other existing user gets a membership carrying their old role, in the
  // white cell if that role was game-master, blue otherwise (a reasonable
  // guess an admin can reassign; nothing leaks, since every existing
  // ipb/exercise/orbat row also migrates to `owner_cell = 'white'`). An
  // existing admin gets no membership — they act as White by the `admin`
  // flag alone until given one.
  {
    run(database) {
      database.exec('ALTER TABLE users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0');
      database.exec("UPDATE users SET admin = 1 WHERE role = 'admin'");
      database.exec(`
        CREATE TABLE memberships (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          cell TEXT NOT NULL,
          role TEXT NOT NULL
        );
      `);
      const nonAdmins = database.prepare("SELECT id, role FROM users WHERE role != 'admin'").all();
      const insertMembership = database.prepare(
        'INSERT INTO memberships (user_id, cell, role) VALUES (?, ?, ?)',
      );
      for (const row of nonAdmins) {
        insertMembership.run(row.id, row.role === 'game-master' ? 'white' : 'blue', row.role);
      }
    },
  },
  // `role` is fully replaced by `admin` + `memberships.role` above: a clean
  // cutover, not a second source of truth left dangling. SQLite's rebuild
  // procedure (server/state.js) preserves every id, so `sessions.user_id`
  // and the new `memberships.user_id` both survive untouched.
  {
    rebuild: true,
    sql: `
      CREATE TABLE new_users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        created_at TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        last_login_at TEXT,
        admin INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO new_users (id, name, password, created_at, disabled, must_change_password, last_login_at, admin)
        SELECT id, name, password, created_at, disabled, must_change_password, last_login_at, admin FROM users;
      DROP TABLE users;
      ALTER TABLE new_users RENAME TO users;
    `,
  },
  // The current exercise (C6): one row, its name and when it (or its most
  // recent reset) started. Lives here, not in a module's own database,
  // because it's read and mutated alongside `memberships` — both cleared
  // or repopulated together by an exercise reset/restore.
  {
    run(database) {
      database.exec(`
        CREATE TABLE exercise (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          name TEXT NOT NULL,
          started_at TEXT NOT NULL
        );
      `);
      database
        .prepare('INSERT INTO exercise (id, name, started_at) VALUES (1, ?, ?)')
        .run(DEFAULT_EXERCISE_NAME, now());
    },
  },
];

function now() {
  return new Date().toISOString();
}

/** Runs on the libuv threadpool, not the event loop — synchronous scrypt
 * under login traffic would otherwise stall every other request and every
 * open SSE stream (IPB-AUTH-003). */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Computed once, at module load, from a password nothing will ever match:
// login() always verifies against a real user's hash *or* this one, so a
// request for an unknown name costs the same scrypt call as one for a real
// account instead of returning instantly (IPB-AUTH-008, a timing oracle for
// which usernames exist).
const DUMMY_HASH = await hashPassword('this-password-matches-no-account');

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function requireName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new HttpError(
      400,
      'Name must be 1-32 characters: letters, digits, dot, underscore or hyphen, not starting with one.',
    );
  }
}

const PASSWORD_MIN_LENGTH = 12;

function requirePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new HttpError(400, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
}

/** Looser than `requirePassword`: login only bounds type and length, so a
 * multi-megabyte body can't be used to pin memory (IPB-AUTH-002) or burn
 * scrypt cycles, without rejecting a real (if short) existing password. */
function requireLoginPassword(password) {
  if (typeof password !== 'string' || !password || password.length > LOGIN_PASSWORD_MAX_LENGTH) {
    throw new HttpError(400, 'Password is required.');
  }
}

function requireCell(cell) {
  if (!CELLS.includes(cell)) {
    throw new HttpError(400, `Cell must be one of: ${CELLS.join(', ')}.`);
  }
}

function requireMembershipRole(role) {
  if (!MEMBERSHIP_ROLES.includes(role)) {
    throw new HttpError(400, `Role must be one of: ${MEMBERSHIP_ROLES.join(', ')}.`);
  }
}

function requireExerciseName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > EXERCISE_NAME_MAX_LENGTH) {
    throw new HttpError(400, `Exercise name must be 1-${EXERCISE_NAME_MAX_LENGTH} characters.`);
  }
}

/** IPv4-mapped IPv6 (`::ffff:10.0.0.5`, common on a dual-stack `::` bind) as
 * its plain IPv4 form; a real IPv6 address expanded to its 8 hextets. `null`
 * for anything that isn't a syntactically plausible IPv6 address. */
function expandIPv6(address) {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill('0'), ...tail];
}

/**
 * A rate-limit bucket for `ip`: an IPv4 address (or an IPv4-mapped IPv6 one)
 * as-is, or an IPv6 address collapsed to its /64 — the block size a single
 * LAN client is typically handed (SLAAC), so rotating addresses within it
 * (IPB-AUTH-003) no longer resets the budget.
 */
function ipGroup(ip) {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const groups = expandIPv6(ip.split('%')[0]); // strip a zone id, e.g. %eth0
  return groups ? groups.slice(0, 4).join(':') : ip;
}

/**
 * Opens (creating on first use) the auth database at `file` and returns an
 * independent store — unlike a module's `openStore(file)` (see
 * `modules/orbat/server/store.js`), which keeps its `database` handle at
 * module scope for a single shared instance, this one is per-call: the CLI,
 * the long-lived server and a test's seed setup can all hold their own
 * connection to the same file (SQLite's WAL mode makes that safe) without
 * one's `close()` pulling the handle out from under another.
 */
export function openAuthStore(file = authState.path) {
  let database = openState(file, MIGRATIONS);
  // Login attempts live in memory, not the database: a rate limit resetting
  // on a dev-server restart is an acceptable trade for not persisting an
  // attacker's IP forever, and it keeps `openAuthStore` synchronous and
  // side-effect-free on disk beyond the schema itself. Two maps: one keyed
  // by address-group + name, one by name alone (IPB-AUTH-003).
  const ipAttempts = new Map();
  const nameAttempts = new Map();

  function rateLimitKey(ip, name) {
    return `${ipGroup(ip)}::${name}`;
  }

  /** Counts `key`'s hits inside the window, without writing anything —
   * `checkRateLimit` must stay read-only so a flood of never-valid names
   * can't each pin a Map entry before validation even rejects them
   * (IPB-AUTH-002); only `recordFailure` (after a real failed attempt)
   * writes. */
  function recentHitCount(map, key) {
    const hits = map.get(key);
    if (!hits) return 0;
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    return hits.filter((at) => at > cutoff).length;
  }

  function checkRateLimit(ipKey, nameKey) {
    if (recentHitCount(ipAttempts, ipKey) >= IP_NAME_MAX_ATTEMPTS) {
      throw new HttpError(429, 'Too many login attempts. Wait a few minutes and try again.');
    }
    if (recentHitCount(nameAttempts, nameKey) >= NAME_MAX_ATTEMPTS) {
      throw new HttpError(
        429,
        'Too many login attempts for this account. Wait a few minutes and try again.',
      );
    }
  }

  /** Drops entries once the map is over its cap, oldest insertion first
   * (`Map` preserves insertion order) — a full map already means traffic
   * beyond what this limiter can usefully track, so losing precision there
   * is an acceptable trade for bounded memory (IPB-AUTH-002). */
  function capAttempts(map) {
    if (map.size <= ATTEMPTS_MAP_CAP) return;
    let excess = map.size - ATTEMPTS_MAP_CAP;
    for (const key of map.keys()) {
      if (excess <= 0) break;
      map.delete(key);
      excess -= 1;
    }
  }

  function recordOneFailure(map, key) {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    const hits = (map.get(key) || []).filter((at) => at > cutoff);
    hits.push(Date.now());
    map.set(key, hits);
    capAttempts(map);
  }

  function recordFailure(ipKey, nameKey) {
    recordOneFailure(ipAttempts, ipKey);
    recordOneFailure(nameAttempts, nameKey);
  }

  function findUser(name) {
    return database.prepare('SELECT * FROM users WHERE name = ?').get(name) ?? null;
  }

  function deleteUserSessions(userId) {
    database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  /** Enabled admins right now — the floor `setAdmin`/`setDisabled`/`removeUser`
   * refuse to cross for the last one, so a classroom can never lock itself
   * out of user management entirely. */
  function countEnabledAdmins() {
    return database
      .prepare('SELECT COUNT(*) AS n FROM users WHERE admin = 1 AND disabled = 0')
      .get().n;
  }

  /** Throws if demoting/disabling/deleting `user` would leave zero enabled
   * admins. Only meaningful for a user who currently *is* one. */
  function guardLastAdmin(user, verb) {
    if (!user.admin || user.disabled) return;
    if (countEnabledAdmins() <= 1) {
      throw new HttpError(409, `Cannot ${verb} the last enabled admin.`);
    }
  }

  /** `request.user`'s shape (C1): `{ name, admin, cell, role,
   * must_change_password }`, from a row joining `users` with its (possibly
   * absent) `memberships` row. An admin with no membership acts as White's
   * game-master, `effective: true` marking that this isn't a real
   * membership. */
  function shapeUser(row) {
    const admin = Boolean(row.admin);
    let cell = row.cell ?? null;
    let role = row.role ?? null;
    let effective;
    if (admin && !row.cell) {
      cell = 'white';
      role = 'game-master';
      effective = true;
    }
    const shaped = {
      name: row.name,
      admin,
      cell,
      role,
      must_change_password: Boolean(row.must_change_password),
    };
    if (effective) shaped.effective = true;
    return shaped;
  }

  const USER_MEMBERSHIP_JOIN = `
    SELECT users.id AS id, users.name AS name, users.admin AS admin,
           users.must_change_password AS must_change_password,
           memberships.cell AS cell, memberships.role AS role
      FROM users LEFT JOIN memberships ON memberships.user_id = users.id
  `;

  return {
    hasUsers() {
      return database.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
    },

    listUsers() {
      return database
        .prepare('SELECT name, admin, created_at FROM users ORDER BY name')
        .all()
        .map((row) => ({ name: row.name, admin: Boolean(row.admin), created_at: row.created_at }));
    },

    /** Everything the admin UI's users table shows, including a live count
     * of open sessions (not persisted, computed on read) and the user's
     * current-exercise membership (`cell`/`role`, both `null` if none). */
    listUsersDetailed() {
      return database
        .prepare(
          `SELECT users.name, users.admin, users.created_at, users.last_login_at,
                  users.disabled, users.must_change_password,
                  memberships.cell AS cell, memberships.role AS role,
                  (SELECT COUNT(*) FROM sessions WHERE sessions.user_id = users.id) AS session_count
             FROM users LEFT JOIN memberships ON memberships.user_id = users.id
            ORDER BY users.name`,
        )
        .all()
        .map((row) => ({
          name: row.name,
          admin: Boolean(row.admin),
          cell: row.cell ?? null,
          role: row.role ?? null,
          created_at: row.created_at,
          last_login_at: row.last_login_at,
          disabled: Boolean(row.disabled),
          must_change_password: Boolean(row.must_change_password),
          session_count: row.session_count,
        }));
    },

    /** `mustChangePassword` is set wherever someone else chose the password:
     * the first-admin bootstrap, an admin creating a user in the UI, and
     * `resetPassword`. Only the host CLI (an operator setting up their own
     * account) leaves it unset. */
    async createUser(name, password, { admin = false, mustChangePassword = false } = {}) {
      requireName(name);
      requirePassword(password);
      if (findUser(name)) throw new HttpError(409, `A user named "${name}" already exists.`);
      const hash = await hashPassword(password);
      database
        .prepare(
          `INSERT INTO users (name, password, created_at, must_change_password, admin)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(name, hash, now(), mustChangePassword ? 1 : 0, admin ? 1 : 0);
    },

    /** Also revokes every existing session of theirs (IPB-AUTH-004): a
     * password change is usually a response to a suspected compromise, and
     * leaving old sessions valid would defeat the point of changing it. */
    async setPassword(name, password) {
      requirePassword(password);
      const user = findUser(name);
      if (!user) throw new HttpError(404, `No user named "${name}".`);
      const hash = await hashPassword(password);
      transact(database, () => {
        database.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, user.id);
        deleteUserSessions(user.id);
      });
    },

    /** An admin resetting someone else's password: like `setPassword`, but
     * also flags the account so the next sign-in forces a change before
     * anything else — the admin, not the user, chose this password. */
    async resetPassword(name, password) {
      requirePassword(password);
      const user = findUser(name);
      if (!user) throw new HttpError(404, `No user named "${name}".`);
      const hash = await hashPassword(password);
      transact(database, () => {
        database
          .prepare('UPDATE users SET password = ?, must_change_password = 1 WHERE id = ?')
          .run(hash, user.id);
        deleteUserSessions(user.id);
      });
    },

    /** The signed-in user changing their own password: verifies the current
     * one first, then revokes every *other* session of theirs — `keepToken`
     * (their current session) stays valid so they aren't signed out by their
     * own change. */
    async changePassword(name, currentPassword, nextPassword, keepToken) {
      requirePassword(nextPassword);
      const user = findUser(name);
      if (!user) throw new HttpError(404, `No user named "${name}".`);
      const valid = await verifyPassword(currentPassword, user.password);
      if (!valid) throw new HttpError(401, 'Current password is incorrect.');
      const hash = await hashPassword(nextPassword);
      const keepHash = keepToken ? hashToken(keepToken) : null;
      transact(database, () => {
        database
          .prepare('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?')
          .run(hash, user.id);
        if (keepHash) {
          database
            .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
            .run(user.id, keepHash);
        } else {
          deleteUserSessions(user.id);
        }
      });
    },

    /** Sets the global admin flag. Refuses to demote the last enabled admin. */
    setAdmin(name, isAdmin) {
      const user = findUser(name);
      if (!user) throw new HttpError(404, `No user named "${name}".`);
      if (!isAdmin && user.admin) guardLastAdmin(user, 'demote');
      database.prepare('UPDATE users SET admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, user.id);
    },

    /** Disabling blocks login and revokes every session of theirs
     * immediately (the same-process live streams still open are the
     * caller's job — `server/live.js`'s `closeStreamsForUser`, since this
     * store has no reference to them). Re-enabling only flips the flag: it
     * doesn't restore the sessions disabling deleted. */
    setDisabled(name, disabled) {
      const user = findUser(name);
      if (!user) throw new HttpError(404, `No user named "${name}".`);
      if (disabled) guardLastAdmin(user, 'disable');
      transact(database, () => {
        database
          .prepare('UPDATE users SET disabled = ? WHERE id = ?')
          .run(disabled ? 1 : 0, user.id);
        if (disabled) deleteUserSessions(user.id);
      });
    },

    revokeSessions(name) {
      const user = findUser(name);
      if (!user) throw new HttpError(404, `No user named "${name}".`);
      deleteUserSessions(user.id);
    },

    /** Deletes the user and, via `ON DELETE CASCADE`, every session and
     * membership of theirs. */
    removeUser(name) {
      const user = findUser(name);
      if (!user) throw new HttpError(404, `No user named "${name}".`);
      guardLastAdmin(user, 'delete');
      database.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    },

    // -- current-exercise membership (C2/C6): cell + role, cleared on reset --

    /** Assigns or changes `name`'s membership in the current exercise. */
    setMembership(name, { cell, role }) {
      requireCell(cell);
      requireMembershipRole(role);
      const user = findUser(name);
      if (!user) throw new HttpError(404, `No user named "${name}".`);
      database
        .prepare(
          `INSERT INTO memberships (user_id, cell, role) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET cell = excluded.cell, role = excluded.role`,
        )
        .run(user.id, cell, role);
    },

    /** Idempotent: a user with no membership stays that way. */
    removeMembership(name) {
      const user = findUser(name);
      if (!user) throw new HttpError(404, `No user named "${name}".`);
      database.prepare('DELETE FROM memberships WHERE user_id = ?').run(user.id);
    },

    /** Every user with their current-exercise membership (`cell`/`role`,
     * both `null` if none) — the admin UI's Members tab. */
    listMembers() {
      return database
        .prepare(`${USER_MEMBERSHIP_JOIN} ORDER BY users.name`)
        .all()
        .map((row) => ({
          name: row.name,
          admin: Boolean(row.admin),
          cell: row.cell ?? null,
          role: row.role ?? null,
        }));
    },

    /** Clears every membership — an exercise reset's "roster wiped" half. */
    clearMemberships() {
      database.exec('DELETE FROM memberships');
    },

    // -- the current exercise record (C6) --

    getExercise() {
      const row = database.prepare('SELECT name, started_at FROM exercise WHERE id = 1').get();
      const members = database.prepare('SELECT COUNT(*) AS n FROM memberships').get().n;
      return { name: row.name, started_at: row.started_at, members };
    },

    setExerciseName(name) {
      requireExerciseName(name);
      database.prepare('UPDATE exercise SET name = ? WHERE id = 1').run(name.trim());
    },

    /** Renames the exercise and restarts its clock — called once the
     * ipb/exercise/orbat databases and the membership roster have already
     * been emptied, so `started_at` reflects when *this* exercise began. */
    resetExercise(name) {
      requireExerciseName(name);
      database
        .prepare('UPDATE exercise SET name = ?, started_at = ? WHERE id = 1')
        .run(name.trim(), now());
    },

    async login({ name, password, ip }) {
      requireName(name);
      requireLoginPassword(password);
      const ipKey = rateLimitKey(ip, name);
      const nameKey = `name::${name}`;
      checkRateLimit(ipKey, nameKey);
      const user = findUser(name);
      // Always scrypt something, real user or not, so an unknown name
      // doesn't return faster than a known one (IPB-AUTH-008).
      const valid = await verifyPassword(password, user ? user.password : DUMMY_HASH);
      // A disabled account fails the same way as a wrong password (no
      // separate message): telling an attacker "that account exists but is
      // disabled" is its own small leak.
      if (!user || !valid || user.disabled) {
        recordFailure(ipKey, nameKey);
        throw new HttpError(401, 'Invalid name or password.');
      }
      ipAttempts.delete(ipKey);
      nameAttempts.delete(nameKey);
      const token = crypto.randomBytes(32).toString('base64url');
      const created = now();
      const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      transact(database, () => {
        database
          .prepare(
            'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
          )
          .run(hashToken(token), user.id, created, expires);
        database.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(created, user.id);
      });
      const full = database.prepare(`${USER_MEMBERSHIP_JOIN} WHERE users.id = ?`).get(user.id);
      return { token, user: shapeUser(full) };
    },

    logout(token) {
      if (!token) return;
      database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    },

    /** `request.user`'s shape (C1) for a live token, sliding its expiry
     * forward; `null` if missing, expired, or past the absolute cap since
     * it was created (IPB-AUTH-004) regardless of how recently it slid. A
     * disabled user has no rows left to find here — `setDisabled` deletes
     * them synchronously — so there is no separate check for it. */
    resolveSession(token) {
      if (!token) return null;
      const row = database
        .prepare(
          `SELECT sessions.id AS sid, sessions.expires_at AS expires_at,
                  sessions.created_at AS created_at,
                  users.name AS name, users.admin AS admin,
                  users.must_change_password AS must_change_password,
                  memberships.cell AS cell, memberships.role AS role
             FROM sessions
             JOIN users ON users.id = sessions.user_id
             LEFT JOIN memberships ON memberships.user_id = users.id
            WHERE sessions.token_hash = ?`,
        )
        .get(hashToken(token));
      if (!row) return null;
      const expired = new Date(row.expires_at).getTime() <= Date.now();
      const overAge = new Date(row.created_at).getTime() + SESSION_ABSOLUTE_TTL_MS <= Date.now();
      if (expired || overAge) {
        database.prepare('DELETE FROM sessions WHERE id = ?').run(row.sid);
        return null;
      }
      const extended = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      database.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(extended, row.sid);
      return shapeUser(row);
    },

    audit({ user, method, path: requestPath, status, client }) {
      database
        .prepare(
          'INSERT INTO audit (at, user, method, path, status, client) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(now(), user ?? null, method, requestPath, status, client ?? null);
    },

    listAudit({ limit = 50, offset = 0 } = {}) {
      const total = database.prepare('SELECT COUNT(*) AS n FROM audit').get().n;
      const items = database
        .prepare(
          'SELECT at, user, method, path, status, client FROM audit ORDER BY id DESC LIMIT ? OFFSET ?',
        )
        .all(limit, offset);
      return { items, total };
    },

    /** Exposed for tests: the number of distinct rate-limit keys currently
     * tracked, to prove IPB-AUTH-002's cap holds under a flood. */
    rateLimitMapSizes() {
      return { ip: ipAttempts.size, name: nameAttempts.size };
    },

    close() {
      database?.close();
      database = undefined;
    },
  };
}
