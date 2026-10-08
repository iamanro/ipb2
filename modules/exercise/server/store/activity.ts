// The AAR activity log.

import { database } from './connection.ts';

/** Every cell can see a global (White-scheduling-hidden aside) activity row;
 * a cell-owned one follows the same visibility as the item it was about.
 * `access.visible` works on any table with `owner_cell`/`releasable_to`
 * columns given any item kind of this module (docs/adr/0002 rule 4) —
 * `'requirement'` here is arbitrary, `activity` isn't one item kind's log. */
export function listActivity(access) {
  const { sql, params } = access.visible('requirement', {});
  return database
    .prepare(`SELECT * FROM activity WHERE owner_cell IS NULL OR (${sql}) ORDER BY id DESC`)
    .all(...params);
}
