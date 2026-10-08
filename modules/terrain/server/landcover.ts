import { open, type FileHandle } from 'node:fs/promises';

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { PMTiles } from 'pmtiles';

import type { Bounds, Lattice } from './lattice.ts';

export type Peak = { name: string; ele: number | null; lon: number; lat: number };
type Position = number[];

export const GO = 0;
export const SLOW_GO = 1;
export const NO_GO = 2;
export const UNKNOWN = 255;

const TILE_ZOOM = 14;

/** Obstacle class contributed by one OpenMapTiles feature, or null to ignore. */
export function coverClass(
  layerName: string,
  properties: Record<string, number | string | boolean>,
) {
  const kind = String(properties.class || properties.subclass || '');
  if (layerName === 'water') return kind === 'swimming_pool' ? null : NO_GO;
  if (layerName === 'waterway') {
    // Rivers and canals stop vehicles; mapped streams are mostly fordable and
    // only restrict them. Scoring every stream NO-GO cut dense stream networks
    // into cells no corridor could cross.
    if (kind === 'river' || kind === 'canal') return NO_GO;
    return kind === 'stream' ? SLOW_GO : null;
  }
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

function tileRange(bounds: Bounds, zoom: number) {
  const [west, south, east, north] = bounds;
  const scale = 2 ** zoom;
  const toX = (lon: number) => Math.floor(((lon + 180) / 360) * scale);
  const toY = (lat: number) => {
    const radians = (Math.min(Math.max(lat, -85.05), 85.05) * Math.PI) / 180;
    const y = (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
    return Math.floor(y * scale);
  };
  return { xMin: toX(west), xMax: toX(east), yMin: toY(north), yMax: toY(south) };
}

/** Local-file byte source for the PMTiles reader. */
function fileSource(file: string) {
  let handle: FileHandle | null = null;
  return {
    getKey: () => file,
    async getBytes(offset: number, length: number) {
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
export async function vectorLayerNames(file: string): Promise<string[]> {
  const source = fileSource(file);
  try {
    const metadata = await new PMTiles(source).getMetadata();
    const layers =
      metadata && typeof metadata === 'object' && 'vector_layers' in metadata
        ? metadata.vector_layers
        : [];
    return Array.isArray(layers)
      ? layers.flatMap((layer) =>
          layer && typeof layer === 'object' && 'id' in layer && typeof layer.id === 'string'
            ? [layer.id]
            : [],
        )
      : [];
  } catch {
    return [];
  } finally {
    await source.close();
  }
}

/** Zoom at which OpenMapTiles carries mountain_peak points; few tiles per AOI. */
const PEAK_ZOOM = 12;

/**
 * Named peaks (`mountain_peak`) inside bounds from the vector basemap, as
 * `[{ name, ele, lon, lat }]`; [] when the archive has no peak layer.
 */
export async function namedPeaks(file: string, bounds: Bounds): Promise<Peak[]> {
  const source = fileSource(file);
  const archive = new PMTiles(source);
  const [west, south, east, north] = bounds;
  const peaks: Peak[] = [];
  try {
    const range = tileRange(bounds, PEAK_ZOOM);
    for (let x = range.xMin; x <= range.xMax; x += 1) {
      for (let y = range.yMin; y <= range.yMax; y += 1) {
        const tile = await archive.getZxy(PEAK_ZOOM, x, y);
        if (!tile?.data) continue;
        const layer = new VectorTile(new PbfReader(new Uint8Array(tile.data))).layers.mountain_peak;
        if (!layer) continue;
        for (let index = 0; index < layer.length; index += 1) {
          const feature = layer.feature(index);
          const { name, ele } = feature.properties;
          if (!name) continue;
          const { geometry } = feature.toGeoJSON(x, y, PEAK_ZOOM);
          if (geometry.type !== 'Point') continue;
          const [lon, lat] = geometry.coordinates;
          if (lon < west || lon > east || lat < south || lat > north) continue;
          peaks.push({ name: String(name), ele: Number(ele) || null, lon, lat });
        }
      }
    }
  } finally {
    await source.close();
  }
  return peaks;
}

/**
 * Obstacle overlay read from the offline vector basemap.
 *
 * `classify(grid)` rasterises water, waterways, buildings, forest and built-up
 * areas onto the caller's lattice (lattice.js) and returns one obstacle class
 * per cell, row-major. Tile addressing, protobuf decoding and polygon filling
 * stay inside.
 */
export function openLandcover(file: string) {
  const source = fileSource(file);
  const archive = new PMTiles(source);

  async function decodeTile(x: number, y: number) {
    const tile = await archive.getZxy(TILE_ZOOM, x, y);
    if (!tile?.data) return null;
    return new VectorTile(new PbfReader(new Uint8Array(tile.data)));
  }

  async function classify(grid: Lattice) {
    const { width, height, column: toColumn, row: toRow } = grid;
    const values = new Uint8Array(width * height).fill(GO);

    const mark = (index: number, cover: number) => {
      if (values[index] < cover) values[index] = cover;
    };

    const fillRing = (rings: Position[][], cover: number) => {
      // Even-odd scanline fill through cell centres.
      let minRow = Infinity;
      let maxRow = -Infinity;
      const edges: [{ x: number; y: number }, { x: number; y: number }][] = [];
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
        const crossings: number[] = [];
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

    const strokeLine = (line: Position[], cover: number) => {
      for (let index = 0; index < line.length - 1; index += 1) {
        const x0 = toColumn(line[index][0]);
        const y0 = toRow(line[index][1]);
        const x1 = toColumn(line[index + 1][0]);
        const y1 = toRow(line[index + 1][1]);
        const steps = Math.max(Math.ceil(Math.hypot(x1 - x0, y1 - y0)), 1);
        for (let step = 0; step <= steps; step += 1) {
          const t = step / steps;
          const column = Math.floor(x0 + (x1 - x0) * t);
          const row = Math.floor(y0 + (y1 - y0) * t);
          if (column < 0 || row < 0 || column >= width || row >= height) continue;
          mark(row * width + column, cover);
        }
      }
    };

    const range = tileRange(grid.extent, TILE_ZOOM);
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
            const geometry = shape.geometry;
            if (geometry.type === 'Polygon') fillRing(geometry.coordinates, cover);
            else if (geometry.type === 'MultiPolygon')
              for (const rings of geometry.coordinates) fillRing(rings, cover);
            else if (geometry.type === 'LineString') strokeLine(geometry.coordinates, cover);
            else if (geometry.type === 'MultiLineString')
              for (const line of geometry.coordinates) strokeLine(line, cover);
          }
        }
      }
    }
    return values;
  }

  return { classify, close: () => source.close() };
}
