// Web-mercator ("XYZ", Google-compatible) tile addressing: tile (0, 0) is
// the north-west corner at every zoom. MBTiles stores rows the other way up
// (TMS), which `tmsRow` converts.

import type { Bounds } from './lattice.ts';

/** Longitude at a global (possibly fractional) x in tiles at zoom `z`. */
export function tileXToLon(x: number, z: number) {
  return (x / 2 ** z) * 360 - 180;
}

/** Latitude at a global (possibly fractional) y in tiles at zoom `z`. */
export function tileYToLat(y: number, z: number) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

function lonToTileX(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z;
}

function latToTileY(lat: number, z: number) {
  const radians = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * 2 ** z;
}

/** Inclusive tile index range covering a lon/lat extent at zoom `z`. */
export function tileRange([west, south, east, north]: Bounds, z: number) {
  const last = 2 ** z - 1;
  const clamp = (value: number) => Math.min(Math.max(Math.floor(value), 0), last);
  return {
    minX: clamp(lonToTileX(west, z)),
    maxX: clamp(lonToTileX(east, z) - 1e-9),
    minY: clamp(latToTileY(north, z)),
    maxY: clamp(latToTileY(south, z) - 1e-9),
  };
}

export function tmsRow(z: number, y: number) {
  return 2 ** z - 1 - y;
}
