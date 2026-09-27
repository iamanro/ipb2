/**
 * A study's area of operations (AO) and area of interest (AOI): one GeoJSON
 * Polygon each, in WGS84 lon/lat. Shared by the IPB server (validation) and
 * the client (the coordinate editor). Pure: no DOM, no OpenLayers.
 */

/** The study fields that hold an area, and how they are named to the analyst. */
export const STUDY_AREAS = [
  { key: 'ao', short: 'AO', name: 'Area of operations' },
  { key: 'aoi', short: 'AOI', name: 'Area of interest' },
];

/** Enough for a drawn outline of a large area; a typo'd paste stops here. */
export const MAX_AREA_VERTICES = 5000;

function positionProblem(position) {
  if (
    !Array.isArray(position) ||
    position.length < 2 ||
    !Number.isFinite(position[0]) ||
    !Number.isFinite(position[1])
  ) {
    return 'every position must be [lon, lat] numbers';
  }
  if (Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90) {
    return 'every position must be within lon ±180 and lat ±90';
  }
  return null;
}

/** The first reason `geometry` can't be an area, or null when it can. */
export function areaPolygonProblem(geometry) {
  if (typeof geometry !== 'object' || geometry === null || geometry.type !== 'Polygon') {
    return 'must be a GeoJSON Polygon';
  }
  const rings = geometry.coordinates;
  if (!Array.isArray(rings) || !rings.length) return 'must have at least one ring';
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4) {
      return 'every ring needs at least 3 corners (4 positions, closed)';
    }
    if (ring.length > MAX_AREA_VERTICES + 1) {
      return `a ring may have at most ${MAX_AREA_VERTICES} corners`;
    }
    for (const position of ring) {
      const problem = positionProblem(position);
      if (problem) return problem;
    }
    const first = ring[0];
    const last = ring.at(-1);
    if (first[0] !== last[0] || first[1] !== last[1]) {
      return 'every ring must end where it starts';
    }
  }
  const corners = new Set(rings[0].slice(0, -1).map(([lon, lat]) => `${lon},${lat}`));
  if (corners.size < 3) return 'the outline needs at least 3 different corners';
  return null;
}

/** The outline's corners (the outer ring without its closing repeat), or [] for no area. */
export function areaCorners(geometry) {
  if (geometry?.type !== 'Polygon' || !Array.isArray(geometry.coordinates?.[0])) return [];
  return geometry.coordinates[0].slice(0, -1);
}

/** A Polygon from `corners` (`[[lon, lat], …]`), closed; holes are not kept. */
export function areaFromCorners(corners) {
  return { type: 'Polygon', coordinates: [[...corners, corners[0]]] };
}

/** `[west, south, east, north]` around every given area, or null when there are none. */
export function areasBounds(geometries) {
  let bounds = null;
  for (const geometry of geometries) {
    for (const ring of geometry?.type === 'Polygon' ? geometry.coordinates : []) {
      for (const [lon, lat] of ring) {
        if (!bounds) bounds = [lon, lat, lon, lat];
        else {
          bounds[0] = Math.min(bounds[0], lon);
          bounds[1] = Math.min(bounds[1], lat);
          bounds[2] = Math.max(bounds[2], lon);
          bounds[3] = Math.max(bounds[3], lat);
        }
      }
    }
  }
  return bounds && bounds[0] < bounds[2] && bounds[1] < bounds[3] ? bounds : null;
}
