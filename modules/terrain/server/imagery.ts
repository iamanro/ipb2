import { DatabaseSync } from 'node:sqlite';

import { blob, text, textOrNull } from '../../../server/state.ts';
import { tmsRow } from './tiles.ts';

/**
 * Read-only access to an MBTiles raster archive (as written by
 * tools/build_satellite.mjs). `tile(z, x, y)` takes XYZ addressing and
 * returns the encoded image bytes, or null when the archive has no such tile.
 */
export function openImagery(file: string) {
  // build_satellite.mjs writes into the archive in place (it resumes); wait out
  // its brief write locks instead of failing the request.
  const database = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  const metadata = new Map(
    database
      .prepare('SELECT name, value FROM metadata')
      .all()
      .map((row) => [text(row, 'name'), textOrNull(row, 'value')]),
  );
  const bounds = metadata.get('bounds');
  if (!bounds) throw new Error(`${file} has no bounds in its metadata.`);
  const selectTile = database.prepare(
    'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?',
  );
  return {
    meta: {
      bounds: bounds.split(',').map(Number),
      minZoom: Number(metadata.get('minzoom')),
      maxZoom: Number(metadata.get('maxzoom')),
      format: metadata.get('format') ?? null,
      attribution: metadata.get('attribution') ?? null,
      builtAt: metadata.get('built_at') ?? null,
    },
    tile(z: number, x: number, y: number): Uint8Array | null {
      const row = selectTile.get(z, x, tmsRow(z, y));
      return row ? blob(row, 'tile_data') : null;
    },
    close: () => database.close(),
  };
}
