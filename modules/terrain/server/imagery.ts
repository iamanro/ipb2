import { DatabaseSync } from 'node:sqlite';

import { tmsRow } from './tiles.ts';

/**
 * Read-only access to an MBTiles raster archive (as written by
 * tools/build_satellite.mjs). `tile(z, x, y)` takes XYZ addressing and
 * returns the encoded image bytes, or null when the archive has no such tile.
 */
export function openImagery(file) {
  // build_satellite.mjs writes into the archive in place (it resumes); wait out
  // its brief write locks instead of failing the request.
  const database = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  const metadata = Object.fromEntries(
    database
      .prepare('SELECT name, value FROM metadata')
      .all()
      .map((row) => [row.name, row.value]),
  );
  const selectTile = database.prepare(
    'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?',
  );
  return {
    meta: {
      bounds: metadata.bounds.split(',').map(Number),
      minZoom: Number(metadata.minzoom),
      maxZoom: Number(metadata.maxzoom),
      format: metadata.format,
      attribution: metadata.attribution,
      builtAt: metadata.built_at,
    },
    tile(z, x, y) {
      return selectTile.get(z, x, tmsRow(z, y))?.tile_data ?? null;
    },
    close: () => database.close(),
  };
}
