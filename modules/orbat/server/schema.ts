import type { Migration } from '../../../server/state.ts';

/**
 * ORBAT state schema: user-authored custom orders of battle, each a tree of
 * units drawn as NATO APP-6(D) symbols (see `client/symbology.js` for the
 * code tables). Separate from `exercise`'s roster — an ORBAT models the
 * *simulated* force structure an exercise runs against, not the people
 * running the exercise.
 */
export const MIGRATIONS: Migration[] = [
  `
  CREATE TABLE orbats (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- A unit tree per ORBAT. \`parent_id\` NULL means top-level; \`position\` is
  -- the unit's 0-based index among its siblings and is kept contiguous
  -- (0..n-1) by every mutation in store.js, so ordering a sibling list is
  -- just \`ORDER BY position\`.
  CREATE TABLE units (
    id INTEGER PRIMARY KEY,
    orbat_id INTEGER NOT NULL REFERENCES orbats(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES units(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    sidc TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    designation TEXT NOT NULL DEFAULT '',
    higher_formation TEXT NOT NULL DEFAULT '',
    reinforced TEXT NOT NULL DEFAULT '' CHECK (reinforced IN ('', '(+)', '(-)', '(±)')),
    additional TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX units_orbat ON units(orbat_id);
  CREATE INDEX units_parent ON units(orbat_id, parent_id, position);
  `,
  // Phase 1 cells: every ORBAT is owned by a cell and may be released to
  // others. Existing ORBATs migrate to 'white' (visible to nobody else) so
  // nothing leaks; White can reassign or release them. Units inherit their
  // ORBAT's visibility and carry no columns of their own.
  `
  ALTER TABLE orbats ADD COLUMN owner_cell TEXT NOT NULL DEFAULT 'white'
    CHECK (owner_cell IN ('white', 'blue', 'red'));
  ALTER TABLE orbats ADD COLUMN releasable_to TEXT NOT NULL DEFAULT '[]';
  `,
];
