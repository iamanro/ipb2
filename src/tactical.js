// Doctrinal control-measure graphics (ADP 1-02 / APP-6 conventions, drawn as
// closely as OpenLayers vector styles allow — filled/hollow doctrinal glyphs
// need a symbol renderer, not a canvas style function). Pure geometry helpers
// (no DOM) are exported for tests; `TACTICAL_GRAPHICS` entries build OL
// styles from an `ol/Feature` whose geometry is already in the map
// projection (EPSG:3857), which is what `map.js`'s vector layers style.
import { getDistance, offset as sphereOffset } from 'ol/sphere.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import Polygon, { circular } from 'ol/geom/Polygon.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import Style from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import Fill from 'ol/style/Fill.js';
import CircleStyle from 'ol/style/Circle.js';
import RegularShape from 'ol/style/RegularShape.js';
import TextStyle from 'ol/style/Text.js';

const LABEL_FONT = '700 11px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif';
const MID_LABEL_FONT = '700 13px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif';

/** APP-6(D) affiliation colours; `none`/unset falls back to plain ink. */
const AFFILIATION_COLOR = {
  friendly: '#3d8bff',
  hostile: '#ff4d4d',
  neutral: '#3fbf5f',
  unknown: '#e6c229',
};
const INK = { pale: '#12324a', dark: '#dfe8ea' };

/** Colour for a graphic/range-ring: by affiliation, or plain ink when unset. */
export function graphicColor(affiliation, darkBase) {
  return AFFILIATION_COLOR[affiliation] || (darkBase ? INK.dark : INK.pale);
}

/**
 * A casing colour opposite the basemap's own brightness, so a graphic line
 * stays legible over whatever terrain or imagery sits under it — the same
 * problem the MGRS grid and contour labels solve (`src/map.js`'s
 * `MGRS_LINE_STYLE`/`CONTOUR_TONES`), applied to graphics instead.
 */
function casingColor(darkBase) {
  return darkBase ? 'rgba(8, 14, 17, 0.7)' : 'rgba(255, 255, 255, 0.88)';
}

function withAlpha(color, alpha) {
  const hex = color.replace('#', '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const value = Number.parseInt(full, 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function boxedLabel(coordinate, text, color, font = LABEL_FONT) {
  if (!text) return null;
  return new Style({
    geometry: new Point(coordinate),
    text: new TextStyle({
      text,
      font,
      fill: new Fill({ color: '#1b1b1b' }),
      backgroundFill: new Fill({ color: 'rgba(255, 255, 255, 0.92)' }),
      backgroundStroke: new Stroke({ color, width: 1.5 }),
      padding: [2, 6, 2, 6],
    }),
  });
}

/** A casing-then-ink stroke pair, so the line reads over any basemap. */
function lineStyles(geometry, color, darkBase, { width = 2.5, dash = null } = {}) {
  return [
    new Style({
      geometry,
      stroke: new Stroke({ color: casingColor(darkBase), width: width + 2.5, lineDash: dash }),
    }),
    new Style({ geometry, stroke: new Stroke({ color, width, lineDash: dash }) }),
  ];
}

function endpointLabels(lineGeometry, text, color) {
  if (!text) return [];
  const coordinates = lineGeometry.getCoordinates();
  if (coordinates.length < 2) return [];
  return [coordinates[0], coordinates[coordinates.length - 1]].map((coordinate) =>
    boxedLabel(coordinate, text, color),
  );
}

function midpointLabel(lineGeometry, text, color) {
  const coordinates = lineGeometry.getCoordinates();
  if (coordinates.length < 2) return null;
  const midpoint = lineGeometry.getCoordinateAt(0.5);
  return boxedLabel(midpoint, text, color, MID_LABEL_FONT);
}

function areaLabel(polygonGeometry, text, color) {
  return boxedLabel(
    polygonGeometry.getInteriorPoint().getCoordinates(),
    text,
    color,
    MID_LABEL_FONT,
  );
}

// -- axis-of-advance: a geodesic arrow corridor from a centreline -----------

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/** Initial bearing in radians from `a` to `b` (`[lon, lat]` degrees), by the standard spherical formula. */
function bearingRad(a, b) {
  const phi1 = toRadians(a[1]);
  const phi2 = toRadians(b[1]);
  const dLambda = toRadians(b[0] - a[0]);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return Math.atan2(y, x);
}

function dedupeAdjacent(points) {
  return points.filter(
    (point, index) => index === 0 || getDistance(point, points[index - 1]) > 0.01,
  );
}

/** The point and outbound bearing at `distance` along a cumulative-distance-indexed polyline. */
function pointAtDistance(points, cumulative, distance) {
  const total = cumulative[cumulative.length - 1];
  const target = Math.min(Math.max(distance, 0), total);
  let i = 1;
  while (i < cumulative.length - 1 && cumulative[i] < target) i++;
  const segStart = points[i - 1];
  const segEnd = points[i];
  const bearing = bearingRad(segStart, segEnd);
  const into = target - cumulative[i - 1];
  const point = into <= 0 ? segStart : sphereOffset(segStart, into, bearing);
  return { point, bearing };
}

/**
 * A geodesic "axis of advance" arrow: a corridor `widthM` metres wide around
 * `lineLonLat` (`[lon, lat]` points, >= 2), flaring to a barbed head that
 * tapers to a point exactly at the line's last vertex. Every offset is a
 * true geodesic destination point (`ol/sphere`'s `offset`), so the corridor
 * is `widthM` wide on the ground at any latitude — a planar offset in Web
 * Mercator would be off by 1/cos(lat), ~1.5x at 50N. Returns a closed ring
 * of `[lon, lat]` points, or `null` when fewer than two distinct points are
 * given.
 */
export function axisOfAdvancePolygon(lineLonLat, widthM = 1000) {
  const points = dedupeAdjacent(lineLonLat);
  if (points.length < 2) return null;
  const halfWidth = widthM / 2;
  const headHalfWidth = widthM;

  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + getDistance(points[i - 1], points[i]));
  }
  const total = cumulative[cumulative.length - 1];
  const headLength = Math.min(widthM * 1.5, total * 0.4);
  const shoulderDistance = total - headLength;

  const left = [];
  const right = [];
  for (let i = 0; i + 1 < points.length && cumulative[i] < shoulderDistance; i++) {
    const bearing = bearingRad(points[i], points[i + 1]);
    left.push(sphereOffset(points[i], halfWidth, bearing - Math.PI / 2));
    right.push(sphereOffset(points[i], halfWidth, bearing + Math.PI / 2));
  }
  const shoulder = pointAtDistance(points, cumulative, shoulderDistance);
  left.push(sphereOffset(shoulder.point, halfWidth, shoulder.bearing - Math.PI / 2));
  right.push(sphereOffset(shoulder.point, halfWidth, shoulder.bearing + Math.PI / 2));

  const leftBarb = sphereOffset(shoulder.point, headHalfWidth, shoulder.bearing - Math.PI / 2);
  const rightBarb = sphereOffset(shoulder.point, headHalfWidth, shoulder.bearing + Math.PI / 2);
  const tip = points[points.length - 1];

  const ring = [...left, leftBarb, tip, rightBarb, ...right.reverse(), left[0]];
  return ring;
}

// -- range rings: geodesic circles about a point -----------------------------

/**
 * A geodesic ring `radiusMetres` from `centerLonLat` (`[lon, lat]`), as an
 * `ol/geom/Polygon` in EPSG:4326 — `circular` (`ol/geom/Polygon`) already
 * builds it from true geodesic offsets, so it is metres-accurate at any
 * latitude. Its first vertex sits due north of the centre.
 */
export function rangeRingGeometry(centerLonLat, radiusMetres, segments = 64) {
  return circular(centerLonLat, radiusMetres, segments);
}

// -- minefield fill: repeating small circles, no canvas pattern -------------

/** A grid of small circle markers clipped to the polygon: "repeating small circles" without a canvas pattern (keeps this DOM-free and testable). */
function minefieldDots(geometry, color) {
  const [minX, minY, maxX, maxY] = geometry.getExtent();
  const width = maxX - minX;
  const height = maxY - minY;
  if (!(width > 0) || !(height > 0)) return [];
  const cells = 6;
  const stepX = width / cells;
  const stepY = height / cells;
  const styles = [];
  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cells; col++) {
      const point = [minX + (col + 0.5) * stepX, minY + (row + 0.5) * stepY];
      if (geometry.containsXY(point[0], point[1])) {
        styles.push(
          new Style({
            geometry: new Point(point),
            image: new CircleStyle({
              radius: 2.5,
              fill: new Fill({ color }),
              stroke: new Stroke({ color: '#ffffff', width: 0.75 }),
            }),
          }),
        );
      }
    }
  }
  return styles;
}

// -- catalogue entries --------------------------------------------------

function lineEntry(displayLabel, prefix, { width = 2.5, dash = null } = {}) {
  return {
    label: displayLabel,
    geometry: 'line',
    labelFormat: (name) => (name ? `${prefix} ${name}` : prefix),
    style(feature, { color, darkBase, label }) {
      const geometry = feature.getGeometry();
      return [
        ...lineStyles(geometry, color, darkBase, { width, dash }),
        ...endpointLabels(geometry, label, color),
      ];
    },
  };
}

function areaEntry(displayLabel, prefix, { dash = null } = {}) {
  return {
    label: displayLabel,
    geometry: 'polygon',
    labelFormat: (name) => (name ? `${prefix} ${name}` : prefix),
    style(feature, { color, darkBase, label }) {
      const geometry = feature.getGeometry();
      const styles = [
        new Style({
          geometry,
          stroke: new Stroke({ color: casingColor(darkBase), width: 4, lineDash: dash }),
          fill: new Fill({ color: withAlpha(color, 0.16) }),
        }),
        new Style({ geometry, stroke: new Stroke({ color, width: 2, lineDash: dash }) }),
      ];
      const label2 = areaLabel(geometry, label, color);
      if (label2) styles.push(label2);
      return styles;
    },
  };
}

function obstacleEffectEntry(letter, displayLabel) {
  const glyphCount = 3;
  return {
    label: displayLabel,
    geometry: 'line',
    labelFormat: (name) => name || displayLabel,
    style(feature, { color, darkBase }) {
      const geometry = feature.getGeometry();
      const styles = lineStyles(geometry, color, darkBase, { width: 2.5 });
      for (let i = 1; i <= glyphCount; i++) {
        const fraction = i / (glyphCount + 1);
        const point = geometry.getCoordinateAt(fraction);
        const ahead = geometry.getCoordinateAt(Math.min(1, fraction + 0.01));
        const behind = geometry.getCoordinateAt(Math.max(0, fraction - 0.01));
        const rotation = Math.atan2(ahead[0] - behind[0], ahead[1] - behind[1]);
        styles.push(
          new Style({
            geometry: new Point(point),
            image: new RegularShape({
              points: 3,
              radius: 8,
              rotation,
              fill: new Fill({ color }),
              stroke: new Stroke({ color: casingColor(darkBase), width: 1.25 }),
              rotateWithView: true,
            }),
          }),
        );
      }
      styles.push(boxedLabel(geometry.getCoordinateAt(0.5), letter, color));
      return styles;
    },
  };
}

/**
 * `{ key: { label, geometry: 'line'|'polygon', labelFormat, style } }`.
 * `style(feature, { color, darkBase, label })` builds the `ol/style/Style`
 * array for a feature whose geometry is already in the map projection.
 * Colour follows the affiliation (`graphicColor`); casing keeps every
 * graphic legible on both the pale vector basemap and dark imagery.
 */
export const TACTICAL_GRAPHICS = {
  'phase-line': lineEntry('Phase line', 'PL'),
  boundary: {
    label: 'Boundary',
    geometry: 'line',
    labelFormat: (name) => name || 'Boundary',
    style(feature, { color, darkBase }) {
      const geometry = feature.getGeometry();
      const properties = feature.get('properties') || {};
      const styles = lineStyles(geometry, color, darkBase, { width: 2.5, dash: [14, 6, 2, 6] });
      if (properties.echelon) {
        const label = boxedLabel(
          geometry.getCoordinateAt(0.5),
          properties.echelon,
          color,
          MID_LABEL_FONT,
        );
        if (label) styles.push(label);
      }
      return styles;
    },
  },
  'axis-of-advance': {
    label: 'Axis of advance',
    geometry: 'line',
    labelFormat: (name) => name || 'Axis of advance',
    style(feature, { color, darkBase, label }) {
      const geometry = feature.getGeometry();
      const properties = feature.get('properties') || {};
      const widthM = Number(properties.width_m) > 0 ? Number(properties.width_m) : 1000;
      const lonLat = geometry.getCoordinates().map((c) => toLonLat(c));
      const ring = axisOfAdvancePolygon(lonLat, widthM);
      if (!ring) return lineStyles(geometry, color, darkBase);
      const polygon = ringToPolygon(ring);
      const styles = [
        new Style({
          geometry: polygon,
          stroke: new Stroke({ color: casingColor(darkBase), width: 3.5 }),
          fill: new Fill({ color: withAlpha(color, 0.26) }),
        }),
        new Style({ geometry: polygon, stroke: new Stroke({ color, width: 1.75 }) }),
      ];
      const label2 = areaLabel(polygon, label, color);
      if (label2) styles.push(label2);
      return styles;
    },
  },
  'direction-of-attack': {
    label: 'Direction of attack',
    geometry: 'line',
    labelFormat: (name) => name || 'Direction of attack',
    style(feature, { color, darkBase, label }) {
      const geometry = feature.getGeometry();
      const styles = lineStyles(geometry, color, darkBase, { width: 2.5 });
      const coordinates = geometry.getCoordinates();
      if (coordinates.length >= 2) {
        const [x2, y2] = coordinates[coordinates.length - 1];
        const [x1, y1] = coordinates[coordinates.length - 2];
        styles.push(
          new Style({
            geometry: new Point([x2, y2]),
            image: new RegularShape({
              points: 3,
              radius: 10,
              rotation: Math.atan2(x2 - x1, y2 - y1),
              fill: new Fill({ color }),
              stroke: new Stroke({ color: casingColor(darkBase), width: 1.5 }),
              rotateWithView: true,
            }),
          }),
        );
      }
      const mid = midpointLabel(geometry, label, color);
      if (mid) styles.push(mid);
      return styles;
    },
  },
  objective: areaEntry('Objective', 'OBJ'),
  'assembly-area': areaEntry('Assembly area', 'AA'),
  'battle-position': areaEntry('Battle position', 'BP'),
  'engagement-area': areaEntry('Engagement area', 'EA', { dash: [8, 5] }),
  minefield: {
    label: 'Minefield',
    geometry: 'polygon',
    labelFormat: (name) => name || 'Minefield',
    style(feature, { color, darkBase, label }) {
      const geometry = feature.getGeometry();
      const styles = [
        new Style({
          geometry,
          stroke: new Stroke({ color: casingColor(darkBase), width: 4, lineDash: [3, 3] }),
          fill: new Fill({ color: withAlpha(color, 0.1) }),
        }),
        new Style({ geometry, stroke: new Stroke({ color, width: 2, lineDash: [3, 3] }) }),
        ...minefieldDots(geometry, color),
      ];
      const label2 = areaLabel(geometry, label || 'M', color);
      if (label2) styles.push(label2);
      return styles;
    },
  },
  'obstacle-line': {
    label: 'Obstacle',
    geometry: 'line',
    labelFormat: (name) => name || 'Obstacle',
    style(feature, { color, darkBase, label }) {
      const geometry = feature.getGeometry();
      const zigzag = zigzagLineString(geometry);
      const styles = [
        new Style({
          geometry: zigzag,
          stroke: new Stroke({ color: casingColor(darkBase), width: 4 }),
        }),
        new Style({ geometry: zigzag, stroke: new Stroke({ color, width: 1.75 }) }),
      ];
      const mid = midpointLabel(geometry, label, color);
      if (mid) styles.push(mid);
      return styles;
    },
  },
  block: obstacleEffectEntry('B', 'Block'),
  fix: obstacleEffectEntry('F', 'Fix'),
  turn: obstacleEffectEntry('T', 'Turn'),
  disrupt: obstacleEffectEntry('D', 'Disrupt'),
};

/** `TACTICAL_GRAPHICS[key].labelFormat(name)`, or `name` for an unknown key. */
export function graphicLabel(key, name) {
  const entry = TACTICAL_GRAPHICS[key];
  return entry ? entry.labelFormat(name) : name || '';
}

/** `'line'` or `'polygon'` — the geometry type stored/drawn for `key`, or `null` when `key` is unknown. */
export function graphicGeometryType(key) {
  return TACTICAL_GRAPHICS[key]?.geometry ?? null;
}

// -- small geometry-only helpers shared by the entries above -----------------

function ringToPolygon(ringLonLat) {
  return new Polygon([ringLonLat.map((point) => fromLonLat(point))]);
}

/** A zigzag version of `geometry` (same map projection), for the obstacle-line glyph. */
function zigzagLineString(geometry, amplitude = 9, wavelength = 34) {
  const length = geometry.getLength();
  if (!(length > 0)) return geometry;
  const steps = Math.max(2, Math.round(length / (wavelength / 2)));
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const fraction = i / steps;
    const point = geometry.getCoordinateAt(fraction);
    const ahead = geometry.getCoordinateAt(Math.min(1, fraction + 0.01));
    const behind = geometry.getCoordinateAt(Math.max(0, fraction - 0.01));
    const dx = ahead[0] - behind[0];
    const dy = ahead[1] - behind[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const side = i === 0 || i === steps ? 0 : i % 2 === 0 ? 1 : -1;
    points.push([point[0] + nx * amplitude * side, point[1] + ny * amplitude * side]);
  }
  return new LineString(points);
}
