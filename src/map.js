// Tactical map engine on top of OpenLayers 10. All public coordinates are
// lon/lat (EPSG:4326); the view itself runs in EPSG:3857 internally.
import { Map as OlMap, View } from 'ol';
import { unByKey } from 'ol/Observable.js';
import { fromLonLat, getPointResolution, toLonLat, transformExtent } from 'ol/proj.js';
import { buffer as bufferExtent, getWidth } from 'ol/extent.js';
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
import { defaults as defaultControls, ScaleLine } from 'ol/control.js';
import { buildMgrsGrid, mgrsGridSpacing } from './mgrsGrid.js';
import { recolourCloudMask } from './weather.js';
import { TACTICAL_GRAPHICS, graphicColor } from './tactical.js';
import { createMeasureController } from './measure.js';
import {
  CONTOUR_STYLE,
  DIMMED_PLACE_LABEL,
  PLACE_LABEL,
  basemapStyle,
  featureLonLat,
  hybridStyle,
  placeLabelStyle,
  resolvePlaceClass,
  topoStyle,
} from './map/basemapStyles.js';
import { buildGridCanvas, drawNorthArrow, drawScaleBar, paintGridInto } from './map/canvas.js';
import {
  SYMBOL_SIZES,
  TRACE_TOLERANCE_PX,
  buildFeatureStyle,
  buildSelectionHalo,
  layerConfig,
  simplifyTrace,
  withAlpha,
} from './map/featureStyles.js';
import {
  MGRS_LINE_STYLE,
  SITUATION_HISTORY_DOT_STYLE,
  SITUATION_HISTORY_STYLE,
  buildScenarioNameIndex,
  countryStyle,
  matchScenarioPlace,
  mgrsLabelStyle,
  regionStyle,
  situationReportStyle,
  situationTrackStyle,
} from './map/overlayStyles.js';
import {
  DATA_PROJECTION,
  DRAW_GEOMETRY_TYPE,
  GEOJSON_OPTIONS,
  MAP_PROJECTION,
} from './map/projection.js';
import {
  CLOUD_MAX_ZOOM,
  CLOUD_TINT,
  cloudRequestSize,
  loadWmsTile,
  windStyle,
} from './map/weather.js';

export { SYMBOL_SIZES } from './map/featureStyles.js';
export { buildScenarioNameIndex, matchScenarioPlace } from './map/overlayStyles.js';

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
  // Icons drawn at the map's current symbol size; setSymbolSize redraws.
  const symbols = { cache: new Map(), size: SYMBOL_SIZES.medium };
  const gridLayers = new Map();
  const listenerKeys = [];
  const domCleanups = [];
  let selectedId = null;
  let drawInteraction = null;
  let modifyInteraction = null;
  /** The feature id `modifyInteraction` reshapes, so setFeatures can re-arm it. */
  let modifyId = null;
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
      styles.push(...buildFeatureStyle(feature, symbols, darkBase));
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
          return situationTrackStyle(feature, symbols);
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
      // While drawing, the right button traces (startDraw): no menu.
      if (drawInteraction) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
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
    // A feature being reshaped was just replaced by its fresh copy: keep
    // reshaping that one, not the removed feature the interaction still holds.
    if (modifyInteraction && modifyId !== null) startModify(modifyId);
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
      const trackFeature = new Feature(
        new Point(fromLonLat([track.lon, track.lat], MAP_PROJECTION)),
      );
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

  /** `maxZoom` keeps a single point (a zero-size extent) from zooming to the last level. */
  function fitExtent(extent, { maxZoom } = {}) {
    const extent3857 = transformExtent(extent, DATA_PROJECTION, MAP_PROJECTION);
    map.getView().fit(extent3857, { padding: fitPadding(24), duration: 250, maxZoom });
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
      ? graphicSketchStyle(
          drawOptions.graphic,
          drawOptions,
          graphicColor(drawOptions.affiliation, darkBase),
        )
      : new Style({
          stroke: new Stroke({ color: config.color, width: 2, lineDash: [6, 4] }),
          fill: new Fill({ color: withAlpha(config.color, 0.15) }),
          image: new CircleStyle({
            radius: 6,
            fill: new Fill({ color: config.color }),
            stroke: new Stroke({ color: '#ffffff', width: 1.5 }),
          }),
        });
    // Holding the right mouse button traces a line or area freehand; the
    // left button still places one vertex per click. The two mix: trace
    // part of an outline, then click the rest.
    let traced = false;
    drawInteraction = new Draw({
      source: sketchSource,
      type: geometryType,
      style,
      freehandCondition: (event) => {
        const pointer = event.originalEvent;
        const right =
          pointer.pointerType === 'mouse' && ((pointer.buttons & 2) !== 0 || pointer.button === 2);
        if (right && event.type === 'pointerdrag') traced = true;
        return right;
      },
    });
    drawInteraction.on('drawend', (event) => {
      let drawn = event.feature.getGeometry();
      // A trace samples every pointer move; keep only what shows at this
      // zoom (vertices ~2 px apart or more), so a traced area stays a
      // manageable list of corners.
      if (traced) drawn = simplifyTrace(drawn, map.getView().getResolution() * TRACE_TOLERANCE_PX);
      const geometry = geoJsonFormat.writeGeometryObject(drawn, GEOJSON_OPTIONS);
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
    modifyId = null;
  }

  function startModify(id) {
    stopModify();
    measureController.stop();
    const feature = findFeature(id);
    if (!feature) return;
    const modifySource = new VectorSource({ features: [feature] });
    modifyInteraction = new Modify({ source: modifySource });
    modifyId = id;
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
    editingScenario = editing;
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

  /**
   * Resolves with the next settled frame (as `exportCanvas()` returns it),
   * after asking for a render: unlike `exportCanvas()`, never a frame from
   * before a view change or layer update that is still loading — what a
   * print button waits on before calling `window.print()`.
   */
  function nextFrame() {
    return new Promise((resolve) => {
      frameWaiters.push(resolve);
      map.render();
    });
  }

  let lastFrame = null;
  let frameTimer = null;
  const frameWaiters = [];
  listenerKeys.push(
    map.on('rendercomplete', () => {
      window.clearTimeout(frameTimer);
      // Settle first: rendercomplete can fire on every frame of an animation.
      frameTimer = window.setTimeout(() => {
        const size = map.getSize();
        if (size?.[0] && size?.[1]) lastFrame = composeFrame(size);
        if (lastFrame) frameWaiters.splice(0).forEach((resolve) => resolve(lastFrame));
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

  /** Redraws every unit and track symbol at `size` px (see SYMBOL_SIZES). */
  function setSymbolSize(size) {
    if (!Number.isFinite(size) || size === symbols.size) return;
    symbols.size = size;
    symbols.cache.clear();
    featureLayer.changed();
    situationLayer.changed();
  }

  /** `[lon, lat]` under a viewport point (e.g. where something was dropped), or null outside the map. */
  function lonLatAtClient(clientX, clientY) {
    const rect = map.getViewport().getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    const coordinate = map.getCoordinateFromPixel([x, y]);
    return coordinate ? toLonLat(coordinate, MAP_PROJECTION) : null;
  }

  /** `[lon, lat]` that lies `dx`, `dy` screen px from `lonLat` at the current view. */
  function offsetLonLat(lonLat, dx, dy) {
    const pixel = map.getPixelFromCoordinate(fromLonLat(lonLat, MAP_PROJECTION));
    return toLonLat(map.getCoordinateFromPixel([pixel[0] + dx, pixel[1] + dy]), MAP_PROJECTION);
  }

  function setMgrsGrid(visible) {
    mgrsLayer.setVisible(visible);
    if (visible) renderMgrsGrid();
    else mgrsSource.clear(true);
  }

  function destroy() {
    // A print still waiting on a frame gets none rather than hanging.
    frameWaiters.splice(0).forEach((resolve) => resolve(null));
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
    symbols.cache.clear();
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
    setSymbolSize,
    lonLatAtClient,
    offsetLonLat,
    setScenario,
    setSituation,
    setRegions,
    regionAt,
    placeAt,
    editCountry,
    drawArea,
    stopEditing,
    exportCanvas,
    nextFrame,
    destroy,
  };
}
