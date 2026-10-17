// Styles for drawn features: graphics, symbols, labels, range rings.

import { toLonLat } from 'ol/proj.js';
import { getCenter as extentCenter } from 'ol/extent.js';
import LineString from 'ol/geom/LineString.js';
import Polygon from 'ol/geom/Polygon.js';
import Point from 'ol/geom/Point.js';
import Style from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import Fill from 'ol/style/Fill.js';
import CircleStyle from 'ol/style/Circle.js';
import RegularShape from 'ol/style/RegularShape.js';
import TextStyle from 'ol/style/Text.js';
import IconStyle from 'ol/style/Icon.js';
import { formatMetres } from '../geo.js';
import { TACTICAL_GRAPHICS, graphicColor, graphicLabel, rangeRingGeometry } from '../tactical.js';
import { createSymbol } from '../symbols/symbol.js';
import { unitSymbolOptions } from '../symbols/unitProperties.js';

import { DATA_PROJECTION, MAP_PROJECTION, MAP_SYMBOL_INK } from './projection.js';

// -- Feature overlay style --------------------------------------------------

const LAYER_STYLE = {
  // Area of operations: solid and heavier; the area of interest around it dashed.
  ao: { color: '#ff7a3d', dash: null, width: 3, fillAlpha: 0 },
  aoi: { color: '#f2c94c', dash: [10, 6], width: 2, fillAlpha: 0 },
  mcoo: { color: '#8d6e63', dash: null, width: 1.5, fillAlpha: 0.18 },
  'key-terrain': { color: '#6d9c50', dash: null, width: 2.5, fillAlpha: 0.22 },
  avenue: { color: '#3d7ab8', dash: null, width: 4, fillAlpha: 0 },
  obstacle: { color: '#c0392b', dash: [6, 4], width: 2.5, fillAlpha: 0.25 },
  nai: { color: '#2f80ed', dash: [4, 3], width: 2, fillAlpha: 0.1 },
  tai: { color: '#eb5757', dash: [4, 3], width: 2, fillAlpha: 0.1 },
  coa: { color: '#27ae60', dash: null, width: 2, fillAlpha: 0.15 },
  threat: { color: '#eb3b5a', dash: null, width: 2, fillAlpha: 0.2 },
  note: { color: '#7f8c8d', dash: [2, 3], width: 1.5, fillAlpha: 0.1 },
  // Where the study's weather is read (step 1); highest/lowest ground hollow.
  weather: { color: '#0e7490', dash: null, width: 2, fillAlpha: 0 },
};

const DEFAULT_LAYER_STYLE = { color: '#546e7a', dash: null, width: 2, fillAlpha: 0.15 };

export function layerConfig(layerName) {
  return LAYER_STYLE[layerName] || DEFAULT_LAYER_STYLE;
}

export function withAlpha(color, alpha) {
  if (typeof color !== 'string' || !color.startsWith('#')) return color;
  const hex = color.slice(1);
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  const value = Number.parseInt(full, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function buildLabelText(label, geometryType) {
  return new TextStyle({
    text: label,
    font: '600 12px system-ui, sans-serif',
    fill: new Fill({ color: '#1b1b1b' }),
    stroke: new Stroke({ color: '#ffffff', width: 3 }),
    offsetY: geometryType === 'Point' ? -14 : 0,
    placement:
      geometryType === 'LineString' || geometryType === 'MultiLineString' ? 'line' : 'point',
    overflow: true,
  });
}

function labelAnchor(geometry) {
  if (geometry.getType() === 'Polygon' && typeof geometry.getInteriorPoint === 'function') {
    return geometry.getInteriorPoint();
  }
  return new Point(extentCenter(geometry.getExtent()));
}

function buildBoxLabelStyle(geometry, label, color) {
  return new Style({
    geometry: labelAnchor(geometry),
    text: new TextStyle({
      text: label,
      font: '700 11px system-ui, sans-serif',
      fill: new Fill({ color: '#1b1b1b' }),
      backgroundFill: new Fill({ color: 'rgba(255, 255, 255, 0.88)' }),
      backgroundStroke: new Stroke({ color, width: 1.5 }),
      padding: [3, 6, 3, 6],
    }),
  });
}

function buildArrowStyle(geometry, color) {
  const coordinates = geometry.getCoordinates();
  if (coordinates.length < 2) return null;
  const [x2, y2] = coordinates[coordinates.length - 1];
  const [x1, y1] = coordinates[coordinates.length - 2];
  const rotation = Math.atan2(x2 - x1, y2 - y1);
  return new Style({
    geometry: new Point([x2, y2]),
    image: new RegularShape({
      points: 3,
      radius: 9,
      rotation,
      fill: new Fill({ color }),
      rotateWithView: true,
    }),
  });
}

/** How far (screen px) a traced line may stray from the trace once simplified. */
export const TRACE_TOLERANCE_PX = 2;

/**
 * A traced line or area with only the vertices that matter at `tolerance`
 * (map units): Douglas–Peucker on the line or the area's outline. OL's own
 * Polygon simplify only quantizes, which keeps most points of a smooth trace.
 */
export function simplifyTrace(geometry, tolerance) {
  if (geometry.getType() !== 'Polygon') return geometry.simplify(tolerance);
  const outline = new LineString(geometry.getCoordinates()[0]).simplify(tolerance).getCoordinates();
  return outline.length >= 4 ? new Polygon([outline]) : geometry;
}

/** Map symbol sizes (milsymbol `size`, the frame's height in px), chosen per map. */
export const SYMBOL_SIZES = { small: 20, medium: 28, large: 40 };

/**
 * A cached milsymbol icon, keyed by every option that changes its pixels (a
 * shared cache keyed on sidc alone would leak one feature's designation,
 * DTG or fade onto every other feature drawn with the same code). The
 * planned/anticipated dashed frame is a field of the SIDC itself
 * (`src/symbols/sidc.js`'s `withStatus`), not a milsymbol render option —
 * milsymbol derives the frame purely from the code it is given.
 * `amplifiers` are milsymbol text/graphic amplifier options.
 */
export function milSymbolIcon(symbols, { sidc, amplifiers = {}, opacity = 1 }) {
  const { cache, size } = symbols;
  const key = `${sidc}|${size}|${opacity}|${JSON.stringify(amplifiers)}`;
  let icon = cache.get(key);
  if (!icon) {
    // Same APP-6 drawing as ORBAT and the picker; a canvas can't resolve the
    // shared default `currentColor`, so the amplifier text gets real ink.
    const symbol = createSymbol(sidc, { ...amplifiers, size, infoColor: MAP_SYMBOL_INK });
    const canvas = symbol.asCanvas();
    // The symbol's own insertion point, not the canvas centre: amplifier
    // text, an HQ staff or a direction arrow make the canvas lopsided.
    const anchor = symbol.getAnchor();
    icon = new IconStyle({
      img: canvas,
      imgSize: [canvas.width, canvas.height],
      anchor: [anchor.x, anchor.y],
      anchorXUnits: 'pixels',
      anchorYUnits: 'pixels',
      opacity,
    });
    cache.set(key, icon);
  }
  return icon;
}

/** A `symbol`-kind feature: the SIDC icon with its amplifiers
 * (`src/symbols/unitProperties.js`). The feature's label is drawn only when
 * no unique designation (T) already names it beside the frame. */
function buildSymbolStyle(properties, label, symbols) {
  const icon = milSymbolIcon(symbols, {
    sidc: properties.sidc,
    amplifiers: unitSymbolOptions(properties),
  });
  const text = label && !properties.designation ? buildLabelText(label, 'Point') : undefined;
  return new Style({ image: icon, text });
}

export function buildSelectionHalo(geometry) {
  const type = geometry.getType();
  if (type === 'Point' || type === 'MultiPoint') {
    return new Style({
      image: new CircleStyle({
        radius: 15,
        fill: new Fill({ color: 'rgba(255, 245, 157, 0.35)' }),
        stroke: new Stroke({ color: '#fff59d', width: 2 }),
      }),
    });
  }
  return new Style({ stroke: new Stroke({ color: '#fff59d', width: 7 }) });
}

/** A `graphic`-kind feature: `properties.graphic` looked up in `TACTICAL_GRAPHICS`. */
function buildGraphicStyle(feature, properties, label, darkBase) {
  const entry = TACTICAL_GRAPHICS[properties.graphic];
  if (!entry) return [];
  const color = graphicColor(properties.affiliation, darkBase);
  return entry.style(feature, { color, darkBase, label });
}

/** A `range-ring`-kind feature: one dashed geodesic circle per `properties.radii` metres, labelled at its north point. */
function buildRangeRingStyle(feature, properties, darkBase) {
  const radii = Array.isArray(properties.radii) ? properties.radii : [];
  if (!radii.length) return [];
  const center = toLonLat(feature.getGeometry().getCoordinates(), MAP_PROJECTION);
  const color = graphicColor(properties.affiliation, darkBase);
  const ringLabels = Array.isArray(properties.ringLabels) ? properties.ringLabels : [];
  const styles = [];
  radii.forEach((radiusM, index) => {
    const ring = rangeRingGeometry(center, radiusM).transform(DATA_PROJECTION, MAP_PROJECTION);
    styles.push(
      new Style({ geometry: ring, stroke: new Stroke({ color, width: 1.5, lineDash: [6, 4] }) }),
    );
    // circular()'s first vertex is due north of the centre — exactly the label anchor we want.
    const north = ring.getCoordinates()[0][0];
    const text = String(ringLabels[index] ?? formatMetres(radiusM));
    styles.push(
      new Style({
        geometry: new Point(north),
        text: new TextStyle({
          text,
          font: '700 11px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif',
          fill: new Fill({ color: '#1b1b1b' }),
          backgroundFill: new Fill({ color: 'rgba(255, 255, 255, 0.9)' }),
          backgroundStroke: new Stroke({ color, width: 1.25 }),
          padding: [1, 4, 1, 4],
          textBaseline: 'bottom',
          offsetY: -4,
        }),
      }),
    );
  });
  return styles;
}

export function buildFeatureStyle(feature, symbols, darkBase) {
  const layerName = feature.get('layer');
  const kind = feature.get('kind');
  const properties = feature.get('properties') || {};
  const label = feature.get('label');
  const geometry = feature.getGeometry();
  if (!geometry) return [];

  if (kind === 'graphic')
    return buildGraphicStyle(
      feature,
      properties,
      label || graphicLabel(properties.graphic, properties.name),
      darkBase,
    );
  if (kind === 'range-ring') return buildRangeRingStyle(feature, properties, darkBase);

  if (properties.sidc) {
    return [buildSymbolStyle(properties, label, symbols)];
  }

  const config = layerConfig(layerName);
  const color = properties.color || config.color;
  const geometryType = geometry.getType();
  const styles = [];
  // Suggestions not yet accepted: same colour as the layer, but hollow/dashed.
  const draft = properties.draft === true;

  if (geometryType === 'Point' || geometryType === 'MultiPoint') {
    styles.push(
      new Style({
        image: new CircleStyle({
          radius: 7,
          fill: new Fill({ color: draft ? 'rgba(255, 255, 255, 0.85)' : withAlpha(color, 0.9) }),
          stroke: draft
            ? new Stroke({ color, width: 2.5, lineDash: [3, 2] })
            : new Stroke({ color: '#1b1b1b', width: 1.5 }),
        }),
        text: label ? buildLabelText(label, 'Point') : undefined,
      }),
    );
    return styles;
  }

  styles.push(
    new Style({
      stroke: new Stroke({
        color: draft ? withAlpha(color, 0.85) : color,
        width: config.width,
        lineDash: draft ? [10, 6] : config.dash || undefined,
      }),
      fill: config.fillAlpha > 0 ? new Fill({ color: withAlpha(color, config.fillAlpha) }) : null,
      text:
        label && layerName !== 'nai' && layerName !== 'tai'
          ? buildLabelText(label, geometryType)
          : undefined,
    }),
  );

  if (
    layerName === 'avenue' &&
    (geometryType === 'LineString' || geometryType === 'MultiLineString')
  ) {
    const arrow = buildArrowStyle(geometry, color);
    if (arrow) styles.push(arrow);
  }

  if ((layerName === 'nai' || layerName === 'tai') && label) {
    styles.push(buildBoxLabelStyle(geometry, label, color));
  }

  return styles;
}
