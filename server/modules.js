/**
 * Server-side module registry. Each entry serves `/api/<id>/...`.
 *
 * A module exports `{ id, handle(context), close() }`. `context` is
 * `{ route, url, request, response }` where `route` is the path after
 * `/api/<id>/`. `handle` sends the response itself and throws `HttpError` for
 * client-visible failures. Read-only reference data lives in `data/`, writable
 * run state in `state/` (see `server/state.js`).
 */
import equipment from '../modules/equipment/server/routes.js';
import ipb from '../modules/ipb/server/routes.js';
import terrain from '../modules/terrain/server/routes.js';

export const modules = [terrain, ipb, equipment];
