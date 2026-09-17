PRAGMA foreign_keys = ON;

CREATE TABLE source (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    source_url TEXT NOT NULL,
    scope TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_record_count INTEGER NOT NULL,
    source_asset_count INTEGER NOT NULL,
    source_updated_at TEXT,
    imported_at TEXT NOT NULL
);

CREATE TABLE metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE source_documents (
    source_ref TEXT PRIMARY KEY,
    top_level_type TEXT NOT NULL,
    json_data TEXT NOT NULL
);

CREATE TABLE navigation_nodes (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES navigation_nodes(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    depth INTEGER NOT NULL,
    source_key TEXT,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    variable TEXT NOT NULL,
    inode TEXT,
    iso_code TEXT,
    UNIQUE (parent_id, ordinal)
);


CREATE TABLE cards (
    identifier TEXT PRIMARY KEY,
    source_ordinal INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    display_name TEXT NOT NULL,
    display_string TEXT NOT NULL,
    notes TEXT NOT NULL,
    date_of_introduction TEXT NOT NULL,
    publish_date TEXT NOT NULL,
    modified_date TEXT NOT NULL,
    author_modified_date TEXT NOT NULL,
    inode TEXT NOT NULL,
    host TEXT NOT NULL,
    live INTEGER NOT NULL CHECK (live IN (0, 1)),
    has_live_version INTEGER NOT NULL CHECK (has_live_version IN (0, 1)),
    raw_json TEXT NOT NULL
);

CREATE TABLE images (
    id INTEGER PRIMARY KEY,
    card_identifier TEXT NOT NULL REFERENCES cards(identifier) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    source_path TEXT NOT NULL,
    local_path TEXT,
    UNIQUE (card_identifier, ordinal)
);

CREATE TABLE classifications (
    card_identifier TEXT NOT NULL REFERENCES cards(identifier) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('domain', 'origin', 'proliferation')),
    ordinal INTEGER NOT NULL,
    source_key TEXT NOT NULL REFERENCES navigation_nodes(key),
    value TEXT NOT NULL,
    PRIMARY KEY (card_identifier, kind, ordinal)
);

CREATE TABLE sections (
    id INTEGER PRIMARY KEY,
    card_identifier TEXT NOT NULL REFERENCES cards(identifier) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES sections(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    depth INTEGER NOT NULL,
    name TEXT NOT NULL,
    name_invalid INTEGER CHECK (name_invalid IN (0, 1)),
    UNIQUE (card_identifier, parent_id, ordinal)
);

CREATE TABLE properties (
    id INTEGER PRIMARY KEY,
    section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    units TEXT,
    property_name_invalid INTEGER CHECK (property_name_invalid IN (0, 1)),
    value_invalid INTEGER CHECK (value_invalid IN (0, 1)),
    UNIQUE (section_id, ordinal)
);

CREATE INDEX classifications_kind_value_idx ON classifications(kind, value);
CREATE INDEX navigation_nodes_parent_idx ON navigation_nodes(parent_id, ordinal);
CREATE INDEX sections_card_idx ON sections(card_identifier);
CREATE INDEX properties_section_idx ON properties(section_id);
CREATE INDEX properties_name_idx ON properties(name);
CREATE INDEX images_card_idx ON images(card_identifier);

CREATE VIRTUAL TABLE cards_fts USING fts5(
    card_identifier UNINDEXED,
    name,
    title,
    notes,
    details,
    tokenize = 'unicode61 remove_diacritics 2'
);
