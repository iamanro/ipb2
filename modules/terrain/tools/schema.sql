-- Reference terrain data. Rebuilt by tools/build_terrain.mjs; never edited at
-- runtime. Elevation is stored on a global one-arc-second WGS84 cell grid:
--
--   ix = floor(longitude * 3600), iy = floor(latitude * 3600)
--   tx = floor(ix / 256),         ty = floor(iy / 256)
--   column = ix - tx * 256,       row = iy - ty * 256   (row 0 = southernmost)
--
-- `grid` holds 256 * 256 little-endian Float32 metres, row-major, south row
-- first. Missing cells are NaN.
PRAGMA journal_mode = DELETE;

CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE dem_tiles (
    tx INTEGER NOT NULL,
    ty INTEGER NOT NULL,
    grid BLOB NOT NULL,
    PRIMARY KEY (tx, ty)
) WITHOUT ROWID;
