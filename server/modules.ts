/**
 * Server-side module registry. Each entry serves `/api/<id>/...` through
 * `server/dispatch.ts`: a module exports its cell-owned items, their parts
 * and a route table (the shape is documented there), never a request
 * handler of its own. Read-only reference data lives in `data/`, writable
 * run state in `state/` (see `server/state.ts`).
 */
import equipment from '../modules/equipment/server/routes.js';
import exercise from '../modules/exercise/server/routes.js';
import ipb from '../modules/ipb/server/routes.js';
import orbat from '../modules/orbat/server/routes.js';
import terrain from '../modules/terrain/server/routes.js';

export const modules = [terrain, ipb, exercise, orbat, equipment];
