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
import ms from 'milsymbol';

import { buildMgrsGrid, mgrsGridSpacing } from './mgrsGrid.js';

const MAP_PROJECTION = 'EPSG:3857';
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

const VECTOR_STYLES = { roads: basemapStyle, topo: topoStyle };

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
/** Hamlets and neighbourhoods only from about zoom 13, or they bury villages. */
const MINOR_PLACE_MAX_RESOLUTION = 20;

/** Place, peak and water names from an OpenMapTiles-schema basemap. */
function placeLabelStyle(feature, resolution) {
  const name = feature.get('name');
  if (!name) return undefined;
  let style;
  let text = name;
  switch (feature.get('layer')) {
    case 'place': {
      const kind = feature.get('class');
      if (kind === 'city' || kind === 'town' || kind === 'village') style = PLACE_LABEL[kind];
      else if (resolution <= MINOR_PLACE_MAX_RESOLUTION) style = PLACE_LABEL.minor;
      break;
    }
    case 'mountain_peak': {
      const ele = feature.get('ele');
      style = PLACE_LABEL.peak;
      text = `▲ ${name}${ele ? ` ${ele} m` : ''}`;
      break;
    }
    case 'water_name':
      style = PLACE_LABEL.water;
      break;
    default:
      return undefined;
  }
  style?.getText().setText(text);
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

function buildSymbolStyle(sidc, label, iconCache) {
  let icon = iconCache.get(sidc);
  if (!icon) {
    const canvas = new ms.Symbol(sidc, { size: 28 }).asCanvas();
    icon = new IconStyle({ img: canvas, imgSize: [canvas.width, canvas.height] });
    iconCache.set(sidc, icon);
  }
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

function buildFeatureStyle(feature, iconCache) {
  const layerName = feature.get('layer');
  const properties = feature.get('properties') || {};
  const label = feature.get('label');
  const geometry = feature.getGeometry();
  if (!geometry) return [];

  if (properties.sidc) {
    return [buildSymbolStyle(properties.sidc, label, iconCache)];
  }

  const config = layerConfig(layerName);
  const color = properties.color || config.color;
  const geometryType = geometry.getType();
  const styles = [];

  if (geometryType === 'Point' || geometryType === 'MultiPoint') {
    styles.push(
      new Style({
        image: new CircleStyle({
          radius: 7,
          fill: new Fill({ color: withAlpha(color, 0.9) }),
          stroke: new Stroke({ color: '#1b1b1b', width: 1.5 }),
        }),
        text: label ? buildLabelText(label, 'Point') : undefined,
      }),
    );
    return styles;
  }

  styles.push(
    new Style({
      stroke: new Stroke({ color, width: config.width, lineDash: config.dash || undefined }),
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
  } = options;

  const geoJsonFormat = new GeoJSON();
  const iconCache = new Map();
  const gridLayers = new Map();
  const listenerKeys = [];
  const domCleanups = [];
  let selectedId = null;
  let drawInteraction = null;
  let modifyInteraction = null;

  const basemapSource = new PMTilesVectorSource({ url: basemapUrl });
  const basemapLayer = new VectorTileLayer({
    source: basemapSource,
    style: basemapStyle,
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
      styles.push(...buildFeatureStyle(feature, iconCache));
      return styles;
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
    style: hybridStyle,
  });
  const placesLayer = new VectorTileLayer({
    source: basemapSource,
    visible: false,
    declutter: true,
    style: placeLabelStyle,
  });

  const map = new OlMap({
    target,
    layers: [
      basemapLayer,
      imageryLayer,
      reliefLayer,
      slopeLayer,
      contourLayer,
      roadsLayer,
      placesLayer,
      mgrsLayer,
      featureLayer,
    ],
    view: new View({
      projection: MAP_PROJECTION,
      center: fromLonLat(center, MAP_PROJECTION),
      zoom,
    }),
  });

  if (onClick) {
    listenerKeys.push(
      map.on('singleclick', (event) => {
        const [lon, lat] = toLonLat(event.coordinate, MAP_PROJECTION);
        const hit = map.forEachFeatureAtPixel(event.pixel, (feature) => feature, {
          layerFilter: (layer) => layer === featureLayer,
          hitTolerance: 6,
        });
        onClick({ lon, lat, featureId: hit ? hit.getId() : null });
      }),
    );
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

  function fitFeature(id) {
    const feature = findFeature(id);
    const geometry = feature && feature.getGeometry();
    if (!geometry) return;
    map
      .getView()
      .fit(geometry.getExtent(), { padding: [48, 48, 48, 48], maxZoom: 18, duration: 250 });
  }

  function fitExtent(extent) {
    const extent3857 = transformExtent(extent, DATA_PROJECTION, MAP_PROJECTION);
    map.getView().fit(extent3857, { padding: [24, 24, 24, 24], duration: 250 });
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

  function startDraw(kind, drawOptions = {}) {
    cancelDraw();
    // Draw inserts the finished feature into its source right after dispatching
    // 'drawend', i.e. after our handler below has already cleared it once —
    // wipe any such leftover here so the headless sketch source never grows.
    sketchSource.clear();
    const geometryType = DRAW_GEOMETRY_TYPE[kind];
    if (!geometryType) throw new Error(`createMap: unknown draw kind "${kind}"`);
    const config = layerConfig(drawOptions.layer);
    drawInteraction = new Draw({
      source: sketchSource,
      type: geometryType,
      style: new Style({
        stroke: new Stroke({ color: config.color, width: 2, lineDash: [6, 4] }),
        fill: new Fill({ color: withAlpha(config.color, 0.15) }),
        image: new CircleStyle({
          radius: 6,
          fill: new Fill({ color: config.color }),
          stroke: new Stroke({ color: '#ffffff', width: 1.5 }),
        }),
      }),
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
      const style = VECTOR_STYLES[vector.style ?? 'roads'];
      if (basemapLayer.getStyle() !== style) basemapLayer.setStyle(style);
    }
    applyTileSpec(imageryLayer, imagery);
    applyTileSpec(reliefLayer, relief);
    darkBase = Boolean(imagery?.dark);
    contourLayer.changed();
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

  /**
   * The last fully rendered view as one canvas, for print, or null before the
   * first frame: every layer canvas composited at device resolution, plus a
   * scale bar (and a north arrow if rotated). Returns
   * `{ canvas, attributions, metresPerPixel }`.
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
    listenerKeys.forEach((key) => unByKey(key));
    listenerKeys.length = 0;
    domCleanups.forEach((cleanup) => cleanup());
    domCleanups.length = 0;
    gridLayers.forEach((entry) => entry.layer.setSource(null));
    gridLayers.clear();
    iconCache.clear();
    featureSource.clear();
    sketchSource.clear();
    mgrsSource.clear(true);
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
    setGrid,
    clearGrid,
    setBasemap,
    setOverlays,
    setMgrsGrid,
    exportCanvas,
    destroy,
  };
}
