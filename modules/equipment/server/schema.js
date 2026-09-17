/**
 * Bookmark state schema. Separate from the read-only reference database
 * (`data/unitgenerator.db`): this file lives in `state/` and is the user's
 * own work, rebuilt by nothing.
 */
export const MIGRATIONS = [
  `
CREATE TABLE bookmarks (
    id INTEGER PRIMARY KEY,
    card_identifier TEXT NOT NULL UNIQUE,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL
);
`,
];
