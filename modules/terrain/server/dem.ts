import { DatabaseSync } from 'node:sqlite';

import type { Json, JsonObject } from '../../../server/http.ts';
import { scalarJson, text } from '../../../server/state.ts';
import {
  METRES_PER_DEGREE_LATITUDE,
  latticeOver,
  longitudeScale,
  metresBetween,
  type LonLat,
} from './lattice.ts';

/** Elevation (or slope) at a point; NaN outside the model. */
export type ElevationFn = (lon: number, lat: number) => number;
type ProfilePoint = { distance: number; lon: number; lat: number; elevation: number };
type Post = LonLat & { ground: number; eye: number };
export type ViewshedRequest = {
  observers: LonLat[];
  radiusMetres?: number;
  observerHeight?: number;
  targetHeight?: number;
  cellMetres?: number;
};
type Analyses = ReturnType<typeof createAnalyses>;
/** A plain or composite elevation model: one interface either way. */
export type ElevationModel = Analyses & {
  /** The `meta` table as stored; a composite adds the detail model's under `detail`. */
  meta: JsonObject;
  bounds: Json;
  elevation: ElevationFn;
  slopeDegrees: ElevationFn;
  close(): void;
};

const TILE = 256;
const DEFAULT_TILE_CACHE_LIMIT = 96;
const EARTH_RADIUS = 6371008.8;
const REFRACTION = 0.13;

/**
 * Apparent drop of terrain at `distance` from the observer: earth curvature
 * less standard atmospheric refraction. Ignoring it overstates visibility by
 * tens of metres past ten kilometres.
 */
function curvatureDrop(distance: number) {
  return ((1 - REFRACTION) * distance * distance) / (2 * EARTH_RADIUS);
}

/**
 * Terrain slope in degrees from central differences one `step` (degrees) to
 * either side, over any elevation function. Shared between a plain model's
 * own grid step and the composite's per-point step (its detail step where
 * the detail model has data, its base step otherwise).
 */
function slopeFromElevation(elevation: ElevationFn, step: number, lon: number, lat: number) {
  const west = elevation(lon - step, lat);
  const east = elevation(lon + step, lat);
  const south = elevation(lon, lat - step);
  const north = elevation(lon, lat + step);
  if ([west, east, south, north].some(Number.isNaN)) return NaN;
  const dzdx = (east - west) / (2 * step * longitudeScale(lat));
  const dzdy = (north - south) / (2 * step * METRES_PER_DEGREE_LATITUDE);
  return (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
}

/**
 * Profile, line-of-sight and viewshed, built once for any `elevation`
 * function. These only ever call `elevation`, so a composite model gets
 * them for free by calling this on its own combined `elevation` — the
 * detail/base split is invisible past that point.
 */
function createAnalyses(elevation: ElevationFn) {
  /** Evenly spaced terrain profile between two points. */
  function profile(
    from: LonLat,
    to: LonLat,
    { spacingMetres = 30 }: { spacingMetres?: number } = {},
  ) {
    const distance = metresBetween(from, to);
    const count = Math.min(Math.max(Math.round(distance / spacingMetres) + 1, 2), 2048);
    const points: ProfilePoint[] = [];
    for (let index = 0; index < count; index += 1) {
      const t = index / (count - 1);
      const lon = from.lon + (to.lon - from.lon) * t;
      const lat = from.lat + (to.lat - from.lat) * t;
      points.push({
        distance: distance * t,
        lon,
        lat,
        elevation: elevation(lon, lat),
      });
    }
    return { distance, points };
  }

  /**
   * Line of sight between two points. Heights are metres above ground. The
   * blocking terrain is the first sample that rises above the sight line.
   */
  function lineOfSight(
    from: LonLat,
    to: LonLat,
    {
      observerHeight = 1.8,
      targetHeight = 1.8,
      spacingMetres,
    }: { observerHeight?: number; targetHeight?: number; spacingMetres?: number } = {},
  ) {
    const { distance, points } = profile(from, to, { spacingMetres });
    const groundStart = points[0].elevation;
    const groundEnd = points[points.length - 1].elevation;
    if (Number.isNaN(groundStart) || Number.isNaN(groundEnd)) {
      throw new Error('The line of sight leaves the elevation model.');
    }
    const eyeHeight = groundStart + observerHeight;
    const aimHeight = groundEnd + targetHeight - curvatureDrop(distance);
    let blockedAt: number | null = null;
    let worstIntrusion = 0;
    const samples = points.map((point) => {
      const t = distance === 0 ? 0 : point.distance / distance;
      const sightHeight = eyeHeight + (aimHeight - eyeHeight) * t;
      const apparent = point.elevation - curvatureDrop(point.distance);
      const clearance = sightHeight - apparent;
      if (point.distance > 0 && point.distance < distance && clearance < 0) {
        if (blockedAt === null) blockedAt = point.distance;
        worstIntrusion = Math.max(worstIntrusion, -clearance);
      }
      return {
        distance: point.distance,
        elevation: point.elevation,
        apparent,
        sight: sightHeight,
        clearance,
      };
    });
    return {
      visible: blockedAt === null,
      distance,
      blockedAt,
      worstIntrusion,
      observer: { ...from, ground: groundStart, eye: eyeHeight },
      target: { ...to, ground: groundEnd, aim: aimHeight },
      samples,
    };
  }

  /**
   * Combined visibility grid for one or more observers (observation posts).
   * Cells are `0` dead ground (inside some observer's radius, seen by none),
   * `1` seen by exactly one observer, `2` seen by two or more, `255` outside
   * every radius or the elevation model. Row 0 is the northern edge so the
   * client can paint the grid straight onto a canvas.
   */
  function viewshed({
    observers,
    radiusMetres = 5000,
    observerHeight = 1.8,
    targetHeight = 1.8,
    cellMetres = 50,
  }: ViewshedRequest) {
    const posts = observers.map(({ lon, lat }): Post => {
      const ground = elevation(lon, lat);
      if (Number.isNaN(ground)) {
        throw new Error('An observer is outside the elevation model.');
      }
      return { lon, lat, ground, eye: ground + observerHeight };
    });
    // One lattice over every observer's circle, measured at the observers'
    // mean latitude; coarsened if it would exceed the old single-observer cap.
    const midLat = posts.reduce((sum, post) => sum + post.lat, 0) / posts.length;
    const lonScale = longitudeScale(midLat);
    const eastings = posts.map((post) => (post.lon - posts[0].lon) * lonScale);
    const northings = posts.map((post) => (post.lat - posts[0].lat) * METRES_PER_DEGREE_LATITUDE);
    const grid = latticeOver(
      [
        posts[0].lon + (Math.min(...eastings) - radiusMetres) / lonScale,
        posts[0].lat + (Math.min(...northings) - radiusMetres) / METRES_PER_DEGREE_LATITUDE,
        posts[0].lon + (Math.max(...eastings) + radiusMetres) / lonScale,
        posts[0].lat + (Math.max(...northings) + radiusMetres) / METRES_PER_DEGREE_LATITUDE,
      ],
      { cellMetres, maxCells: 601 * 601 },
    );
    const { width, height, cellMetres: cell } = grid;
    const stepMetres = Math.max(cell / 2, 15);

    /** Whether `post` sees the target cell `range` metres away at offset (dx, dy). */
    function sees(post: Post, dx: number, dy: number, range: number, targetGround: number) {
      if (range < cell) return true;
      const aim = targetGround + targetHeight - curvatureDrop(range);
      const steps = Math.max(Math.ceil(range / stepMetres), 2);
      for (let step = 1; step < steps; step += 1) {
        const t = step / steps;
        const terrain =
          elevation(
            post.lon + (dx * t) / lonScale,
            post.lat + (dy * t) / METRES_PER_DEGREE_LATITUDE,
          ) - curvatureDrop(range * t);
        if (!Number.isNaN(terrain) && terrain > post.eye + (aim - post.eye) * t) return false;
      }
      return true;
    }

    const values = new Uint8Array(width * height).fill(255);
    let visibleCells = 0;
    let overlapCells = 0;
    let deadCells = 0;
    for (let row = 0; row < height; row += 1) {
      const cellLat = grid.lat(row);
      for (let column = 0; column < width; column += 1) {
        const cellLon = grid.lon(column);
        let inRange = false;
        let seenBy = 0;
        let targetGround: number | null = null;
        for (const post of posts) {
          const dx = (cellLon - post.lon) * lonScale;
          const dy = (cellLat - post.lat) * METRES_PER_DEGREE_LATITUDE;
          const range = Math.hypot(dx, dy);
          if (range > radiusMetres) continue;
          targetGround ??= elevation(cellLon, cellLat);
          if (Number.isNaN(targetGround)) break;
          inRange = true;
          if (sees(post, dx, dy, range, targetGround)) {
            seenBy += 1;
            if (seenBy === 2) break;
          }
        }
        if (!inRange) continue;
        values[row * width + column] = seenBy;
        if (seenBy === 0) deadCells += 1;
        else visibleCells += 1;
        if (seenBy === 2) overlapCells += 1;
      }
    }
    return {
      observers: posts,
      radiusMetres,
      cellMetres: cell,
      extent: grid.extent,
      width,
      height,
      visibleCells,
      overlapCells,
      deadCells,
      values,
    };
  }

  return { profile, lineOfSight, viewshed };
}

/**
 * Elevation model over the lon/lat grid described in tools/schema.sql (the
 * cell density comes from the file's own `cells_per_degree`, so this reads
 * both the 1-arcsecond GLO-30 base and the 1/6-arcsecond DMR4G detail).
 *
 * The interface is `{ meta, bounds, elevation, slopeDegrees, profile, lineOfSight,
 * viewshed, close }`. Tile addressing, the LRU cache and bilinear interpolation
 * stay inside; metres and grids come from the metric plane in lattice.js.
 */
export function openTerrain(
  file: string,
  { tileCacheLimit = DEFAULT_TILE_CACHE_LIMIT }: { tileCacheLimit?: number } = {},
): ElevationModel {
  const database = new DatabaseSync(file, { readOnly: true });
  const meta: JsonObject = Object.fromEntries(
    database
      .prepare('SELECT key, value FROM meta')
      .all()
      .map((row) => [text(row, 'key'), scalarJson(row.value)]),
  );
  const cellsPerDegree = Number(meta.cells_per_degree || 3600);
  const bounds: Json = JSON.parse(typeof meta.bounds === 'string' ? meta.bounds : '[0,0,0,0]');
  const selectTile = database.prepare('SELECT grid FROM dem_tiles WHERE tx = ? AND ty = ?');
  const cache = new Map<number, Float32Array | null>();

  function tileGrid(tx: number, ty: number) {
    const key = tx * 100000 + ty;
    const cached = cache.get(key);
    if (cached !== undefined) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const row = selectTile.get(tx, ty);
    const blob = row?.grid;
    const grid =
      blob instanceof Uint8Array
        ? new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)
        : null;
    cache.set(key, grid);
    const oldest = cache.keys().next().value;
    if (cache.size > tileCacheLimit && oldest !== undefined) cache.delete(oldest);
    return grid;
  }

  /** Elevation of one grid cell, NaN when the cell is absent. */
  function cellElevation(ix: number, iy: number) {
    const tx = Math.floor(ix / TILE);
    const ty = Math.floor(iy / TILE);
    const grid = tileGrid(tx, ty);
    if (!grid) return NaN;
    return grid[(iy - ty * TILE) * TILE + (ix - tx * TILE)];
  }

  /** Bilinear elevation in metres, NaN outside the built area. */
  function elevation(lon: number, lat: number) {
    const x = lon * cellsPerDegree - 0.5;
    const y = lat * cellsPerDegree - 0.5;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const z00 = cellElevation(ix, iy);
    const z10 = cellElevation(ix + 1, iy);
    const z01 = cellElevation(ix, iy + 1);
    const z11 = cellElevation(ix + 1, iy + 1);
    if (Number.isNaN(z00) || Number.isNaN(z10) || Number.isNaN(z01) || Number.isNaN(z11)) {
      return Number.isNaN(z00) ? NaN : z00;
    }
    const bottom = z00 * (1 - fx) + z10 * fx;
    const top = z01 * (1 - fx) + z11 * fx;
    return bottom * (1 - fy) + top * fy;
  }

  const step = 1 / cellsPerDegree;
  const slopeDegrees = (lon: number, lat: number) => slopeFromElevation(elevation, step, lon, lat);

  return {
    meta,
    bounds,
    elevation,
    slopeDegrees,
    ...createAnalyses(elevation),
    close: () => database.close(),
  };
}

/**
 * Composite elevation model: `detail` (a fine, small-footprint model — DMR4G
 * over GLO-30) wins wherever it has data, `base` fills the rest. Same
 * interface as `openTerrain`, so callers (profile/LOS/viewshed included)
 * don't know or care that two grids are behind it.
 *
 * Takes already-open models, not file paths: the server keeps `base` and
 * `detail` behind separate `referenceFile` handles (so either rebuilding
 * independently reopens just that one), and recomposes them here on every
 * request — composing is pointer-cheap, no data is copied.
 */
export function openElevation(
  base: ElevationModel,
  detailModel: ElevationModel | null,
): ElevationModel {
  if (!detailModel) return base;
  const detail = detailModel;
  const detailStep = 1 / Number(detail.meta.cells_per_degree || 3600);

  /** Detail where it has data (including at its own ragged edge), base elsewhere. */
  function elevation(lon: number, lat: number) {
    const fine = detail.elevation(lon, lat);
    return Number.isNaN(fine) ? base.elevation(lon, lat) : fine;
  }

  /** Central differences at the detail spacing inside detail's coverage, the base spacing outside it. */
  function slopeDegrees(lon: number, lat: number) {
    if (!Number.isNaN(detail.elevation(lon, lat))) {
      return slopeFromElevation(elevation, detailStep, lon, lat);
    }
    return base.slopeDegrees(lon, lat);
  }

  return {
    meta: { ...base.meta, detail: detail.meta },
    bounds: base.bounds,
    elevation,
    slopeDegrees,
    ...createAnalyses(elevation),
    close: () => {
      base.close();
      detail.close();
    },
  };
}
