// Basemap styles: the muted default, Topo, the hybrid reference overlay,
// place labels and contours.

import { toLonLat } from 'ol/proj.js';
import { getCenter as extentCenter } from 'ol/extent.js';
import Style from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import Fill from 'ol/style/Fill.js';
import TextStyle from 'ol/style/Text.js';

import { MAP_PROJECTION } from './projection.js';

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

export function basemapStyle(feature) {
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

export function topoStyle(feature) {
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

export function hybridStyle(feature) {
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

export const PLACE_LABEL = {
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
export const DIMMED_PLACE_LABEL = {
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
export function resolvePlaceClass(feature, resolution) {
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
export function featureLonLat(feature) {
  const coordinate =
    feature.getType() === 'Point'
      ? feature.getFlatCoordinates().slice(0, 2)
      : extentCenter(feature.getExtent());
  return toLonLat(coordinate, MAP_PROJECTION);
}

/** Place, peak and water names from an OpenMapTiles-schema basemap. */
export function placeLabelStyle(feature, resolution) {
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

export const CONTOUR_STYLE = { dark: contourStyles('dark'), light: contourStyles('light') };
