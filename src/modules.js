/**
 * Client-side module registry. The first entry is the default route.
 *
 * A manifest is `{ id, title, summary, load }`. `id` is the first URL path
 * segment (`/<id>/`) and the `/api/<id>/` prefix. `load()` resolves to a
 * module whose `mount({ root, status })` renders into `root`, may fill the
 * masthead `status` slot, and returns an unmount function. The shell sets
 * `root.dataset.module = id`; module stylesheets nest their rules under
 * `[data-module='<id>']` because lazy-loaded CSS stays in the document.
 *
 * `terrain` has no entry here: it is a server-only analysis service
 * (`/api/terrain/...`) used by the IPB workspace.
 */
import admin from '../modules/admin/module.js';
import equipment from '../modules/equipment/module.js';
import exercise from '../modules/exercise/module.js';
import ipb from '../modules/ipb/module.js';
import orbat from '../modules/orbat/module.js';

export const modules = [ipb, exercise, orbat, equipment, admin];
