import { DatabaseSync } from 'node:sqlite';

import {
  METRES_PER_DEGREE_LATITUDE,
  latticeOver,
  longitudeScale,
  metresBetween,
} from './lattice.js';

const TILE = 256;
const TILE_CACHE_LIMIT = 96;
const EARTH_RADIUS = 6371008.8;
const REFRACTION = 0.13;

/**
 * Apparent drop of terrain at `distance` from the observer: earth curvature
 * less standard atmospheric refraction. Ignoring it overstates visibility by
 * tens of metres past ten kilometres.
 */
function curvatureDrop(distance) {
  return ((1 - REFRACTION) * distance * distance) / (2 * EARTH_RADIUS);
}

/**
 * Elevation model over the one-arc-second grid described in tools/schema.sql.
 *
 * The interface is `{ meta, bounds, elevation, slopeDegrees, profile, lineOfSight,
 * viewshed, close }`. Tile addressing, the LRU cache and bilinear interpolation
 * stay inside; metres and grids come from the metric plane in lattice.js.
 */
export function openTerrain(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  const meta = Object.fromEntries(
    database
      .prepare('SELECT key, value FROM meta')
      .all()
      .map((row) => [row.key, row.value]),
  );
  const cellsPerDegree = Number(meta.cells_per_degree || 3600);
  const bounds = JSON.parse(meta.bounds || '[0,0,0,0]');
  const selectTile = database.prepare('SELECT grid FROM dem_tiles WHERE tx = ? AND ty = ?');
  const cache = new Map();

  function tileGrid(tx, ty) {
    const key = tx * 100000 + ty;
    const cached = cache.get(key);
    if (cached !== undefined) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const row = selectTile.get(tx, ty);
    const grid = row
      ? new Float32Array(row.grid.buffer, row.grid.byteOffset, row.grid.byteLength / 4)
      : null;
    cache.set(key, grid);
    if (cache.size > TILE_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return grid;
  }

  /** Elevation of one grid cell, NaN when the cell is absent. */
  function cellElevation(ix, iy) {
    const tx = Math.floor(ix / TILE);
    const ty = Math.floor(iy / TILE);
    const grid = tileGrid(tx, ty);
    if (!grid) return NaN;
    return grid[(iy - ty * TILE) * TILE + (ix - tx * TILE)];
  }

  /** Bilinear elevation in metres, NaN outside the built area. */
  function elevation(lon, lat) {
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

  /** Terrain slope in degrees from central differences over one cell. */
  function slopeDegrees(lon, lat) {
    const step = 1 / cellsPerDegree;
    const west = elevation(lon - step, lat);
    const east = elevation(lon + step, lat);
    const south = elevation(lon, lat - step);
    const north = elevation(lon, lat + step);
    if ([west, east, south, north].some(Number.isNaN)) return NaN;
    const dzdx = (east - west) / (2 * step * longitudeScale(lat));
    const dzdy = (north - south) / (2 * step * METRES_PER_DEGREE_LATITUDE);
    return (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
  }

  /** Evenly spaced terrain profile between two points. */
  function profile(from, to, { spacingMetres = 30 } = {}) {
    const distance = metresBetween(from, to);
    const count = Math.min(Math.max(Math.round(distance / spacingMetres) + 1, 2), 2048);
    const points = [];
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
  function lineOfSight(from, to, { observerHeight = 1.8, targetHeight = 1.8, spacingMetres } = {}) {
    const { distance, points } = profile(from, to, { spacingMetres });
    const groundStart = points[0].elevation;
    const groundEnd = points[points.length - 1].elevation;
    if (Number.isNaN(groundStart) || Number.isNaN(groundEnd)) {
      throw new Error('The line of sight leaves the elevation model.');
    }
    const eyeHeight = groundStart + observerHeight;
    const aimHeight = groundEnd + targetHeight - curvatureDrop(distance);
    let blockedAt = null;
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
  }) {
    const posts = observers.map(({ lon, lat }) => {
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
    function sees(post, dx, dy, range, targetGround) {
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
        let targetGround = null;
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

  return {
    meta,
    bounds,
    elevation,
    slopeDegrees,
    profile,
    lineOfSight,
    viewshed,
    close: () => database.close(),
  };
}
