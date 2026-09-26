// Geodesic distance/area/bearing measurement, drawn live on the map as
// vector styles (never persisted): a companion to `map.js`'s `startDraw`,
// mutually exclusive with it — `createMap` calls `stop()` here before
// starting a draw/modify, and `start()` here cancels any draw/modify first.
import { getArea, getDistance, getLength } from 'ol/sphere.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import Draw from 'ol/interaction/Draw.js';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import VectorSource from 'ol/source/Vector.js';
import VectorLayer from 'ol/layer/Vector.js';
import Style from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import Fill from 'ol/style/Fill.js';
import CircleStyle from 'ol/style/Circle.js';
import TextStyle from 'ol/style/Text.js';

const INK = '#e8793f'; // --signal: "active tool", matches the shell's own convention
const CASING = 'rgba(255, 255, 255, 0.88)';
const LABEL_FONT = '700 12px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif';

// -- pure helpers (no OL, no DOM) — exported for tests ----------------------

/** True bearing in degrees `[0, 360)` from `a` to `b` (`[lon, lat]` pairs), by the standard spherical formula. */
export function bearingDegrees(a, b) {
  const phi1 = (a[1] * Math.PI) / 180;
  const phi2 = (b[1] * Math.PI) / 180;
  const dLambda = ((b[0] - a[0]) * Math.PI) / 180;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const degrees = (Math.atan2(y, x) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** A true bearing in degrees, as NATO mils (6400 per circle), rounded and wrapped to `[0, 6400)`. */
export function bearingMils(degrees) {
  return Math.round((degrees / 360) * 6400) % 6400;
}

/** Below 1 km: whole metres; at or above: kilometres to 2 decimals. */
export function formatDistanceLabel(metres) {
  if (!Number.isFinite(metres)) return '—';
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(2)} km`;
}

/** Below 1 km² (100 ha): hectares to 2 decimals; at or above: km² to 2 decimals. */
export function formatAreaLabel(squareMetres) {
  if (!Number.isFinite(squareMetres)) return '—';
  const hectares = squareMetres / 10000;
  return hectares < 100 ? `${hectares.toFixed(2)} ha` : `${(squareMetres / 1e6).toFixed(2)} km²`;
}

function segmentsOf(lonLatCoordinates) {
  const segments = [];
  let total = 0;
  for (let i = 1; i < lonLatCoordinates.length; i++) {
    const distance = getDistance(lonLatCoordinates[i - 1], lonLatCoordinates[i]);
    segments.push({ from: lonLatCoordinates[i - 1], to: lonLatCoordinates[i], distance });
    total += distance;
  }
  return { segments, total };
}

function degreesLabel(degrees) {
  return String(Math.round(degrees) % 360).padStart(3, '0');
}

function milsLabel(mils) {
  return String(mils).padStart(4, '0');
}

// -- on-map "tooltip" styling: a boxed label, drawn as a Style, not a DOM overlay --

function boxedLabel(coordinate, text) {
  return new Style({
    geometry: new Point(coordinate),
    text: new TextStyle({
      text,
      font: LABEL_FONT,
      fill: new Fill({ color: '#1b1b1b' }),
      backgroundFill: new Fill({ color: 'rgba(255, 255, 255, 0.92)' }),
      backgroundStroke: new Stroke({ color: INK, width: 1.25 }),
      padding: [3, 6, 3, 6],
      offsetY: -10,
    }),
  });
}

function lineStyles(geometry, fill) {
  return [
    new Style({ geometry, stroke: new Stroke({ color: CASING, width: 5 }) }),
    new Style({
      geometry,
      stroke: new Stroke({ color: INK, width: 2, lineDash: [2, 5] }),
      fill,
      image: new CircleStyle({
        radius: 4,
        fill: new Fill({ color: INK }),
        stroke: new Stroke({ color: '#ffffff', width: 1.25 }),
      }),
    }),
  ];
}

/** `computeResult`'s payload, plus the live/finished `ol/style/Style` array for the sketch feature. */
function distanceResult(geometry, done) {
  const lonLat = geometry.getCoordinates().map((c) => toLonLat(c));
  const { segments, total } = segmentsOf(lonLat);
  const result = {
    mode: 'distance',
    segments: segments.map((segment) => ({ ...segment, label: formatDistanceLabel(segment.distance) })),
    total,
    totalLabel: formatDistanceLabel(total),
    done,
  };
  const coordinates = geometry.getCoordinates();
  const styles = lineStyles(geometry);
  result.segments.forEach((segment, index) => {
    const midpoint = [
      (coordinates[index][0] + coordinates[index + 1][0]) / 2,
      (coordinates[index][1] + coordinates[index + 1][1]) / 2,
    ];
    styles.push(boxedLabel(midpoint, segment.label));
  });
  if (coordinates.length >= 2) {
    styles.push(boxedLabel(coordinates[coordinates.length - 1], `Σ ${result.totalLabel}`));
  }
  return { result, styles };
}

function areaResult(geometry, done) {
  const area = Math.abs(getArea(geometry));
  const perimeter = getLength(geometry);
  const result = {
    mode: 'area',
    area,
    areaLabel: formatAreaLabel(area),
    perimeter,
    perimeterLabel: formatDistanceLabel(perimeter),
    done,
  };
  const styles = lineStyles(geometry, new Fill({ color: 'rgba(232, 121, 63, 0.16)' }));
  styles.push(boxedLabel(geometry.getInteriorPoint().getCoordinates(), result.areaLabel));
  return { result, styles };
}

/**
 * Live geodesic distance/area/bearing measurement on `map` (an `ol/Map`),
 * drawn as boxed on-map labels (never DOM overlays, so `exportCanvas`-style
 * canvas compositing would see them too, though nothing here is meant to be
 * printed). `start({ mode, onResult })`: `'distance'|'area'` sketch like
 * `startDraw` (double-click finishes one measurement and immediately arms
 * the next); `'bearing'` is click-A, click-B, repeatable the same way.
 * `onResult` fires on every change (`done: false`) and once finished
 * (`done: true`) with a mode-specific payload:
 *   distance  `{ segments: [{from,to,distance,label}], total, totalLabel }`
 *   area      `{ area, areaLabel, perimeter, perimeterLabel }`
 *   bearing   `{ from, to, degrees, degreesLabel, mils, milsLabel, distance, distanceLabel }`
 * `stop()` (also Escape, or right-click on the map) removes every
 * measurement and interaction; nothing is ever saved.
 */
export function createMeasureController(map) {
  const source = new VectorSource();
  const layer = new VectorLayer({ source, zIndex: 50 });
  map.addLayer(layer);

  let mode = null;
  let onResult = null;
  let draw = null;
  let bearingStart = null;
  let cleanupBearing = null;

  function emit(payload) {
    if (onResult) onResult(payload);
  }

  function removeDraw() {
    if (!draw) return;
    map.removeInteraction(draw);
    draw = null;
  }

  function removeBearing() {
    if (cleanupBearing) cleanupBearing();
    cleanupBearing = null;
    bearingStart = null;
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') stop();
  }

  function armLineOrArea(nextMode) {
    const type = nextMode === 'area' ? 'Polygon' : 'LineString';
    const build = nextMode === 'area' ? areaResult : distanceResult;
    draw = new Draw({
      source,
      type,
      // Draw's overlay also carries helper features (a cursor Point, and for
      // a polygon a tracing LineString) through this same style function —
      // only the sketch's own geometry type gets the full measurement style.
      style: (feature) => {
        const geometry = feature.getGeometry();
        return geometry.getType() === type ? build(geometry, false).styles : undefined;
      },
    });
    draw.on('drawstart', (event) => {
      const geometry = event.feature.getGeometry();
      geometry.on('change', () => emit(build(geometry, false).result));
    });
    draw.on('drawend', (event) => {
      const geometry = event.feature.getGeometry();
      const { result, styles } = build(geometry, true);
      event.feature.setStyle(styles);
      emit(result);
      map.removeInteraction(draw);
      if (mode === nextMode) armLineOrArea(nextMode);
    });
    map.addInteraction(draw);
  }

  function bearingPreview(from, toMapCoordinate, done) {
    const to = toLonLat(toMapCoordinate);
    const degrees = bearingDegrees(from, to);
    const mils = bearingMils(degrees);
    const distance = getDistance(from, to);
    const result = {
      mode: 'bearing',
      from,
      to,
      degrees,
      degreesLabel: degreesLabel(degrees),
      mils,
      milsLabel: milsLabel(mils),
      distance,
      distanceLabel: formatDistanceLabel(distance),
      done,
    };
    const line = new Feature(new LineString([fromLonLat(from), toMapCoordinate]));
    line.setStyle([
      ...lineStyles(line.getGeometry()),
      boxedLabel(toMapCoordinate, `${result.degreesLabel}° / ${result.milsLabel} mils — ${result.distanceLabel}`),
    ]);
    return { result, line };
  }

  function armBearing() {
    function handleClick(event) {
      if (!bearingStart) {
        bearingStart = toLonLat(event.coordinate);
        return;
      }
      const { result, line } = bearingPreview(bearingStart, event.coordinate, true);
      source.clear(true);
      source.addFeature(line);
      bearingStart = null;
      emit(result);
    }
    function handleMove(event) {
      if (!bearingStart) return;
      const { result, line } = bearingPreview(bearingStart, event.coordinate, false);
      source.clear(true);
      source.addFeature(line);
      emit(result);
    }
    map.on('singleclick', handleClick);
    map.on('pointermove', handleMove);
    cleanupBearing = () => {
      map.un('singleclick', handleClick);
      map.un('pointermove', handleMove);
    };
  }

  /** Starts measuring; any previous measurement (or draw/modify — see `map.js`) stops first. */
  function start({ mode: nextMode, onResult: nextOnResult }) {
    stop();
    if (nextMode !== 'distance' && nextMode !== 'area' && nextMode !== 'bearing') {
      throw new Error(`createMeasureController: unknown mode "${nextMode}"`);
    }
    mode = nextMode;
    onResult = nextOnResult;
    window.addEventListener('keydown', handleKeydown);
    if (nextMode === 'bearing') armBearing();
    else armLineOrArea(nextMode);
  }

  /** Stops measuring and clears every on-map label; safe to call when idle. */
  function stop() {
    if (!mode) return;
    window.removeEventListener('keydown', handleKeydown);
    removeDraw();
    removeBearing();
    source.clear(true);
    mode = null;
    onResult = null;
  }

  function isActive() {
    return mode !== null;
  }

  function destroy() {
    stop();
    map.removeLayer(layer);
    source.clear(true);
  }

  return { start, stop, isActive, destroy };
}
