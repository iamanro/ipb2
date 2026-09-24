import { open } from 'node:fs/promises';

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { PMTiles } from 'pmtiles';

export const GO = 0;
export const SLOW_GO = 1;
export const NO_GO = 2;
export const UNKNOWN = 255;

const TILE_ZOOM = 14;

/** Obstacle class contributed by one OpenMapTiles feature, or null to ignore. */
function coverClass(layerName, properties) {
  const kind = String(properties.class || properties.subclass || '');
  if (layerName === 'water') return kind === 'swimming_pool' ? null : NO_GO;
  if (layerName === 'waterway') return ['river', 'canal', 'stream'].includes(kind) ? NO_GO : null;
  if (layerName === 'building') return NO_GO;
  if (layerName === 'landcover') {
    if (['wood', 'forest', 'scrub'].includes(kind)) return SLOW_GO;
    if (['wetland', 'swamp', 'marsh', 'bog', 'mangrove'].includes(kind)) return NO_GO;
    return null;
  }
  if (layerName === 'landuse') {
    if (['residential', 'suburb', 'quarter', 'neighbourhood'].includes(kind)) return SLOW_GO;
    // `military` is an administrative district, not terrain, so it is ignored.
    if (['industrial', 'commercial', 'retail'].includes(kind)) return SLOW_GO;
    return null;
  }
  return null;
}

const LAYERS = ['water', 'waterway', 'building', 'landcover', 'landuse'];

function tileRange(bounds, zoom) {
  const [west, south, east, north] = bounds;
  const scale = 2 ** zoom;
  const toX = (lon) => Math.floor(((lon + 180) / 360) * scale);
  const toY = (lat) => {
    const radians = (Math.min(Math.max(lat, -85.05), 85.05) * Math.PI) / 180;
    const y = (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
    return Math.floor(y * scale);
  };
  return { xMin: toX(west), xMax: toX(east), yMin: toY(north), yMax: toY(south) };
}

/** Local-file byte source for the PMTiles reader. */
function fileSource(file) {
  let handle = null;
  return {
    getKey: () => file,
    async getBytes(offset, length) {
      handle ??= await open(file, 'r');
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead) };
    },
    async close() {
      await handle?.close();
      handle = null;
    },
  };
}

/**
 * Names of the vector layers in a basemap archive (e.g. `transportation`,
 * `place`), from its metadata, or [] when the file is missing or unreadable.
 * Lets the client offer only the labels the built basemap can actually draw.
 */
export async function vectorLayerNames(file) {
  const source = fileSource(file);
  try {
    const metadata = await new PMTiles(source).getMetadata();
    return (metadata?.vector_layers ?? []).map((layer) => layer.id);
  } catch {
    return [];
  } finally {
    await source.close();
  }
}

/**
 * Obstacle overlay read from the offline vector basemap.
 *
 * `classify(grid)` rasterises water, waterways, buildings, forest and built-up
 * areas onto the caller's grid and returns one obstacle class per cell. Tile
 * addressing, protobuf decoding and polygon filling stay inside.
 */
export function openLandcover(file) {
  const source = fileSource(file);
  const archive = new PMTiles(source);

  async function decodeTile(x, y) {
    const tile = await archive.getZxy(TILE_ZOOM, x, y);
    if (!tile?.data) return null;
    return new VectorTile(new PbfReader(new Uint8Array(tile.data)));
  }

  async function classify(grid) {
    const { west, north, cellMetres, width, height, metresPerLongitude, metresPerLatitude } = grid;
    const values = new Uint8Array(width * height).fill(GO);
    const toColumn = (lon) => ((lon - west) * metresPerLongitude) / cellMetres;
    const toRow = (lat) => ((north - lat) * metresPerLatitude) / cellMetres;

    const mark = (index, cover) => {
      if (values[index] < cover) values[index] = cover;
    };

    const fillRing = (rings, cover) => {
      // Even-odd scanline fill through cell centres.
      let minRow = Infinity;
      let maxRow = -Infinity;
      const edges = [];
      for (const ring of rings) {
        for (let index = 0; index < ring.length - 1; index += 1) {
          const a = { x: toColumn(ring[index][0]), y: toRow(ring[index][1]) };
          const b = { x: toColumn(ring[index + 1][0]), y: toRow(ring[index + 1][1]) };
          if (a.y === b.y) continue;
          edges.push([a, b]);
          minRow = Math.min(minRow, a.y, b.y);
          maxRow = Math.max(maxRow, a.y, b.y);
        }
      }
      if (!edges.length) return;
      const rowStart = Math.max(Math.floor(minRow), 0);
      const rowEnd = Math.min(Math.ceil(maxRow), height - 1);
      for (let row = rowStart; row <= rowEnd; row += 1) {
        const y = row + 0.5;
        const crossings = [];
        for (const [a, b] of edges) {
          if (y < Math.min(a.y, b.y) || y >= Math.max(a.y, b.y)) continue;
          crossings.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
        crossings.sort((left, right) => left - right);
        for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
          const from = Math.max(Math.ceil(crossings[pair] - 0.5), 0);
          const to = Math.min(Math.floor(crossings[pair + 1] - 0.5), width - 1);
          for (let column = from; column <= to; column += 1) mark(row * width + column, cover);
        }
      }
    };

    const strokeLine = (line, cover) => {
      for (let index = 0; index < line.length - 1; index += 1) {
        const x0 = toColumn(line[index][0]);
        const y0 = toRow(line[index][1]);
        const x1 = toColumn(line[index + 1][0]);
        const y1 = toRow(line[index + 1][1]);
        const steps = Math.max(Math.ceil(Math.hypot(x1 - x0, y1 - y0)), 1);
        for (let step = 0; step <= steps; step += 1) {
          const t = step / steps;
          const column = Math.round(x0 + (x1 - x0) * t);
          const row = Math.round(y0 + (y1 - y0) * t);
          if (column < 0 || row < 0 || column >= width || row >= height) continue;
          mark(row * width + column, cover);
        }
      }
    };

    const east = west + (width * cellMetres) / metresPerLongitude;
    const south = north - (height * cellMetres) / metresPerLatitude;
    const range = tileRange([west, south, east, north], TILE_ZOOM);
    for (let x = range.xMin; x <= range.xMax; x += 1) {
      for (let y = range.yMin; y <= range.yMax; y += 1) {
        const tile = await decodeTile(x, y);
        if (!tile) continue;
        for (const name of LAYERS) {
          const layer = tile.layers[name];
          if (!layer) continue;
          for (let index = 0; index < layer.length; index += 1) {
            const feature = layer.feature(index);
            const cover = coverClass(name, feature.properties);
            if (cover === null) continue;
            const shape = feature.toGeoJSON(x, y, TILE_ZOOM);
            const { type, coordinates } = shape.geometry;
            if (type === 'Polygon') fillRing(coordinates, cover);
            else if (type === 'MultiPolygon')
              for (const rings of coordinates) fillRing(rings, cover);
            else if (type === 'LineString') strokeLine(coordinates, cover);
            else if (type === 'MultiLineString')
              for (const line of coordinates) strokeLine(line, cover);
          }
        }
      }
    }
    return values;
  }

  return { classify, close: () => source.close() };
}
