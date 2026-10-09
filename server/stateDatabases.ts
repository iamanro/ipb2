/**
 * Every writable state database, for the exercise lifecycle, backup and
 * restore. Only the small `state.js` declarations are imported, never route
 * code, so the backup container can load this with no reference data.
 * `stateDatabases.test.js` fails if a module's `server/state.ts` is missing
 * here, so a new module can't be silently left out of backups.
 */
import authState from './authState.ts';
import equipmentState from '../modules/equipment/server/state.js';
import exerciseState from '../modules/exercise/server/state.js';
import ipbState from '../modules/ipb/server/state.js';
import orbatState from '../modules/orbat/server/state.js';

export const STATE_DATABASES = [authState, ipbState, exerciseState, orbatState, equipmentState];

/** The databases archived, emptied and restored with the current exercise. */
export const EXERCISE_DATABASES = STATE_DATABASES.filter((database) => database.exercise);
