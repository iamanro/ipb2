/**
 * The exercise lifecycle (C6, docs/phase1-access.md): archive, reset and
 * restore the current exercise's ipb/exercise/orbat state, and the
 * current-exercise record itself (name, `/api/auth/members`). `server/api.js`
 * instantiates one of these per middleware and routes `/api/auth/exercise*`
 * and `/api/auth/members*` into it.
 *
 * Archiving copies the three module databases (`VACUUM INTO`, via
 * `server/dbArchive.js` — the same approach `server/tools/backup.mjs` uses
 * for its dated backups) plus a `meta.json` (the exercise's name and its
 * membership roster at archive time) into one dated, slugged folder under
 * `$IPB_STATE_ROOT/archives` (or `modules/archives` alongside the module
 * state directories, when that env var is unset). A reset or restore
 * always archives first, so nothing is ever discarded unrecoverably.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import { vacuumInto } from './dbArchive.js';
import { HttpError } from './http.js';
import { publish } from './live.js';
import { modules } from './modules.js';
import { stateDirectory } from './state.js';

const EXERCISE_NAME_MAX_LENGTH = 80;

/** The exercise's own databases — never `auth` (users/sessions/memberships
 * live alongside, not inside, an exercise: only `clearMemberships`/
 * `setMembership` touch them) and never `equipment`/`terrain` (bookmarks
 * and reference data outlive any one exercise, per the model in
 * docs/phase1-access.md). */
const EXERCISE_DATABASES = [
  {
    id: 'ipb',
    defaultDir: path.join(import.meta.dirname, '..', 'modules', 'ipb', 'state'),
    file: 'ipb.db',
  },
  {
    id: 'exercise',
    defaultDir: path.join(import.meta.dirname, '..', 'modules', 'exercise', 'state'),
    file: 'exercise.db',
  },
  {
    id: 'orbat',
    defaultDir: path.join(import.meta.dirname, '..', 'modules', 'orbat', 'state'),
    file: 'orbat.db',
  },
];

function now() {
  return new Date().toISOString();
}

function dtgStamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function slugify(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'exercise';
}

async function fileExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Yields the event loop for one turn: a reset/restore's several await
 * points (also real file I/O in between) so a long-running one never
 * monopolises it, and so a concurrent request genuinely gets a chance to
 * observe the lock below rather than queueing invisibly behind it. */
function yieldTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function assertExerciseName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > EXERCISE_NAME_MAX_LENGTH) {
    throw new HttpError(400, `Exercise name must be 1-${EXERCISE_NAME_MAX_LENGTH} characters.`);
  }
}

function archiveRoot() {
  const stateRoot = process.env.IPB_STATE_ROOT || path.join(import.meta.dirname, '..', 'modules');
  return path.join(stateRoot, 'archives');
}

function moduleById(id) {
  return modules.find((module) => module.id === id);
}

/** Closes a module's store and deletes its database file (plus any
 * `-wal`/`-shm` siblings still on disk from an open WAL connection); the
 * module reopens lazily, empty, on its next request (every module's own
 * `handle()` does `store ??= openStore(DATABASE)`). */
async function emptyModule(entry) {
  moduleById(entry.id)?.close();
  const dbPath = path.join(stateDirectory(entry.id, entry.defaultDir), entry.file);
  await Promise.all(
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((file) => fsp.rm(file, { force: true })),
  );
}

/**
 * `{ getAuthStore }`: a `server/api.js`-owned accessor for the (lazily
 * opened, middleware-lifetime) auth store — not opened here, so archiving,
 * resetting or restoring shares the exact same connection every other
 * `/api/auth/*` route uses.
 */
export function createExerciseLifecycle({ getAuthStore }) {
  let lockMessage = null;

  /** Truthy (the in-progress message) while a reset or restore is running;
   * `server/api.js`'s `dispatch` 503s every other `/api/*` request while
   * this holds, so nothing reads or writes a module mid-swap. */
  function isLocked() {
    return lockMessage;
  }

  function acquireLock(message) {
    if (lockMessage) throw new HttpError(503, lockMessage);
    lockMessage = message;
  }

  function releaseLock() {
    lockMessage = null;
  }

  async function performArchive({ note = null } = {}) {
    const store = getAuthStore();
    const exercise = store.getExercise();
    const members = store
      .listMembers()
      .filter((member) => member.cell)
      .map((member) => ({ name: member.name, cell: member.cell, role: member.role }));
    const id = `${dtgStamp(new Date())}-${slugify(exercise.name)}`;
    const dir = path.join(archiveRoot(), id);
    await fsp.mkdir(dir, { recursive: true });
    const sizes = {};
    for (const entry of EXERCISE_DATABASES) {
      const source = path.join(stateDirectory(entry.id, entry.defaultDir), entry.file);
      if (!(await fileExists(source))) continue;
      vacuumInto(source, path.join(dir, entry.file));
      sizes[entry.id] = (await fsp.stat(path.join(dir, entry.file))).size;
      await yieldTick();
    }
    const archivedAt = now();
    const meta = { name: exercise.name, archived_at: archivedAt, note, members };
    await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return { id, name: exercise.name, archived_at: archivedAt, note, sizes };
  }

  return {
    isLocked,

    getExercise() {
      return getAuthStore().getExercise();
    },

    setExerciseName(name) {
      getAuthStore().setExerciseName(name);
      return getAuthStore().getExercise();
    },

    /** `VACUUM INTO` is itself safe against a live writer (a brief read
     * lock at the WAL checkpoint, never a long one — see
     * `server/dbArchive.js`), so an on-demand archive never needs the
     * reset/restore lock: it never mutates anything this app reads. */
    async archive({ note } = {}) {
      return performArchive({ note: note ?? null });
    },

    async listArchives() {
      const root = archiveRoot();
      let entries;
      try {
        entries = await fsp.readdir(root, { withFileTypes: true });
      } catch {
        return [];
      }
      const archives = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        let meta;
        try {
          meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
        } catch {
          continue; // a malformed/partial archive folder: skip it, don't fail the whole list
        }
        const sizes = {};
        for (const db of EXERCISE_DATABASES) {
          try {
            sizes[db.id] = (await fsp.stat(path.join(dir, db.file))).size;
          } catch {
            // that module had nothing to archive at the time
          }
        }
        archives.push({
          id: entry.name,
          name: meta.name,
          archived_at: meta.archived_at,
          note: meta.note ?? null,
          sizes,
        });
      }
      // Ids are timestamp-prefixed (`dtgStamp`), so lexical order is
      // chronological — newest first.
      archives.sort((a, b) => (a.id < b.id ? 1 : -1));
      return archives;
    },

    /** Always archives first, then empties the ipb/exercise/orbat
     * databases, clears the membership roster, and renames/restarts the
     * exercise. `confirm` must equal the *current* exercise's name — a
     * typed confirmation, not just a click, before every membership and
     * every study/track/ORBAT in the running exercise is gone. */
    async reset({ name, confirm }) {
      assertExerciseName(name);
      const store = getAuthStore();
      const current = store.getExercise().name;
      if (confirm !== current) {
        throw new HttpError(400, 'Confirmation does not match the current exercise name.');
      }
      acquireLock('Exercise is being reset.');
      try {
        await yieldTick();
        const archived = await performArchive({ note: 'auto: before reset' });
        for (const entry of EXERCISE_DATABASES) {
          await emptyModule(entry);
          await yieldTick();
        }
        store.clearMemberships();
        store.resetExercise(name);
        publish({ module: 'auth', route: 'exercise/reset' });
        return { ...store.getExercise(), archived };
      } finally {
        releaseLock();
      }
    },

    /** Archives the current exercise, then swaps `archive`'s ipb/exercise/
     * orbat files in and reapplies its membership roster — skipping any
     * member whose account no longer exists (or whose archived role/cell
     * somehow no longer validates), so a partly-stale roster never blocks
     * the rest of the restore. */
    async restore({ archive }) {
      // Archive ids are generated directory names (timestamp + slug), never paths.
      if (typeof archive !== 'string' || !/^[A-Za-z0-9][\w.-]*$/.test(archive) || archive.includes('..')) {
        throw new HttpError(400, 'archive must be an archive id from the archives list.');
      }
      // Acquires the lock before the first `await` (matching `reset`), so
      // a caller that starts a restore and immediately checks `isLocked()`
      // always observes it, with no window where the operation has begun
      // but the lock hasn't been set yet.
      acquireLock('Exercise is being restored.');
      try {
        const archiveDir = path.join(archiveRoot(), archive);
        let meta;
        try {
          meta = JSON.parse(await fsp.readFile(path.join(archiveDir, 'meta.json'), 'utf8'));
        } catch {
          throw new HttpError(404, `No archive named "${archive}".`);
        }
        await yieldTick();
        await performArchive({ note: 'auto: before restore' });
        for (const entry of EXERCISE_DATABASES) {
          await emptyModule(entry);
          const archivedFile = path.join(archiveDir, entry.file);
          if (await fileExists(archivedFile)) {
            const dest = path.join(stateDirectory(entry.id, entry.defaultDir), entry.file);
            await fsp.copyFile(archivedFile, dest);
          }
          await yieldTick();
        }
        const store = getAuthStore();
        store.clearMemberships();
        for (const member of meta.members ?? []) {
          try {
            store.setMembership(member.name, { cell: member.cell, role: member.role });
          } catch {
            // The user no longer exists (or the archived cell/role no
            // longer validates): C6 says keep only members who still do.
          }
        }
        store.resetExercise(meta.name);
        publish({ module: 'auth', route: 'exercise/reset' });
        return store.getExercise();
      } finally {
        releaseLock();
      }
    },
  };
}
