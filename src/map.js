// Tactical map engine on top of OpenLayers 10. All public coordinates are
// lon/lat (EPSG:4326); the view itself runs in EPSG:3857 internally.
import { Map as OlMap, View } from 'ol';
import { unByKey } from 'ol/Observable.js';
import { fromLonLat, getPointResolution, toLonLat, transformExtent } from 'ol/proj.js';
import { buffer as bufferExtent, getCenter as extentCenter, getWidth } from 'ol/extent.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import VectorLayer from 'ol/layer/Vector.js';
import ImageLayer from 'ol/layer/Image.js';
import VectorSource from 'ol/source/Vector.js';
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
      return LANDUSE_STYLE;
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
const MGRS_LINE_STYLE = {
  zone: new Style({ stroke: new Stroke({ color: MGRS_INK, width: 2.2 }) }),
  square: new Style({ stroke: new Stroke({ color: MGRS_INK, width: 1.4 }) }),
  line: new Style({ stroke: new Stroke({ color: 'rgba(18, 50, 74, 0.5)', width: 0.8 }) }),
};
const MGRS_LABEL_TEXT = {
  // Easting digits sit just above the bottom edge, northing digits just
  // right of the left edge, as on a paper map sheet's margin.
  easting: { font: `600 11px ${MGRS_FONT}`, textBaseline: 'bottom', offsetY: -4 },
  northing: { font: `600 11px ${MGRS_FONT}`, textAlign: 'left', offsetX: 5 },
  square: { font: `700 12px ${MGRS_FONT}`, boxed: true },
  zone: { font: `700 13px ${MGRS_FONT}`, boxed: true },
};

function mgrsLabelStyle(kind, text) {
  const { boxed, ...options } = MGRS_LABEL_TEXT[kind];
  return new Style({
    text: new TextStyle({
      ...options,
      text,
      fill: new Fill({ color: MGRS_INK }),
      ...(boxed
        ? {
            backgroundFill: new Fill({ color: 'rgba(255, 255, 255, 0.85)' }),
            padding: [2, 5, 2, 5],
          }
        : { stroke: new Stroke({ color: '#ffffff', width: 3 }) }),
    }),
  });
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

  const map = new OlMap({
    target,
    layers: [basemapLayer, mgrsLayer, featureLayer],
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

  function setBasemapVisible(visible) {
    basemapLayer.setVisible(visible);
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
    const features = lines.map(({ rank, coordinates }) => {
      const feature = new Feature(
        new LineString(coordinates.map((point) => fromLonLat(point, MAP_PROJECTION))),
      );
      feature.setStyle(MGRS_LINE_STYLE[rank]);
      return feature;
    });
    for (const { kind, text, coordinate } of labels) {
      const feature = new Feature(new Point(fromLonLat(coordinate, MAP_PROJECTION)));
      feature.setStyle(mgrsLabelStyle(kind, text));
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
    setBasemapVisible,
    setMgrsGrid,
    destroy,
  };
}
