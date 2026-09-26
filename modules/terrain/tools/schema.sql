-- Reference terrain data. Rebuilt by tools/build_terrain.mjs (GLO-30, the
-- base) or tools/build_dmr4g.mjs (ČÚZK DMR4G, a finer detail layer over it —
-- see server/dem.js's `openElevation`); never edited at runtime. Both use
-- the same global WGS84 cell grid, at `cells_per_degree` cells per degree
-- (`meta`; 3600 for GLO-30, 21600 for DMR4G):
--
--   ix = floor(longitude * cells_per_degree), iy = floor(latitude * cells_per_degree)
--   tx = floor(ix / 256),                     ty = floor(iy / 256)
--   column = ix - tx * 256,                   row = iy - ty * 256   (row 0 = southernmost)
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
