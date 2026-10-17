// GeoJSON geometry types (RFC 7946) as the stores keep them, and a reader
// that checks a parsed value really has that shape before it is used as one.
import type { Json } from './http.ts';

export type Position = number[];
export type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint'; coordinates: Position[] }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

function readPosition(value: Json | undefined): Position | null {
  return Array.isArray(value) &&
    value.length >= 2 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? value.filter((n) => typeof n === 'number')
    : null;
}

/** `value` as nested arrays `depth` deep with positions at the bottom, or null. */
function readNested(value: Json | undefined, depth: 1): Position[] | null;
function readNested(value: Json | undefined, depth: 2): Position[][] | null;
function readNested(value: Json | undefined, depth: 3): Position[][][] | null;
function readNested(
  value: Json | undefined,
  depth: 1 | 2 | 3,
): Position[] | Position[][] | Position[][][] | null {
  if (!Array.isArray(value)) return null;
  if (depth === 1) {
    const positions = value.map(readPosition);
    return positions.every((p) => p !== null) ? positions.filter((p) => p !== null) : null;
  }
  if (depth === 2) {
    const lines = value.map((item) => readNested(item, 1));
    return lines.every((l) => l !== null) ? lines.filter((l) => l !== null) : null;
  }
  const polygons = value.map((item) => readNested(item, 2));
  return polygons.every((p) => p !== null) ? polygons.filter((p) => p !== null) : null;
}

/** A parsed GeoJSON geometry, checked; null when it is not one this app uses. */
export function readGeometry(value: Json | undefined): Geometry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { coordinates } = value;
  switch (value.type) {
    case 'Point': {
      const point = readPosition(coordinates);
      return point && { type: 'Point', coordinates: point };
    }
    case 'MultiPoint':
    case 'LineString': {
      const positions = readNested(coordinates, 1);
      return positions && { type: value.type, coordinates: positions };
    }
    case 'MultiLineString':
    case 'Polygon': {
      const lines = readNested(coordinates, 2);
      return lines && { type: value.type, coordinates: lines };
    }
    case 'MultiPolygon': {
      const polygons = readNested(coordinates, 3);
      return polygons && { type: 'MultiPolygon', coordinates: polygons };
    }
    default:
      return null;
  }
}
