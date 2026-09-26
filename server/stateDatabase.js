/**
 * One writable state database: where it lives, whether it belongs to the
 * current exercise, and every file-level operation on it (archive/backup
 * copy, empty, replace), so the exercise lifecycle, backup and restore never
 * touch a module's files themselves. Each module declares its database in a
 * small `server/state.js` that imports nothing else of the module, which is
 * what lets the backup container load the list without any route code.
 *
 * The store that opens the database registers how to drop its connection
 * (`onClose`); `empty` and `replaceFrom` close it first, and the store opens
 * the new file lazily on its next use.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { integrityCheck, vacuumInto } from './dbArchive.js';
import { stateDirectory } from './state.js';

const SIDECARS = ['-wal', '-shm', '-journal'];

export function declareStateDatabase({ id, file, exercise, defaultDir }) {
  const closers = new Set();
  const fullPath = () => path.join(stateDirectory(id, defaultDir), file);

  function close() {
    for (const closer of closers) closer();
  }

  function removeSidecars() {
    for (const suffix of SIDECARS) rmSync(`${fullPath()}${suffix}`, { force: true });
  }

  return Object.freeze({
    id,
    file,
    /** Belongs to the current exercise: archived, emptied and restored with it. */
    exercise,
    get path() {
      return fullPath();
    },
    /** Registers what drops this database's open connection (a store's close and cached handle). */
    onClose(closer) {
      closers.add(closer);
    },
    close,
    exists: () => existsSync(fullPath()),
    /** A `-wal`/`-shm` file exists: a running server has it open (a clean shutdown removes them). */
    looksOpen: () => existsSync(`${fullPath()}-wal`) || existsSync(`${fullPath()}-shm`),
    /** A consistent copy into `dir` (safe against a live writer); its size, or null if there's no database yet. */
    copyInto(dir) {
      if (!existsSync(fullPath())) return null;
      const dest = path.join(dir, file);
      vacuumInto(fullPath(), dest);
      return statSync(dest).size;
    },
    /** Closes it and deletes it; the store reopens an empty one on next use. */
    empty() {
      close();
      rmSync(fullPath(), { force: true });
      removeSidecars();
    },
    /** Replaces it with `source` (a copy made by `copyInto`), which must pass an integrity check first. */
    replaceFrom(source) {
      let check;
      try {
        check = integrityCheck(source);
      } catch (error) {
        check = error.message;
      }
      if (check !== 'ok') throw new Error(`${source} failed its integrity check (${check}).`);
      close();
      removeSidecars();
      mkdirSync(path.dirname(fullPath()), { recursive: true });
      const partial = `${fullPath()}.restoring`;
      copyFileSync(source, partial);
      renameSync(partial, fullPath());
    },
  });
}
