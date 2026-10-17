/**
 * Server-side module registry. Each entry serves `/api/<id>/...` through
 * `server/dispatch.ts`: a module exports its cell-owned items, their parts
 * and a route table (the shape is documented there), never a request
 * handler of its own. Read-only reference data lives in `data/`, writable
 * run state in `state/` (see `server/state.ts`).
 */
import equipment from '../modules/equipment/server/routes.ts';
import exercise from '../modules/exercise/server/routes.ts';
import ipb from '../modules/ipb/server/routes.ts';
import orbat from '../modules/orbat/server/routes.ts';
import terrain from '../modules/terrain/server/routes.ts';

export const modules = [terrain, ipb, exercise, orbat, equipment];
