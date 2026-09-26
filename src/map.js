// Tactical map engine on top of OpenLayers 10. All public coordinates are
// lon/lat (EPSG:4326); the view itself runs in EPSG:3857 internally.
import { Map as OlMap, View } from 'ol';
import { unByKey } from 'ol/Observable.js';
import { fromLonLat, getPointResolution, toLonLat, transformExtent } from 'ol/proj.js';
import { buffer as bufferExtent, getCenter as extentCenter, getWidth } from 'ol/extent.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import VectorLayer from 'ol/layer/Vector.js';
import ImageLayer from 'ol/layer/Image.js';
import TileLayer from 'ol/layer/Tile.js';
import LayerGroup from 'ol/layer/Group.js';
import ImageTileSource from 'ol/source/ImageTile.js';
import VectorSource from 'ol/source/Vector.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import XYZ from 'ol/source/XYZ.js';
import { createXYZ } from 'ol/tilegrid.js';
import ImageCanvasSource from 'ol/source/ImageCanvas.js';
import { PMTilesVectorSource } from 'ol-pmtiles';
import Draw from 'ol/interaction/Draw.js';
import Modify from 'ol/interaction/Modify.js';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import Style from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import Fill from 'ol/style/Fill.js';
import CircleStyle from 'ol/style/Circle.js';
import RegularShape from 'ol/style/RegularShape.js';
import TextStyle from 'ol/style/Text.js';
import IconStyle from 'ol/style/Icon.js';
import { defaults as defaultControls, ScaleLine } from 'ol/control.js';

import { buildMgrsGrid, mgrsGridSpacing } from './mgrsGrid.js';
import { downwindRotation, recolourCloudMask, wmsTileUrl } from './weather.js';
import { formatMetres } from './geo.js';
import { formatDtg } from './dtg.js';
import { TACTICAL_GRAPHICS, graphicColor, graphicLabel, rangeRingGeometry } from './tactical.js';
import { createMeasureController } from './measure.js';
import { withStatus } from './symbols/sidc.js';
import { createSymbol } from './symbols/symbol.js';

const MAP_PROJECTION = 'EPSG:3857';
/** Amplifier text on map symbols; the symbols' light outline carries it on dark imagery. */
const MAP_SYMBOL_INK = '#1b1b1b';
const DATA_PROJECTION = 'EPSG:4326';
const GEOJSON_OPTIONS = { featureProjection: MAP_PROJECTION, dataProjection: DATA_PROJECTION };

const DRAW_GEOMETRY_TYPE = { point: 'Point', line: 'LineString', polygon: 'Polygon' };

// -- Basemap style (muted OpenMapTiles backdrop) ---------------------------

const ROAD_WIDTH = {
  motorway: 3.2,
  trunk: 2.8,
  primary: 2.4,
  secondary: 2,
  tertiary: 1.6,
  minor: 1.2,
  service: 1,
  path: 0.8,
  rail: 1.2,
};
const ROAD_COLOR = {
  motorway: '#d5a56b',
  trunk: '#dcb48d',
  primary: '#e6ceac',
  secondary: '#e9ddc6',
  tertiary: '#ede7d7',
  minor: '#f0ebe1',
  service: '#efeae0',
  path: '#c9c2b0',
  rail: '#a6a096',
};

const WATER_STYLE = new Style({ fill: new Fill({ color: '#b7c9d8' }) });
const WATERWAY_STYLE = new Style({ stroke: new Stroke({ color: '#b7c9d8', width: 1.4 }) });
const WOOD_STYLE = new Style({ fill: new Fill({ color: '#cbd8c1' }) });
const LANDUSE_STYLE = new Style({ fill: new Fill({ color: '#e7e2d6' }) });
const BUILDING_STYLE = new Style({
  fill: new Fill({ color: '#dcd5c6' }),
  stroke: new Stroke({ color: '#cfc6b3', width: 0.5 }),
});
/**
 * Military land, in every vector style, is an outline only. OSM wraps a whole
 * training area in one `landuse=military` polygon; filling or hatching it
 * (as OpenTopoMap does) hides the terrain inside, which is what IPB reads.
 */
const MILITARY_OUTLINE = new Style({
  stroke: new Stroke({ color: 'rgba(142, 63, 160, 0.9)', width: 2, lineDash: [12, 5] }),
});
const BOUNDARY_STYLE_CACHE = new Map();
const ROAD_STYLE_CACHE = new Map();

function boundaryStyle(adminLevel) {
  const level = Number(adminLevel) || 10;
  const key = level <= 2 ? 2 : 10;
  if (!BOUNDARY_STYLE_CACHE.has(key)) {
    BOUNDARY_STYLE_CACHE.set(
      key,
      new Style({
        stroke: new Stroke({
          color: 'rgba(150, 130, 165, 0.55)',
          width: key === 2 ? 1.6 : 1,
          lineDash: key === 2 ? undefined : [4, 4],
        }),
      }),
    );
  }
  return BOUNDARY_STYLE_CACHE.get(key);
}

function roadStyle(roadClass) {
  const key = ROAD_WIDTH[roadClass] ? roadClass : 'minor';
  if (!ROAD_STYLE_CACHE.has(key)) {
    ROAD_STYLE_CACHE.set(
      key,
      new Style({ stroke: new Stroke({ color: ROAD_COLOR[key], width: ROAD_WIDTH[key] }) }),
    );
  }
  return ROAD_STYLE_CACHE.get(key);
}

function basemapStyle(feature) {
  const sourceLayer = feature.get('layer');
  switch (sourceLayer) {
    case 'water':
      return WATER_STYLE;
    case 'waterway':
      return WATERWAY_STYLE;
    case 'landcover':
      return feature.get('class') === 'wood' || feature.get('class') === 'forest'
        ? WOOD_STYLE
        : undefined;
    case 'landuse':
      return feature.get('class') === 'military' ? MILITARY_OUTLINE : LANDUSE_STYLE;
    case 'building':
      return BUILDING_STYLE;
    case 'transportation':
      return roadStyle(feature.get('class'));
    case 'boundary':
      return boundaryStyle(feature.get('admin_level'));
    default:
      return undefined;
  }
}

// -- Topographic style (the "Topo" basemap) -----------------------------------

const fillStyle = (color) => new Style({ fill: new Fill({ color }) });

/**
 * Land cover by OpenMapTiles class. Drawn in full, because inside a training
 * area this is the ground truth an analyst reads: forest, meadow, wetland.
 */
const TOPO_LANDCOVER = {
  wood: fillStyle('#c9ddb3'),
  grass: fillStyle('#e3ecd3'),
  wetland: fillStyle('#d6e9e4'),
  farmland: fillStyle('#f3f0e3'),
  sand: fillStyle('#eee6d3'),
  rock: fillStyle('#e3e0da'),
  ice: fillStyle('#eef4f8'),
};
const TOPO_SCRUB = fillStyle('#d6e2c1');
const TOPO_LANDUSE = {
  residential: fillStyle('#ebe4dc'),
  suburb: fillStyle('#ebe4dc'),
  commercial: fillStyle('#e6e1e1'),
  industrial: fillStyle('#e3e0e0'),
  retail: fillStyle('#e6e1e1'),
  railway: fillStyle('#e3e0e0'),
  quarry: fillStyle('#e2ddd3'),
  cemetery: fillStyle('#dde6d6'),
};
const TOPO_WATER = fillStyle('#b5d0ea');
const TOPO_WATER_INK = '#6d9fd3';
const TOPO_WATERWAY = {
  river: new Style({ stroke: new Stroke({ color: TOPO_WATER_INK, width: 1.8 }) }),
  canal: new Style({ stroke: new Stroke({ color: TOPO_WATER_INK, width: 1.2 }) }),
  stream: new Style({ stroke: new Stroke({ color: TOPO_WATER_INK, width: 0.9 }) }),
  ditch: new Style({ stroke: new Stroke({ color: TOPO_WATER_INK, width: 0.6 }) }),
};
const TOPO_BUILDING = new Style({
  fill: new Fill({ color: '#cfc5b8' }),
  stroke: new Stroke({ color: '#b9ad9d', width: 0.5 }),
});
const TOPO_TRACK_INK = '#8b6b3f';
/** zIndex keeps every casing under every road fill, so junctions stay clean. */
const TOPO_ROAD_FILL = {
  motorway: '#e3a56a',
  trunk: '#ecc07e',
  primary: '#f4d493',
  secondary: '#f7e6a8',
  tertiary: '#ffffff',
  minor: '#ffffff',
  service: '#ffffff',
};
const TOPO_TRANSPORT_CACHE = new Map();

function topoTransportStyle(roadClass) {
  if (TOPO_TRANSPORT_CACHE.has(roadClass)) return TOPO_TRANSPORT_CACHE.get(roadClass);
  let style;
  if (roadClass === 'track') {
    style = new Style({
      stroke: new Stroke({ color: TOPO_TRACK_INK, width: 1.1, lineDash: [5, 3] }),
      zIndex: 3,
    });
  } else if (roadClass === 'path') {
    style = new Style({
      stroke: new Stroke({ color: TOPO_TRACK_INK, width: 1, lineDash: [1.5, 2.5] }),
      zIndex: 3,
    });
  } else if (roadClass === 'rail' || roadClass === 'transit') {
    style = [
      new Style({ stroke: new Stroke({ color: '#6b6b6b', width: 2 }), zIndex: 3 }),
      new Style({
        stroke: new Stroke({ color: '#ffffff', width: 1, lineDash: [6, 6] }),
        zIndex: 4,
      }),
    ];
  } else {
    const key = TOPO_ROAD_FILL[roadClass] ? roadClass : 'minor';
    style = [
      new Style({
        stroke: new Stroke({ color: '#8f8676', width: ROAD_WIDTH[key] + 1.4 }),
        zIndex: 1,
      }),
      new Style({
        stroke: new Stroke({ color: TOPO_ROAD_FILL[key], width: ROAD_WIDTH[key] }),
        zIndex: 2,
      }),
    ];
  }
  TOPO_TRANSPORT_CACHE.set(roadClass, style);
  return style;
}

function topoStyle(feature) {
  const kind = feature.get('class');
  switch (feature.get('layer')) {
    case 'landcover':
      if (kind === 'grass' && feature.get('subclass') === 'scrub') return TOPO_SCRUB;
      return TOPO_LANDCOVER[kind];
    case 'landuse':
      return kind === 'military' ? MILITARY_OUTLINE : TOPO_LANDUSE[kind];
    case 'water':
      return TOPO_WATER;
    case 'waterway':
      return TOPO_WATERWAY[kind] ?? TOPO_WATERWAY.ditch;
    case 'building':
      return TOPO_BUILDING;
    case 'transportation':
      return topoTransportStyle(kind);
    case 'boundary':
      return boundaryStyle(feature.get('admin_level'));
    default:
      return undefined;
  }
}

// -- Reference overlays: roads & water, place names, contours ------------------

/** Basemap roads with a dark casing, water as outlines, so imagery stays visible. */
const HYBRID_STYLE_CACHE = new Map();
const HYBRID_WATER_COLOR = '#7fb2e5';
const HYBRID_WATERWAY_STYLE = new Style({
  stroke: new Stroke({ color: HYBRID_WATER_COLOR, width: 1.4 }),
});
const HYBRID_WATER_STYLE = new Style({
  stroke: new Stroke({ color: HYBRID_WATER_COLOR, width: 1 }),
  fill: new Fill({ color: 'rgba(127, 178, 229, 0.25)' }),
});

function hybridStyle(feature) {
  const layer = feature.get('layer');
  if (layer === 'waterway') return HYBRID_WATERWAY_STYLE;
  if (layer === 'water') return HYBRID_WATER_STYLE;
  if (layer !== 'transportation') return undefined;
  const key = ROAD_WIDTH[feature.get('class')] ? feature.get('class') : 'minor';
  if (!HYBRID_STYLE_CACHE.has(key)) {
    HYBRID_STYLE_CACHE.set(key, [
      new Style({
        stroke: new Stroke({ color: 'rgba(0, 0, 0, 0.5)', width: ROAD_WIDTH[key] + 1.6 }),
      }),
      new Style({ stroke: new Stroke({ color: ROAD_COLOR[key], width: ROAD_WIDTH[key] }) }),
    ]);
  }
  return HYBRID_STYLE_CACHE.get(key);
}

const LABEL_HALO = new Stroke({ color: 'rgba(255, 255, 255, 0.92)', width: 3 });

/** One reusable style per label class; the text is set per feature at render time. */
function labelStyle(font, color) {
  return new Style({
    text: new TextStyle({ font, fill: new Fill({ color }), stroke: LABEL_HALO, overflow: true }),
  });
}

const PLACE_LABEL = {
  city: labelStyle('700 15px system-ui, sans-serif', '#1b1b1b'),
  town: labelStyle('700 13px system-ui, sans-serif', '#1b1b1b'),
  village: labelStyle('600 12px system-ui, sans-serif', '#262626'),
  minor: labelStyle('500 11px system-ui, sans-serif', '#3a3a3a'),
  peak: labelStyle('600 11px system-ui, sans-serif', '#5a3d1e'),
  water: labelStyle('italic 500 11px system-ui, sans-serif', '#2f5d8a'),
};
/**
 * Real labels a scenario leaves unmatched, shown only in the Exercise
 * editor: grey and italic, so they read as "not this war" but
 * stay clickable to rename.
 */
const DIMMED_PLACE_LABEL = {
  city: labelStyle('italic 700 15px system-ui, sans-serif', '#8b98a0'),
  town: labelStyle('italic 700 13px system-ui, sans-serif', '#8b98a0'),
  village: labelStyle('italic 600 12px system-ui, sans-serif', '#8b98a0'),
  minor: labelStyle('italic 500 11px system-ui, sans-serif', '#8b98a0'),
  peak: labelStyle('italic 600 11px system-ui, sans-serif', '#8b98a0'),
  water: labelStyle('italic 500 11px system-ui, sans-serif', '#8b98a0'),
};
/** Hamlets and neighbourhoods only from about zoom 13, or they bury villages. */
const MINOR_PLACE_MAX_RESOLUTION = 20;

/**
 * Which `PLACE_LABEL`/`DIMMED_PLACE_LABEL` bucket a place/peak/water-name
 * feature falls into (`styleKind`), its real name, and the place class a
 * scenario place record uses (`placeKind`: the basemap's own class for
 * `place` features, or `'peak'`/`'water'`) — shared by the plain label
 * style below and by the scenario-aware one in `createMap`.
 */
function resolvePlaceClass(feature, resolution) {
  const name = feature.get('name');
  if (!name) return null;
  switch (feature.get('layer')) {
    case 'place': {
      const cls = feature.get('class');
      if (cls === 'city' || cls === 'town' || cls === 'village') {
        return { styleKind: cls, placeKind: cls, name };
      }
      if (resolution <= MINOR_PLACE_MAX_RESOLUTION) {
        return { styleKind: 'minor', placeKind: cls || 'minor', name };
      }
      return null;
    }
    case 'mountain_peak':
      return { styleKind: 'peak', placeKind: 'peak', name, ele: feature.get('ele') };
    case 'water_name':
      return { styleKind: 'water', placeKind: 'water', name };
    default:
      return null;
  }
}

/**
 * A vector-tile feature's representative lon/lat: the point itself, or the
 * extent's centre for a line/polygon. These features render as
 * `ol/render/Feature`, whose `getGeometry()` returns itself rather than a
 * real Geometry (no `getCoordinates()`) — so this reads flat coordinates
 * and the extent off the feature directly instead of through that.
 */
function featureLonLat(feature) {
  const coordinate =
    feature.getType() === 'Point'
      ? feature.getFlatCoordinates().slice(0, 2)
      : extentCenter(feature.getExtent());
  return toLonLat(coordinate, MAP_PROJECTION);
}

/** Place, peak and water names from an OpenMapTiles-schema basemap. */
function placeLabelStyle(feature, resolution) {
  const resolved = resolvePlaceClass(feature, resolution);
  if (!resolved) return undefined;
  const style = PLACE_LABEL[resolved.styleKind];
  const text =
    resolved.styleKind === 'peak'
      ? `▲ ${resolved.name}${resolved.ele ? ` ${resolved.ele} m` : ''}`
      : resolved.name;
  style.getText().setText(text);
  return style;
}

/** Contour inks for a pale basemap and for dark imagery. */
const CONTOUR_TONES = {
  dark: { line: 'rgba(140, 90, 45, 0.55)', index: 'rgba(140, 90, 45, 0.9)', halo: '#ffffff' },
  light: {
    line: 'rgba(255, 214, 160, 0.55)',
    index: 'rgba(255, 214, 160, 0.95)',
    halo: 'rgba(0, 0, 0, 0.75)',
  },
};

function contourStyles(tone) {
  const ink = CONTOUR_TONES[tone];
  return {
    line: new Style({ stroke: new Stroke({ color: ink.line, width: 0.7 }) }),
    index: new Style({
      stroke: new Stroke({ color: ink.index, width: 1.3 }),
      text: new TextStyle({
        font: '600 10px "Cascadia Mono", "IBM Plex Mono", ui-monospace, monospace',
        placement: 'line',
        fill: new Fill({ color: ink.index }),
        stroke: new Stroke({ color: ink.halo, width: 3 }),
      }),
    }),
  };
}
const CONTOUR_STYLE = { dark: contourStyles('dark'), light: contourStyles('light') };

// -- Feature overlay style --------------------------------------------------

const LAYER_STYLE = {
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

function layerConfig(layerName) {
  return LAYER_STYLE[layerName] || DEFAULT_LAYER_STYLE;
}

function withAlpha(color, alpha) {
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

/**
 * A cached milsymbol icon, keyed by every option that changes its pixels (a
 * shared cache keyed on sidc alone would leak one feature's designation,
 * DTG or fade onto every other feature drawn with the same code). The
 * planned/anticipated dashed frame is a field of the SIDC itself
 * (`src/symbols/sidc.js`'s `withStatus`), not a milsymbol render option —
 * milsymbol derives the frame purely from the code it is given.
 */
function milSymbolIcon(iconCache, { sidc, size = 28, designation, dtg, opacity = 1 }) {
  const key = `${sidc}|${size}|${designation || ''}|${dtg || ''}|${opacity}`;
  let icon = iconCache.get(key);
  if (!icon) {
    // Same APP-6 drawing as ORBAT and the picker; a canvas can't resolve the
    // shared default `currentColor`, so the amplifier text gets real ink.
    const canvas = createSymbol(sidc, {
      size,
      uniqueDesignation: designation,
      dtg,
      infoColor: MAP_SYMBOL_INK,
    }).asCanvas();
    icon = new IconStyle({ img: canvas, imgSize: [canvas.width, canvas.height], opacity });
    iconCache.set(key, icon);
  }
  return icon;
}

/** A `symbol`-kind feature: the SIDC icon, plus optional `designation`/`dtg` milsymbol modifiers. */
function buildSymbolStyle(properties, label, iconCache) {
  const icon = milSymbolIcon(iconCache, {
    sidc: properties.sidc,
    designation: properties.designation,
    dtg: properties.dtg,
  });
  return new Style({ image: icon, text: label ? buildLabelText(label, 'Point') : undefined });
}

function buildSelectionHalo(geometry) {
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

function buildFeatureStyle(feature, iconCache, darkBase) {
  const layerName = feature.get('layer');
  const kind = feature.get('kind');
  const properties = feature.get('properties') || {};
  const label = feature.get('label');
  const geometry = feature.getGeometry();
  if (!geometry) return [];

  if (kind === 'graphic') return buildGraphicStyle(feature, properties, label || graphicLabel(properties.graphic, properties.name), darkBase);
  if (kind === 'range-ring') return buildRangeRingStyle(feature, properties, darkBase);

  if (properties.sidc) {
    return [buildSymbolStyle(properties, label, iconCache)];
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

// -- Situation overlay style (setSituation: Exercise's current tracks/reports) --

const TRACK_ICON_SIZE = 30;
/** `destroyed`/`lost` tracks fade instead of disappearing — still on the map, marked as no longer live. */
const TRACK_FADED_OPACITY = 0.4;
const SITUATION_LABEL_FONT = '700 11px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif';
/** Report labels hide below this (OL "256px tile" resolution at zoom 12), so a busy situation doesn't bury the basemap when zoomed out. */
const REPORT_LABEL_MAX_RESOLUTION = 38.22;
const REPORT_INK = '#e6c229';

/** A track's icon: designation + DTG via milsymbol modifiers, `suspected` dashed (planned), `destroyed`/`lost` faded. */
function situationTrackStyle(feature, iconCache) {
  const track = feature.get('track');
  const opacity = track.status === 'destroyed' || track.status === 'lost' ? TRACK_FADED_OPACITY : 1;
  const sidc = track.status === 'suspected' ? withStatus(track.sidc, 'planned') : track.sidc;
  const icon = milSymbolIcon(iconCache, {
    sidc,
    size: TRACK_ICON_SIZE,
    designation: track.designation,
    dtg: track.observed_at ? formatDtg(new Date(track.observed_at).getTime()) : undefined,
    opacity,
  });
  return new Style({ image: icon });
}

const SITUATION_HISTORY_STYLE = new Style({
  stroke: new Stroke({ color: '#546e7a', width: 1.5, lineDash: [3, 4] }),
});
const SITUATION_HISTORY_DOT_STYLE = new Style({
  image: new CircleStyle({ radius: 2.5, fill: new Fill({ color: '#546e7a' }) }),
});

/** A report marker: a rotated square, filled by credibility (1-2 solid, 3 medium, 4-6 hollow). */
function situationReportStyle(feature, resolution) {
  const report = feature.get('report');
  const fillAlpha = report.credibility <= 2 ? 0.9 : report.credibility === 3 ? 0.45 : 0;
  const styles = [
    new Style({
      image: new RegularShape({
        points: 4,
        radius: 7,
        angle: Math.PI / 4,
        fill: new Fill({ color: withAlpha(REPORT_INK, fillAlpha) }),
        stroke: new Stroke({ color: REPORT_INK, width: 1.75 }),
      }),
    }),
  ];
  if (resolution <= REPORT_LABEL_MAX_RESOLUTION) {
    styles.push(
      new Style({
        text: new TextStyle({
          text: (report.report_type || 'report').toUpperCase(),
          font: SITUATION_LABEL_FONT,
          offsetY: -14,
          fill: new Fill({ color: '#1b1b1b' }),
          stroke: new Stroke({ color: '#ffffff', width: 3 }),
        }),
      }),
    );
  }
  return styles;
}

// -- Scenario overlay style (Exercise "Geography" fictional countries) -----

/** Great-circle distance in km; good enough for the ≤5 km name-match rule. */
function haversineKm(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Scenario places bucketed by lowercased real name, for a fast lookup before
 * the distance check. Exported so the Exercise "Geography" editor can run
 * the same match rule when a clicked real label is already
 * renamed, instead of guessing from `scenario.places` itself.
 */
export function buildScenarioNameIndex(scenario) {
  const index = new Map();
  if (!scenario) return index;
  for (const place of scenario.places) {
    const key = place.real_name.trim().toLowerCase();
    const bucket = index.get(key);
    if (bucket) bucket.push(place);
    else index.set(key, [place]);
  }
  return index;
}

/**
 * Match rule: same name (case/trim-insensitive), ≤5 km apart.
 * The name lookup narrows to a handful of candidates before any distance
 * math runs, which is what keeps this affordable per rendered label.
 */
export function matchScenarioPlace(index, name, lon, lat) {
  if (!name) return null;
  const bucket = index.get(name.trim().toLowerCase());
  if (!bucket) return null;
  return bucket.find((place) => haversineKm(lon, lat, place.lon, place.lat) <= 5) ?? null;
}

/** "Arnland" -> "A R N L A N D": crude letter-spacing, canvas text has none. */
function letterSpaced(text) {
  return text.toLocaleUpperCase().split('').join('\u2009');
}

const COUNTRY_LABEL_FONT = '700 13px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif';
/** Dark ink over the pale vector basemap, light ink over dark imagery — same pairing as MGRS/contours. */
const COUNTRY_TONE = {
  dark: {
    label: '#1b1b1b',
    halo: 'rgba(255, 255, 255, 0.92)',
    casing: 'rgba(255, 255, 255, 0.9)',
  },
  light: { label: '#ffffff', halo: 'rgba(8, 12, 16, 0.85)', casing: 'rgba(8, 12, 16, 0.85)' },
};

/**
 * A point safely inside a Polygon or MultiPolygon, for a country's label —
 * `getInteriorPoint()` only exists on `Polygon`; for a MultiPolygon (most
 * countries here, unioned from several kraje/okresy) this uses the largest
 * constituent polygon's interior point, so the label sits in the biggest
 * landmass rather than a sliver.
 */
function geometryAnchor(geometry) {
  if (geometry.getType() === 'Polygon') return geometry.getInteriorPoint().getCoordinates();
  const largest = geometry
    .getPolygons()
    .reduce(
      (best, polygon) => (!best || polygon.getArea() > best.getArea() ? polygon : best),
      null,
    );
  return largest.getInteriorPoint().getCoordinates();
}

/** EPSG:3857 resolution (m/px) → the usual 256px-tile zoom level, for style
 * functions that only get a resolution — same tile grid this map uses
 * everywhere else (`createXYZ()`'s default). */
function resolutionToZoom(resolution) {
  return Math.log2(156543.03392804097 / resolution);
}

const COUNTRY_FILL_MAX_ALPHA = 0.16;
/** Full fill at/below this zoom, fading to none by the zoom above: inside
 * one country the whole map isn't tinted once zoomed in to work in it. */
const COUNTRY_FILL_FADE_START = 8;
const COUNTRY_FILL_FADE_END = 10;

/** A country fill's alpha at `zoom`: full through 8, 0 from 10, linear between. */
function countryFillAlpha(zoom) {
  if (zoom <= COUNTRY_FILL_FADE_START) return COUNTRY_FILL_MAX_ALPHA;
  if (zoom >= COUNTRY_FILL_FADE_END) return 0;
  const t = (zoom - COUNTRY_FILL_FADE_START) / (COUNTRY_FILL_FADE_END - COUNTRY_FILL_FADE_START);
  return COUNTRY_FILL_MAX_ALPHA * (1 - t);
}

const COUNTRY_FILL_STYLE_CACHE = new Map();
/** Cached by colour + a rounded alpha (zoom moves continuously; alpha only
 * needs ~256 steps to look smooth), so panning/zooming doesn't allocate a
 * new Style/Fill every frame. */
function countryFillStyle(color, zoom) {
  const alpha = Math.round(countryFillAlpha(zoom) * 255) / 255;
  if (alpha <= 0) return null;
  const key = `${color}|${alpha}`;
  if (!COUNTRY_FILL_STYLE_CACHE.has(key)) {
    COUNTRY_FILL_STYLE_CACHE.set(key, new Style({ fill: new Fill({ color: withAlpha(color, alpha) }) }));
  }
  return COUNTRY_FILL_STYLE_CACHE.get(key);
}

/** A scenario country: low-alpha fill (fading out zoomed in), a coloured
 * border on a casing, an uppercase spaced label — the border and label stay
 * at every zoom, only the fill fades. */
function countryStyle(feature, tone, resolution) {
  const color = feature.get('color') || '#8ea2a8';
  const ink = COUNTRY_TONE[tone];
  const anchor = geometryAnchor(feature.getGeometry());
  const fill = countryFillStyle(color, resolutionToZoom(resolution));
  return [
    ...(fill ? [fill] : []),
    new Style({ stroke: new Stroke({ color: ink.casing, width: 5 }) }),
    new Style({ stroke: new Stroke({ color, width: 2.4 }) }),
    new Style({
      geometry: new Point(anchor),
      text: new TextStyle({
        text: letterSpaced(feature.get('name') || ''),
        font: COUNTRY_LABEL_FONT,
        fill: new Fill({ color: ink.label }),
        stroke: new Stroke({ color: ink.halo, width: 4 }),
        overflow: true,
      }),
    }),
  ];
}

/** Kraj/okres outline for the Exercise "Pick regions" mode; tinted by its owning country, if any. */
function regionStyle(ownerColor) {
  return new Style({
    stroke: new Stroke({
      color: ownerColor ? withAlpha(ownerColor, 0.9) : 'rgba(159, 208, 222, 0.55)',
      width: ownerColor ? 2 : 1,
    }),
    fill: new Fill({
      color: ownerColor ? withAlpha(ownerColor, 0.22) : 'rgba(159, 208, 222, 0.05)',
    }),
  });
}

// -- MGRS grid style ------------------------------------------------------------

const MGRS_INK = '#12324a';
const MGRS_FONT = '"Cascadia Mono", "IBM Plex Mono", ui-monospace, monospace';
const MGRS_LINE_WIDTH = { zone: 2.2, square: 1.4, line: 0.8 };
/**
 * Two tones: dark ink over the pale vector basemap, and over imagery (dark
 * and busy) white lines on a dark casing so they read on fields and forest.
 */
const MGRS_LINE_STYLE = {
  dark: {
    zone: new Style({ stroke: new Stroke({ color: MGRS_INK, width: MGRS_LINE_WIDTH.zone }) }),
    square: new Style({ stroke: new Stroke({ color: MGRS_INK, width: MGRS_LINE_WIDTH.square }) }),
    line: new Style({
      stroke: new Stroke({ color: 'rgba(18, 50, 74, 0.5)', width: MGRS_LINE_WIDTH.line }),
    }),
  },
  light: Object.fromEntries(
    Object.entries(MGRS_LINE_WIDTH).map(([rank, width]) => [
      rank,
      [
        new Style({ stroke: new Stroke({ color: 'rgba(0, 0, 0, 0.45)', width: width + 1.6 }) }),
        new Style({
          stroke: new Stroke({
            color: rank === 'line' ? 'rgba(255, 255, 255, 0.7)' : '#ffffff',
            width,
          }),
        }),
      ],
    ]),
  ),
};
const MGRS_LABEL_TEXT = {
  // Easting digits sit just above the bottom edge, northing digits just
  // right of the left edge, as on a paper map sheet's margin.
  easting: { font: `600 11px ${MGRS_FONT}`, textBaseline: 'bottom', offsetY: -4 },
  northing: { font: `600 11px ${MGRS_FONT}`, textAlign: 'left', offsetX: 5 },
  square: { font: `700 12px ${MGRS_FONT}`, boxed: true },
  zone: { font: `700 13px ${MGRS_FONT}`, boxed: true },
};

function mgrsLabelStyle(kind, text, tone) {
  const { boxed, ...options } = MGRS_LABEL_TEXT[kind];
  // Boxed labels carry their own white background and read on any basemap.
  const light = tone === 'light' && !boxed;
  return new Style({
    text: new TextStyle({
      ...options,
      text,
      fill: new Fill({ color: light ? '#ffffff' : MGRS_INK }),
      ...(boxed
        ? {
            backgroundFill: new Fill({ color: 'rgba(255, 255, 255, 0.85)' }),
            padding: [2, 5, 2, 5],
          }
        : { stroke: new Stroke({ color: light ? 'rgba(0, 0, 0, 0.8)' : '#ffffff', width: 3 }) }),
    }),
  });
}

// -- Print furniture ---------------------------------------------------------------

/** Longest 1/2/5 × 10^n metres that fits in `maxMetres`. */
function niceScaleLength(maxMetres) {
  const power = 10 ** Math.floor(Math.log10(maxMetres));
  return [5, 2, 1].map((step) => step * power).find((length) => length <= maxMetres);
}

/** Four-segment black/white scale bar in the bottom-left corner (CSS px). */
function drawScaleBar(context, height, metresPerPixel) {
  const metres = niceScaleLength(160 * metresPerPixel);
  const barWidth = metres / metresPerPixel;
  const x = 16;
  const y = height - 30;
  const label = metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
  context.font = '600 11px "Cascadia Mono", "IBM Plex Mono", ui-monospace, monospace';
  context.fillStyle = 'rgba(255, 255, 255, 0.9)';
  context.fillRect(x - 8, y - 20, barWidth + 16 + context.measureText(label).width + 8, 38);
  for (let segment = 0; segment < 4; segment += 1) {
    context.fillStyle = segment % 2 ? '#ffffff' : '#1b1b1b';
    context.fillRect(x + (segment * barWidth) / 4, y, barWidth / 4, 6);
  }
  context.strokeStyle = '#1b1b1b';
  context.lineWidth = 1;
  context.strokeRect(x, y, barWidth, 6);
  context.fillStyle = '#1b1b1b';
  context.textBaseline = 'bottom';
  context.fillText('0', x - 3, y - 3);
  context.fillText(label, x + barWidth + 6, y + 8);
}

/** North arrow in the top-right corner, only drawn when the view is rotated. */
function drawNorthArrow(context, width, rotation) {
  context.save();
  context.translate(width - 30, 36);
  context.rotate(rotation);
  context.fillStyle = '#1b1b1b';
  context.beginPath();
  context.moveTo(0, -16);
  context.lineTo(7, 10);
  context.lineTo(0, 5);
  context.lineTo(-7, 10);
  context.closePath();
  context.fill();
  context.font = '700 11px system-ui, sans-serif';
  context.textAlign = 'center';
  context.fillText('N', 0, -20);
  context.restore();
}

// -- Grid overlay rasterisation ---------------------------------------------

function decodeGridValues(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function cssColorToRgba(css, probeContext) {
  probeContext.clearRect(0, 0, 1, 1);
  probeContext.fillStyle = css;
  probeContext.fillRect(0, 0, 1, 1);
  return probeContext.getImageData(0, 0, 1, 1).data;
}

function buildGridCanvas(grid, palette) {
  const canvas = document.createElement('canvas');
  canvas.width = grid.width;
  canvas.height = grid.height;
  const context = canvas.getContext('2d');
  const imageData = context.createImageData(grid.width, grid.height);
  const values = decodeGridValues(grid.values);

  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  const probeContext = probe.getContext('2d');
  const colorCache = new Map();

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    const css = palette[value];
    const offset = i * 4;
    if (!css) {
      imageData.data[offset + 3] = 0;
      continue;
    }
    let rgba = colorCache.get(css);
    if (!rgba) {
      rgba = cssColorToRgba(css, probeContext);
      colorCache.set(css, rgba);
    }
    imageData.data[offset] = rgba[0];
    imageData.data[offset + 1] = rgba[1];
    imageData.data[offset + 2] = rgba[2];
    imageData.data[offset + 3] = rgba[3];
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

/** Paint a fixed-resolution raster canvas into the extent OL is requesting, nearest-neighbour. */
function paintGridInto(sourceCanvas, sourceExtent, destExtent, destSize) {
  const canvas = document.createElement('canvas');
  canvas.width = destSize[0];
  canvas.height = destSize[1];
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;

  const [gx0, gy0, gx1, gy1] = sourceExtent;
  const [ex0, ey0, ex1, ey1] = destExtent;
  const gw = sourceCanvas.width;
  const gh = sourceCanvas.height;

  const scaleX = (destSize[0] * (gx1 - gx0)) / (gw * (ex1 - ex0));
  const scaleY = (destSize[1] * (gy1 - gy0)) / (gh * (ey1 - ey0));
  const offsetX = (destSize[0] * (gx0 - ex0)) / (ex1 - ex0);
  const offsetY = (destSize[1] * (ey1 - gy1)) / (ey1 - ey0);

  context.setTransform(scaleX, 0, 0, scaleY, offsetX, offsetY);
  context.drawImage(sourceCanvas, 0, 0);
  context.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

// -- Weather ----------------------------------------------------------------

/** Cloud tint per basemap tone: dark shading on paper maps, white over imagery. */
const CLOUD_TINT = {
  dark: { rgb: [38, 58, 88], alpha: 0.38 },
  light: { rgb: [255, 255, 255], alpha: 0.55 },
};
const WEATHER_TILE_SIZE = 256;
const WEATHER_TILE_GRID = createXYZ({ tileSize: WEATHER_TILE_SIZE });
/**
 * Deepest cloud-mask tile zoom. Meteosat's 3 km pixels are ~4-6 km at 50° N;
 * 32 px per zoom-8 tile (~4.9 km) is about that.
 */
const CLOUD_MAX_ZOOM = 8;

/**
 * Cloud-mask request size for a tile zoom, at about the product's own pixel
 * size, so the browser does the enlarging smoothly instead of the server in
 * hard blocks. Each zoom out doubles the ground a tile covers, so it doubles
 * the pixels, up to the full tile.
 */
function cloudRequestSize(z) {
  return Math.min(WEATHER_TILE_SIZE, 32 * 2 ** (CLOUD_MAX_ZOOM - z));
}

const WIND_INK = {
  dark: { stroke: '#123047', halo: 'rgba(255, 255, 255, 0.9)' },
  light: { stroke: '#ffffff', halo: 'rgba(0, 0, 0, 0.75)' },
};
const windArrowCache = new Map();

/** A north-pointing arrow, longer for stronger wind (capped at 20 m/s). */
function windArrowCanvas(length, tone) {
  const key = `${tone}:${length}`;
  let canvas = windArrowCache.get(key);
  if (canvas) return canvas;
  const ink = WIND_INK[tone];
  const ratio = window.devicePixelRatio || 1;
  const width = 14;
  canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * ratio);
  canvas.height = Math.ceil((length + 4) * ratio);
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  const shaft = () => {
    context.beginPath();
    context.moveTo(width / 2, length + 2);
    context.lineTo(width / 2, 4);
    context.moveTo(2, 10);
    context.lineTo(width / 2, 2);
    context.lineTo(width - 2, 10);
  };
  shaft();
  context.strokeStyle = ink.halo;
  context.lineWidth = 4.5;
  context.stroke();
  shaft();
  context.strokeStyle = ink.stroke;
  context.lineWidth = 2;
  context.stroke();
  windArrowCache.set(key, canvas);
  return canvas;
}

/** Arrow pointing downwind plus "speed (gusts)" in m/s. */
function windStyle({ speed, gusts, direction }, tone) {
  if (!Number.isFinite(speed) || !Number.isFinite(direction)) return null;
  const length = Math.round(14 + Math.min(speed, 20) * 1.6);
  const ink = WIND_INK[tone];
  const ratio = window.devicePixelRatio || 1;
  // Not aviation "2G7": at label size the G reads as a 6.
  const gustText = Number.isFinite(gusts) && gusts >= speed + 3 ? ` (${Math.round(gusts)})` : '';
  return [
    new Style({
      image: new IconStyle({
        img: windArrowCanvas(length, tone),
        scale: 1 / ratio,
        rotation: downwindRotation(direction),
        rotateWithView: true,
      }),
    }),
    new Style({
      text: new TextStyle({
        text: `${Math.round(speed)}${gustText}`,
        font: '600 11px ui-monospace, SFMono-Regular, Menlo, monospace',
        fill: new Fill({ color: ink.stroke }),
        stroke: new Stroke({ color: ink.halo, width: 3 }),
        offsetY: 18,
      }),
    }),
  ];
}

/**
 * Load one WMS tile as a canvas; `transform(ImageData)` may recolour it. The
 * WMS answers with CORS `*`, so the pixels are readable. A coarse product can
 * be fetched at `size` < the tile size and upscaled smoothly here: the server
 * resamples nearest-neighbour, which draws its pixels as hard blocks.
 */
async function loadWmsTile(layer, time, [z, x, y], signal, { size, transform } = {}) {
  const extent = WEATHER_TILE_GRID.getTileCoordExtent([z, x, y]);
  const requestSize = Math.min(size ?? WEATHER_TILE_SIZE, WEATHER_TILE_SIZE);
  const response = await fetch(wmsTileUrl(layer, extent, requestSize, time), { signal });
  if (!response.ok) throw new Error(`WMS ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  let canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: Boolean(transform) });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  if (transform) {
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    transform(image.data);
    context.putImageData(image, 0, 0);
  }
  if (canvas.width < WEATHER_TILE_SIZE) {
    const small = canvas;
    canvas = document.createElement('canvas');
    canvas.width = WEATHER_TILE_SIZE;
    canvas.height = WEATHER_TILE_SIZE;
    const large = canvas.getContext('2d');
    large.imageSmoothingQuality = 'high';
    large.drawImage(small, 0, 0, WEATHER_TILE_SIZE, WEATHER_TILE_SIZE);
  }
  return canvas;
}

// -- Controller ---------------------------------------------------------

export function createMap(options) {
  const {
    target,
    basemapUrl,
    center = [0, 0],
    zoom = 10,
    onClick,
    onContextMenu,
    onFeatureChange,
    onDraw,
    onPointerMove,
    onViewChange,
    // [top, right, bottom, left] px of the map covered by UI floating over
    // it; fits keep their target inside the part left visible.
    coveredInsets = () => [0, 0, 0, 0],
  } = options;

  const geoJsonFormat = new GeoJSON();
  const iconCache = new Map();
  const gridLayers = new Map();
  const listenerKeys = [];
  const domCleanups = [];
  let selectedId = null;
  let drawInteraction = null;
  let modifyInteraction = null;
  /** setSituation's `onSelect`, or null while the overlay is off. */
  let situationOnSelect = null;

  // The one active scenario (Exercise module), or null for the real map —
  // see setScenario. Read by the basemap/roads/places style functions below,
  // so toggling it just needs `.changed()`, not a new style function.
  let currentScenario = null;
  let editingScenario = false;
  let scenarioIndex = new Map();
  let countryModify = null;
  let countryDraw = null;

  /** Hides real admin boundaries (every level) while a scenario is active. */
  function scenarioAwareStyle(baseStyleFn) {
    return (feature, resolution) => {
      if (currentScenario && feature.get('layer') === 'boundary') return undefined;
      return baseStyleFn(feature, resolution);
    };
  }
  const VECTOR_STYLES_SCENARIO = {
    roads: scenarioAwareStyle(basemapStyle),
    topo: scenarioAwareStyle(topoStyle),
  };
  const scenarioAwareHybridStyle = scenarioAwareStyle(hybridStyle);

  /** Real place/peak/water labels: substituted, dimmed or hidden. */
  function scenarioPlaceLabelStyle(feature, resolution) {
    if (!currentScenario) return placeLabelStyle(feature, resolution);
    const resolved = resolvePlaceClass(feature, resolution);
    if (!resolved) return undefined;
    const [lon, lat] = featureLonLat(feature);
    const match = matchScenarioPlace(scenarioIndex, resolved.name, lon, lat);
    if (match) {
      const style = PLACE_LABEL[resolved.styleKind];
      const matchedText = resolved.styleKind === 'peak' ? `▲ ${match.name}` : match.name;
      style.getText().setText(editingScenario ? `${matchedText} (${resolved.name})` : matchedText);
      return style;
    }
    if (!editingScenario) return undefined;
    const dim = DIMMED_PLACE_LABEL[resolved.styleKind];
    const dimText = resolved.styleKind === 'peak' ? `▲ ${resolved.name}` : resolved.name;
    dim.getText().setText(dimText);
    return dim;
  }

  const basemapSource = new PMTilesVectorSource({ url: basemapUrl });
  const basemapLayer = new VectorTileLayer({
    source: basemapSource,
    style: VECTOR_STYLES_SCENARIO.roads,
    declutter: false,
  });

  const featureSource = new VectorSource();
  const featureLayer = new VectorLayer({
    source: featureSource,
    style: (feature) => {
      const styles = [];
      const geometry = feature.getGeometry();
      if (geometry && selectedId !== null && feature.getId() === selectedId) {
        styles.push(buildSelectionHalo(geometry));
      }
      styles.push(...buildFeatureStyle(feature, iconCache, darkBase));
      return styles;
    },
  });

  // The current situation (setSituation): tracks, their history, and reports —
  // a separate layer above featureLayer, off until a study/study session sets it.
  const situationSource = new VectorSource();
  const situationLayer = new VectorLayer({
    source: situationSource,
    visible: false,
    style: (feature, resolution) => {
      switch (feature.get('situationKind')) {
        case 'track':
          return situationTrackStyle(feature, iconCache);
        case 'track-history':
          return SITUATION_HISTORY_STYLE;
        case 'track-history-dot':
          return SITUATION_HISTORY_DOT_STYLE;
        case 'report':
          return situationReportStyle(feature, resolution);
        default:
          return undefined;
      }
    },
  });

  // Headless source used only to stage the in-progress draw; never added to the map.
  const sketchSource = new VectorSource();

  // Above the basemap and analysis rasters (setGrid inserts below it), below
  // the analyst's features. Rebuilt for the current view on every moveend.
  const mgrsSource = new VectorSource();
  const mgrsLayer = new VectorLayer({
    source: mgrsSource,
    visible: false,
    declutter: true,
  });

  // Raster basemap pieces, both off until setBasemap. Both sit over the
  // vector basemap: imagery clipped to its coverage leaves the vector map
  // visible around it, and hillshade is a translucent overlay by design.
  const imageryLayer = new TileLayer({ visible: false });
  const reliefLayer = new TileLayer({ visible: false });
  /** Set by setBasemap: dark imagery switches the grid and contours to light ink. */
  let darkBase = false;

  // Reference overlays, all off until setOverlays. Roads and places restyle
  // the basemap's own tiles, so they share its source.
  const slopeLayer = new TileLayer({ visible: false });
  const contourLayer = new VectorTileLayer({
    visible: false,
    declutter: true,
    style: (feature) => {
      const styles = CONTOUR_STYLE[darkBase ? 'light' : 'dark'];
      if (!feature.get('index')) return styles.line;
      styles.index.getText().setText(String(feature.get('ele')));
      return styles.index;
    },
  });
  const roadsLayer = new VectorTileLayer({
    source: basemapSource,
    visible: false,
    style: scenarioAwareHybridStyle,
  });
  const placesLayer = new VectorTileLayer({
    source: basemapSource,
    visible: false,
    declutter: true,
    style: scenarioPlaceLabelStyle,
  });

  // The active scenario's countries (setScenario), drawn in place of the
  // real boundaries above. Kraj/okres picking (setRegions) and a country's
  // own vertex-edit overlay (editCountry/drawArea) are separate, editor-only
  // layers so the scenario's own render never has to be rebuilt for them.
  const countriesSource = new VectorSource();
  const countriesLayer = new VectorLayer({
    source: countriesSource,
    visible: false,
    declutter: true,
    style: (feature, resolution) => countryStyle(feature, darkBase ? 'light' : 'dark', resolution),
  });
  const regionsSource = new VectorSource();
  const regionsLayer = new VectorLayer({ source: regionsSource, visible: false });
  const countryEditSource = new VectorSource();
  const countryEditLayer = new VectorLayer({
    source: countryEditSource,
    style: new Style({
      stroke: new Stroke({ color: '#ffffff', width: 2, lineDash: [4, 4] }),
      fill: new Fill({ color: 'rgba(255, 255, 255, 0.1)' }),
    }),
  });

  // Weather, all off until setWeather: over the terrain, under the roads and
  // names that orient the reader; wind arrows over the grid, under features.
  const cloudLayer = new TileLayer({ visible: false });
  /** One layer per radar frame (all loading, only the current one opaque). */
  const radarGroup = new LayerGroup({ visible: false });
  const radarLayers = new Map();
  const lightningLayer = new TileLayer({ visible: false });
  const windSource = new VectorSource();
  const windLayer = new VectorLayer({
    source: windSource,
    visible: false,
    style: (feature) => windStyle(feature.get('wind'), darkBase ? 'light' : 'dark'),
  });
  /** The last cloud spec, re-applied when the basemap tone changes the tint. */
  let cloudSpec = null;

  const map = new OlMap({
    target,
    layers: [
      basemapLayer,
      imageryLayer,
      reliefLayer,
      slopeLayer,
      contourLayer,
      cloudLayer,
      radarGroup,
      lightningLayer,
      roadsLayer,
      countriesLayer,
      regionsLayer,
      placesLayer,
      mgrsLayer,
      windLayer,
      featureLayer,
      situationLayer,
      countryEditLayer,
    ],
    // The default Zoom and Attribution controls stay put (view.js's status
    // bar proxy-clicks/reads them rather than duplicating their behaviour);
    // ScaleLine is added bare so the host can relocate and restyle it into
    // that same status bar instead of leaving it in its own corner.
    // 40-80 px keeps the scale inside the status bar's budget between both
    // open sheets (OL's default can grow it to ~160 px).
    controls: defaultControls().extend([
      new ScaleLine({ className: 'ipb-scale', bar: false, minWidth: 40, maxWidth: 80 }),
    ]),
    view: new View({
      projection: MAP_PROJECTION,
      center: fromLonLat(center, MAP_PROJECTION),
      zoom,
    }),
  });

  // Live measurement (startMeasure/stopMeasure): never conflicts with
  // startDraw/startModify — each stops the other first.
  const measureController = createMeasureController(map);

  // Always registered (not gated on `onClick`) so setSituation's onSelect
  // works even for a caller that never passes onClick.
  listenerKeys.push(
    map.on('singleclick', (event) => {
      // Situation features (setSituation) sit above the analyst's own
      // features and take priority: a click on a track or report calls
      // onSelect instead of the normal onClick feature routing.
      if (situationOnSelect) {
        const situationHit = map.forEachFeatureAtPixel(event.pixel, (feature) => feature, {
          layerFilter: (layer) => layer === situationLayer,
          hitTolerance: 6,
        });
        const situationKind = situationHit?.get('situationKind');
        if (situationKind === 'track' || situationKind === 'report') {
          situationOnSelect({ kind: situationKind, id: situationHit.get('situationId') });
          return;
        }
      }
      if (!onClick) return;
      const [lon, lat] = toLonLat(event.coordinate, MAP_PROJECTION);
      const hit = map.forEachFeatureAtPixel(event.pixel, (feature) => feature, {
        layerFilter: (layer) => layer === featureLayer,
        hitTolerance: 6,
      });
      // pixel lets a caller follow up with regionAt/placeAt without a
      // second listener (the Exercise "Geography" editor's pick modes).
      onClick({ lon, lat, pixel: event.pixel, featureId: hit ? hit.getId() : null });
    }),
  );

  // Right-click finishes/stops an active measurement (like Escape), instead
  // of opening the analyst's usual context menu — registered ahead of
  // `onContextMenu` below and `stopImmediatePropagation`s past it.
  {
    const viewport = map.getViewport();
    const handleMeasureContextMenu = (event) => {
      if (!measureController.isActive()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      measureController.stop();
    };
    viewport.addEventListener('contextmenu', handleMeasureContextMenu);
    domCleanups.push(() => viewport.removeEventListener('contextmenu', handleMeasureContextMenu));
  }

  if (onContextMenu) {
    // OpenLayers does not synthesize a MapBrowserEvent for the browser's
    // native contextmenu event; listen on the viewport directly.
    const viewport = map.getViewport();
    const handleContextMenu = (event) => {
      event.preventDefault();
      const pixel = map.getEventPixel(event);
      const [lon, lat] = toLonLat(map.getCoordinateFromPixel(pixel), MAP_PROJECTION);
      const hit = map.forEachFeatureAtPixel(pixel, (feature) => feature, {
        layerFilter: (layer) => layer === featureLayer,
        hitTolerance: 6,
      });
      onContextMenu({
        lon,
        lat,
        featureId: hit ? hit.getId() : null,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    };
    viewport.addEventListener('contextmenu', handleContextMenu);
    domCleanups.push(() => viewport.removeEventListener('contextmenu', handleContextMenu));
  }

  if (onPointerMove) {
    let scheduled = false;
    let lastCoordinate = null;
    listenerKeys.push(
      map.on('pointermove', (event) => {
        if (event.dragging) return;
        lastCoordinate = event.coordinate;
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          if (!lastCoordinate) return;
          const [lon, lat] = toLonLat(lastCoordinate, MAP_PROJECTION);
          onPointerMove({ lon, lat });
        });
      }),
    );
  }

  function findFeature(id) {
    return featureSource.getFeatureById(id);
  }

  function setFeatures(features) {
    featureSource.clear();
    const olFeatures = features.map((entry) => {
      const geometry = geoJsonFormat.readGeometry(entry.geometry, GEOJSON_OPTIONS);
      const feature = new Feature({ geometry });
      feature.setId(entry.id);
      feature.set('layer', entry.layer);
      feature.set('kind', entry.kind);
      feature.set('label', entry.label);
      feature.set('properties', entry.properties || {});
      return feature;
    });
    featureSource.addFeatures(olFeatures);
  }

  function selectFeature(id) {
    selectedId = id ?? null;
    featureLayer.changed();
  }

  /**
   * The current situation — Exercise tracks and reports — on its own layer
   * above the analyst's own features: `null` clears and hides it.
   *   tracks   `[{ id, sidc, designation, lon, lat, observed_at, status, history: [{lon,lat,observed_at}] }]`
   *            a milsymbol icon (designation + a `formatDtg` DTG label);
   *            `status: 'suspected'` draws the planned (dashed) frame,
   *            `'destroyed'`/`'lost'` fades the icon; `history` draws as a
   *            thin dashed polyline with a small dot at each past position.
   *   reports  `[{ id, lon, lat, report_type, occurred_at, reliability, credibility }]`
   *            a small rotated-square marker, filled solid for credibility
   *            1-2, half-filled for 3, hollow for 4-6; its type label hides
   *            below zoom 12.
   * `onSelect({ kind: 'track'|'report', id })` fires on a click that hits a
   * track or report; such a click takes priority over the normal `onClick`
   * feature routing (see the `singleclick` handler above).
   */
  function setSituation(data, { onSelect } = {}) {
    situationSource.clear(true);
    situationOnSelect = data ? onSelect || null : null;
    situationLayer.setVisible(Boolean(data));
    if (!data) return;
    const features = [];
    for (const track of data.tracks || []) {
      if (Array.isArray(track.history) && track.history.length > 1) {
        const historyCoords = track.history.map((point) =>
          fromLonLat([point.lon, point.lat], MAP_PROJECTION),
        );
        const historyLine = new Feature(new LineString(historyCoords));
        historyLine.set('situationKind', 'track-history');
        features.push(historyLine);
        for (const point of track.history) {
          const dot = new Feature(new Point(fromLonLat([point.lon, point.lat], MAP_PROJECTION)));
          dot.set('situationKind', 'track-history-dot');
          features.push(dot);
        }
      }
      const trackFeature = new Feature(new Point(fromLonLat([track.lon, track.lat], MAP_PROJECTION)));
      trackFeature.set('situationKind', 'track');
      trackFeature.set('situationId', track.id);
      trackFeature.set('track', track);
      features.push(trackFeature);
    }
    for (const report of data.reports || []) {
      const reportFeature = new Feature(
        new Point(fromLonLat([report.lon, report.lat], MAP_PROJECTION)),
      );
      reportFeature.set('situationKind', 'report');
      reportFeature.set('situationId', report.id);
      reportFeature.set('report', report);
      features.push(reportFeature);
    }
    situationSource.addFeatures(features);
  }

  function fitFeature(id) {
    const feature = findFeature(id);
    const geometry = feature && feature.getGeometry();
    if (!geometry) return;
    map
      .getView()
      .fit(geometry.getExtent(), { padding: fitPadding(48), maxZoom: 18, duration: 250 });
  }

  function fitPadding(margin) {
    return coveredInsets().map((inset) => inset + margin);
  }

  function fitExtent(extent) {
    const extent3857 = transformExtent(extent, DATA_PROJECTION, MAP_PROJECTION);
    map.getView().fit(extent3857, { padding: fitPadding(24), duration: 250 });
  }

  function getBounds() {
    const extent = map.getView().calculateExtent(map.getSize());
    return transformExtent(extent, MAP_PROJECTION, DATA_PROJECTION);
  }

  function getCenter() {
    return toLonLat(map.getView().getCenter(), MAP_PROJECTION);
  }

  function cancelDraw() {
    if (!drawInteraction) return;
    map.removeInteraction(drawInteraction);
    drawInteraction = null;
    sketchSource.clear();
  }

  /** A sketch style previewing `graphicKey`'s own `TACTICAL_GRAPHICS` style, falling back to a plain dashed line until the sketch has enough vertices for it (e.g. an axis of advance before its second point). */
  function graphicSketchStyle(graphicKey, drawOptions, color) {
    const entry = TACTICAL_GRAPHICS[graphicKey];
    const fallback = new Style({
      stroke: new Stroke({ color, width: 2, lineDash: [6, 4] }),
      fill: new Fill({ color: withAlpha(color, 0.15) }),
      image: new CircleStyle({
        radius: 6,
        fill: new Fill({ color }),
        stroke: new Stroke({ color: '#ffffff', width: 1.5 }),
      }),
    });
    if (!entry) return fallback;
    return (feature) => {
      feature.set('properties', { ...drawOptions, graphic: graphicKey });
      try {
        const styles = entry.style(feature, { color, darkBase, label: drawOptions.name });
        return styles.length ? styles : fallback;
      } catch {
        return fallback;
      }
    };
  }

  function startDraw(kind, drawOptions = {}) {
    cancelDraw();
    measureController.stop();
    // Draw inserts the finished feature into its source right after dispatching
    // 'drawend', i.e. after our handler below has already cleared it once —
    // wipe any such leftover here so the headless sketch source never grows.
    sketchSource.clear();
    const geometryType = DRAW_GEOMETRY_TYPE[kind];
    if (!geometryType) throw new Error(`createMap: unknown draw kind "${kind}"`);
    const config = layerConfig(drawOptions.layer);
    const style = drawOptions.graphic
      ? graphicSketchStyle(drawOptions.graphic, drawOptions, graphicColor(drawOptions.affiliation, darkBase))
      : new Style({
          stroke: new Stroke({ color: config.color, width: 2, lineDash: [6, 4] }),
          fill: new Fill({ color: withAlpha(config.color, 0.15) }),
          image: new CircleStyle({
            radius: 6,
            fill: new Fill({ color: config.color }),
            stroke: new Stroke({ color: '#ffffff', width: 1.5 }),
          }),
        });
    drawInteraction = new Draw({
      source: sketchSource,
      type: geometryType,
      style,
    });
    drawInteraction.on('drawend', (event) => {
      const geometry = geoJsonFormat.writeGeometryObject(
        event.feature.getGeometry(),
        GEOJSON_OPTIONS,
      );
      map.removeInteraction(drawInteraction);
      drawInteraction = null;
      sketchSource.clear();
      if (onDraw) onDraw({ kind, geometry });
    });
    map.addInteraction(drawInteraction);
  }

  function stopModify() {
    if (!modifyInteraction) return;
    map.removeInteraction(modifyInteraction);
    modifyInteraction = null;
  }

  function startModify(id) {
    stopModify();
    measureController.stop();
    const feature = findFeature(id);
    if (!feature) return;
    const modifySource = new VectorSource({ features: [feature] });
    modifyInteraction = new Modify({ source: modifySource });
    modifyInteraction.on('modifyend', () => {
      const geometry = geoJsonFormat.writeGeometryObject(feature.getGeometry(), GEOJSON_OPTIONS);
      if (onFeatureChange) onFeatureChange({ id, geometry });
    });
    map.addInteraction(modifyInteraction);
  }

  /**
   * Live geodesic measurement (`src/measure.js`), drawn on its own layer as
   * on-map labels: `mode` is `'distance'` (per-segment and total),
   * `'area'` (km²/ha) or `'bearing'` (click-A, click-B: true degrees and
   * mils). `onResult(payload)` fires on every change and once finished
   * (`payload.done`); nothing is ever saved. Cancels any `startDraw`/
   * `startModify` in progress; Escape or a right-click on the map stops it.
   */
  function startMeasure({ mode, onResult }) {
    cancelDraw();
    stopModify();
    measureController.start({ mode, onResult });
  }

  /** Stops measuring and clears its labels; a no-op when idle. */
  function stopMeasure() {
    measureController.stop();
  }

  /**
   * The single active scenario (Exercise module), or `null` for the real
   * map. Real admin boundaries (every level) hide; the
   * scenario's countries draw instead (low-alpha fill, a coloured border on
   * a casing, an uppercase spaced label at the interior point of its
   * largest part). A real place/peak/water-name label whose name matches
   * a scenario place within 5 km shows the scenario name; every other real
   * label is hidden.
   *
   * `editing: true` (the Exercise "Geography" tab) instead keeps unmatched
   * real labels visible, grey and italic, and shows a match as
   * "Scenario (Real)", so both can be found and clicked — see `placeAt`.
   */
  function setScenario(scenario, { editing = false } = {}) {
    currentScenario = scenario || null;
    editingScenario = Boolean(editing);
    scenarioIndex = buildScenarioNameIndex(currentScenario);
    countriesSource.clear();
    if (currentScenario) {
      countriesSource.addFeatures(
        currentScenario.countries
          .filter((country) => country.geometry)
          .map((country) => {
            const feature = new Feature(
              geoJsonFormat.readGeometry(country.geometry, GEOJSON_OPTIONS),
            );
            feature.setId(country.id);
            feature.set('name', country.name);
            feature.set('color', country.color);
            return feature;
          }),
      );
    }
    countriesLayer.setVisible(Boolean(currentScenario));
    // The boundary/place style functions read currentScenario/editingScenario
    // directly (closures), so a redraw is all these three layers need.
    basemapLayer.changed();
    roadsLayer.changed();
    placesLayer.changed();
  }

  /**
   * Kraj or okres outlines for the Exercise "Pick regions" mode, tinted by
   * the country that already owns each one (`owner: Map<regionId, color>`);
   * `null` clears them. A click is reported through `onClick`'s `pixel`,
   * resolved with `regionAt(pixel)`.
   */
  function setRegions(featureCollection, { level = 'kraj', owner = new Map() } = {}) {
    regionsSource.clear();
    if (!featureCollection) {
      regionsLayer.setVisible(false);
      return;
    }
    const features = geoJsonFormat
      .readFeatures(featureCollection, GEOJSON_OPTIONS)
      .filter((feature) => feature.get('level') === level);
    features.forEach((feature) => feature.setId(feature.get('id')));
    regionsSource.addFeatures(features);
    regionsLayer.setStyle((feature) => regionStyle(owner.get(feature.getId())));
    regionsLayer.setVisible(true);
  }

  /** The region id (setRegions) under a pixel, or null. */
  function regionAt(pixel) {
    if (!regionsLayer.getVisible()) return null;
    const hit = map.forEachFeatureAtPixel(pixel, (feature) => feature, {
      layerFilter: (layer) => layer === regionsLayer,
      hitTolerance: 4,
    });
    return hit ? hit.getId() : null;
  }

  /**
   * The real place/peak/water-name label under a pixel, as
   * `{ real_name, kind, lon, lat }` (`kind` matches the scenario places API:
   * the basemap's own class for a `place` feature, or `'peak'`/`'water'`),
   * or null. Needs `setOverlays({ places: true })` — the Exercise editor
   * turns that on so real labels are there to click.
   */
  function placeAt(pixel) {
    if (!placesLayer.getVisible()) return null;
    const hit = map.forEachFeatureAtPixel(pixel, (feature) => feature, {
      layerFilter: (layer) => layer === placesLayer,
      hitTolerance: 8,
    });
    if (!hit) return null;
    const resolved = resolvePlaceClass(hit, map.getView().getResolution());
    if (!resolved) return null;
    const [lon, lat] = featureLonLat(hit);
    return { real_name: resolved.name, kind: resolved.placeKind, lon, lat };
  }

  /**
   * Vertex-edit a country's polygon on its own overlay (separate from the
   * scenario's own render, so a half-finished edit is never sent):
   * `onChange(geometry)` fires after every drag. `drawArea({ onDone })`
   * freehand-draws a new polygon instead of editing one; either is
   * cancelled the same way, `stopEditing()`, which is always safe to call.
   */
  function editCountry(geometry, { onChange }) {
    stopEditing();
    const feature = new Feature(geoJsonFormat.readGeometry(geometry, GEOJSON_OPTIONS));
    countryEditSource.addFeature(feature);
    countryModify = new Modify({ source: countryEditSource });
    countryModify.on('modifyend', () => {
      onChange(geoJsonFormat.writeGeometryObject(feature.getGeometry(), GEOJSON_OPTIONS));
    });
    map.addInteraction(countryModify);
  }

  function drawArea({ onDone }) {
    stopEditing();
    countryDraw = new Draw({
      source: new VectorSource(),
      type: 'Polygon',
      style: new Style({
        stroke: new Stroke({ color: '#ffffff', width: 2, lineDash: [6, 4] }),
        fill: new Fill({ color: 'rgba(255, 255, 255, 0.12)' }),
      }),
    });
    countryDraw.on('drawend', (event) => {
      const drawnGeometry = geoJsonFormat.writeGeometryObject(
        event.feature.getGeometry(),
        GEOJSON_OPTIONS,
      );
      map.removeInteraction(countryDraw);
      countryDraw = null;
      onDone(drawnGeometry);
    });
    map.addInteraction(countryDraw);
  }

  /** Cancels `editCountry`/`drawArea`; a no-op if neither is running. */
  function stopEditing() {
    if (countryModify) {
      map.removeInteraction(countryModify);
      countryModify = null;
    }
    if (countryDraw) {
      map.removeInteraction(countryDraw);
      countryDraw = null;
    }
    countryEditSource.clear();
  }

  function setGrid(name, grid, gridOptions = {}) {
    const palette = gridOptions.palette || {};
    const opacity = gridOptions.opacity ?? 0.75;
    const sourceExtent = transformExtent(grid.extent, DATA_PROJECTION, MAP_PROJECTION);
    const rasterCanvas = buildGridCanvas(grid, palette);
    const source = new ImageCanvasSource({
      projection: MAP_PROJECTION,
      ratio: 1,
      canvasFunction: (extent, resolution, pixelRatio, size) =>
        paintGridInto(rasterCanvas, sourceExtent, extent, size),
    });

    let entry = gridLayers.get(name);
    if (entry) {
      entry.layer.setSource(source);
      entry.layer.setOpacity(opacity);
    } else {
      const layer = new ImageLayer({ source, opacity });
      gridLayers.set(name, { layer });
      const gridIndex = map.getLayers().getArray().indexOf(mgrsLayer);
      map.getLayers().insertAt(gridIndex, layer);
    }
  }

  function clearGrid(name) {
    const entry = gridLayers.get(name);
    if (!entry) return;
    map.removeLayer(entry.layer);
    entry.layer.setSource(null);
    gridLayers.delete(name);
  }

  /** Point a raster layer at an XYZ tile spec, or hide it for `null`. */
  function applyTileSpec(layer, spec) {
    if (!spec) {
      layer.setVisible(false);
      return;
    }
    if (layer.get('tileUrl') !== spec.url) {
      layer.setSource(
        new XYZ({
          url: spec.url,
          attributions: spec.attributions,
          minZoom: spec.minZoom,
          maxZoom: spec.maxZoom,
        }),
      );
      layer.set('tileUrl', spec.url);
    }
    // Clamp to the data's coverage so no tiles are requested outside it.
    layer.setExtent(
      spec.extent ? transformExtent(spec.extent, DATA_PROJECTION, MAP_PROJECTION) : undefined,
    );
    layer.setVisible(true);
  }

  /**
   * Choose what sits under the analysis layers, bottom to top:
   *   vector   { attributions, style? } shows the vector basemap ('roads' default,
   *            or 'topo'), null hides it
   *   imagery  XYZ spec over it; with an `extent`, the vector map shows around it;
   *            `dark: true` (satellite) switches grid and contours to light ink
   *   relief   XYZ spec drawn over both (translucent hillshade)
   * An XYZ spec is `{ url, attributions, minZoom?, maxZoom?, extent? }` with
   * `extent` in lon/lat.
   */
  function setBasemap({ vector = null, imagery = null, relief = null }) {
    basemapLayer.setVisible(Boolean(vector));
    if (vector) {
      basemapSource.setAttributions(vector.attributions);
      const style = VECTOR_STYLES_SCENARIO[vector.style ?? 'roads'];
      if (basemapLayer.getStyle() !== style) basemapLayer.setStyle(style);
    }
    applyTileSpec(imageryLayer, imagery);
    applyTileSpec(reliefLayer, relief);
    darkBase = Boolean(imagery?.dark);
    contourLayer.changed();
    windLayer.changed();
    featureLayer.changed();
    if (cloudSpec) applyClouds(cloudSpec);
    if (mgrsLayer.getVisible()) renderMgrsGrid();
  }

  /**
   * Reference overlays, drawn over any basemap and under analysis results:
   *   slope     XYZ spec (slope-class tint), or null
   *   contours  `{ url, minZoom, maxZoom, extent? }` GeoJSON tiles, or null
   *   roads     true draws basemap roads and water over imagery
   *   places    true draws place, peak and water names from the basemap
   */
  function setOverlays({ slope = null, contours = null, roads = false, places = false }) {
    applyTileSpec(slopeLayer, slope);
    if (contours) {
      if (contourLayer.get('tileUrl') !== contours.url) {
        contourLayer.setSource(
          new VectorTileSource({
            format: new GeoJSON(),
            url: contours.url,
            // 256 px tiles, so the tile zoom (which sets the contour interval)
            // matches the view zoom; the default 512 px would lag it by one.
            tileGrid: createXYZ({
              tileSize: 256,
              minZoom: contours.minZoom,
              maxZoom: contours.maxZoom,
            }),
          }),
        );
        contourLayer.set('tileUrl', contours.url);
      }
      contourLayer.setMinZoom(contours.minZoom);
      contourLayer.setExtent(
        contours.extent
          ? transformExtent(contours.extent, DATA_PROJECTION, MAP_PROJECTION)
          : undefined,
      );
    }
    contourLayer.setVisible(Boolean(contours));
    roadsLayer.setVisible(roads);
    placesLayer.setVisible(places);
  }

  /** Cloud-mask tiles recoloured for the current basemap tone. */
  function applyClouds(spec) {
    cloudSpec = spec;
    if (!spec) {
      cloudLayer.setVisible(false);
      return;
    }
    const tint = CLOUD_TINT[darkBase ? 'light' : 'dark'];
    const key = `${spec.layer}|${spec.time}|${darkBase}`;
    if (cloudLayer.get('weatherKey') !== key) {
      cloudLayer.setSource(
        new ImageTileSource({
          projection: MAP_PROJECTION,
          // Deeper zooms would only enlarge the same 3-5 km pixels.
          maxZoom: CLOUD_MAX_ZOOM,
          attributions: spec.attributions,
          transition: 0,
          loader: (z, x, y, { signal }) =>
            loadWmsTile(spec.layer, spec.time, [z, x, y], signal, {
              size: cloudRequestSize(z),
              transform: (data) => recolourCloudMask(data, tint.rgb, tint.alpha),
            }),
        }),
      );
      cloudLayer.set('weatherKey', key);
    }
    cloudLayer.setVisible(true);
  }

  /** Show radar frame `index`; every frame's layer keeps loading for smooth playback. */
  function applyRadar(spec) {
    if (!spec?.frames.length) {
      radarGroup.setVisible(false);
      return;
    }
    const wanted = new Set(spec.frames.map((frame) => frame.url));
    const layers = radarGroup.getLayers();
    for (const [url, layer] of radarLayers) {
      if (wanted.has(url)) continue;
      layers.remove(layer);
      radarLayers.delete(url);
    }
    spec.frames.forEach((frame, index) => {
      let layer = radarLayers.get(frame.url);
      if (!layer) {
        layer = new TileLayer({
          source: new XYZ({
            url: frame.url,
            // 512 px images on the 256 px grid: sharp on HiDPI screens.
            tilePixelRatio: 2,
            maxZoom: spec.maxZoom,
            attributions: spec.attributions,
            transition: 0,
          }),
        });
        radarLayers.set(frame.url, layer);
        layers.push(layer);
      }
      layer.setOpacity(index === spec.index ? (spec.opacity ?? 0.75) : 0);
    });
    radarGroup.setVisible(true);
  }

  function applyLightning(spec) {
    if (!spec) {
      lightningLayer.setVisible(false);
      return;
    }
    const key = `${spec.layer}|${spec.time}`;
    if (lightningLayer.get('weatherKey') !== key) {
      lightningLayer.setSource(
        new ImageTileSource({
          projection: MAP_PROJECTION,
          // Flashes are a few km across: full-size tiles keep the server's detail.
          maxZoom: 10,
          attributions: spec.attributions,
          transition: 0,
          loader: (z, x, y, { signal }) => loadWmsTile(spec.layer, spec.time, [z, x, y], signal),
        }),
      );
      lightningLayer.set('weatherKey', key);
    }
    lightningLayer.setVisible(true);
  }

  function applyWind(spec) {
    windSource.clear(true);
    if (!spec) {
      windLayer.setVisible(false);
      return;
    }
    windSource.setAttributions(spec.attributions);
    windSource.addFeatures(
      spec.points.map((point) => {
        const feature = new Feature(new Point(fromLonLat([point.lon, point.lat], MAP_PROJECTION)));
        feature.set('wind', point);
        return feature;
      }),
    );
    windLayer.setVisible(true);
  }

  /**
   * Online weather over the terrain; each entry null hides it:
   *   clouds     { layer, time, attributions } EUMETSAT cloud-mask WMS image
   *   radar      { frames: [{ time, url }], index, maxZoom, opacity?, attributions }
   *   lightning  { layer, time, attributions } EUMETSAT lightning WMS image
   *   wind       { points: [{ lon, lat, speed, gusts, direction }], attributions }
   * `time` (ms) pins the image, so a newer one replaces the tiles.
   */
  function setWeather({ clouds = null, radar = null, lightning = null, wind = null }) {
    applyClouds(clouds);
    applyRadar(radar);
    applyLightning(lightning);
    applyWind(wind);
  }

  /**
   * The last fully rendered view as one canvas, for print, or null before the
   * first frame: every layer canvas composited at device resolution, plus a
   * scale bar (and a north arrow if rotated). Returns
   * `{ canvas, attributions, metresPerPixel }`. Tactical graphics, range
   * rings and the situation overlay (`setSituation`) are ordinary vector
   * layers over the basemap, so they are included the same way as every
   * other layer — no special-casing needed here.
   *
   * Taken after each `rendercomplete` rather than at print time: once the
   * print stylesheet hides the map, OpenLayers resizes it to nothing and
   * drops its canvases, so there is nothing left to copy by `beforeprint`.
   * The canvas is displayed, never read back, so other-origin tiles are fine.
   */
  function exportCanvas() {
    return lastFrame;
  }

  let lastFrame = null;
  let frameTimer = null;
  listenerKeys.push(
    map.on('rendercomplete', () => {
      window.clearTimeout(frameTimer);
      // Settle first: rendercomplete can fire on every frame of an animation.
      frameTimer = window.setTimeout(() => {
        const size = map.getSize();
        if (size?.[0] && size?.[1]) lastFrame = composeFrame(size);
      }, 250);
    }),
  );
  domCleanups.push(() => window.clearTimeout(frameTimer));

  function composeFrame([width, height]) {
    const ratio = window.devicePixelRatio || 1;
    const out = document.createElement('canvas');
    out.width = Math.round(width * ratio);
    out.height = Math.round(height * ratio);
    const context = out.getContext('2d');
    const viewport = map.getViewport();
    for (const canvas of viewport.querySelectorAll('.ol-layer canvas, canvas.ol-layer')) {
      if (!canvas.width) continue;
      const opacity = canvas.parentNode.style.opacity || canvas.style.opacity;
      context.globalAlpha = opacity === '' ? 1 : Number(opacity);
      // Each layer canvas carries its own CSS transform (canvas px -> CSS px).
      const matrix = canvas.style.transform
        ? canvas.style.transform
            .match(/^matrix\(([^(]*)\)$/)[1]
            .split(',')
            .map(Number)
        : [
            Number.parseFloat(canvas.style.width) / canvas.width,
            0,
            0,
            Number.parseFloat(canvas.style.height) / canvas.height,
            0,
            0,
          ];
      context.setTransform(...matrix.map((value) => value * ratio));
      const background = canvas.parentNode.style.backgroundColor;
      if (background) {
        context.fillStyle = background;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(canvas, 0, 0);
    }
    context.globalAlpha = 1;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const view = map.getView();
    const metresPerPixel = getPointResolution(
      MAP_PROJECTION,
      view.getResolution(),
      view.getCenter(),
      'm',
    );
    drawScaleBar(context, height, metresPerPixel);
    if (view.getRotation()) drawNorthArrow(context, width, view.getRotation());
    const attributions = [...viewport.querySelectorAll('.ol-attribution li')]
      .map((item) => item.textContent.trim())
      .filter(Boolean);
    return { canvas: out, attributions, metresPerPixel };
  }

  function renderMgrsGrid() {
    const size = map.getSize();
    const view = map.getView();
    if (!size || !view.getResolution()) return;
    const extent = view.calculateExtent(size);
    const toLonLatExtent = (value) => transformExtent(value, MAP_PROJECTION, DATA_PROJECTION);
    const metresPerPixel = getPointResolution(
      MAP_PROJECTION,
      view.getResolution(),
      view.getCenter(),
      'm',
    );
    const { lines, labels } = buildMgrsGrid({
      extent: toLonLatExtent(extent),
      drawExtent: toLonLatExtent(bufferExtent(extent, getWidth(extent) / 2)),
      spacing: mgrsGridSpacing(metresPerPixel),
    });
    const tone = darkBase ? 'light' : 'dark';
    const features = lines.map(({ rank, coordinates }) => {
      const feature = new Feature(
        new LineString(coordinates.map((point) => fromLonLat(point, MAP_PROJECTION))),
      );
      feature.setStyle(MGRS_LINE_STYLE[tone][rank]);
      return feature;
    });
    for (const { kind, text, coordinate } of labels) {
      const feature = new Feature(new Point(fromLonLat(coordinate, MAP_PROJECTION)));
      feature.setStyle(mgrsLabelStyle(kind, text, tone));
      features.push(feature);
    }
    mgrsSource.clear(true);
    mgrsSource.addFeatures(features);
  }

  listenerKeys.push(
    map.on('moveend', () => {
      if (mgrsLayer.getVisible()) renderMgrsGrid();
      const size = map.getSize();
      if (onViewChange && size?.[0] && size?.[1]) onViewChange({ bounds: getBounds(), size });
    }),
  );

  function setMgrsGrid(visible) {
    mgrsLayer.setVisible(visible);
    if (visible) renderMgrsGrid();
    else mgrsSource.clear(true);
  }

  function destroy() {
    cancelDraw();
    stopModify();
    stopEditing();
    measureController.destroy();
    listenerKeys.forEach((key) => unByKey(key));
    listenerKeys.length = 0;
    domCleanups.forEach((cleanup) => cleanup());
    domCleanups.length = 0;
    gridLayers.forEach((entry) => entry.layer.setSource(null));
    gridLayers.clear();
    iconCache.clear();
    featureSource.clear();
    situationSource.clear();
    sketchSource.clear();
    mgrsSource.clear(true);
    windSource.clear(true);
    radarLayers.clear();
    countriesSource.clear();
    regionsSource.clear();
    map.setTarget(null);
  }

  return {
    setFeatures,
    selectFeature,
    fitFeature,
    fitExtent,
    getBounds,
    getCenter,
    startDraw,
    cancelDraw,
    startModify,
    stopModify,
    startMeasure,
    stopMeasure,
    setGrid,
    clearGrid,
    setBasemap,
    setOverlays,
    setWeather,
    setMgrsGrid,
    setScenario,
    setSituation,
    setRegions,
    regionAt,
    placeAt,
    editCountry,
    drawArea,
    stopEditing,
    exportCanvas,
    destroy,
  };
}
