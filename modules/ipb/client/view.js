import './styles.css';
import './staff.css';
import template from './view.html?raw';

import { lightData } from '../../../src/astro.js';
import { formatDtg } from '../../../src/dtg.js';
import { formatArea, formatMetres, formatMgrs, parseCoordinate } from '../../../src/geo.js';
import { clientId, subscribe } from '../../../src/live.js';
import {
  SYMBOL_SIZES,
  buildScenarioNameIndex,
  createMap,
  matchScenarioPlace,
} from '../../../src/map.js';
import { canEditClient, renderCellBadge, renderReleaseControl } from '../../../src/release.js';
import {
  can,
  cellLabel,
  currentUser,
  handleUnauthorized,
  isWhite,
  sessionMode,
} from '../../../src/session.js';
import {
  CLOUD_LAYER,
  EUMETSAT_ATTRIBUTION,
  LIGHTNING_LAYER,
  OPEN_METEO_ATTRIBUTION,
  RAINVIEWER_API,
  RAINVIEWER_ATTRIBUTION,
  RAINVIEWER_MAX_ZOOM,
  compassPoint,
  forecastUrl,
  latestWmsTime,
  parseForecasts,
  parseWind,
  radarFrames,
  weatherText,
  windLattice,
  windUrl,
  wmsCapabilitiesUrl,
} from '../../../src/weather.js';
import { renderCivilConsiderationsMatrix } from './civil.js';
import {
  applyClassificationBanner,
  renderClassificationField,
  renderExchangeTools,
} from './exchange.js';
import { initMapToolbar, renderGraphicsAndRingsList } from './mapTools.js';
import {
  areaFeatures,
  areaMenuItems,
  handleAreaDrawn,
  handleAreaReshaped,
  isAreaId,
  renderAreaTools,
  renderAreaWorksheet,
} from './areas.js';
import {
  filterByCoa,
  handleSitempClick,
  initSitemp,
  refreshOrbatLinks,
  renderSitempTools,
  renderSitempWorksheet,
  unitMenuItems,
} from './sitemp.js';
import { destroySituation, renderSituationOverlayRow, setSituationEnabled } from './situation.js';
import {
  destroyTimeline,
  renderDecisionPointsSection,
  renderEventTimeChip,
  renderHHourField,
  renderPhasesSection,
  renderTimelineStripSection,
  sortEventGroups,
} from './timeline.js';
import { importThreatsFromOrbat, renderThreatSymbolCell } from './threatSymbols.js';
import { renderWeatherEffectsBlock, resolveWeatherEffectsPoint } from './weatherEffects.js';

const API = '/api/ipb';
const TERRAIN_API = '/api/terrain';
const EQUIPMENT_API = '/api/equipment';
const EXERCISE_API = '/api/exercise';

const DEFAULT_CENTER = [17.5, 49.7];
const DEFAULT_ZOOM = 11;

/** The only basemaps that need internet; everything else is served locally. */
const ONLINE_BASEMAPS = {
  'topo-online': {
    url: 'https://{a-c}.tile.opentopomap.org/{z}/{x}/{y}.png',
    maxZoom: 17,
    attributions:
      'Map data: © OpenStreetMap contributors, SRTM | Map style: © OpenTopoMap (CC-BY-SA)',
  },
  'satellite-online': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
    dark: true,
    attributions:
      // Esri's credit for this item (arcgis.com item 10df2279f9684e4a9f6a7f08febac2a9).
      'Tiles © Esri — Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
  },
  'ortho-online': {
    url: 'https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 20,
    dark: true,
    // The service's own fullExtent (EPSG:3857 x 1321579..2130407, y 6141009..6694506)
    // reprojected to lon/lat, so Roads shows around it past the Czech border.
    extent: [11.87195, 48.20489, 19.13777, 51.41205],
    attributions: 'Ortofoto © ČÚZK (CC BY 4.0)',
  },
};
const BASEMAPS = [
  { id: 'roads', label: 'Roads' },
  {
    id: 'terrain',
    label: 'Terrain',
    missing: 'No elevation data yet: run node modules/terrain/tools/build_terrain.mjs',
  },
  {
    id: 'topo',
    label: 'Topo',
    title: 'Offline topographic map: land cover, tracks, hillshade, contours and names',
    missing: 'No elevation data yet: run node modules/terrain/tools/build_terrain.mjs',
    // Drawn as part of this basemap; the Layers panel shows them locked on.
    includes: ['contours', 'places'],
  },
  {
    id: 'satellite',
    label: 'Satellite',
    missing: 'No imagery yet: run node modules/terrain/tools/build_satellite.mjs',
  },
  {
    id: 'aerial',
    label: 'Aerial',
    title: 'Offline ČÚZK aerial orthophoto, sub-metre',
    missing: 'No imagery yet: run node modules/terrain/tools/build_satellite.mjs --source cuzk',
  },
  {
    id: 'topo-online',
    label: 'OpenTopoMap',
    note: 'online',
    title: 'Streams OpenTopoMap; needs an internet connection',
  },
  {
    id: 'satellite-online',
    label: 'Satellite HD',
    note: 'online',
    title: 'Streams Esri World Imagery; needs an internet connection',
  },
  {
    id: 'ortho-online',
    label: 'ČÚZK Ortho',
    note: 'online',
    title: 'Streams ČÚZK aerial orthophoto; needs an internet connection',
  },
];
const NO_ELEVATION = 'No elevation data yet: run node modules/terrain/tools/build_terrain.mjs';
const OVERLAYS = [
  {
    id: 'contours',
    label: 'Contour lines',
    hint: '10 m, labelled every 50 m, when zoomed in',
    missing: NO_ELEVATION,
  },
  { id: 'slope', label: 'Slope classes', missing: NO_ELEVATION },
  {
    id: 'roads',
    label: 'Roads & water',
    hint: 'for the satellite basemaps',
    missing: 'No vector basemap: see the README, Terrain section',
  },
  {
    id: 'places',
    label: 'Place names',
    missing:
      'vector.pmtiles was built without place/name layers: rebuild it with the Planetiler command in the README',
  },
];

const MINUTE = 60_000;
/**
 * Online weather overlays. Each request tells the service which area is being
 * looked at, so they stay off until switched on. `refresh` is how often the
 * newest image (or wind readings) is checked while on.
 */
const WEATHER_OVERLAYS = [
  {
    id: 'clouds',
    label: 'Clouds',
    source: 'Meteosat cloud mask, every 15 min',
    caption: 'Clouds',
    refresh: 5 * MINUTE,
  },
  {
    id: 'radar',
    label: 'Precipitation radar',
    source: 'RainViewer, past 2 h',
    caption: 'Radar',
    refresh: 5 * MINUTE,
  },
  {
    id: 'lightning',
    label: 'Lightning',
    source: 'Meteosat Lightning Imager; yellow → red: more flashes',
    caption: 'Lightning',
    refresh: 5 * MINUTE,
  },
  {
    id: 'wind',
    label: 'Wind (10 m)',
    source: 'Open-Meteo model; arrows downwind, m/s (gusts)',
    caption: 'Wind',
    refresh: 15 * MINUTE,
  },
];
const WEATHER_BY_ID = new Map(WEATHER_OVERLAYS.map((overlay) => [overlay.id, overlay]));
const WEATHER_UNAVAILABLE = 'Unavailable: no connection, or the service is down';
const RADAR_FRAME_MS = 700;
const CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const STEP_NAMES = {
  1: 'Define the environment',
  2: 'Describe the effects',
  3: 'Evaluate the threat',
  4: 'Threat courses of action',
};

const KIND_LABELS = { point: 'Point', line: 'Line', polygon: 'Area' };

const FEATURE_LAYERS = {
  'key-terrain': { label: 'Key terrain', kinds: ['point', 'polygon'] },
  avenue: { label: 'Avenue of approach', kinds: ['line'] },
  obstacle: { label: 'Obstacle', kinds: ['point', 'line', 'polygon'] },
  nai: { label: 'Named area of interest', kinds: ['point', 'polygon'] },
  tai: { label: 'Target area of interest', kinds: ['point', 'polygon'] },
  coa: { label: 'COA sketch', kinds: ['point', 'line', 'polygon'] },
};
const OAKOC_LAYERS = ['key-terrain', 'avenue', 'obstacle'];

const MOBILITY_CELL_SIZES = [50, 100, 200];
/** 0 dead ground, 1 seen by one post, 2 seen by two or more (dem.js viewshed). */
const VIEWSHED_PALETTE = {
  0: 'rgba(31, 65, 76, 0.35)',
  1: 'rgba(216, 91, 43, 0.45)',
  2: 'rgba(216, 91, 43, 0.75)',
  255: null,
};

const ECHELONS = [
  'team',
  'squad',
  'section',
  'platoon',
  'company',
  'battalion',
  'regiment',
  'brigade',
  'division',
  'corps',
  'army',
];

const EVENT_STATUSES = ['expected', 'observed', 'not-observed'];
const EVENT_STATUS_LABELS = {
  expected: 'Expected',
  observed: 'Observed',
  'not-observed': 'Not observed',
};

let state;
let elements;
let mapController;
let mapToolsController;

// --- State & elements ------------------------------------------------------

/** Basemap, overlays and grid survive reloads; everything else is per session. */
const MAP_VIEW_KEY = 'ipb.mapView';

function loadMapView() {
  const view = {
    basemap: 'roads',
    overlays: {
      contours: false,
      slope: false,
      roads: false,
      places: false,
      // Off by default (item 1's Situation overlay): tracks/reports from the
      // Exercise module, drawn via src/map.js's setSituation.
      situation: false,
      ...Object.fromEntries(WEATHER_OVERLAYS.map((overlay) => [overlay.id, false])),
    },
    grid: true,
    symbolSize: 'medium',
  };
  try {
    const saved = JSON.parse(window.localStorage.getItem(MAP_VIEW_KEY) ?? 'null');
    if (BASEMAPS.some((basemap) => basemap.id === saved?.basemap)) view.basemap = saved.basemap;
    for (const id of Object.keys(view.overlays)) {
      if (typeof saved?.overlays?.[id] === 'boolean') view.overlays[id] = saved.overlays[id];
    }
    if (typeof saved?.grid === 'boolean') view.grid = saved.grid;
    if (Object.hasOwn(SYMBOL_SIZES, saved?.symbolSize ?? '')) view.symbolSize = saved.symbolSize;
  } catch {
    // Unreadable or blocked storage: fall back to the defaults above.
  }
  return view;
}

function saveMapView() {
  try {
    window.localStorage.setItem(
      MAP_VIEW_KEY,
      JSON.stringify({
        basemap: state.basemap,
        overlays: state.overlays,
        grid: state.grid,
        symbolSize: state.symbolSize,
      }),
    );
  } catch {
    // Storage full or blocked: the choice just won't survive a reload.
  }
}

/** Which floating sheets are out; remembered like the map view. */
const SHEETS_KEY = 'ipb.sheets';
/** Below this width the sheets dock to the bottom half, one at a time. */
const NARROW_QUERY = '(max-width: 980px)';

function loadSheets() {
  const sheets = { tools: true, worksheet: true };
  try {
    const saved = JSON.parse(window.localStorage.getItem(SHEETS_KEY) ?? 'null');
    for (const name of Object.keys(sheets)) {
      if (typeof saved?.[name] === 'boolean') sheets[name] = saved[name];
    }
  } catch {
    // Unreadable or blocked storage: both sheets out.
  }
  return sheets;
}

function saveSheets() {
  try {
    window.localStorage.setItem(SHEETS_KEY, JSON.stringify(state.sheets));
  } catch {
    // Storage full or blocked: the layout just won't survive a reload.
  }
}

function createState() {
  return {
    session: new AbortController(),
    sheets: loadSheets(),
    // The one active scenario (Exercise module), or null; see loadScenario.
    scenario: null,
    studies: [],
    studyQuery: '',
    studyId: null,
    study: null,
    step: 1,
    tool: null,
    losPicks: [],
    losForm: { observer: 1.8, target: 1.8 },
    losResult: null,
    viewshedForm: { radius: 3000, observer: 1.8, target: 1.8 },
    lightForm: { start: localDateInputValue(new Date()), days: 7 },
    viewshedResult: null,
    /** Observation posts of the combined viewshed, in the order added. */
    viewshedPosts: [],
    keyTerrain: { prominence: 30, running: false, candidates: null },
    avenues: { width: 500, picks: [], running: false, routes: null },
    mobility: { cell: 100, opacity: 0.55, grid: null, running: false },
    selectedFeatureId: null,
    selectedCoaId: null,
    /** SITEMP (step 4): show every COA's units/graphics instead of only the
     * selected one's — a plain toggle, not persisted (like selectedCoaId). */
    showAllCoas: false,
    /** SITEMP placement: new units go on every COA instead of the selected one. */
    unitsOnEveryCoa: false,
    /** AO/AOI corner editor: the notation corners are shown in ('mgrs' | 'dd'). */
    areaFormat: 'mgrs',
    /** SITEMP placement: the affiliation a custom symbol's picker opens on. */
    customAffiliation: 'hostile',
    /** ORBAT id -> its units (null when this user can't load it), for units
     * placed from an ORBAT; filled by sitemp.js's refreshOrbatLinks. */
    orbatUnits: new Map(),
    /** The custom layer expanded in the panel (its points listed, add form shown). */
    activeLayerId: null,
    terrainMeta: null,
    ...loadMapView(),
    equipmentQuery: '',
    equipmentResults: [],
    equipmentLoading: false,
    equipmentRequest: null,
    equipmentBookmarks: [],
    studyRequest: null,
    timers: new Map(),
    weather: {
      clouds: { time: null, checkedAt: 0, loading: false, error: null },
      lightning: { time: null, checkedAt: 0, loading: false, error: null },
      radar: { frames: [], index: -1, playing: false, checkedAt: 0, loading: false, error: null },
      /** Readings by lattice key; `points` are the ones for the current view. */
      wind: {
        readings: new Map(),
        points: [],
        view: null,
        checkedAt: 0,
        loading: false,
        error: null,
      },
      /**
       * Where the study's weather is read, resolved offline from terrain.db:
       * the weather point with its ground height, and the AOI's highest and
       * lowest ground. `key` says which study/AOI/point it was resolved for.
       */
      site: { key: null, value: null, loading: false, error: null },
      /** `key` is the site last asked for, `dataKey` the one `data` is for. */
      forecast: { key: null, dataKey: null, data: null, fetchedAt: 0, loading: false, error: null },
      /** Latest report of the nearest station, for the weather point `dataKey`. */
      station: { key: null, dataKey: null, data: null, loading: false, error: null },
    },
  };
}

function queryElements(root) {
  const pick = (selector) => root.querySelector(selector);
  return {
    printButton: pick('#print-worksheet'),
    printMap: pick('#print-map'),
    studyToggle: pick('#study-toggle'),
    studyName: pick('#study-name'),
    studyMenu: pick('#study-menu'),
    studySearch: pick('#study-search'),
    studyList: pick('#study-list'),
    createStudy: pick('#create-study'),
    mastheadStudy: pick('#masthead-study'),
    stepNav: pick('#step-nav'),
    toolPanel: pick('#tool-panel'),
    workspace: pick('#workspace'),
    controlPanel: pick('#control-panel'),
    detailPanel: pick('#detail-panel'),
    toolsToggle: pick('#tools-toggle'),
    worksheetToggle: pick('#worksheet-toggle'),
    mapTarget: pick('#map-target'),
    mapTools: pick('#map-tools'),
    classificationTop: pick('#classification-banner-top'),
    classificationBottom: pick('#classification-banner-bottom'),
    pointerMgrs: pick('#pointer-mgrs'),
    pointerElevation: pick('#pointer-elevation'),
    gridToggle: pick('#grid-toggle'),
    symbolSizeSwitch: pick('#symbol-size-switch'),
    mapMenuToggle: pick('#map-menu-toggle'),
    mapMenuLabel: pick('#map-menu-label'),
    mapPopover: pick('#map-popover'),
    mapPopoverScenario: pick('#map-popover-scenario'),
    basemapSwitch: pick('#basemap-switch'),
    scenarioChip: pick('#scenario-chip'),
    overlayList: pick('#overlay-list'),
    mapHint: pick('#map-hint'),
    mapClickInfo: pick('#map-click-info'),
    statusBar: pick('#status-bar'),
    zoomIn: pick('#zoom-in'),
    zoomOut: pick('#zoom-out'),
    infoToggle: pick('#info-toggle'),
    infoPopover: pick('#info-popover'),
    mapEmpty: pick('#map-empty'),
    mapEmptyCreate: pick('#map-empty-create'),
    worksheetStudyName: pick('#worksheet-study-name'),
    worksheetStudyRelease: pick('#worksheet-study-release'),
    worksheet1: pick('#worksheet-1'),
    worksheet2: pick('#worksheet-2'),
    worksheet3: pick('#worksheet-3'),
    worksheet4: pick('#worksheet-4'),
    customLayers: pick('#custom-layers'),
    layersPrint: pick('#worksheet-layers'),
  };
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** C2b: whether the currently open study is editable for this client —
 * release grants read access only, so a study visible only because it was
 * released to your cell (or you're merely an observer of your own cell's
 * study) still locks every mutating control the same way a below-analyst
 * role does. True with nothing open (a create-new action, ungated by any
 * study's cell). Mirrors `server/policy.js`'s `canEdit`. */
function canEditStudy() {
  return !state.study || canEditClient(state.study.study);
}

/** The hide/disable/readOnly behaviour `editable()` applies to a control it
 * has decided is locked; factored out so a control gated on a specific
 * study other than the currently open one (a study-list row) can apply the
 * same lock without going through `editable()`'s own (open-study) check. */
function applyLock(el, { hide = el.tagName === 'BUTTON' } = {}) {
  const locksAsDisabled =
    el.tagName === 'SELECT' ||
    el.tagName === 'BUTTON' ||
    ['checkbox', 'radio', 'color', 'range'].includes(el.type);
  if (hide) el.hidden = true;
  else if (locksAsDisabled) el.disabled = true;
  else el.readOnly = true;
  return el;
}

/**
 * The single role gate for every control this module renders that mutates
 * study data (the server enforces this regardless; this only hides or locks
 * what an observer/below-analyst role, or a cell with read-only release
 * access (C2b), can't use). Call it at the point a control is created:
 * `editable(createElement('button', 'icon-button danger', 'Delete'))`. A
 * `<button>` (or a whole-row/whole-group wrapper passed `{ hide: true }`) is
 * hidden outright — its absence leaves no layout gap. A text/number/date
 * input, textarea or `<select>` defaults to locked in place instead, so its
 * current value (and, for a textarea with one, its `.print-copy` sibling)
 * still shows; pass `{ hide: true }` to hide one of those too (e.g. a field
 * that only exists to feed an add button). A checkbox/radio/colour input is
 * disabled either way, since neither can be marked read-only.
 */
function editable(el, opts) {
  if (can('analyst') && canEditStudy()) return el;
  return applyLock(el, opts);
}

/** Like `editable()`, but gated on a given `study` (e.g. a study-list row)
 * rather than the currently open one. */
function editableFor(study, el, opts) {
  if (can('analyst') && canEditClient(study)) return el;
  return applyLock(el, opts);
}

function foldText(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function showError(container, message) {
  let node = container.querySelector(':scope > .inline-error');
  if (!node) {
    node = createElement('p', 'inline-error');
    container.prepend(node);
  }
  node.textContent = message;
}

function clearError(container) {
  container.querySelector(':scope > .inline-error')?.remove();
}

// --- Prompts ---------------------------------------------------------------

let dialogNode;

/** One reusable <dialog>: focus trap, Escape and backdrop come for free. */
function createDialogNode(root) {
  dialogNode = createElement('dialog', 'workspace-dialog');
  const form = createElement('form');
  form.method = 'dialog';
  const message = createElement('p', 'dialog-message');
  const input = createElement('input', 'dialog-input');
  input.type = 'text';
  input.autocomplete = 'off';
  // Labelled fields for multi-value prompts (askFields); empty otherwise.
  const fields = createElement('div', 'dialog-fields');
  const actions = createElement('div', 'dialog-actions');
  // Enter in the text input submits the form with its *first* submit button,
  // so Cancel must not be one, or Enter would discard what was typed. As the
  // first focusable control it still takes Enter in inputless confirms,
  // which keeps "Delete?" defaulting to the safe answer.
  const cancel = createElement('button', 'text-button', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => dialogNode.close('cancel'));
  const accept = createElement('button', 'dialog-accept');
  accept.type = 'submit';
  accept.value = 'accept';
  actions.append(cancel, accept);
  form.append(message, input, fields, actions);
  dialogNode.append(form);
  root.append(dialogNode);
}

function openDialog({ message, initial, accept, withInput, fields, destructive = false }) {
  dialogNode.querySelector('.dialog-message').textContent = message;
  const input = dialogNode.querySelector(':scope form > .dialog-input');
  input.hidden = !withInput;
  input.value = initial ?? '';
  const fieldBox = dialogNode.querySelector('.dialog-fields');
  const controls = (fields ?? []).map((field) => {
    const label = createElement('label', 'dialog-field');
    label.append(createElement('span', null, field.label));
    // A textarea keeps Enter for new lines; in a text input Enter saves; a
    // field with `options` (e.g. an owner-cell choice) is a <select>.
    const control = field.options
      ? document.createElement('select')
      : document.createElement(field.multiline ? 'textarea' : 'input');
    control.className = 'dialog-input';
    if (field.options) {
      for (const option of field.options) {
        const optionEl = document.createElement('option');
        optionEl.value = option.value;
        optionEl.textContent = option.label;
        control.append(optionEl);
      }
      control.value = field.value ?? field.options[0]?.value ?? '';
    } else if (field.multiline) {
      control.rows = 3;
      control.value = field.value ?? '';
      control.placeholder = field.placeholder ?? '';
    } else {
      control.type = 'text';
      control.autocomplete = 'off';
      control.value = field.value ?? '';
      control.placeholder = field.placeholder ?? '';
    }
    label.append(control);
    return [field.id, control, label];
  });
  fieldBox.replaceChildren(...controls.map(([, , label]) => label));
  fieldBox.hidden = !controls.length;
  const acceptButton = dialogNode.querySelector('.dialog-accept');
  acceptButton.textContent = accept;
  acceptButton.classList.toggle('danger', destructive);
  return new Promise((resolve) => {
    const settle = () => {
      dialogNode.removeEventListener('close', settle);
      const accepted = dialogNode.returnValue === 'accept';
      if (fields) {
        return resolve(
          accepted
            ? Object.fromEntries(controls.map(([id, control]) => [id, control.value.trim()]))
            : null,
        );
      }
      if (!withInput) return resolve(accepted);
      return resolve(accepted ? input.value.trim() : null);
    };
    dialogNode.addEventListener('close', settle);
    dialogNode.showModal();
    const first = withInput ? input : controls[0]?.[1];
    if (first) {
      first.focus();
      first.select();
    }
  });
}

/**
 * Several labelled values at once: `fields` is `[{ id, label, value?,
 * placeholder?, multiline? }]`. Resolves to `{ id: trimmed text }`, or null
 * when the analyst cancels.
 */
function askFields(message, fields, accept = 'Save') {
  return openDialog({ message, accept, fields });
}

/** Resolves to the trimmed text, or null when the analyst cancels. */
function askText(message, initial = '', accept = 'Save') {
  return openDialog({ message, initial, accept, withInput: true });
}

/** Every confirmation here guards a delete, so its accept reads as one. */
function askConfirm(message, accept = 'Delete') {
  return openDialog({ message, accept, withInput: false, destructive: true });
}

/** Every request dies with its mount, so a stale view never touches a newer one. */
async function requestJson(path, { method = 'GET', body, signal = state.session.signal } = {}) {
  const options = { method, signal, headers: { 'X-Client-Id': clientId } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) handleUnauthorized();
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

// --- Geometry helpers --------------------------------------------------------

function geometryBounds(geometry) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const walk = (coords) => {
    if (typeof coords[0] === 'number') {
      const [lon, lat] = coords;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      return;
    }
    coords.forEach(walk);
  };
  walk(geometry.coordinates);
  return [west, south, east, north];
}

function ringAreaSquareKm(ring, kmPerDegLon, kmPerDegLat) {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [lon1, lat1] = ring[index];
    const [lon2, lat2] = ring[index + 1];
    sum += lon1 * kmPerDegLon * (lat2 * kmPerDegLat) - lon2 * kmPerDegLon * (lat1 * kmPerDegLat);
  }
  return Math.abs(sum) / 2;
}

/** Planar area approximation, accurate enough for AOIs within a single UTM zone. */
function polygonAreaSquareKm(geometry) {
  const bounds = geometryBounds(geometry);
  const midLatitude = (bounds[1] + bounds[3]) / 2;
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((midLatitude * Math.PI) / 180);
  return geometry.coordinates.reduce((total, ring, index) => {
    const area = ringAreaSquareKm(ring, kmPerDegLon, kmPerDegLat);
    return index === 0 ? total + area : total - area;
  }, 0);
}

/**
 * Area-weighted centre of a polygon's outer ring, `[lon, lat]`; for an
 * irregular AOI it sits where the area is, unlike the envelope's middle.
 * Falls back to the envelope's middle for a degenerate ring.
 */
function aoiCentre(geometry) {
  const ring =
    geometry.type === 'MultiPolygon' ? geometry.coordinates[0][0] : geometry.coordinates[0];
  // Relative to the first vertex: products of raw degrees (~17 × 49) would
  // cancel away the small differences that carry the shape.
  const [originLon, originLat] = ring[0];
  let twiceArea = 0;
  let sumLon = 0;
  let sumLat = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const x0 = ring[index][0] - originLon;
    const y0 = ring[index][1] - originLat;
    const x1 = ring[index + 1][0] - originLon;
    const y1 = ring[index + 1][1] - originLat;
    const cross = x0 * y1 - x1 * y0;
    twiceArea += cross;
    sumLon += (x0 + x1) * cross;
    sumLat += (y0 + y1) * cross;
  }
  if (Math.abs(twiceArea) < 1e-14) {
    const [west, south, east, north] = geometryBounds(geometry);
    return [(west + east) / 2, (south + north) / 2];
  }
  return [originLon + sumLon / (3 * twiceArea), originLat + sumLat / (3 * twiceArea)];
}

function jumpToCoordinate(lon, lat) {
  const bounds = mapController.getBounds();
  const width = bounds[2] - bounds[0];
  const height = bounds[3] - bounds[1];
  mapController.fitExtent([lon - width / 2, lat - height / 2, lon + width / 2, lat + height / 2]);
}

// --- URL state ---------------------------------------------------------------

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  state.studyId = params.get('study') || null;
  const step = Number.parseInt(params.get('step'), 10);
  state.step = [1, 2, 3, 4].includes(step) ? step : 1;
  const hash = window.location.hash;
  state.selectedFeatureId = hash.startsWith('#feature=') ? hash.slice(9) : null;
}

function writeLocation() {
  const params = new URLSearchParams();
  if (state.studyId) params.set('study', state.studyId);
  params.set('step', String(state.step));
  const search = params.toString();
  const hash = state.selectedFeatureId ? `#feature=${state.selectedFeatureId}` : '';
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${search ? `?${search}` : ''}${hash}`,
  );
}

function canUseStep(step) {
  return step === 1 || Boolean(state.study);
}

// --- Masthead status -----------------------------------------------------

function buildMastheadStatus(status) {
  const light = createElement('span', 'status-light');
  light.setAttribute('aria-hidden', 'true');
  const source = createElement('div', 'source-status');
  source.append(light);
  // In `on` mode the exercise name/cell badge/role live in the masthead's
  // user chip (src/main.js); this widget just keeps its status light.
  if (sessionMode() === 'off') source.append(createElement('span', null, 'Local workbench'));
  // The study switcher and scenario chip are parsed as part of the module
  // template (so their ids resolve via queryElements like everything else)
  // but belong in the masthead, next to this status — move the live nodes
  // rather than rebuilding them. Their styles (and the buttons inside the
  // study menu) are scoped to `[data-module='ipb']`, which the masthead
  // sits outside of, so they move inside a layout-transparent scope.
  const scope = createElement('div', 'ipb-masthead-scope');
  scope.dataset.module = 'ipb';
  scope.append(elements.mastheadStudy, elements.scenarioChip);
  status.replaceChildren(source, scope);
}

// --- Study management ------------------------------------------------------

function toggleStudyMenu(force) {
  const next = force ?? elements.studyMenu.hidden;
  if (next) closeAllPopovers();
  elements.studyMenu.hidden = !next;
  elements.studyToggle.setAttribute('aria-expanded', String(next));
  if (next) {
    elements.studySearch.focus();
    elements.studySearch.select();
  }
}

function closeStudyMenu() {
  toggleStudyMenu(false);
}

function renderStudyRow(study) {
  const row = createElement('div', 'study-row');
  if (String(study.id) === String(state.studyId)) row.classList.add('active');
  const body = createElement('div', 'study-row-body');
  const open = createElement('button', 'study-open', study.name);
  open.type = 'button';
  open.addEventListener('click', () => {
    closeStudyMenu();
    selectStudy(study.id);
  });
  const meta = createElement(
    'span',
    'study-row-meta',
    `${study.feature_count} feature${study.feature_count === 1 ? '' : 's'} · ${study.coa_count} COA${study.coa_count === 1 ? '' : 's'}`,
  );
  body.append(open, renderCellBadge(study.owner_cell), meta);
  const actions = createElement('div', 'study-row-actions');
  const rename = editableFor(study, createElement('button', 'icon-button', 'Rename'));
  rename.type = 'button';
  rename.addEventListener('click', () => renameStudy(study));
  const remove = editableFor(study, createElement('button', 'icon-button danger', 'Delete'));
  remove.type = 'button';
  remove.addEventListener('click', () => deleteStudy(study));
  actions.append(rename, remove);
  row.append(body, actions);
  return row;
}

function renderStudyList() {
  const query = foldText(state.studyQuery);
  const matches = state.studies.filter((study) => !query || foldText(study.name).includes(query));
  elements.studyList.replaceChildren(...matches.map(renderStudyRow));
  if (!matches.length) {
    elements.studyList.append(
      createElement(
        'p',
        'menu-empty',
        state.studies.length ? 'No studies match.' : 'No studies yet. Create one below.',
      ),
    );
  }
}

async function loadStudies() {
  const list = await requestJson(`${API}/studies`);
  state.studies = list.items;
  renderStudyList();
}

async function createStudy() {
  if (!can('analyst')) return;
  let name;
  let ownerCell;
  if (isWhite()) {
    const values = await askFields('Create study', [
      { id: 'name', label: 'Name' },
      {
        id: 'owner_cell',
        label: 'Owner',
        value: currentUser()?.cell ?? 'white',
        options: ['white', 'blue', 'red'].map((cell) => ({ value: cell, label: cellLabel(cell) })),
      },
    ]);
    if (!values?.name) return;
    name = values.name;
    ownerCell = values.owner_cell;
  } else {
    name = await askText('Name for the new study', '', 'Create');
    if (!name) return;
  }
  clearError(elements.studyMenu);
  try {
    const study = await requestJson(`${API}/studies`, {
      method: 'POST',
      body: ownerCell ? { name, owner_cell: ownerCell } : { name },
    });
    state.studies.push(study);
    state.studyQuery = '';
    elements.studySearch.value = '';
    renderStudyList();
    closeStudyMenu();
    await selectStudy(study.id);
  } catch (error) {
    showError(elements.studyMenu, error.message);
  }
}

async function renameStudy(study) {
  if (!can('analyst') || !canEditClient(study)) return;
  const name = await askText('Rename study', study.name);
  if (!name || name === study.name) return;
  clearError(elements.studyMenu);
  try {
    const updated = await requestJson(`${API}/studies/${study.id}`, {
      method: 'PATCH',
      body: { name },
    });
    Object.assign(study, updated, { name });
    if (String(state.studyId) === String(study.id)) {
      state.study.study = { ...state.study.study, ...updated, name };
      elements.studyName.textContent = name;
      elements.worksheetStudyName.textContent = name;
    }
    renderStudyList();
  } catch (error) {
    showError(elements.studyMenu, error.message);
  }
}

async function deleteStudy(study) {
  if (!can('analyst') || !canEditClient(study)) return;
  if (!(await askConfirm(`Delete study "${study.name}"? This cannot be undone.`))) return;
  clearError(elements.studyMenu);
  try {
    await requestJson(`${API}/studies/${study.id}`, { method: 'DELETE' });
    state.studies = state.studies.filter((entry) => String(entry.id) !== String(study.id));
    renderStudyList();
    if (String(state.studyId) === String(study.id)) {
      state.studyId = null;
      state.study = null;
      state.selectedFeatureId = null;
      state.selectedCoaId = null;
      renderEmptyState();
      writeLocation();
    }
  } catch (error) {
    showError(elements.studyMenu, error.message);
  }
}

async function selectStudy(id, { preserveFeature = false } = {}) {
  if (String(state.studyId) === String(id) && state.study) return;
  state.studyRequest?.abort();
  const controller = new AbortController();
  state.studyRequest = controller;
  state.studyId = String(id);
  state.study = null;
  if (!preserveFeature) state.selectedFeatureId = null;
  state.selectedCoaId = null;
  state.activeLayerId = null;
  state.losPicks = [];
  state.losResult = null;
  state.viewshedResult = null;
  state.viewshedPosts = [];
  state.keyTerrain.candidates = null;
  state.avenues.picks = [];
  state.avenues.routes = null;
  state.mobility.grid = null;
  state.tool = null;
  state.orbatUnits = new Map();
  renderEmptyState();
  try {
    const payload = await requestJson(`${API}/studies/${id}`, {
      signal: AbortSignal.any([controller.signal, state.session.signal]),
    });
    if (controller.signal.aborted) return;
    state.study = payload;
    renderStudyLoaded();
    writeLocation();
    refreshOrbatLinks().catch(() => {});
  } catch (error) {
    if (error.name === 'AbortError') return;
    showError(elements.toolPanel, error.message);
  }
}

/** The owner badge + release control (and, for White, an owner reassign
 * select) for the currently open study's worksheet header. Empty when no
 * study is open. */
function renderStudyReleaseControl() {
  const container = elements.worksheetStudyRelease;
  if (!container) return;
  const study = state.study?.study;
  if (!study) {
    container.replaceChildren();
    return;
  }
  const control = renderReleaseControl({
    item: study,
    onRelease: async (cells) => {
      try {
        const updated = await requestJson(`${API}/studies/${study.id}/release`, {
          method: 'POST',
          body: { cells },
        });
        Object.assign(study, updated);
        renderStudyReleaseControl();
      } catch (error) {
        showError(container, error.message);
      }
    },
  });
  if (isWhite()) {
    const label = createElement('label', 'release-control-label', 'Reassign');
    const select = document.createElement('select');
    select.className = 'release-owner-select';
    for (const cell of ['white', 'blue', 'red']) {
      const option = document.createElement('option');
      option.value = cell;
      option.textContent = cellLabel(cell);
      if (cell === study.owner_cell) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', async () => {
      try {
        const updated = await requestJson(`${API}/studies/${study.id}/owner`, {
          method: 'PATCH',
          body: { owner_cell: select.value },
        });
        Object.assign(study, updated);
        if (state.study) state.study.study = { ...state.study.study, ...updated };
        renderStudyReleaseControl();
      } catch (error) {
        showError(container, error.message);
      }
    });
    control.append(label, select);
  }
  const nodes = [control];
  if (!canEditClient(study)) {
    nodes.push(
      createElement('p', 'read-only-note', `Read-only — owned by ${cellLabel(study.owner_cell)}.`),
    );
  }
  container.replaceChildren(...nodes);
}

function renderEmptyState() {
  elements.mapEmpty.hidden = false;
  elements.studyName.textContent = 'No study selected';
  elements.worksheetStudyName.textContent = 'No study open';
  renderStudyReleaseControl();
  updateStepNavAvailability();
  renderToolPanel();
  [1, 2, 3, 4].forEach((step) => {
    elements[`worksheet${step}`].replaceChildren(
      createElement('p', 'panel-note', 'Select or create a study to see this step.'),
    );
  });
  renderCustomLayers();
  renderLayersPrint();
  applyClassificationBanner(elements.classificationTop, elements.classificationBottom, '');
  if (mapController) {
    mapController.setFeatures([]);
    mapController.clearGrid('mobility');
    mapController.clearGrid('viewshed');
  }
}

/**
 * Reloads the currently open study's data in place — its tool/selection
 * state untouched — for a live update (C2) from another client. Unlike
 * `selectStudy`, this never skips the fetch just because the id is already
 * open: that is precisely the case a live update needs to handle.
 */
async function refetchOpenStudy() {
  if (!state.studyId) return;
  try {
    const payload = await requestJson(`${API}/studies/${state.studyId}`, {
      signal: state.session.signal,
    });
    state.study = payload;
    renderStudyLoaded();
    await refreshOrbatLinks();
  } catch (error) {
    if (error.name !== 'AbortError') showError(elements.toolPanel, error.message);
  }
}

function renderStudyLoaded() {
  const study = state.study.study;
  elements.studyName.textContent = study.name;
  elements.worksheetStudyName.textContent = study.name;
  elements.mapEmpty.hidden = true;
  renderStudyReleaseControl();
  updateStepNavAvailability();
  renderToolPanel();
  renderStep1Worksheet();
  renderStep2Worksheet();
  renderStep3Worksheet();
  renderStep4Worksheet();
  renderCustomLayers();
  renderLayersPrint();
  applyClassificationBanner(
    elements.classificationTop,
    elements.classificationBottom,
    study.classification,
    study.owner_cell,
  );
  mapToolsController?.refresh();
  syncMapFeatures();
  if (state.selectedFeatureId) mapController.selectFeature(state.selectedFeatureId);
  if (study.bounds) mapController.fitExtent(study.bounds);
}

function updateStepNavAvailability() {
  elements.stepNav.querySelectorAll('.step-tab').forEach((button) => {
    const step = Number(button.dataset.step);
    button.disabled = step !== 1 && !state.study;
  });
}

// --- Step navigation ---------------------------------------------------------

function renderStepChrome() {
  elements.stepNav.querySelectorAll('.step-tab').forEach((button) => {
    const isActive = Number(button.dataset.step) === state.step;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-current', isActive ? 'step' : 'false');
  });
  [1, 2, 3, 4].forEach((step) => {
    elements[`worksheet${step}`].classList.toggle('active', step === state.step);
  });
  if (state.step !== 2) elements.mapClickInfo.hidden = true;
  renderToolPanel();
  syncMapFeatures();
}

function switchStep(step) {
  if (state.step === step) return;
  cancelActiveTool();
  const direction = step > state.step ? 'forward' : 'back';
  state.step = step;
  renderStepChrome();
  writeLocation();
  playStepMotion(direction);
}

/* The tool panel and worksheets re-render on every edit; the slide-in is
 * keyed to this attribute so it plays on a step change only. */
function playStepMotion(direction) {
  const { workspace } = elements;
  delete workspace.dataset.stepMotion;
  void workspace.offsetWidth; // restart the animation
  workspace.dataset.stepMotion = direction;
  window.clearTimeout(state.timers.get('step-motion'));
  state.timers.set(
    'step-motion',
    window.setTimeout(() => delete workspace.dataset.stepMotion, 500),
  );
}

// --- Floating sheets -----------------------------------------------------

const SHEET_ELEMENTS = {
  tools: { panel: 'controlPanel', toggle: 'toolsToggle' },
  worksheet: { panel: 'detailPanel', toggle: 'worksheetToggle' },
};

function isNarrow() {
  return window.matchMedia(NARROW_QUERY).matches;
}

function renderSheets() {
  // Docked sheets share the bottom half: never both out on a narrow screen.
  if (isNarrow() && state.sheets.tools && state.sheets.worksheet) state.sheets.worksheet = false;
  for (const [name, { panel, toggle }] of Object.entries(SHEET_ELEMENTS)) {
    const open = state.sheets[name];
    elements.workspace.dataset[name] = open ? 'open' : 'closed';
    elements[toggle].setAttribute('aria-expanded', String(open));
    // A sheet sliding away must not keep keyboard focus inside it.
    if (!open && elements[panel].contains(document.activeElement)) elements[toggle].focus();
  }
}

function toggleSheet(name) {
  const open = !state.sheets[name];
  state.sheets[name] = open;
  if (open && isNarrow()) {
    for (const other of Object.keys(SHEET_ELEMENTS))
      if (other !== name) state.sheets[other] = false;
  }
  renderSheets();
  saveSheets();
}

/** Map pixels hidden under the open sheets, for fitting features into view. */
function coveredInsets() {
  const map = elements.mapTarget.getBoundingClientRect();
  const insets = [0, 0, 0, 0];
  for (const [name, { panel }] of Object.entries(SHEET_ELEMENTS)) {
    if (!state.sheets[name]) continue;
    const box = elements[panel].getBoundingClientRect();
    if (isNarrow()) insets[2] = Math.max(insets[2], map.bottom - box.top);
    else if (name === 'tools') insets[3] = Math.max(0, box.right - map.left);
    else insets[1] = Math.max(0, map.right - box.left);
  }
  return insets;
}

// --- Map wiring ----------------------------------------------------------

function renderMapHint(text) {
  elements.mapHint.hidden = !text;
  elements.mapHint.textContent = text || '';
  if (text) elements.mapClickInfo.hidden = true;
}

function visibleFeatures() {
  if (!state.study) return [];
  const study = state.study.study;
  const features = [];
  features.push(...areaFeatures(study));
  const byLayer = (layer) => state.study.features.filter((feature) => feature.layer === layer);
  OAKOC_LAYERS.forEach((layer) => features.push(...byLayer(layer)));
  // Tactical graphics and range rings (mapTools.js) show on every step,
  // regardless of COA selection — unlike SITEMP units/sketches, they are not
  // exclusively tied to one COA.
  ['graphic', 'range-ring'].forEach((layer) => features.push(...byLayer(layer)));
  features.push(...customLayerFeatures());
  if (state.step === 4) {
    // NAI and TAI stay visible: the event template ties them to the COAs.
    features.push(...byLayer('nai'), ...byLayer('tai'));
    // A COA's own sketches and placed units (SITEMP) show only for the
    // selected COA, unless "show all COAs" is on; those with no COA show on every COA.
    const coaFiltered = (list) => filterByCoa(list, state.selectedCoaId, state.showAllCoas);
    features.push(...coaFiltered(byLayer('coa')), ...coaFiltered(byLayer('unit')));
  }
  const marker = (id, label, { lon, lat }, layer = 'note', properties = {}) => ({
    id,
    layer,
    kind: 'point',
    label,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties,
  });
  state.losPicks.forEach((pick, index) => {
    features.push(marker(`los-pick-${index}`, index === 0 ? 'Observer' : 'Target', pick));
  });
  state.viewshedPosts.forEach((post, index) => {
    features.push(marker(`viewshed-post-${index}`, `OP ${index + 1}`, post));
  });
  if (state.step === 1) {
    // A map-centre point moves with the map, so it gets no marker.
    const point = weatherPoint(study);
    if (point.source !== 'map')
      features.push(marker('weather-point', 'Weather point', point, 'weather'));
    const site = state.weather.site;
    const resolved = site.key === siteKey(study) ? site.value : null;
    for (const [role, label] of [
      ['high', 'Highest'],
      ['low', 'Lowest'],
    ]) {
      const place = resolved?.[role];
      if (place) {
        features.push(
          marker(`weather-${role}`, `${label} ${Math.round(place.elevation)} m`, place, 'weather', {
            draft: true,
          }),
        );
      }
    }
  }
  if (state.step === 2) {
    // Suggestions shown dashed until the analyst accepts them as features.
    (state.keyTerrain.candidates ?? []).forEach((candidate, index) => {
      features.push(
        marker(`key-terrain-draft-${index}`, keyTerrainLabel(candidate), candidate, 'key-terrain', {
          draft: true,
        }),
      );
    });
    state.avenues.picks.forEach((pick, index) => {
      features.push(marker(`avenue-pick-${index}`, index === 0 ? 'Start' : 'Objective', pick));
    });
    (state.avenues.routes ?? []).forEach((route) => {
      features.push({
        id: `avenue-draft-${route.option}`,
        layer: 'avenue',
        kind: 'line',
        label: `Option ${route.option}`,
        geometry: { type: 'LineString', coordinates: route.coordinates },
        properties: { draft: true },
      });
    });
  }
  return features;
}

function syncMapFeatures() {
  mapController?.setFeatures(visibleFeatures());
}

function reRenderContainingWorksheet(layer) {
  if (OAKOC_LAYERS.includes(layer)) renderStep2Worksheet();
  else if (['nai', 'tai', 'coa', 'unit', 'graphic', 'range-ring'].includes(layer)) {
    renderStep4Worksheet();
  }
}

function cancelActiveTool() {
  mapToolsController?.cancelActiveTool();
  if (!state.tool) return;
  if (state.tool.type === 'draw-feature' || state.tool.type === 'draw-area') {
    mapController.cancelDraw();
  }
  if (state.tool.type === 'modify-feature' || state.tool.type === 'point-move') {
    mapController.stopModify();
  }
  state.tool = null;
  state.losPicks = [];
  renderMapHint('');
  syncMapFeatures();
  renderToolPanel();
  renderCustomLayers();
}

async function showElevationReadout(lon, lat) {
  elements.mapClickInfo.hidden = false;
  elements.mapClickInfo.textContent = 'Reading elevation…';
  try {
    const params = new URLSearchParams({ at: `${lon},${lat}` });
    const result = await requestJson(`${TERRAIN_API}/elevation?${params}`);
    const elevationText = Number.isFinite(result.elevation)
      ? formatMetres(result.elevation)
      : 'No data';
    const slopeText = Number.isFinite(result.slope) ? `${result.slope.toFixed(1)}°` : '—';
    elements.mapClickInfo.textContent = `${formatMgrs(lon, lat)} · Elevation ${elevationText} · Slope ${slopeText}`;
  } catch (error) {
    elements.mapClickInfo.textContent = error.message;
  }
}

// --- Basemap -------------------------------------------------------------------

/** The map.setBasemap spec for a basemap id, or null while its data is missing. */
function basemapSpec(id) {
  const meta = state.terrainMeta;
  const vector = { attributions: meta?.basemap.attribution };
  if (id === 'roads') return { vector };
  if (id === 'terrain' || id === 'topo') {
    return (
      meta && {
        vector: { ...vector, style: id === 'topo' ? 'topo' : 'roads' },
        relief: {
          url: meta.hillshade.url,
          minZoom: meta.hillshade.minZoom,
          maxZoom: meta.hillshade.maxZoom,
          extent: meta.elevation.bounds,
          attributions: meta.elevation.attribution,
        },
      }
    );
  }
  if (id === 'satellite') {
    return (
      meta?.imagery && {
        vector,
        imagery: {
          url: meta.imagery.url,
          minZoom: meta.imagery.minZoom,
          maxZoom: meta.imagery.maxZoom,
          extent: meta.imagery.bounds,
          attributions: meta.imagery.attribution,
          dark: true,
        },
      }
    );
  }
  if (id === 'aerial') {
    return (
      meta?.ortho && {
        vector,
        imagery: {
          url: meta.ortho.url,
          minZoom: meta.ortho.minZoom,
          maxZoom: meta.ortho.maxZoom,
          extent: meta.ortho.bounds,
          attributions: meta.ortho.attribution,
          dark: true,
        },
      }
    );
  }
  // 'ortho-online' has a Czechia-sized extent, unlike the worldwide online
  // basemaps above: draw the vector map so Roads shows past its border.
  if (id === 'ortho-online') return { vector, imagery: ONLINE_BASEMAPS[id] };
  return { imagery: ONLINE_BASEMAPS[id] };
}

/** Overlays the selected basemap draws as part of itself. */
function includedOverlays() {
  return BASEMAPS.find((basemap) => basemap.id === state.basemap)?.includes ?? [];
}

/** The map.setOverlays spec for the checked (or included) overlays that have data. */
function overlaySpec() {
  const meta = state.terrainMeta;
  const included = includedOverlays();
  const on = (id) => (state.overlays[id] || included.includes(id)) && overlayAvailable(id);
  return {
    slope: on('slope') && {
      url: meta.slope.url,
      minZoom: meta.slope.minZoom,
      maxZoom: meta.slope.maxZoom,
      extent: meta.elevation.bounds,
    },
    contours: on('contours') && { ...meta.contours, extent: meta.elevation.bounds },
    roads: Boolean(on('roads')),
    places: Boolean(on('places')),
  };
}

function overlayAvailable(id) {
  const meta = state.terrainMeta;
  if (!meta) return false;
  if (id === 'roads') return meta.basemap.layers.includes('transportation');
  if (id === 'places') return meta.basemap.layers.includes('place');
  return true;
}

function renderOverlayList() {
  const included = includedOverlays();
  const basemapLabel = BASEMAPS.find((basemap) => basemap.id === state.basemap)?.label;
  elements.overlayList.replaceChildren(
    ...OVERLAYS.map((overlay) => {
      const available = overlayAvailable(overlay.id);
      const locked = available && included.includes(overlay.id);
      const row = createElement('label', 'overlay-option');
      row.title = available ? '' : overlay.missing;
      row.classList.toggle('unavailable', !available);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.overlay = overlay.id;
      checkbox.checked = locked || state.overlays[overlay.id];
      checkbox.disabled = !available || locked;
      const text = createElement('span', 'overlay-text', overlay.label);
      const hint = locked ? `included in ${basemapLabel}` : overlay.hint;
      if (hint) text.append(createElement('small', null, hint));
      if (overlay.id === 'slope' && available) {
        const legend = createElement('span', 'overlay-legend');
        state.terrainMeta.slope.legend.forEach((entry) => {
          const chip = createElement('span', 'overlay-chip', `${entry.code} ${entry.range}`);
          chip.style.setProperty('--chip', entry.color);
          legend.append(chip);
        });
        text.append(legend);
      }
      row.append(checkbox, text);
      return row;
    }),
    ...renderWeatherRows(),
    renderSituationOverlayRow(),
  );
}

function applyOverlays() {
  mapController.setOverlays(overlaySpec());
  renderOverlayList();
}

// --- Weather (online) ------------------------------------------------------------

function minutesAgo(time) {
  const minutes = Math.max(0, Math.round((Date.now() - time) / MINUTE));
  return minutes < 1 ? 'just now' : `${minutes} min ago`;
}

/** What the Layers panel says under a weather overlay's name. */
function weatherStatus(overlay) {
  const entry = state.weather[overlay.id];
  if (!state.overlays[overlay.id]) return overlay.source;
  if (entry.error) return entry.error;
  const time = weatherTime(overlay.id);
  if (time !== null) return `${overlay.source} · ${CLOCK.format(time)} (${minutesAgo(time)})`;
  return entry.loading ? 'Loading…' : overlay.source;
}

/** The time of the data shown for a weather overlay, or null. */
function weatherTime(id) {
  const entry = state.weather[id];
  if (id === 'radar') return entry.frames[entry.index]?.time ?? null;
  if (id === 'wind') return entry.points[0]?.time ?? null;
  return entry.time;
}

function renderWeatherRows() {
  const heading = createElement('div', 'overlay-group', 'Weather');
  heading.append(createElement('span', 'basemap-note', 'online'));
  const rows = [heading];
  for (const overlay of WEATHER_OVERLAYS) {
    const on = state.overlays[overlay.id];
    const entry = state.weather[overlay.id];
    const row = createElement('label', 'overlay-option');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.overlay = overlay.id;
    checkbox.checked = on;
    const text = createElement('span', 'overlay-text', overlay.label);
    const status = createElement('small', null, weatherStatus(overlay));
    status.classList.toggle('weather-error', Boolean(on && entry.error));
    if (overlay.id === 'radar') status.dataset.radarStatus = '';
    text.append(status);
    row.append(checkbox, text);
    rows.push(row);
    // Outside the <label>, so its buttons don't toggle the checkbox.
    if (overlay.id === 'radar' && on && entry.frames.length > 1) rows.push(renderRadarControls());
  }
  return rows;
}

function renderRadarControls() {
  const radar = state.weather.radar;
  const controls = createElement('div', 'radar-controls');
  const play = createElement('button', 'readout-toggle', radar.playing ? 'Pause' : 'Play');
  play.type = 'button';
  play.dataset.radar = 'play';
  play.setAttribute('aria-pressed', String(radar.playing));
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(radar.frames.length - 1);
  slider.value = String(radar.index);
  slider.dataset.radar = 'frame';
  slider.setAttribute('aria-label', 'Radar frame');
  controls.append(play, slider);
  return controls;
}

function weatherSpec() {
  const { overlays, weather } = state;
  const wms = (id, layer) =>
    overlays[id] && weather[id].time !== null
      ? { layer, time: weather[id].time, attributions: EUMETSAT_ATTRIBUTION }
      : null;
  return {
    clouds: wms('clouds', CLOUD_LAYER),
    lightning: wms('lightning', LIGHTNING_LAYER),
    radar:
      overlays.radar && weather.radar.frames.length
        ? {
            frames: weather.radar.frames,
            index: weather.radar.index,
            maxZoom: RAINVIEWER_MAX_ZOOM,
            attributions: RAINVIEWER_ATTRIBUTION,
          }
        : null,
    wind:
      overlays.wind && weather.wind.points.length
        ? { points: weather.wind.points, attributions: OPEN_METEO_ATTRIBUTION }
        : null,
  };
}

function applyWeather() {
  mapController?.setWeather(weatherSpec());
}

/** Newest image time of a Meteosat WMS layer, from its small per-layer capabilities. */
async function loadWmsTime(id, layer) {
  const response = await fetch(wmsCapabilitiesUrl(layer), { signal: state.session.signal });
  if (!response.ok) throw new Error(`EUMETSAT ${response.status}`);
  const time = latestWmsTime(await response.text());
  if (time === null) throw new Error('EUMETSAT: no image time');
  state.weather[id].time = time;
}

async function loadRadar() {
  const radar = state.weather.radar;
  const frames = radarFrames(await requestJson(RAINVIEWER_API));
  if (!frames.length) throw new Error('RainViewer: no frames');
  const shown = radar.frames[radar.index]?.time;
  const atNewest = radar.index === radar.frames.length - 1;
  radar.frames = frames;
  // Follow the newest frame unless the analyst stepped back to an older one.
  const kept = frames.findIndex((frame) => frame.time === shown);
  radar.index = atNewest || kept < 0 ? frames.length - 1 : kept;
}

/** Wind at the lattice points of the current view; fetches only missing or stale ones. */
async function loadWind() {
  const wind = state.weather.wind;
  const view = wind.view ?? {
    bounds: mapController.getBounds(),
    size: [elements.mapTarget.clientWidth, elements.mapTarget.clientHeight],
  };
  const { points } = windLattice(view.bounds, view.size);
  const now = Date.now();
  const { refresh } = WEATHER_BY_ID.get('wind');
  for (const [key, reading] of wind.readings) {
    if (now - reading.fetchedAt > 4 * refresh) wind.readings.delete(key);
  }
  const missing = points.filter(
    (point) => !(now - (wind.readings.get(point.key)?.fetchedAt ?? 0) < refresh),
  );
  if (missing.length) {
    const readings = parseWind(await requestJson(windUrl(missing)), missing);
    for (const reading of readings) wind.readings.set(reading.key, { ...reading, fetchedAt: now });
  }
  wind.points = points.map((point) => wind.readings.get(point.key)).filter(Boolean);
}

const WEATHER_LOADERS = {
  clouds: () => loadWmsTime('clouds', CLOUD_LAYER),
  lightning: () => loadWmsTime('lightning', LIGHTNING_LAYER),
  radar: loadRadar,
  wind: loadWind,
};

/** Run one overlay's loader; a request made while one is running runs after it. */
function loadWeather(id) {
  const entry = state.weather[id];
  if (entry.loading) {
    entry.again = true;
    return;
  }
  entry.loading = true;
  renderOverlayList();
  WEATHER_LOADERS[id]()
    .then(
      () => {
        entry.error = null;
      },
      (error) => {
        if (error.name !== 'AbortError') entry.error = WEATHER_UNAVAILABLE;
      },
    )
    .finally(() => {
      entry.loading = false;
      entry.checkedAt = Date.now();
      if (state.session.signal.aborted) return;
      applyWeather();
      renderOverlayList();
      if (entry.again) {
        entry.again = false;
        if (state.overlays[id]) loadWeather(id);
      }
    });
}

/** Load every switched-on overlay whose data is older than its refresh period. */
function refreshWeather() {
  const now = Date.now();
  for (const overlay of WEATHER_OVERLAYS) {
    const entry = state.weather[overlay.id];
    if (state.overlays[overlay.id] && now - entry.checkedAt >= overlay.refresh) {
      loadWeather(overlay.id);
    }
  }
}

/** Check once a minute while the page is visible; each overlay keeps its own period. */
function scheduleWeatherRefresh() {
  state.timers.set(
    'weather',
    window.setTimeout(() => {
      if (document.visibilityState === 'visible') refreshWeather();
      scheduleWeatherRefresh();
    }, MINUTE),
  );
}

function toggleWeather(id, on) {
  state.overlays[id] = on;
  const entry = state.weather[id];
  // Switching back on after a failure retries at once.
  if (on && entry.error) entry.checkedAt = 0;
  if (!on && id === 'radar') setRadarPlaying(false);
  applyWeather();
  renderOverlayList();
  if (on) refreshWeather();
  saveMapView();
}

function onWeatherViewChange(view) {
  state.weather.wind.view = view;
  if (!state.overlays.wind) return;
  window.clearTimeout(state.timers.get('wind'));
  state.timers.set(
    'wind',
    window.setTimeout(() => loadWeather('wind'), 400),
  );
}

function showRadarFrame(index) {
  const radar = state.weather.radar;
  radar.index = index;
  applyWeather();
  // Update in place: re-rendering would steal the slider from under the pointer.
  const status = elements.overlayList.querySelector('[data-radar-status]');
  if (status) status.textContent = weatherStatus(WEATHER_BY_ID.get('radar'));
  const slider = elements.overlayList.querySelector('[data-radar="frame"]');
  if (slider) slider.value = String(index);
}

function setRadarPlaying(playing) {
  const radar = state.weather.radar;
  radar.playing = playing;
  window.clearTimeout(state.timers.get('radar-play'));
  if (playing) {
    const tick = () => {
      const last = radar.frames.length - 1;
      showRadarFrame(radar.index >= last ? 0 : radar.index + 1);
      // Linger on the newest frame so the loop reads as "up to now".
      const delay = radar.index === last ? 3 * RADAR_FRAME_MS : RADAR_FRAME_MS;
      state.timers.set('radar-play', window.setTimeout(tick, delay));
    };
    state.timers.set('radar-play', window.setTimeout(tick, RADAR_FRAME_MS));
  }
  const button = elements.overlayList.querySelector('[data-radar="play"]');
  if (button) {
    button.textContent = playing ? 'Pause' : 'Play';
    button.setAttribute('aria-pressed', String(playing));
  }
}

/** "Clouds 21:45, Radar 21:50" for the print caption. */
function weatherCaption() {
  return WEATHER_OVERLAYS.filter((overlay) => state.overlays[overlay.id])
    .map((overlay) => {
      const time = weatherTime(overlay.id);
      return time === null ? null : `${overlay.caption} ${CLOCK.format(time)}`;
    })
    .filter(Boolean);
}

/** OpenTopoMap's labels are baked into its tiles and real, so it is disabled whenever
 * a scenario is active, so a renamed/hidden place can never leak through it. */
function scenarioBlocksBasemap(id) {
  return id === 'topo-online' && Boolean(state.scenario);
}

function basemapRadio(basemap) {
  const blocked = scenarioBlocksBasemap(basemap.id);
  const available = !blocked && Boolean(basemapSpec(basemap.id));
  const button = createElement('button', 'basemap-option', basemap.label);
  button.type = 'button';
  button.dataset.basemap = basemap.id;
  button.setAttribute('role', 'radio');
  button.setAttribute('aria-checked', String(state.basemap === basemap.id));
  button.tabIndex = state.basemap === basemap.id ? 0 : -1;
  button.disabled = !available;
  button.title = blocked
    ? `Disabled: shows real place names, hidden while "${state.scenario.name}" is active.`
    : available
      ? (basemap.title ?? '')
      : basemap.missing;
  return button;
}

/** Basemap radios as a single list with one "Online" note ahead of the
 * basemaps that need internet, rather than a badge on every online button. */
function renderBasemapSwitch() {
  const offline = BASEMAPS.filter((basemap) => !basemap.note);
  const online = BASEMAPS.filter((basemap) => basemap.note === 'online');
  const group = createElement('div', 'basemap-group');
  group.append(...offline.map(basemapRadio));
  const onlineGroup = createElement('div', 'basemap-group basemap-group-online');
  onlineGroup.append(
    createElement('p', 'basemap-online-note', 'Online (needs internet)'),
    ...online.map(basemapRadio),
  );
  elements.basemapSwitch.replaceChildren(group, onlineGroup);
  const current = BASEMAPS.find((basemap) => basemap.id === state.basemap);
  if (elements.mapMenuLabel) elements.mapMenuLabel.textContent = current?.label ?? state.basemap;
}

function applyBasemap(id) {
  if (scenarioBlocksBasemap(id)) id = 'roads';
  const spec = basemapSpec(id);
  if (!spec) {
    // A remembered basemap whose data has since gone (e.g. imagery deleted).
    if (id !== 'roads') applyBasemap('roads');
    return;
  }
  state.basemap = id;
  mapController.setBasemap(spec);
  renderBasemapSwitch();
  applyOverlays(); // basemaps like Topo include overlays of their own
  saveMapView();
}

/** The active scenario's places, indexed for the name-match rule in src/map.js. */
function scenarioPlaceIndex() {
  return buildScenarioNameIndex(state.scenario);
}

/** Shortened for the masthead chip; the full name is always in its title. */
function shortenScenarioName(name, max = 22) {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

function renderScenarioChip() {
  const chip = elements.scenarioChip;
  if (chip) {
    chip.hidden = !state.scenario;
    if (state.scenario) {
      chip.textContent = `Scenario: ${shortenScenarioName(state.scenario.name)}`;
      chip.title = state.scenario.name;
    }
  }
  const notice = elements.mapPopoverScenario;
  if (notice) {
    notice.hidden = !state.scenario;
    if (state.scenario) {
      notice.textContent = `Scenario active: "${state.scenario.name}" — OpenTopoMap is disabled while it shows real place names.`;
    }
  }
}

// --- Map popover, info popover ------------------------------------------

function toggleMapPopover(force) {
  const next = force ?? elements.mapPopover.hidden;
  if (next) closeAllPopovers();
  elements.mapPopover.hidden = !next;
  elements.mapMenuToggle.setAttribute('aria-expanded', String(next));
}

function closeMapPopover() {
  if (elements.mapPopover.hidden) return;
  toggleMapPopover(false);
}

function renderInfoPopover() {
  const popover = elements.infoPopover;
  if (!popover) return;
  const attributions = elements.mapTarget
    ? [...elements.mapTarget.querySelectorAll('.ol-attribution li')].map((item) =>
        item.textContent.trim(),
      )
    : [];
  popover.replaceChildren();
  const dataset = state.terrainMeta?.elevation?.dataset;
  if (dataset) {
    const row = createElement('div', 'info-popover-row');
    row.append(
      createElement('span', 'readout-label', 'Elevation dataset'),
      createElement('span', null, dataset),
    );
    popover.append(row);
  }
  if (attributions.length) {
    popover.append(createElement('p', 'info-popover-attribution', attributions.join(' · ')));
  } else {
    popover.append(createElement('p', 'panel-note', 'No attribution for the current view.'));
  }
}

function toggleInfoPopover(force) {
  const next = force ?? elements.infoPopover.hidden;
  if (next) {
    closeAllPopovers();
    renderInfoPopover();
  }
  elements.infoPopover.hidden = !next;
  elements.infoToggle.setAttribute('aria-expanded', String(next));
}

function closeInfoPopover() {
  if (elements.infoPopover.hidden) return;
  toggleInfoPopover(false);
}

/** Closes every popover/menu except the caller's own (there is never more
 * than one open at a time: opening one always closes the others). */
function closeAllPopovers() {
  closeStudyMenu();
  closeMapPopover();
  closeInfoPopover();
  closeRowMenu();
}

/**
 * Fetches the one active scenario (Exercise module) and pushes it onto the
 * map and the rest of the IPB view. Called on mount, and again
 * on `visibilitychange`/`focus` so activating a scenario in Exercise shows
 * up here without a reload.
 */
async function loadScenario() {
  try {
    const { scenario } = await requestJson(`${EXERCISE_API}/scenario/active`);
    state.scenario = scenario;
  } catch (error) {
    if (error.name === 'AbortError') return;
    state.scenario = null;
  }
  mapController?.setScenario(state.scenario);
  renderScenarioChip();
  if (scenarioBlocksBasemap(state.basemap)) applyBasemap('roads');
  else renderBasemapSwitch();
  // Key-terrain candidate labels and the weather station name read real
  // place/peak names straight from state — both change with the scenario.
  if (state.step === 2) renderStep2Worksheet();
  if (state.step === 1) replaceForecastBlock();
}

// --- Toast -------------------------------------------------------------------

let toastTimer;

function showToast(message) {
  let node = elements.moduleRoot.querySelector(':scope > .ipb-toast');
  if (!node) {
    node = createElement('div', 'ipb-toast');
    elements.moduleRoot.append(node);
  }
  node.textContent = message;
  node.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove('visible'), 1600);
}

// --- Context menu --------------------------------------------------------

function closeContextMenu() {
  elements.moduleRoot?.querySelector(':scope > .context-menu')?.remove();
  document.removeEventListener('mousedown', onContextMenuOutside, true);
  document.removeEventListener('contextmenu', onContextMenuOutside, true);
  document.removeEventListener('keydown', onContextMenuKeydown, true);
}

/** A real click is mousedown → mouseup → click. Closing on a mousedown
 * inside the menu would remove the item before its click fires, so only
 * presses outside the menu dismiss it. */
function onContextMenuOutside(event) {
  const menu = elements.moduleRoot?.querySelector(':scope > .context-menu');
  if (menu?.contains(event.target)) {
    if (event.type === 'contextmenu') event.preventDefault();
    return;
  }
  closeContextMenu();
}

function onContextMenuKeydown(event) {
  if (event.key === 'Escape') closeContextMenu();
}

/** Renders `items` into `menu`; a submenu item drills down in place with a
 * "Back" entry, rather than opening a nested flyout. */
function renderContextMenuItems(menu, items, onBack) {
  menu.replaceChildren();
  if (onBack) {
    const back = createElement('li', 'context-menu-item context-menu-back', '← Back');
    back.addEventListener('click', (event) => {
      event.stopPropagation();
      onBack();
    });
    menu.append(back);
  }
  items.forEach((item) => {
    const li = createElement('li', 'context-menu-item', item.label);
    if (item.disabled) {
      li.classList.add('disabled');
    } else {
      li.addEventListener('click', (event) => {
        event.stopPropagation();
        if (item.submenu) {
          renderContextMenuItems(menu, item.submenu, () =>
            renderContextMenuItems(menu, items, onBack),
          );
        } else {
          closeContextMenu();
          item.action();
        }
      });
    }
    menu.append(li);
  });
}

function openContextMenu(x, y, items) {
  closeContextMenu();
  const menu = createElement('ul', 'context-menu');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  renderContextMenuItems(menu, items);
  elements.moduleRoot.append(menu);
  // Clamp on-screen once the menu has a real size.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, y - rect.height)}px`;
  window.setTimeout(() => {
    document.addEventListener('mousedown', onContextMenuOutside, true);
    document.addEventListener('contextmenu', onContextMenuOutside, true);
    document.addEventListener('keydown', onContextMenuKeydown, true);
  }, 0);
}

/**
 * Copy via the legacy selection path. `navigator.clipboard` only exists in
 * secure contexts, so opening the app by IP over plain http needs this; it
 * works because it runs inside the menu click's user activation.
 */
function copyWithSelection(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

async function copyCoordinates(lon, lat) {
  const text = formatMgrs(lon, lat);
  let copied = false;
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // Permission denied: fall through to the selection path.
    }
  }
  copied ||= copyWithSelection(text);
  showToast(copied ? `Copied ${text}` : `${text} (clipboard unavailable)`);
}

/** Feeds the existing pick-two-points line-of-sight flow without requiring
 * the panel's "Pick two points" button to be armed first. */
function setLosPoint(lon, lat, role) {
  if (!(can('analyst') && canEditStudy())) return;
  if (state.tool?.type !== 'los-pick') {
    state.tool = { type: 'los-pick' };
    state.losPicks = [];
  }
  if (role === 'observer') {
    if (state.losPicks.length >= 1) state.losPicks[0] = { lon, lat };
    else state.losPicks.push({ lon, lat });
    syncMapFeatures();
    renderMapHint('Click, or right-click and choose "Set as LOS target", to finish.');
    return;
  }
  handleLosPick(lon, lat);
}

function armFeatureModify(feature) {
  if (!(can('analyst') && canEditStudy())) return;
  cancelActiveTool();
  state.tool = { type: 'modify-feature', featureId: feature.id };
  mapController.startModify(feature.id);
  renderMapHint(
    `Drag vertices to reshape "${feature.label || feature.layer}". Press Escape when done.`,
  );
}

/** Layer/kind combinations offered by the toolbar, reused for "Draw here". */
function drawHereItems(lon, lat) {
  return Object.entries(FEATURE_LAYERS).map(([layer, config]) => ({
    label: config.label,
    submenu: config.kinds.map((kind) => {
      const disabled = layer === 'coa' && !state.selectedCoaId;
      return {
        label: `${kind === 'point' ? 'Point here' : `Start ${kind}`}`,
        disabled,
        action: () => {
          if (disabled) return;
          if (kind === 'point') {
            handleFeatureDrawn(
              { layer, coaId: layer === 'coa' ? state.selectedCoaId : undefined },
              'point',
              {
                type: 'Point',
                coordinates: [lon, lat],
              },
            );
          } else {
            armFeatureDraw(layer, kind);
          }
        },
      };
    }),
  }));
}

/** Drops every mutating item (and mutating-only submenu) from a built context
 * menu for a read-only role; navigation/copy/read items (`mutating: false`)
 * stay. The single filter point for all three menu builders below. */
function filterMenuForRole(items) {
  if (can('analyst') && canEditStudy()) return items;
  return items.filter((item) => item.mutating === false);
}

// --- Row menus ("⋯") --------------------------------------------------------
// One shared control for worksheet-list rows with 3+ actions: a primary
// button (the row's own select/zoom/go-to) plus a "⋯" menu for the rest.
// Reused by view.js's own lists and, via export, by sitemp.js and
// mapTools.js. Also closed whenever the Map popover or study menu opens,
// and vice versa — only one popover is ever open at a time.

let openRowMenu = null; // { button, menu }

function closeRowMenu() {
  if (!openRowMenu) return;
  const { button, menu } = openRowMenu;
  menu.remove();
  button.setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', onRowMenuOutside, true);
  document.removeEventListener('keydown', onRowMenuKeydown, true);
  openRowMenu = null;
}

function onRowMenuOutside(event) {
  if (!openRowMenu) return;
  if (openRowMenu.menu.contains(event.target) || openRowMenu.button.contains(event.target)) return;
  closeRowMenu();
}

function onRowMenuKeydown(event) {
  if (!openRowMenu) return;
  const items = [...openRowMenu.menu.querySelectorAll('[role="menuitem"]')];
  const index = items.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    const { button } = openRowMenu;
    closeRowMenu();
    button.focus();
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    items[(index + 1 + items.length) % items.length]?.focus();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    items[(index - 1 + items.length) % items.length]?.focus();
  } else if (event.key === 'Tab') {
    closeRowMenu();
  }
}

function openRowMenuFor(button, items) {
  closeAllPopovers();
  const menu = createElement('div', 'row-menu');
  menu.setAttribute('role', 'menu');
  items.forEach((item) => {
    const entry = createElement(
      'button',
      `row-menu-item${item.danger || /delete/i.test(item.label) ? ' danger' : ''}`,
      item.label,
    );
    entry.type = 'button';
    entry.setAttribute('role', 'menuitem');
    entry.tabIndex = -1;
    entry.addEventListener('click', () => {
      closeRowMenu();
      button.focus();
      item.action();
    });
    menu.append(entry);
  });
  elements.moduleRoot.append(menu);
  const rect = button.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  const wouldOverflow = rect.bottom + menu.offsetHeight + 4 > window.innerHeight;
  menu.style.top = wouldOverflow
    ? `${Math.max(4, rect.top - menu.offsetHeight - 4)}px`
    : `${rect.bottom + 4}px`;
  button.setAttribute('aria-expanded', 'true');
  openRowMenu = { button, menu };
  menu.querySelector('[role="menuitem"]')?.focus();
  window.setTimeout(() => {
    document.addEventListener('mousedown', onRowMenuOutside, true);
    document.addEventListener('keydown', onRowMenuKeydown, true);
  }, 0);
}

/**
 * Builds a row's "⋯" menu button for `items` (`{ label, action, danger?,
 * mutating? }`), role-filtered via `filterMenuForRole` — returns `null` when
 * nothing is left (e.g. an observer with no mutating items), so the caller
 * can omit the button entirely rather than show an empty menu.
 */
function renderRowMenu(items) {
  const filtered = filterMenuForRole(items);
  if (!filtered.length) return null;
  const button = createElement('button', 'row-menu-toggle', '⋯');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', 'More actions');
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (openRowMenu?.button === button) {
      closeRowMenu();
      return;
    }
    openRowMenuFor(button, filtered);
  });
  return button;
}

function buildMapContextMenu(lon, lat) {
  return filterMenuForRole([
    { label: 'Copy coordinates', action: () => copyCoordinates(lon, lat), mutating: false },
    {
      label: 'Set as LOS point',
      submenu: [
        { label: 'Set as observer', action: () => setLosPoint(lon, lat, 'observer') },
        { label: 'Set as target', action: () => setLosPoint(lon, lat, 'target') },
      ],
    },
    { label: 'Add observation post here', action: () => handleViewshedPick(lon, lat) },
    { label: 'Draw here', submenu: drawHereItems(lon, lat) },
    {
      label: 'Show elevation here',
      action: () => showElevationReadout(lon, lat),
      mutating: false,
    },
    { label: 'Set weather point here', action: () => setWeatherPoint({ lon, lat }) },
    {
      label: 'Add point here',
      submenu: [
        ...(state.study?.layers ?? []).map((layer) => ({
          label: layer.name,
          action: () => addPointAt(layer.id, lon, lat),
        })),
        { label: 'New layer…', action: () => addPointToNewLayer(lon, lat) },
      ],
    },
  ]);
}

function buildPointContextMenu(point) {
  return filterMenuForRole([
    { label: 'Edit…', action: () => editPoint(point) },
    { label: 'Move (drag)', action: () => armPointMove(point) },
    {
      label: 'Copy coordinates',
      action: () => copyCoordinates(point.lon, point.lat),
      mutating: false,
    },
    { label: 'Delete', action: () => deletePoint(point) },
  ]);
}

function buildFeatureContextMenu(featureId, lon, lat) {
  const feature = state.study?.features.find((entry) => String(entry.id) === String(featureId));
  if (!feature) return buildMapContextMenu(lon, lat);
  const [pointLon, pointLat] =
    feature.kind === 'point' || feature.kind === 'symbol'
      ? feature.geometry.coordinates
      : [lon, lat];
  if (feature.layer === 'unit') {
    return filterMenuForRole([
      ...unitMenuItems(feature),
      { label: 'Zoom to', action: () => mapController.fitFeature(feature.id), mutating: false },
      {
        label: 'Copy coordinates',
        action: () => copyCoordinates(pointLon, pointLat),
        mutating: false,
      },
    ]);
  }
  return filterMenuForRole([
    { label: 'Zoom to', action: () => mapController.fitFeature(feature.id), mutating: false },
    { label: 'Rename', action: () => renameFeature(feature) },
    { label: 'Start modify (drag vertices)', action: () => armFeatureModify(feature) },
    {
      label: 'Copy coordinates',
      action: () => copyCoordinates(pointLon, pointLat),
      mutating: false,
    },
    { label: 'Delete', action: () => deleteFeature(feature) },
  ]);
}

function onMapContextMenu({ lon, lat, featureId, clientX, clientY }) {
  const point = findPoint(featureId);
  const items = point
    ? buildPointContextMenu(point)
    : isAreaId(featureId)
      ? filterMenuForRole(areaMenuItems(featureId))
      : featureId !== null
        ? buildFeatureContextMenu(featureId, lon, lat)
        : buildMapContextMenu(lon, lat);
  openContextMenu(clientX, clientY, items);
}

let pointerElevationTimer = null;
let pointerElevationController = null;

/** Debounced ~250 ms after the pointer stops, cancelling a stale in-flight
 * request; "—" is shown until the first result and outside the elevation
 * data (which `requestJson` treats as elevation: null, not an error). */
function scheduleElevationReadout(lon, lat) {
  window.clearTimeout(pointerElevationTimer);
  pointerElevationTimer = window.setTimeout(async () => {
    pointerElevationController?.abort();
    const controller = new AbortController();
    pointerElevationController = controller;
    try {
      const params = new URLSearchParams({ at: `${lon},${lat}` });
      const result = await requestJson(`${TERRAIN_API}/elevation?${params}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      elements.pointerElevation.textContent = Number.isFinite(result.elevation)
        ? formatMetres(result.elevation)
        : '—';
    } catch (error) {
      if (error.name === 'AbortError') return;
      elements.pointerElevation.textContent = '—';
    }
  }, 250);
}

function onMapPointerMove({ lon, lat }) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    elements.pointerMgrs.textContent = '—';
    elements.pointerElevation.textContent = '—';
    window.clearTimeout(pointerElevationTimer);
    pointerElevationController?.abort();
    return;
  }
  elements.pointerMgrs.textContent = formatMgrs(lon, lat, 5, { spaced: true });
  scheduleElevationReadout(lon, lat);
}

function onMapClick({ lon, lat }) {
  if (mapToolsController?.handleClick({ lon, lat })) return;
  const tool = state.tool;
  if (!tool) {
    if (state.step === 2) showElevationReadout(lon, lat);
    return;
  }
  if (handleSitempClick(lon, lat)) return;
  if (tool.type === 'los-pick') {
    handleLosPick(lon, lat);
    return;
  }
  if (tool.type === 'viewshed-pick') {
    handleViewshedPick(lon, lat);
    return;
  }
  if (tool.type === 'point-add') {
    // Stays armed: each click adds another point until Escape.
    addPointAt(tool.layerId, lon, lat);
    return;
  }
  if (tool.type === 'weather-pick') {
    state.tool = null;
    renderMapHint('');
    setWeatherPoint({ lon, lat });
    return;
  }
  if (tool.type === 'avenue-pick') handleAvenuePick(lon, lat);
}

async function handleFeatureDrawn(tool, kind, geometry) {
  if (!(can('analyst') && canEditStudy())) return;
  state.tool = null;
  renderMapHint('');
  const layerLabel = FEATURE_LAYERS[tool.layer].label;
  const label = await askText(`Label for this ${layerLabel.toLowerCase()}`, '', 'Add');
  if (label === null) {
    mapController.cancelDraw();
    syncMapFeatures();
    return;
  }
  try {
    const feature = await requestJson(`${API}/studies/${state.studyId}/features`, {
      method: 'POST',
      body: {
        layer: tool.layer,
        kind,
        label: label || layerLabel,
        geometry,
        properties: tool.coaId ? { coa_id: tool.coaId } : undefined,
      },
    });
    state.study.features.push(feature);
    syncMapFeatures();
    reRenderContainingWorksheet(tool.layer);
  } catch (error) {
    showError(elements.toolPanel, error.message);
  }
}

function onMapDraw({ kind, geometry }) {
  if (mapToolsController?.handleDraw({ kind, geometry })) return;
  const tool = state.tool;
  if (!tool) return;
  // Defense in depth: every arming path already checks the role (so this
  // never triggers from the ordinary UI), but a tool set some other way
  // still can't complete a mutation for a read-only role.
  if (!(can('analyst') && canEditStudy())) {
    state.tool = null;
    mapController.cancelDraw();
    return;
  }
  if (handleAreaDrawn(tool, geometry)) return;
  if (tool.type !== 'draw-feature') return;
  handleFeatureDrawn(tool, kind, geometry);
}

async function handleFeatureModified(id, geometry) {
  if (!(can('analyst') && canEditStudy())) return;
  const feature = state.study.features.find((entry) => String(entry.id) === String(id));
  if (!feature) return;
  try {
    const updated = await requestJson(`${API}/studies/${feature.study_id}/features/${id}`, {
      method: 'PATCH',
      body: { geometry },
    });
    Object.assign(feature, updated);
    syncMapFeatures();
    reRenderContainingWorksheet(feature.layer);
  } catch (error) {
    showError(elements.toolPanel, error.message);
  }
}

function onMapFeatureChange({ id, geometry }) {
  const point = findPoint(id);
  if (point) {
    const [lon, lat] = geometry.coordinates;
    cancelActiveTool();
    updatePoint(point, { lon, lat });
    return;
  }
  if (handleAreaReshaped(id, geometry)) return;
  handleFeatureModified(id, geometry);
}

// --- Shared feature list / draw button widgets --------------------------

function selectAndZoomFeature(feature) {
  state.selectedFeatureId = feature.id;
  mapController.selectFeature(feature.id);
  mapController.fitFeature(feature.id);
  writeLocation();
  reRenderContainingWorksheet(feature.layer);
}

function renderFeatureRow(feature) {
  const row = createElement('li', 'feature-row');
  if (String(feature.id) === String(state.selectedFeatureId)) row.classList.add('active');
  const primary = createElement('button', 'feature-label', feature.label);
  primary.type = 'button';
  primary.title = 'Select and zoom to this feature';
  primary.addEventListener('click', () => selectAndZoomFeature(feature));
  row.append(primary);
  const menu = renderRowMenu([
    { label: 'Rename', action: () => renameFeature(feature) },
    { label: 'Delete', action: () => deleteFeature(feature) },
  ]);
  if (menu) row.append(menu);
  return row;
}

async function renameFeature(feature) {
  if (!(can('analyst') && canEditStudy())) return;
  const label = await askText('Rename', feature.label);
  if (!label || label === feature.label) return;
  try {
    const updated = await requestJson(`${API}/studies/${feature.study_id}/features/${feature.id}`, {
      method: 'PATCH',
      body: { label },
    });
    Object.assign(feature, updated);
    syncMapFeatures();
    reRenderContainingWorksheet(feature.layer);
  } catch (error) {
    showError(
      elements[OAKOC_LAYERS.includes(feature.layer) ? 'worksheet2' : 'worksheet4'],
      error.message,
    );
  }
}

async function deleteFeature(feature) {
  if (!(can('analyst') && canEditStudy())) return;
  if (!(await askConfirm(`Delete "${feature.label}"?`))) return;
  try {
    await requestJson(`${API}/studies/${feature.study_id}/features/${feature.id}`, {
      method: 'DELETE',
    });
    state.study.features = state.study.features.filter(
      (entry) => String(entry.id) !== String(feature.id),
    );
    if (String(state.selectedFeatureId) === String(feature.id)) state.selectedFeatureId = null;
    syncMapFeatures();
    reRenderContainingWorksheet(feature.layer);
  } catch (error) {
    showError(
      elements[OAKOC_LAYERS.includes(feature.layer) ? 'worksheet2' : 'worksheet4'],
      error.message,
    );
  }
}

function armFeatureDraw(layer, kind) {
  if (!(can('analyst') && canEditStudy())) return;
  const coaId = layer === 'coa' ? state.selectedCoaId : undefined;
  state.tool = { type: 'draw-feature', layer, kind, coaId };
  mapController.startDraw(kind, { layer });
  const trace =
    kind === 'point' ? '' : ' Click each point, or hold the right mouse button and trace.';
  renderMapHint(
    `Draw a ${KIND_LABELS[kind].toLowerCase()} ${FEATURE_LAYERS[layer].label.toLowerCase()}.${trace} Press Escape to cancel.`,
  );
}

function renderDrawButtons(layer) {
  const group = createElement('div', 'draw-buttons');
  FEATURE_LAYERS[layer].kinds.forEach((kind) => {
    const button = editable(createElement('button', 'chip-button', KIND_LABELS[kind]));
    button.type = 'button';
    if (layer === 'coa' && !state.selectedCoaId) button.disabled = true;
    button.addEventListener('click', () => armFeatureDraw(layer, kind));
    group.append(button);
  });
  return group;
}

// --- Step 1: define the environment --------------------------------------

function renderStep1Tools() {
  const container = createElement('div', 'tool-section');

  container.append(renderAreaTools());
  if (state.study) container.append(renderWeatherPointGroup());

  const jumpGroup = createElement('div', 'field-group');
  jumpGroup.append(createElement('h3', null, 'Jump to coordinate'));
  const jumpRow = createElement('div', 'inline-form');
  const jumpInput = document.createElement('input');
  jumpInput.type = 'text';
  jumpInput.placeholder = 'MGRS, UTM, or DD…';
  const jumpButton = createElement('button', 'chip-button', 'Go');
  jumpButton.type = 'button';
  const jumpError = createElement('p', 'inline-error');
  jumpError.hidden = true;
  const jump = () => {
    const parsed = parseCoordinate(jumpInput.value.trim());
    if (!parsed) {
      jumpError.hidden = false;
      jumpError.textContent = 'Could not parse that coordinate.';
      return;
    }
    jumpError.hidden = true;
    jumpToCoordinate(parsed.lon, parsed.lat);
  };
  jumpButton.addEventListener('click', jump);
  jumpInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') jump();
  });
  jumpRow.append(jumpInput, jumpButton);
  jumpGroup.append(jumpRow, jumpError);
  container.append(jumpGroup);

  container.append(
    renderExchangeTools({
      createElement,
      requestJson,
      showError,
      can: can('analyst') && canEditStudy(),
      getStudyId: () => state.studyId,
      onImported: (items) => {
        state.study.features.push(...items);
        syncMapFeatures();
        renderStep2Worksheet();
        renderStep4Worksheet();
      },
    }),
  );

  return container;
}

function renderStep1Worksheet() {
  const container = elements.worksheet1;
  container.replaceChildren();
  if (!state.study) return;
  const study = state.study.study;
  container.append(createElement('h3', null, '1 · Define the operational environment'));

  container.append(
    renderClassificationField({
      createElement,
      requestJson,
      showError,
      can: can('analyst') && canEditStudy(),
      study,
      studyId: state.studyId,
      getStudyId: () => state.studyId,
      onSaved: (text) =>
        applyClassificationBanner(
          elements.classificationTop,
          elements.classificationBottom,
          text,
          state.study?.study?.owner_cell,
        ),
    }),
  );

  container.append(renderAreaWorksheet());
  container.append(renderLightData(study));
  container.append(renderForecast(study));

  // Reuses the forecast the block above already fetched — never refetches.
  const { forecast } = state.weather;
  const forecastHours =
    forecast.dataKey === forecast.key && forecast.dataKey !== null
      ? (forecast.data?.[0]?.hours ?? [])
      : [];
  const weatherEffectsPoint = state.weather.site.value?.point ?? resolveWeatherEffectsPoint(study);
  container.append(
    renderWeatherEffectsBlock({
      createElement,
      requestJson,
      showError,
      can: can('analyst') && canEditStudy(),
      study,
      hours: forecastHours,
      point: weatherEffectsPoint,
    }),
  );

  const noteLabel = createElement('label', 'field-label', 'Environment notes');
  noteLabel.setAttribute('for', 'step1-note');
  const textarea = document.createElement('textarea');
  textarea.id = 'step1-note';
  textarea.className = 'note-field';
  textarea.rows = 10;
  textarea.placeholder = 'Terrain, weather, civil considerations…';
  textarea.value = study.notes?.step1 || '';
  editable(textarea);
  const printCopy = createElement('div', 'print-copy', textarea.value || '—');
  textarea.addEventListener('input', () => {
    printCopy.textContent = textarea.value || '—';
    const studyId = state.studyId;
    window.clearTimeout(state.timers.get('step1-note'));
    state.timers.set(
      'step1-note',
      window.setTimeout(() => {
        if (!state.study || state.studyId !== studyId) return;
        const notes = { ...state.study.study.notes, step1: textarea.value };
        requestJson(`${API}/studies/${studyId}`, { method: 'PATCH', body: { notes } })
          .then((updated) => {
            if (!state.study || state.studyId !== studyId) return;
            state.study.study = { ...state.study.study, ...updated, notes };
          })
          .catch((error) => {
            if (error.name !== 'AbortError') showError(container, error.message);
          });
      }, 180),
    );
  });
  container.append(noteLabel, textarea, printCopy);
}

// --- Step 1: light data --------------------------------------------------------

const LIGHT_COLUMNS = [
  ['bmnt', 'BMNT'],
  ['bmct', 'BMCT'],
  ['sunrise', 'Sunrise'],
  ['sunset', 'Sunset'],
  ['eect', 'EECT'],
  ['eent', 'EENT'],
  ['moonrise', 'Moonrise'],
  ['moonset', 'Moonset'],
];
const LIGHT_DAY_OPTIONS = [1, 3, 7, 14];

function localDateInputValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "Europe/Prague (UTC+2)" for the browser's zone on a given date. */
function timeZoneLabel(date) {
  const offset = -date.getTimezoneOffset() / 60;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${zone} (UTC${offset >= 0 ? '+' : '−'}${Math.abs(offset)})`;
}

/**
 * Sun and moon light table for the AOI centre (or the map centre until an AOI
 * is drawn), in local time, one row per local calendar day.
 */
function renderLightData(study) {
  const block = createElement('section', 'worksheet-block light-data');
  block.append(createElement('h4', null, 'Light data'));

  const location = aoiLocation(study);
  const { lon, lat } = location;
  const [year, month, day] = state.lightForm.start.split('-').map(Number);
  const firstDay = new Date(year, month - 1, day);

  const controls = createElement('div', 'light-controls');
  const startInput = document.createElement('input');
  startInput.type = 'date';
  startInput.value = state.lightForm.start;
  startInput.addEventListener('change', () => {
    if (!startInput.value) return;
    state.lightForm.start = startInput.value;
    renderStep1Worksheet();
  });
  const daysSelect = document.createElement('select');
  LIGHT_DAY_OPTIONS.forEach((count) => {
    daysSelect.append(new Option(`${count} day${count > 1 ? 's' : ''}`, String(count)));
  });
  daysSelect.value = String(state.lightForm.days);
  daysSelect.addEventListener('change', () => {
    state.lightForm.days = Number(daysSelect.value);
    renderStep1Worksheet();
  });
  controls.append(startInput, daysSelect);
  block.append(controls);

  block.append(
    createElement(
      'p',
      'panel-note',
      `${describeLocation(location)} · times in ${timeZoneLabel(firstDay)}`,
    ),
  );

  const time = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const table = document.createElement('table');
  table.className = 'data-table light-table';
  const headRow = document.createElement('tr');
  ['Date', ...LIGHT_COLUMNS.map(([, label]) => label), 'Moon (noon)'].forEach((label) => {
    headRow.append(createElement('th', null, label));
  });
  const head = document.createElement('thead');
  head.append(headRow);
  const body = document.createElement('tbody');
  for (let offset = 0; offset < state.lightForm.days; offset += 1) {
    // Local midnight each day, so rows follow the local calendar across DST.
    const dayStart = new Date(
      firstDay.getFullYear(),
      firstDay.getMonth(),
      firstDay.getDate() + offset,
    );
    const light = lightData(lat, lon, dayStart.getTime());
    const row = document.createElement('tr');
    row.append(createElement('td', null, date.format(dayStart)));
    LIGHT_COLUMNS.forEach(([key]) => {
      // Light tables round to the nearest minute; Intl would truncate seconds.
      const text = light[key] === null ? '—' : time.format(Math.round(light[key] / 60000) * 60000);
      row.append(createElement('td', null, text));
    });
    row.append(
      createElement(
        'td',
        null,
        `${Math.round(light.illumination * 100)}% ${light.waxing ? 'waxing' : 'waning'}`,
      ),
    );
    body.append(row);
  }
  table.append(head, body);
  block.append(table);
  block.append(
    createElement(
      'p',
      'panel-note',
      'BMNT/EENT: begin morning / end evening nautical twilight (sun 12° below the horizon); BMCT/EECT: civil twilight (6°). — : no such event that day.',
    ),
  );
  return block;
}

/** The AOI centre, else the AO centre, or the map centre until either is set. */
function aoiLocation(study) {
  for (const source of ['aoi', 'ao']) {
    if (!study[source]) continue;
    const [lon, lat] = aoiCentre(study[source]);
    return { lon, lat, source };
  }
  const [lon, lat] = mapController.getCenter();
  return { lon, lat, source: 'map' };
}

/** Where the study takes its weather: the point set for it, else derived from the AOI. */
function weatherPoint(study) {
  if (study.weather_point) return { ...study.weather_point, source: 'set' };
  return aoiLocation(study);
}

const LOCATION_SOURCES = {
  set: 'Weather point',
  aoi: 'AOI centre',
  ao: 'AO centre',
  map: 'Map centre (set an AOI or a weather point to fix it)',
};

/** "AOI centre 33UXR80270827". */
function describeLocation({ lon, lat, source }) {
  return `${LOCATION_SOURCES[source]} ${formatMgrs(lon, lat, 4)}`;
}

/**
 * Save the study's weather point (`{ lon, lat }`, or null to derive it from
 * the AOI again). A forecast already fetched in this session follows it.
 */
async function setWeatherPoint(point) {
  const studyId = state.studyId;
  try {
    const updated = await requestJson(`${API}/studies/${studyId}`, {
      method: 'PATCH',
      body: { weather_point: point },
    });
    if (!state.study || state.studyId !== studyId) return;
    state.study.study = { ...state.study.study, ...updated };
    const hadWeather = Boolean(state.weather.forecast.data);
    syncMapFeatures();
    renderStep1Worksheet();
    if (state.step === 1) renderToolPanel();
    if (hadWeather) loadWeatherReport();
  } catch (error) {
    if (error.name !== 'AbortError') showError(elements.toolPanel, error.message);
  }
}

function armWeatherPick() {
  if (!(can('analyst') && canEditStudy())) return;
  cancelActiveTool();
  state.tool = { type: 'weather-pick' };
  renderMapHint('Click the map to set the weather point. Press Escape to cancel.');
}

function renderWeatherPointGroup() {
  const group = createElement('div', 'field-group');
  group.append(createElement('h3', null, 'Weather point'));
  const study = state.study.study;
  const point = weatherPoint(study);
  group.append(
    createElement(
      'p',
      'tool-hint',
      study.weather_point
        ? `Set to ${formatMgrs(point.lon, point.lat, 4)}.`
        : `Automatic: ${point.source === 'map' ? 'the map centre until an AOI is set' : `the ${point.source.toUpperCase()} centre`}, ${formatMgrs(point.lon, point.lat, 4)}. Set a point for a specific place, e.g. a ridge, a valley or a landing zone.`,
    ),
  );
  const row = createElement('div', 'inline-form');
  const input = editable(document.createElement('input'));
  input.type = 'text';
  input.placeholder = 'MGRS, UTM, or DD…';
  const set = editable(createElement('button', 'chip-button', 'Set'));
  set.type = 'button';
  const error = createElement('p', 'inline-error');
  error.hidden = true;
  const apply = () => {
    const parsed = parseCoordinate(input.value.trim());
    error.hidden = Boolean(parsed);
    if (!parsed) {
      error.textContent = 'Could not parse that coordinate.';
      return;
    }
    setWeatherPoint({ lon: parsed.lon, lat: parsed.lat });
  };
  set.addEventListener('click', apply);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') apply();
  });
  row.append(input, set);
  const actions = createElement('div', 'inline-form');
  const pick = editable(createElement('button', 'chip-button', 'Pick on map'));
  pick.type = 'button';
  pick.addEventListener('click', armWeatherPick);
  const reset = editable(createElement('button', 'chip-button', 'Use AOI centre'));
  reset.type = 'button';
  reset.disabled = !study.weather_point;
  reset.addEventListener('click', () => setWeatherPoint(null));
  actions.append(pick, reset);
  group.append(row, error, actions);
  return group;
}

// --- Step 1: weather forecast (online) -----------------------------------------

const FORECAST_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatNumber(value, digits = 0) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/** "W 4 (9)": direction the wind comes from, speed, gusts when notably higher. */
function formatWind({ direction, wind, gusts }) {
  if (!Number.isFinite(wind)) return '—';
  const from = Number.isFinite(direction) && wind >= 0.5 ? `${compassPoint(direction)} ` : '';
  const gust = Number.isFinite(gusts) && gusts >= wind + 3 ? ` (${Math.round(gusts)})` : '';
  return `${from}${Math.round(wind)}${gust}`;
}

function formatVisibility(metres) {
  return Number.isFinite(metres) ? (metres / 1000).toFixed(metres < 10_000 ? 1 : 0) : '—';
}

/**
 * Which study, weather point and AOI the site, forecast and station belong
 * to; rounded to ~100 m so a map-centre point survives small pans.
 */
function siteKey(study) {
  const point = weatherPoint(study);
  return JSON.stringify([study.id, point.lon.toFixed(3), point.lat.toFixed(3), study.aoi]);
}

/**
 * Resolve the study's weather site offline from terrain.db: the weather
 * point's ground height and the AOI's highest and lowest ground. Memoised on
 * siteKey; the map markers and the forecast block update when it lands.
 * Without elevation data the site still resolves, without heights.
 */
function resolveSite(study) {
  const site = state.weather.site;
  const key = siteKey(study);
  if (site.key === key && site.promise) return site.promise;
  const point = weatherPoint(study);
  Object.assign(site, { key, value: null, loading: true, error: null });
  site.promise = (async () => {
    let value;
    try {
      const params = new URLSearchParams({ at: `${point.lon},${point.lat}` });
      const [ground, extremes] = await Promise.all([
        requestJson(`${TERRAIN_API}/elevation?${params}`),
        study.aoi
          ? requestJson(`${TERRAIN_API}/extremes`, { method: 'POST', body: { area: study.aoi } })
          : null,
      ]);
      value = {
        point: { ...point, elevation: Number.isFinite(ground.elevation) ? ground.elevation : null },
        high: extremes?.highest ?? null,
        low: extremes?.lowest ?? null,
      };
    } catch (error) {
      if (error.name === 'AbortError') return null;
      value = { point: { ...point, elevation: null }, high: null, low: null };
      if (site.key === key) site.error = error.message;
    }
    if (site.key !== key) return null;
    Object.assign(site, { value, loading: false });
    if (!state.session.signal.aborted) {
      syncMapFeatures();
      replaceForecastBlock();
    }
    return value;
  })();
  return site.promise;
}

/** The points the forecast is read at: the weather point, then the AOI's extremes. */
function sitePoints(site) {
  return [
    { role: 'point', label: 'Weather point', ...site.point },
    site.high && { role: 'high', label: 'Highest ground', ...site.high },
    site.low && { role: 'low', label: 'Lowest ground', ...site.low },
  ].filter(Boolean);
}

function replaceForecastBlock() {
  const block = elements.worksheet1?.querySelector('.weather-forecast');
  if (block && state.study) block.replaceWith(renderForecast(state.study.study));
}

/**
 * Forecast for every site point (one Open-Meteo request) and the nearest
 * station's latest report (through this server), side by side; each part
 * fails on its own.
 */
async function loadWeatherReport() {
  const study = state.study.study;
  const key = siteKey(study);
  const { forecast, station } = state.weather;
  Object.assign(forecast, { key, loading: true, error: null });
  Object.assign(station, { key, loading: true, error: null });
  replaceForecastBlock();
  const site = await resolveSite(study);
  if (!site || forecast.key !== key) return;
  const points = sitePoints(site);
  const current = (entry) => entry.key === key;
  await Promise.all([
    requestJson(forecastUrl(points))
      .then((json) => {
        if (!current(forecast)) return;
        const results = parseForecasts(json);
        Object.assign(forecast, {
          data: points.map((point, index) => ({ ...point, ...results[index] })),
          dataKey: key,
          fetchedAt: Date.now(),
        });
      })
      .catch((error) => {
        if (error.name !== 'AbortError' && current(forecast)) forecast.error = WEATHER_UNAVAILABLE;
      })
      .finally(() => {
        if (current(forecast)) forecast.loading = false;
      }),
    requestJson(`${API}/weather/station?at=${site.point.lon},${site.point.lat}`)
      .then((data) => {
        if (current(station)) Object.assign(station, { data, dataKey: key });
      })
      .catch((error) => {
        if (error.name !== 'AbortError' && current(station)) station.error = error.message;
      })
      .finally(() => {
        if (current(station)) station.loading = false;
      }),
  ]);
  if (!state.session.signal.aborted) replaceForecastBlock();
}

function heightText(elevation) {
  return Number.isFinite(elevation) ? `${Math.round(elevation)} m` : 'height unknown';
}

/**
 * 48-hour model forecast at the study's weather point, how it compares
 * across the AOI, and the nearest station's measurement. Fetched only on
 * request: the requests tell open-meteo.com and aviationweather.gov where
 * the AOI is.
 */
function renderForecast(study) {
  const key = siteKey(study);
  const { site, forecast } = state.weather;
  if (site.key !== key) resolveSite(study);
  const resolved = site.key === key ? site.value : null;
  const point = resolved?.point ?? weatherPoint(study);
  const loading = forecast.key === key && forecast.loading;
  const points = forecast.dataKey === key ? forecast.data : null;

  const block = createElement('section', 'worksheet-block weather-forecast');
  const heading = createElement('h4', null, 'Weather ');
  heading.append(createElement('span', 'basemap-note', 'online'));
  block.append(heading);

  const facts = createElement('dl', 'fact-list weather-site');
  const fact = (term, text) =>
    facts.append(createElement('dt', null, term), createElement('dd', null, text));
  fact(
    'Weather point',
    `${describeLocation(point)}${resolved ? ` · ground ${heightText(point.elevation)}` : ''}`,
  );
  if (resolved?.high) {
    fact(
      'Highest ground',
      `${formatMgrs(resolved.high.lon, resolved.high.lat, 4)} · ${heightText(resolved.high.elevation)}`,
    );
    fact(
      'Lowest ground',
      `${formatMgrs(resolved.low.lon, resolved.low.lat, 4)} · ${heightText(resolved.low.elevation)}`,
    );
  }
  block.append(facts);

  const controls = createElement('div', 'light-controls');
  const button = createElement(
    'button',
    'text-button',
    loading ? 'Loading…' : points ? 'Refresh weather' : 'Get weather',
  );
  button.type = 'button';
  button.disabled = loading;
  button.addEventListener('click', loadWeatherReport);
  controls.append(button);
  block.append(controls);
  if (forecast.key === key && forecast.error) {
    block.append(createElement('p', 'inline-error', forecast.error));
  }

  if (!points) {
    block.append(
      createElement(
        'p',
        'panel-note',
        'A 48-hour model forecast (open-meteo.com) at the weather point and the AOI’s highest and lowest ground, and the latest measurement of the nearest reporting station (aviationweather.gov). Getting it sends those locations to both services. Set the weather point in the tool panel or by right-clicking the map.',
      ),
    );
    block.append(renderStation(key));
    return block;
  }

  const [main] = points;
  const now = main.current;
  if (now) {
    block.append(
      createElement(
        'p',
        'weather-now',
        `Now (${CLOCK.format(now.time)}): ${weatherText(now.code)}, ${formatNumber(now.temperature)} °C, wind ${formatWind(now)} m/s, cloud ${formatNumber(now.cloud)} % (low ${formatNumber(now.cloudLow)} %), visibility ${formatVisibility(now.visibility)} km, precipitation ${formatNumber(now.precipitation, 1)} mm`,
      ),
    );
  }
  block.append(forecastTable(main.hours));
  const cellKm = Number.isFinite(main.cell.lat) ? metresApart(main, main.cell) / 1000 : Number.NaN;
  block.append(
    createElement(
      'p',
      'panel-note',
      [
        `At the weather point; times in ${timeZoneLabel(new Date())}`,
        "weather, precipitation (total, chance) and gusts: the worst of the 3 h from the row's time; the rest at that time; wind from the named direction",
        Number.isFinite(cellKm)
          ? `model grid point ${cellKm.toFixed(1)} km away${Number.isFinite(main.elevation) ? `, temperature corrected to the ground height ${Math.round(main.elevation)} m` : ''}`
          : null,
        `model forecast by Open-Meteo.com (CC BY 4.0), fetched ${CLOCK.format(forecast.fetchedAt)}`,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
  );
  if (points.length > 1) block.append(renderSpread(points));
  block.append(renderStation(key));
  return block;
}

function metresApart(a, b) {
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((a.lon - b.lon) * kmPerDegLon, (a.lat - b.lat) * kmPerDegLat) * 1000;
}

function forecastTable(hours) {
  const table = document.createElement('table');
  table.className = 'data-table light-table weather-table';
  const headRow = document.createElement('tr');
  [
    'Time',
    'Weather',
    '°C',
    'Wind m/s (gusts)',
    'Precip. mm (prob.)',
    'Cloud % (low)',
    'Visibility km',
  ].forEach((label) => headRow.append(createElement('th', null, label)));
  const head = document.createElement('thead');
  head.append(headRow);
  const body = document.createElement('tbody');
  for (const hour of hours) {
    const row = document.createElement('tr');
    const probability = Number.isFinite(hour.probability) ? ` (${hour.probability} %)` : '';
    [
      FORECAST_TIME.format(hour.time),
      weatherText(hour.code),
      formatNumber(hour.temperature),
      formatWind(hour),
      `${formatNumber(hour.precipitation, 1)}${probability}`,
      `${formatNumber(hour.cloud)} (${formatNumber(hour.cloudLow)})`,
      formatVisibility(hour.visibility),
    ].forEach((text) => row.append(createElement('td', null, text)));
    body.append(row);
  }
  table.append(head, body);
  return table;
}

/**
 * The elements that differ across the AOI, per row "point / high / low":
 * temperature (height), wind (exposure), low cloud (hill fog on the tops)
 * and visibility (valley fog).
 */
function renderSpread(points) {
  const wrap = createElement('div', 'weather-spread');
  wrap.append(createElement('h5', null, 'Across the AOI'));
  wrap.append(
    createElement(
      'p',
      'panel-note',
      `Each cell: ${points.map((point) => `${point.label.toLowerCase()} (${heightText(point.elevation)})`).join(' / ')}`,
    ),
  );
  const table = document.createElement('table');
  table.className = 'data-table light-table weather-table';
  const headRow = document.createElement('tr');
  ['Time', '°C', 'Wind m/s (gusts)', 'Low cloud %', 'Visibility km'].forEach((label) =>
    headRow.append(createElement('th', null, label)),
  );
  const head = document.createElement('thead');
  head.append(headRow);
  const body = document.createElement('tbody');
  const rows = [
    { label: 'Now', pick: (point) => point.current },
    ...points[0].hours.map((hour, index) => ({
      label: FORECAST_TIME.format(hour.time),
      pick: (point) => point.hours[index],
    })),
  ];
  for (const { label, pick } of rows) {
    const row = document.createElement('tr');
    const cells = (format) =>
      points.map((point) => (pick(point) ? format(pick(point)) : '—')).join(' / ');
    [
      label,
      cells((entry) => formatNumber(entry.temperature)),
      cells(formatWind),
      cells((entry) => formatNumber(entry.cloudLow)),
      cells((entry) => formatVisibility(entry.visibility)),
    ].forEach((text) => row.append(createElement('td', null, text)));
    body.append(row);
  }
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

/** The nearest station's latest METAR, decoded, with the raw report. */
function renderStation(key) {
  const station = state.weather.station;
  const wrap = createElement('div', 'weather-station');
  if (station.key !== key && station.dataKey !== key) return wrap;
  wrap.append(createElement('h5', null, 'Nearest observation (measured)'));
  if (station.key === key && station.loading) {
    wrap.append(createElement('p', 'panel-note', 'Asking for the nearest station…'));
    return wrap;
  }
  if (station.key === key && station.error) {
    wrap.append(createElement('p', 'inline-error', station.error));
    return wrap;
  }
  const report = station.dataKey === key ? station.data : null;
  if (!report) return wrap;
  const { wind, visibility } = report;
  const from = wind.variable
    ? 'variable '
    : Number.isFinite(wind.direction)
      ? `${compassPoint(wind.direction)} `
      : '';
  const windText = Number.isFinite(wind.speed)
    ? `${from}${wind.speed.toFixed(0)} m/s (${wind.knots} kt)${Number.isFinite(wind.gusts) ? `, gusts ${wind.gusts.toFixed(0)} m/s` : ''}`
    : '—';
  const visibilityText = visibility
    ? `${visibility.atLeast ? '≥ ' : ''}${formatVisibility(visibility.metres)} km`
    : '—';
  const cloudText = report.cavok
    ? 'CAVOK (no cloud below 1,500 m, no significant weather)'
    : report.clouds.length
      ? report.clouds
          .map((layer) =>
            `${layer.cover} ${Number.isFinite(layer.baseFeet) ? `${Math.round(layer.baseFeet * 0.3048)} m` : ''}`.trim(),
          )
          .join(', ')
      : 'no cloud reported';
  const ceilingText = Number.isFinite(report.ceilingMetres)
    ? `ceiling ${report.ceilingMetres} m (${report.ceilingFeet.toLocaleString()} ft)`
    : 'no ceiling';
  // The station is a real, named place, so its identifier is hidden while a
  // scenario is active — everything else about the reading (distance, bearing, height) stays.
  const stationLabel = state.scenario
    ? 'Nearest station'
    : `${report.station.id} ${report.station.name}`;
  wrap.append(
    createElement(
      'p',
      'weather-now',
      `${stationLabel}, ${report.distanceKm.toFixed(0)} km ${compassPoint(report.bearing)} of the weather point, station ${heightText(report.station.elevation)} · observed ${CLOCK.format(report.observed)} (${minutesAgo(report.observed)})`,
    ),
    createElement(
      'p',
      'weather-now',
      [
        `${formatNumber(report.temperature)} °C, dew point ${formatNumber(report.dewPoint)} °C`,
        `wind ${windText}`,
        `visibility ${visibilityText}`,
        report.weather ? `weather ${report.weather}` : null,
        `cloud ${cloudText}`,
        ceilingText,
        Number.isFinite(report.qnh) ? `QNH ${report.qnh} hPa` : null,
      ]
        .filter(Boolean)
        .join(', '),
    ),
    createElement('code', 'weather-metar', report.raw),
    createElement(
      'p',
      'panel-note',
      `Measured at the airfield, not in the AOI${report.distanceKm > 25 ? `; ${report.distanceKm.toFixed(0)} km away it shows the wider region, not local effects` : ''}. Cloud heights above the station. METAR via aviationweather.gov (NOAA).`,
    ),
  );
  return wrap;
}

// --- Step 2: describe the effects ----------------------------------------

function heightInput(labelText, value, onChange, min = 0, max = 500) {
  const label = createElement('label', 'inline-field');
  label.append(createElement('span', null, labelText));
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = 'any';
  input.value = String(value);
  input.addEventListener('change', () => {
    const parsed = Number(input.value);
    if (Number.isFinite(parsed)) onChange(Math.min(Math.max(parsed, min), max));
  });
  label.append(input);
  return label;
}

function mobilityPalette(legend) {
  const palette = {};
  legend.forEach((entry) => {
    palette[entry.value] = entry.value === 255 ? null : entry.color;
  });
  return palette;
}

function paintMobility() {
  if (!state.mobility.grid) {
    mapController.clearGrid('mobility');
    return;
  }
  mapController.setGrid('mobility', state.mobility.grid, {
    opacity: state.mobility.opacity,
    palette: mobilityPalette(state.mobility.grid.legend),
  });
}

function paintViewshed() {
  if (!state.viewshedResult) {
    mapController.clearGrid('viewshed');
    return;
  }
  mapController.setGrid('viewshed', state.viewshedResult, {
    opacity: 1,
    palette: VIEWSHED_PALETTE,
  });
}

async function runMobility() {
  if (!(can('analyst') && canEditStudy())) return;
  const bounds = state.study.study.bounds;
  if (!bounds) return;
  state.mobility.running = true;
  renderToolPanel();
  try {
    const params = new URLSearchParams({
      bounds: bounds.join(','),
      cell: String(state.mobility.cell),
    });
    const grid = await requestJson(`${TERRAIN_API}/mobility?${params}`);
    state.mobility.grid = grid;
    paintMobility();
    renderStep2Worksheet();
    const analysis = await requestJson(`${API}/studies/${state.studyId}/analyses`, {
      method: 'POST',
      body: {
        kind: 'mobility',
        params: { bounds, cell: state.mobility.cell },
        summary: {
          cellMetres: grid.cellMetres,
          width: grid.width,
          height: grid.height,
          classes: grid.summary,
        },
      },
    });
    state.study.analyses.push(analysis);
  } catch (error) {
    showError(elements.worksheet2, error.message);
  } finally {
    state.mobility.running = false;
    renderToolPanel();
  }
}

function armLosTool() {
  if (!(can('analyst') && canEditStudy())) return;
  state.tool = { type: 'los-pick' };
  state.losPicks = [];
  state.losResult = null;
  renderMapHint('Click the observer point, then the target point.');
  syncMapFeatures();
  renderToolPanel();
}

function handleLosPick(lon, lat) {
  state.losPicks.push({ lon, lat });
  syncMapFeatures();
  if (state.losPicks.length < 2) {
    renderMapHint('Click the target point.');
    return;
  }
  runLineOfSight();
}

async function runLineOfSight() {
  const [from, to] = state.losPicks;
  state.tool = null;
  renderMapHint('');
  const params = new URLSearchParams({
    from: `${from.lon},${from.lat}`,
    to: `${to.lon},${to.lat}`,
    observer: String(state.losForm.observer),
    target: String(state.losForm.target),
  });
  try {
    const result = await requestJson(`${TERRAIN_API}/line-of-sight?${params}`);
    state.losResult = result;
    renderStep2Worksheet();
    const analysis = await requestJson(`${API}/studies/${state.studyId}/analyses`, {
      method: 'POST',
      body: {
        kind: 'line-of-sight',
        params: { from, to, observer: state.losForm.observer, target: state.losForm.target },
        summary: {
          visible: result.visible,
          distance: result.distance,
          blockedAt: result.blockedAt,
          worstIntrusion: result.worstIntrusion,
        },
      },
    });
    state.study.analyses.push(analysis);
  } catch (error) {
    state.losResult = { error: error.message };
    renderStep2Worksheet();
  } finally {
    state.losPicks = [];
    syncMapFeatures();
    renderToolPanel();
  }
}

/** Matches the server's cap (routes.js MAX_OBSERVERS). */
const MAX_VIEWSHED_POSTS = 10;

function armViewshedTool() {
  if (!(can('analyst') && canEditStudy())) return;
  state.tool = { type: 'viewshed-pick' };
  renderMapHint('Click to add an observation post.');
  renderToolPanel();
}

/** Adds an observation post and reruns the combined viewshed. */
function handleViewshedPick(lon, lat) {
  if (!(can('analyst') && canEditStudy())) return;
  state.tool = null;
  renderMapHint('');
  if (state.viewshedPosts.length >= MAX_VIEWSHED_POSTS) {
    showError(elements.worksheet2, `At most ${MAX_VIEWSHED_POSTS} observation posts.`);
    return;
  }
  state.viewshedPosts.push({ lon, lat });
  syncMapFeatures();
  runViewshed();
}

function clearViewshedPosts() {
  state.viewshedPosts = [];
  state.viewshedResult = null;
  paintViewshed();
  syncMapFeatures();
  renderStep2Worksheet();
  renderToolPanel();
}

const squareKm = (cells, cellMetres) => (cells * cellMetres ** 2) / 1_000_000;

async function runViewshed() {
  const posts = [...state.viewshedPosts];
  const params = new URLSearchParams({
    at: posts.map(({ lon, lat }) => `${lon},${lat}`).join(';'),
    radius: String(state.viewshedForm.radius),
    observer: String(state.viewshedForm.observer),
    target: String(state.viewshedForm.target),
    cell: '50',
  });
  try {
    const grid = await requestJson(`${TERRAIN_API}/viewshed?${params}`);
    state.viewshedResult = grid;
    paintViewshed();
    renderStep2Worksheet();
    const analysis = await requestJson(`${API}/studies/${state.studyId}/analyses`, {
      method: 'POST',
      body: {
        kind: 'viewshed',
        params: { observers: posts, ...state.viewshedForm },
        summary: {
          observers: posts.length,
          cellMetres: grid.cellMetres,
          radiusMetres: grid.radiusMetres,
          visibleAreaSquareKm: squareKm(grid.visibleCells, grid.cellMetres),
          overlapAreaSquareKm: squareKm(grid.overlapCells, grid.cellMetres),
          deadAreaSquareKm: squareKm(grid.deadCells, grid.cellMetres),
        },
      },
    });
    state.study.analyses.push(analysis);
  } catch (error) {
    // The post just added (e.g. outside the elevation data) is dropped again.
    const added = posts.at(-1);
    state.viewshedPosts = state.viewshedPosts.filter((post) => post !== added);
    syncMapFeatures();
    showError(elements.worksheet2, error.message);
  } finally {
    renderToolPanel();
  }
}

// --- Step 2: key terrain candidates ------------------------------------------

/** A candidate named after a mapped peak takes the scenario's name for it, or "Hill <elevation>"
 * if it isn't a renamed peak: real names are substituted or hidden while a scenario
 * is active, so a candidate can never surface a real summit name in the worksheet or print. */
function keyTerrainLabel(candidate) {
  if (state.scenario) {
    const match =
      candidate.name &&
      matchScenarioPlace(scenarioPlaceIndex(), candidate.name, candidate.lon, candidate.lat);
    const name = match ? match.name : null;
    return `${name ?? 'Hill'} ${Math.round(candidate.elevation)} m`;
  }
  return `${candidate.name ?? 'Hill'} ${Math.round(candidate.elevation)} m`;
}

async function findKeyTerrain() {
  const bounds = state.study.study.bounds;
  if (!bounds) return;
  state.keyTerrain.running = true;
  renderToolPanel();
  try {
    const params = new URLSearchParams({
      bounds: bounds.join(','),
      prominence: String(state.keyTerrain.prominence),
    });
    const { candidates } = await requestJson(`${TERRAIN_API}/key-terrain?${params}`);
    state.keyTerrain.candidates = candidates;
    syncMapFeatures();
  } catch (error) {
    showError(elements.toolPanel, error.message);
  } finally {
    state.keyTerrain.running = false;
    renderToolPanel();
  }
}

function dropKeyTerrainCandidate(candidate) {
  state.keyTerrain.candidates = state.keyTerrain.candidates.filter((entry) => entry !== candidate);
  syncMapFeatures();
  renderToolPanel();
}

async function acceptKeyTerrainCandidate(candidate) {
  if (!(can('analyst') && canEditStudy())) return;
  try {
    const feature = await requestJson(`${API}/studies/${state.studyId}/features`, {
      method: 'POST',
      body: {
        layer: 'key-terrain',
        kind: 'point',
        label: keyTerrainLabel(candidate),
        geometry: { type: 'Point', coordinates: [candidate.lon, candidate.lat] },
        properties: {
          prominence: candidate.prominence,
          visibleAreaSquareKm: candidate.visibleAreaSquareKm,
        },
      },
    });
    state.study.features.push(feature);
    dropKeyTerrainCandidate(candidate);
    renderStep2Worksheet();
  } catch (error) {
    showError(elements.toolPanel, error.message);
  }
}

// --- Step 2: avenues of approach ---------------------------------------------

/** Corridor widths offered, in metres (a unit's frontage when moving). */
const AVENUE_WIDTHS = [250, 500, 1000, 2000];

function armAvenueTool() {
  cancelActiveTool();
  state.tool = { type: 'avenue-pick' };
  state.avenues.picks = [];
  state.avenues.routes = null;
  renderMapHint('Click where the enemy starts, then the objective.');
  syncMapFeatures();
  renderToolPanel();
}

function handleAvenuePick(lon, lat) {
  state.avenues.picks.push({ lon, lat });
  syncMapFeatures();
  if (state.avenues.picks.length < 2) {
    renderMapHint('Click the objective.');
    return;
  }
  state.tool = null;
  renderMapHint('');
  runAvenues();
}

async function runAvenues() {
  const [from, to] = state.avenues.picks;
  state.avenues.running = true;
  renderToolPanel();
  try {
    const params = new URLSearchParams({
      bounds: state.study.study.bounds.join(','),
      from: `${from.lon},${from.lat}`,
      to: `${to.lon},${to.lat}`,
      width: String(state.avenues.width),
      cell: String(state.mobility.cell),
    });
    const { routes } = await requestJson(`${TERRAIN_API}/avenues?${params}`);
    // Stable "Option n" names; "AA n" is reserved for saved avenues.
    state.avenues.routes = routes.map((route, index) => ({ ...route, option: index + 1 }));
  } catch (error) {
    state.avenues.routes = null;
    showError(elements.toolPanel, error.message);
  } finally {
    state.avenues.running = false;
    syncMapFeatures();
    renderToolPanel();
  }
}

function dropAvenueRoute(route) {
  state.avenues.routes = state.avenues.routes.filter((entry) => entry !== route);
  if (!state.avenues.routes.length) state.avenues.picks = [];
  syncMapFeatures();
  renderToolPanel();
}

async function acceptAvenueRoute(route) {
  if (!(can('analyst') && canEditStudy())) return;
  const existing = state.study.features.filter((feature) => feature.layer === 'avenue').length;
  try {
    const feature = await requestJson(`${API}/studies/${state.studyId}/features`, {
      method: 'POST',
      body: {
        layer: 'avenue',
        kind: 'line',
        label: `AA ${existing + 1}`,
        geometry: { type: 'LineString', coordinates: route.coordinates },
        properties: {
          corridorWidthMetres: state.avenues.width,
          lengthMetres: Math.round(route.lengthMetres),
          goShare: route.goShare,
        },
      },
    });
    state.study.features.push(feature);
    dropAvenueRoute(route);
    renderStep2Worksheet();
  } catch (error) {
    showError(elements.toolPanel, error.message);
  }
}

function renderStep2Tools() {
  const container = createElement('div', 'tool-section');
  const bounds = state.study.study.bounds;

  const mcooGroup = createElement('div', 'field-group');
  mcooGroup.append(createElement('h3', null, 'Mobility (MCOO)'));
  if (!bounds) {
    mcooGroup.append(
      createElement('p', 'tool-hint', 'Draw and save an AOI in Step 1 before running the MCOO.'),
    );
  } else {
    const cellLabel = createElement('label', 'inline-field');
    cellLabel.append(createElement('span', null, 'Cell size'));
    const cellSelect = document.createElement('select');
    MOBILITY_CELL_SIZES.forEach((size) => {
      const option = document.createElement('option');
      option.value = String(size);
      option.textContent = `${size} m`;
      if (size === state.mobility.cell) option.selected = true;
      cellSelect.append(option);
    });
    cellSelect.addEventListener('change', () => {
      state.mobility.cell = Number(cellSelect.value);
    });
    cellLabel.append(cellSelect);
    mcooGroup.append(cellLabel);

    const runButton = editable(
      createElement('button', 'primary-button', state.mobility.running ? 'Running…' : 'Run MCOO'),
    );
    runButton.type = 'button';
    runButton.disabled = state.mobility.running;
    runButton.addEventListener('click', runMobility);
    mcooGroup.append(runButton);

    const opacityLabel = createElement('label', 'inline-field');
    opacityLabel.append(createElement('span', null, 'Overlay opacity'));
    const opacityInput = document.createElement('input');
    opacityInput.type = 'range';
    opacityInput.min = '0';
    opacityInput.max = '100';
    opacityInput.value = String(Math.round(state.mobility.opacity * 100));
    opacityInput.addEventListener('input', () => {
      state.mobility.opacity = Number(opacityInput.value) / 100;
      paintMobility();
    });
    opacityLabel.append(opacityInput);
    mcooGroup.append(opacityLabel);
  }
  container.append(mcooGroup);

  const losGroup = createElement('div', 'field-group');
  losGroup.append(createElement('h3', null, 'Line of sight'));
  losGroup.append(
    heightInput('Observer height (m)', state.losForm.observer, (value) => {
      state.losForm.observer = value;
    }),
    heightInput('Target height (m)', state.losForm.target, (value) => {
      state.losForm.target = value;
    }),
  );
  const losButton = editable(
    createElement(
      'button',
      'chip-button',
      state.tool?.type === 'los-pick' ? 'Picking…' : 'Pick two points',
    ),
  );
  losButton.type = 'button';
  losButton.addEventListener('click', armLosTool);
  losGroup.append(losButton);
  container.append(losGroup);

  const viewshedGroup = createElement('div', 'field-group');
  viewshedGroup.append(createElement('h3', null, 'Viewshed'));
  const radiusLabel = createElement('label', 'inline-field');
  radiusLabel.append(createElement('span', null, 'Radius (m)'));
  const radiusInput = document.createElement('input');
  radiusInput.type = 'number';
  radiusInput.min = '200';
  radiusInput.max = '25000';
  radiusInput.step = 'any';
  radiusInput.value = String(state.viewshedForm.radius);
  radiusInput.addEventListener('change', () => {
    const parsed = Number(radiusInput.value);
    if (Number.isFinite(parsed)) state.viewshedForm.radius = Math.min(Math.max(parsed, 200), 25000);
  });
  radiusLabel.append(radiusInput);
  viewshedGroup.append(
    radiusLabel,
    heightInput('Observer height (m)', state.viewshedForm.observer, (value) => {
      state.viewshedForm.observer = value;
    }),
    heightInput('Target height (m)', state.viewshedForm.target, (value) => {
      state.viewshedForm.target = value;
    }),
  );
  const viewshedActions = createElement('div', 'button-row');
  const viewshedButton = editable(
    createElement(
      'button',
      'chip-button',
      state.tool?.type === 'viewshed-pick' ? 'Picking…' : 'Add observation post',
    ),
  );
  viewshedButton.type = 'button';
  viewshedButton.disabled = state.viewshedPosts.length >= MAX_VIEWSHED_POSTS;
  viewshedButton.addEventListener('click', armViewshedTool);
  viewshedActions.append(viewshedButton);
  if (state.viewshedPosts.length) {
    const clearButton = createElement('button', 'text-button', 'Clear posts');
    clearButton.type = 'button';
    clearButton.addEventListener('click', clearViewshedPosts);
    viewshedActions.append(clearButton);
  }
  viewshedGroup.append(viewshedActions);
  if (state.viewshedPosts.length) {
    viewshedGroup.append(
      createElement(
        'p',
        'tool-hint',
        `${state.viewshedPosts.length} post${state.viewshedPosts.length > 1 ? 's' : ''}: dark = dead ground, deeper orange = seen by two or more.`,
      ),
    );
  }
  container.append(viewshedGroup);

  container.append(renderKeyTerrainTools(bounds), renderAvenueTools(bounds));

  const oakocGroup = createElement('div', 'field-group');
  oakocGroup.append(createElement('h3', null, 'OAKOC overlays'));
  OAKOC_LAYERS.forEach((layer) => {
    const row = createElement('div', 'oakoc-tool-row');
    row.append(createElement('span', 'oakoc-tool-label', FEATURE_LAYERS[layer].label));
    row.append(renderDrawButtons(layer));
    oakocGroup.append(row);
  });
  container.append(oakocGroup);

  return container;
}

/** A tool-panel list row: summary text plus Add/Dismiss style actions. `mutating`
 * (default true) hides an action — e.g. "Add"/"Save" — for a read-only role;
 * a client-only "Dismiss" passes `mutating: false` to stay available. */
function suggestionRow(text, detail, actions) {
  const row = createElement('li', 'suggestion-row');
  const body = createElement('div', 'suggestion-text');
  body.append(createElement('strong', null, text), createElement('small', null, detail));
  const buttons = createElement('div', 'button-row');
  actions.forEach(([label, className, handler, mutating = true]) => {
    const button = createElement('button', className, label);
    button.type = 'button';
    button.addEventListener('click', handler);
    if (mutating) editable(button);
    buttons.append(button);
  });
  row.append(body, buttons);
  return row;
}

function renderKeyTerrainTools(bounds) {
  const group = createElement('div', 'field-group');
  group.append(createElement('h3', null, 'Key terrain candidates'));
  if (!bounds) {
    group.append(createElement('p', 'tool-hint', 'Draw and save an AOI in Step 1 first.'));
    return group;
  }
  const label = createElement('label', 'inline-field');
  label.append(createElement('span', null, 'Min. prominence'));
  const select = document.createElement('select');
  [20, 30, 50, 80].forEach((metres) => select.append(new Option(`${metres} m`, String(metres))));
  select.value = String(state.keyTerrain.prominence);
  select.addEventListener('change', () => {
    state.keyTerrain.prominence = Number(select.value);
  });
  label.append(select);
  const run = createElement(
    'button',
    'chip-button',
    state.keyTerrain.running ? 'Searching…' : 'Find candidates',
  );
  run.type = 'button';
  run.disabled = state.keyTerrain.running;
  run.addEventListener('click', findKeyTerrain);
  group.append(
    label,
    run,
    createElement(
      'p',
      'tool-hint',
      'Summits standing out from their surroundings, ranked by the ground they overlook within 3 km.',
    ),
  );
  const candidates = state.keyTerrain.candidates;
  if (candidates && !candidates.length) {
    group.append(createElement('p', 'panel-note', 'No summits reach that prominence in the AOI.'));
  } else if (candidates) {
    const list = createElement('ul', 'suggestion-list');
    candidates.forEach((candidate) => {
      list.append(
        suggestionRow(
          keyTerrainLabel(candidate),
          `${formatMgrs(candidate.lon, candidate.lat, 4)} · +${Math.round(candidate.prominence)} m · overlooks ${formatArea(candidate.visibleAreaSquareKm)}`,
          [
            ['Add', 'chip-button', () => acceptKeyTerrainCandidate(candidate)],
            ['Dismiss', 'text-button', () => dropKeyTerrainCandidate(candidate), false],
          ],
        ),
      );
    });
    group.append(list);
  }
  return group;
}

function renderAvenueTools(bounds) {
  const group = createElement('div', 'field-group');
  group.append(createElement('h3', null, 'Avenues of approach'));
  if (!bounds) {
    group.append(createElement('p', 'tool-hint', 'Draw and save an AOI in Step 1 first.'));
    return group;
  }
  const label = createElement('label', 'inline-field');
  label.append(createElement('span', null, 'Corridor width'));
  const select = document.createElement('select');
  AVENUE_WIDTHS.forEach((metres) =>
    select.append(new Option(formatMetres(metres), String(metres))),
  );
  select.value = String(state.avenues.width);
  select.addEventListener('change', () => {
    state.avenues.width = Number(select.value);
  });
  label.append(select);
  const pickLabel = state.avenues.running
    ? 'Searching…'
    : state.tool?.type === 'avenue-pick'
      ? 'Picking…'
      : 'Pick start and objective';
  const pick = createElement('button', 'chip-button', pickLabel);
  pick.type = 'button';
  pick.disabled = state.avenues.running;
  pick.addEventListener('click', armAvenueTool);
  group.append(
    label,
    pick,
    createElement(
      'p',
      'tool-hint',
      `Routes through the MCOO (${state.mobility.cell} m cells) that keep the whole corridor off NO-GO ground, preferring GO over SLOW-GO.`,
    ),
  );
  if (state.avenues.routes?.length) {
    const list = createElement('ul', 'suggestion-list');
    state.avenues.routes.forEach((route) => {
      list.append(
        suggestionRow(
          `Option ${route.option} · ${formatMetres(route.lengthMetres)}`,
          `${Math.round(route.goShare * 100)}% GO · ${Math.round(route.slowGoShare * 100)}% SLOW-GO`,
          [
            ['Save', 'chip-button', () => acceptAvenueRoute(route)],
            ['Dismiss', 'text-button', () => dropAvenueRoute(route), false],
          ],
        ),
      );
    });
    group.append(list);
  }
  return group;
}

function renderLosChart(result) {
  const width = 520;
  const height = 180;
  const paddingLeft = 46;
  const paddingBottom = 22;
  const paddingTop = 12;
  const plotWidth = width - paddingLeft - 12;
  const plotHeight = height - paddingTop - paddingBottom;
  const samples = result.samples;
  const maxDistance = result.distance || 1;
  const values = samples
    .flatMap((sample) => [sample.elevation, sample.sight])
    .filter(Number.isFinite);
  const minY = Math.min(...values);
  const maxY = Math.max(...values);
  const spanY = Math.max(maxY - minY, 1);
  const x = (distance) => paddingLeft + (distance / maxDistance) * plotWidth;
  const y = (value) => paddingTop + plotHeight - ((value - minY) / spanY) * plotHeight;

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'los-chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    result.visible
      ? 'Line of sight is clear.'
      : `Line of sight blocked at ${formatMetres(result.blockedAt)}.`,
  );

  const terrainPoints = samples
    .map((sample) => `${x(sample.distance)},${y(sample.elevation)}`)
    .join(' ');
  const terrainArea = `${paddingLeft},${paddingTop + plotHeight} ${terrainPoints} ${x(maxDistance)},${paddingTop + plotHeight}`;
  const terrainPolygon = document.createElementNS(svgNs, 'polygon');
  terrainPolygon.setAttribute('points', terrainArea);
  terrainPolygon.setAttribute('class', 'los-terrain');
  svg.append(terrainPolygon);

  const sightPoints = samples.map((sample) => `${x(sample.distance)},${y(sample.sight)}`).join(' ');
  const sightLine = document.createElementNS(svgNs, 'polyline');
  sightLine.setAttribute('points', sightPoints);
  sightLine.setAttribute('class', 'los-sight');
  svg.append(sightLine);

  if (result.blockedAt !== null) {
    const bx = x(result.blockedAt);
    const marker = document.createElementNS(svgNs, 'line');
    marker.setAttribute('x1', String(bx));
    marker.setAttribute('x2', String(bx));
    marker.setAttribute('y1', String(paddingTop));
    marker.setAttribute('y2', String(paddingTop + plotHeight));
    marker.setAttribute('class', 'los-block-marker');
    svg.append(marker);
  }

  const axis = document.createElementNS(svgNs, 'line');
  axis.setAttribute('x1', String(paddingLeft));
  axis.setAttribute('x2', String(paddingLeft));
  axis.setAttribute('y1', String(paddingTop));
  axis.setAttribute('y2', String(paddingTop + plotHeight));
  axis.setAttribute('class', 'los-axis');
  svg.append(axis);

  const labelMax = document.createElementNS(svgNs, 'text');
  labelMax.textContent = formatMetres(maxY);
  labelMax.setAttribute('x', '4');
  labelMax.setAttribute('y', String(paddingTop + 8));
  labelMax.setAttribute('class', 'los-label');
  svg.append(labelMax);

  const labelMin = document.createElementNS(svgNs, 'text');
  labelMin.textContent = formatMetres(minY);
  labelMin.setAttribute('x', '4');
  labelMin.setAttribute('y', String(paddingTop + plotHeight));
  labelMin.setAttribute('class', 'los-label');
  svg.append(labelMin);

  const labelDistance = document.createElementNS(svgNs, 'text');
  labelDistance.textContent = formatMetres(maxDistance);
  labelDistance.setAttribute('x', String(width - 8));
  labelDistance.setAttribute('y', String(height - 4));
  labelDistance.setAttribute('text-anchor', 'end');
  labelDistance.setAttribute('class', 'los-label');
  svg.append(labelDistance);

  return svg;
}

/** Most recent saved run of a kind, so a reopened study still reports it. */
function latestAnalysis(kind) {
  return state.study.analyses.reduce(
    (latest, row) => (row.kind === kind && (!latest || row.id > latest.id) ? row : latest),
    null,
  );
}

function renderMobilityLegend(classes, legend) {
  const list = createElement('ul', 'legend-list');
  classes.forEach((entry) => {
    const legendEntry = legend?.find((item) => item.code === entry.code);
    const row = createElement('li', 'legend-row');
    const swatch = createElement('span', 'legend-swatch');
    swatch.style.background = legendEntry?.color || '#888';
    row.append(
      swatch,
      createElement('span', 'legend-code', entry.code),
      createElement(
        'span',
        'legend-figures',
        `${(entry.share * 100).toFixed(1)}% · ${formatArea(entry.areaSquareKm)}`,
      ),
    );
    list.append(row);
  });
  return list;
}

function renderStep2Worksheet() {
  const container = elements.worksheet2;
  container.replaceChildren();
  if (!state.study) return;
  container.append(createElement('h3', null, '2 · Describe the environmental effects (OAKOC)'));

  const mcooSection = createElement('section', 'worksheet-block');
  mcooSection.append(createElement('h4', null, 'Modified combined obstacle overlay'));
  const bounds = state.study.study.bounds;
  const savedMobility = latestAnalysis('mobility');
  if (!bounds) {
    mcooSection.append(createElement('p', 'panel-note', 'No AOI drawn yet.'));
  } else if (state.mobility.grid) {
    mcooSection.append(
      renderMobilityLegend(state.mobility.grid.summary, state.mobility.grid.legend),
    );
  } else if (savedMobility) {
    mcooSection.append(
      renderMobilityLegend(savedMobility.summary.classes, state.terrainMeta?.legend),
      createElement(
        'p',
        'panel-note',
        `Saved run at ${savedMobility.summary.cellMetres} m cells. Run MCOO to paint it again.`,
      ),
    );
  } else {
    mcooSection.append(
      createElement('p', 'panel-note', 'No MCOO run yet. Use Run MCOO in the tool panel.'),
    );
  }
  container.append(mcooSection);

  const losSection = createElement('section', 'worksheet-block');
  losSection.append(createElement('h4', null, 'Line of sight'));
  const savedLos = latestAnalysis('line-of-sight');
  if (!state.losResult && savedLos) {
    const summary = savedLos.summary;
    const verdict = summary.visible
      ? `Clear over ${formatMetres(summary.distance)}.`
      : `Blocked at ${formatMetres(summary.blockedAt)} of ${formatMetres(summary.distance)} (worst intrusion ${formatMetres(summary.worstIntrusion)}).`;
    losSection.append(
      createElement('p', `los-verdict ${summary.visible ? 'visible' : 'blocked'}`, verdict),
      createElement('p', 'panel-note', 'Saved run. Pick two points to plot the profile again.'),
    );
  } else if (!state.losResult) {
    losSection.append(createElement('p', 'panel-note', 'No line of sight computed yet.'));
  } else if (state.losResult.error) {
    losSection.append(createElement('p', 'inline-error', state.losResult.error));
  } else {
    const verdict = state.losResult.visible
      ? `Clear over ${formatMetres(state.losResult.distance)}.`
      : `Blocked at ${formatMetres(state.losResult.blockedAt)} of ${formatMetres(state.losResult.distance)} (worst intrusion ${formatMetres(state.losResult.worstIntrusion)}).`;
    losSection.append(
      createElement('p', `los-verdict ${state.losResult.visible ? 'visible' : 'blocked'}`, verdict),
    );
    losSection.append(renderLosChart(state.losResult));
  }
  container.append(losSection);

  const viewshedSection = createElement('section', 'worksheet-block');
  viewshedSection.append(createElement('h4', null, 'Viewshed'));
  const savedViewshed = latestAnalysis('viewshed');
  // Older saved runs (single observer) carry only visibleAreaSquareKm.
  const describeViewshed = ({
    observers = 1,
    visibleAreaSquareKm,
    overlapAreaSquareKm,
    deadAreaSquareKm,
    radiusMetres,
  }) =>
    [
      `${observers} observation post${observers > 1 ? 's' : ''}, ${formatMetres(radiusMetres)} radius.`,
      `Seen: ${formatArea(visibleAreaSquareKm)}`,
      overlapAreaSquareKm !== undefined && observers > 1
        ? `seen by two or more: ${formatArea(overlapAreaSquareKm)}`
        : null,
      deadAreaSquareKm !== undefined ? `dead ground: ${formatArea(deadAreaSquareKm)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  if (!state.viewshedResult && savedViewshed) {
    viewshedSection.append(
      createElement('p', null, describeViewshed(savedViewshed.summary)),
      createElement('p', 'panel-note', 'Saved run. Add observation posts to paint it again.'),
    );
  } else if (!state.viewshedResult) {
    viewshedSection.append(createElement('p', 'panel-note', 'No viewshed computed yet.'));
  } else {
    const grid = state.viewshedResult;
    viewshedSection.append(
      createElement(
        'p',
        null,
        describeViewshed({
          observers: grid.observers.length,
          radiusMetres: grid.radiusMetres,
          visibleAreaSquareKm: squareKm(grid.visibleCells, grid.cellMetres),
          overlapAreaSquareKm: squareKm(grid.overlapCells, grid.cellMetres),
          deadAreaSquareKm: squareKm(grid.deadCells, grid.cellMetres),
        }),
      ),
    );
    const posts = createElement('ul', 'feature-list');
    grid.observers.forEach((post, index) => {
      posts.append(
        createElement(
          'li',
          null,
          `OP ${index + 1} · ${formatMgrs(post.lon, post.lat, 4)} · ${Math.round(post.ground)} m`,
        ),
      );
    });
    viewshedSection.append(posts);
  }
  container.append(viewshedSection);

  const oakocSection = createElement('section', 'worksheet-block');
  oakocSection.append(createElement('h4', null, 'OAKOC overlays'));
  OAKOC_LAYERS.forEach((layer) => {
    const features = state.study.features.filter((feature) => feature.layer === layer);
    const group = createElement('div', 'oakoc-group');
    group.append(createElement('h5', null, `${FEATURE_LAYERS[layer].label} (${features.length})`));
    if (features.length) {
      const list = createElement('ul', 'feature-list');
      features.forEach((feature) => list.append(renderFeatureRow(feature)));
      group.append(list);
    } else {
      group.append(createElement('p', 'panel-note', 'None drawn yet.'));
    }
    oakocSection.append(group);
  });
  container.append(oakocSection);

  container.append(
    renderCivilConsiderationsMatrix({
      createElement,
      requestJson,
      showError,
      can: can('analyst') && canEditStudy(),
      study: state.study,
      studyId: state.studyId,
      getStudyId: () => state.studyId,
    }),
  );
}

// --- Shared debounced field helper -----------------------------------------

function bindDebouncedCommit(element, key, commit) {
  element.addEventListener('input', () => {
    const studyId = state.studyId;
    window.clearTimeout(state.timers.get(key));
    state.timers.set(
      key,
      window.setTimeout(() => {
        if (state.studyId !== studyId) return;
        commit(element.value);
      }, 180),
    );
  });
}

// --- Step 3: evaluate the threat ------------------------------------------

/** Shared by the order-of-battle table and the COA cards: both sort by ordinal. */
async function reorderChild(kind, item, direction, worksheetElement, rerender) {
  if (!(can('analyst') && canEditStudy())) return;
  try {
    const result = await requestJson(`${API}/studies/${item.study_id}/${kind}/${item.id}/reorder`, {
      method: 'POST',
      body: { direction },
    });
    state.study[kind] = result.items;
    rerender();
  } catch (error) {
    if (error.name === 'AbortError') return;
    showError(worksheetElement, error.message);
  }
}

function renderReorderButtons(kind, item, index, total, worksheetElement, rerender) {
  const wrap = editable(createElement('span', 'reorder-buttons'), { hide: true });
  const up = createElement('button', 'icon-button', '↑');
  up.type = 'button';
  up.title = 'Move up';
  up.disabled = index === 0;
  up.addEventListener('click', () => reorderChild(kind, item, 'up', worksheetElement, rerender));
  const down = createElement('button', 'icon-button', '↓');
  down.type = 'button';
  down.title = 'Move down';
  down.disabled = index === total - 1;
  down.addEventListener('click', () =>
    reorderChild(kind, item, 'down', worksheetElement, rerender),
  );
  wrap.append(up, down);
  return wrap;
}

async function patchThreat(threat, body) {
  try {
    const updated = await requestJson(`${API}/studies/${threat.study_id}/threats/${threat.id}`, {
      method: 'PATCH',
      body,
    });
    Object.assign(threat, updated);
  } catch (error) {
    showError(elements.worksheet3, error.message);
  }
}

async function deleteThreat(threat) {
  if (!(can('analyst') && canEditStudy())) return;
  if (!(await askConfirm(`Delete "${threat.name}"?`))) return;
  try {
    await requestJson(`${API}/studies/${threat.study_id}/threats/${threat.id}`, {
      method: 'DELETE',
    });
    state.study.threats = state.study.threats.filter(
      (entry) => String(entry.id) !== String(threat.id),
    );
    renderStep3Worksheet();
  } catch (error) {
    showError(elements.worksheet3, error.message);
  }
}

async function addManualThreat(name) {
  if (!(can('analyst') && canEditStudy())) return;
  try {
    const threat = await requestJson(`${API}/studies/${state.studyId}/threats`, {
      method: 'POST',
      body: { name },
    });
    state.study.threats.push(threat);
    renderStep3Worksheet();
  } catch (error) {
    showError(elements.worksheet3, error.message);
  }
}

async function addThreatFromEquipment(item) {
  if (!(can('analyst') && canEditStudy())) return;
  try {
    const threat = await requestJson(`${API}/studies/${state.studyId}/threats`, {
      method: 'POST',
      body: { name: item.display_name || item.name, equipment_identifier: item.identifier },
    });
    state.study.threats.push(threat);
    renderStep3Worksheet();
  } catch (error) {
    showError(elements.worksheet3, error.message);
  }
}

/** Shared by search results and the bookmarked-equipment list: both pick a
 * card by clicking it. Bookmark items carry `title` but not `display_name`
 * or `domains`, so the fallbacks matter for both callers. */
function renderEquipmentRow(item) {
  const row = editable(createElement('button', 'equipment-result'), { hide: false });
  row.type = 'button';
  const media = createElement('span', 'equipment-result-media');
  if (item.image_url) {
    const image = document.createElement('img');
    image.src = item.image_url;
    image.alt = '';
    media.append(image);
  }
  const body = createElement('span', 'equipment-result-body');
  body.append(createElement('strong', null, item.display_name || item.name));
  body.append(
    createElement('span', 'equipment-result-meta', item.domains?.[0] || item.title || ''),
  );
  row.append(media, body);
  row.addEventListener('click', () => addThreatFromEquipment(item));
  return row;
}

function renderEquipmentResults(container) {
  container.replaceChildren();
  if (state.equipmentLoading) {
    container.append(createElement('p', 'panel-note', 'Searching…'));
    return;
  }
  if (!state.equipmentQuery) {
    container.append(createElement('p', 'panel-note', 'Type to search the equipment catalogue.'));
    return;
  }
  if (!state.equipmentResults.length) {
    container.append(createElement('p', 'panel-note', 'No equipment matches.'));
    return;
  }
  state.equipmentResults.forEach((item) => container.append(renderEquipmentRow(item)));
}

async function loadEquipmentBookmarks() {
  try {
    const result = await requestJson(`${EQUIPMENT_API}/bookmarks`);
    state.equipmentBookmarks = result.items;
  } catch (error) {
    if (error.name === 'AbortError') return;
    // Non-critical: the lookup still works by search without it.
    state.equipmentBookmarks = [];
  }
}

function renderBookmarkedEquipment(container) {
  container.replaceChildren();
  if (!state.equipmentBookmarks.length) {
    container.append(
      createElement(
        'p',
        'panel-note',
        'No equipment bookmarked yet. Star cards in the Equipment module to see them here.',
      ),
    );
    return;
  }
  state.equipmentBookmarks.forEach((item) => container.append(renderEquipmentRow(item)));
}

async function searchEquipment(query, container) {
  state.equipmentRequest?.abort();
  const controller = new AbortController();
  state.equipmentRequest = controller;
  state.equipmentLoading = true;
  renderEquipmentResults(container);
  try {
    const params = new URLSearchParams({ q: query, limit: '20' });
    const result = await requestJson(`${EQUIPMENT_API}/cards?${params}`, {
      signal: AbortSignal.any([controller.signal, state.session.signal]),
    });
    state.equipmentResults = result.items;
    state.equipmentLoading = false;
    renderEquipmentResults(container);
  } catch (error) {
    if (error.name === 'AbortError') return;
    state.equipmentLoading = false;
    container.replaceChildren(createElement('p', 'inline-error', error.message));
  }
}

function renderStep3Tools() {
  const container = createElement('div', 'tool-section');

  const addGroup = createElement('div', 'field-group');
  addGroup.append(createElement('h3', null, 'Add threat'));
  const addRow = createElement('div', 'inline-form');
  const nameInput = editable(document.createElement('input'), { hide: true });
  nameInput.type = 'text';
  nameInput.placeholder = 'Unit or system name…';
  const addButton = editable(createElement('button', 'chip-button', 'Add'));
  addButton.type = 'button';
  const submitAdd = () => {
    const name = nameInput.value.trim();
    if (!name) return;
    nameInput.value = '';
    addManualThreat(name);
  };
  addButton.addEventListener('click', submitAdd);
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitAdd();
  });
  addRow.append(nameInput, addButton);
  addGroup.append(addRow);
  if (can('analyst') && canEditStudy()) {
    const importButton = createElement('button', 'chip-button', 'Import from ORBAT…');
    importButton.type = 'button';
    importButton.addEventListener('click', async () => {
      const created = await importThreatsFromOrbat({
        requestJson,
        studyId: state.studyId,
        api: API,
        onError: (error) => showError(elements.worksheet3, error.message),
      });
      if (created?.length) {
        state.study.threats.push(...created);
        renderStep3Worksheet();
      }
    });
    addGroup.append(importButton);
  }
  container.append(addGroup);

  const lookupGroup = createElement('div', 'field-group');
  lookupGroup.append(createElement('h3', null, 'Equipment lookup'));
  const searchField = createElement('label', 'search-field');
  searchField.setAttribute('for', 'equipment-lookup');
  searchField.append(createElement('span', null, 'Search the sibling equipment catalogue'));
  const searchControl = createElement('div', 'search-control');
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.autocomplete = 'off';
  searchInput.placeholder = 'Tank, radar, designation…';
  searchInput.id = 'equipment-lookup';
  const searchIcon = createElement('span', null, '⌕');
  searchIcon.setAttribute('aria-hidden', 'true');
  searchControl.append(searchIcon, searchInput);
  searchField.append(searchControl);
  const results = createElement('div', 'equipment-results');
  let timer;
  searchInput.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      state.equipmentQuery = searchInput.value.trim();
      if (!state.equipmentQuery) {
        state.equipmentResults = [];
        renderEquipmentResults(results);
        return;
      }
      searchEquipment(state.equipmentQuery, results);
    }, 180);
  });
  lookupGroup.append(searchField, results);
  renderEquipmentResults(results);
  container.append(lookupGroup);

  const bookmarksGroup = createElement('div', 'field-group');
  bookmarksGroup.append(createElement('h3', null, 'Your bookmarks'));
  const bookmarksList = createElement('div', 'equipment-results');
  renderBookmarkedEquipment(bookmarksList);
  bookmarksGroup.append(bookmarksList);
  container.append(bookmarksGroup);

  return container;
}

function renderThreatRow(threat, index, total) {
  const row = document.createElement('tr');

  const nameCell = document.createElement('td');
  const nameInput = editable(document.createElement('input'));
  nameInput.type = 'text';
  nameInput.value = threat.name;
  bindDebouncedCommit(nameInput, `threat:${threat.id}:name`, (value) => {
    if (!value.trim()) return;
    patchThreat(threat, { name: value.trim() });
  });
  nameCell.append(nameInput);
  row.append(nameCell);

  row.append(
    renderThreatSymbolCell(threat, {
      createElement,
      disabled: !(can('analyst') && canEditStudy()),
      onChange: (sidc) => patchThreat(threat, { sidc }),
      onError: (error) => showError(elements.worksheet3, error.message),
    }),
  );

  const echelonCell = document.createElement('td');
  const echelonSelect = editable(document.createElement('select'));
  const blankOption = document.createElement('option');
  blankOption.value = '';
  blankOption.textContent = '—';
  echelonSelect.append(blankOption);
  ECHELONS.forEach((echelon) => {
    const option = document.createElement('option');
    option.value = echelon;
    option.textContent = echelon[0].toUpperCase() + echelon.slice(1);
    if (threat.echelon === echelon) option.selected = true;
    echelonSelect.append(option);
  });
  echelonSelect.addEventListener('change', () => {
    patchThreat(threat, { echelon: echelonSelect.value || null });
  });
  echelonCell.append(echelonSelect);
  row.append(echelonCell);

  const roleCell = document.createElement('td');
  const roleInput = editable(document.createElement('input'));
  roleInput.type = 'text';
  roleInput.value = threat.role || '';
  roleInput.placeholder = 'Role…';
  bindDebouncedCommit(roleInput, `threat:${threat.id}:role`, (value) => {
    patchThreat(threat, { role: value });
  });
  roleCell.append(roleInput);
  row.append(roleCell);

  const equipmentCell = document.createElement('td');
  if (threat.equipment_identifier) {
    const link = document.createElement('a');
    link.href = `/equipment/?q=${encodeURIComponent(threat.name)}#card=${encodeURIComponent(threat.equipment_identifier)}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'View card';
    equipmentCell.append(link);
  } else {
    equipmentCell.append('—');
  }
  row.append(equipmentCell);

  const hvtCell = document.createElement('td');
  hvtCell.className = 'hvt-cell';
  const hvtInput = document.createElement('input');
  hvtInput.type = 'checkbox';
  hvtInput.checked = Boolean(threat.hvt);
  editable(hvtInput);
  hvtInput.addEventListener('change', async () => {
    await patchThreat(threat, { hvt: hvtInput.checked });
    renderHvtList();
  });
  hvtCell.append(hvtInput);
  row.append(hvtCell);

  // HPT (high-payoff target): an HVT the collection/targeting plan can
  // actually act on. Distinct checkbox — a threat can be one, the other,
  // both or neither.
  const hptCell = document.createElement('td');
  hptCell.className = 'hvt-cell';
  const hptInput = document.createElement('input');
  hptInput.type = 'checkbox';
  hptInput.checked = Boolean(threat.hpt);
  editable(hptInput);
  hptInput.addEventListener('change', async () => {
    await patchThreat(threat, { hpt: hptInput.checked });
    renderHvtList();
  });
  hptCell.append(hptInput);
  row.append(hptCell);

  const notesCell = document.createElement('td');
  const notesArea = editable(document.createElement('textarea'));
  notesArea.rows = 2;
  notesArea.value = threat.notes || '';
  const notesPrintCopy = createElement('div', 'print-copy', notesArea.value || '—');
  notesArea.addEventListener('input', () => {
    notesPrintCopy.textContent = notesArea.value || '—';
  });
  bindDebouncedCommit(notesArea, `threat:${threat.id}:notes`, (value) => {
    patchThreat(threat, { notes: value });
  });
  notesCell.append(notesArea, notesPrintCopy);
  row.append(notesCell);

  const actionsCell = document.createElement('td');
  actionsCell.append(
    renderReorderButtons(
      'threats',
      threat,
      index,
      total,
      elements.worksheet3,
      renderStep3Worksheet,
    ),
  );
  const deleteButton = editable(createElement('button', 'icon-button danger', 'Delete'));
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteThreat(threat));
  actionsCell.append(deleteButton);
  row.append(actionsCell);

  return row;
}

function renderTargetList(selector, predicate) {
  const list = elements.worksheet3.querySelector(selector);
  if (!list) return;
  const matches = state.study.threats.filter(predicate);
  list.replaceChildren();
  if (!matches.length) {
    list.append(createElement('li', 'panel-note', 'None designated yet.'));
    return;
  }
  matches.forEach((threat) => {
    list.append(
      createElement('li', null, `${threat.name}${threat.role ? ` — ${threat.role}` : ''}`),
    );
  });
}

function renderHvtList() {
  renderTargetList('.hvt-list', (threat) => threat.hvt);
  renderTargetList('.hpt-list', (threat) => threat.hpt);
}

function renderStep3Worksheet() {
  const container = elements.worksheet3;
  container.replaceChildren();
  if (!state.study) return;
  container.append(createElement('h3', null, '3 · Evaluate the threat'));

  const tableSection = createElement('section', 'worksheet-block');
  tableSection.append(createElement('h4', null, 'Order of battle'));
  const table = document.createElement('table');
  table.className = 'data-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Name', 'Symbol', 'Echelon', 'Role', 'Equipment', 'HVT', 'HPT', 'Notes', ''].forEach((label) => {
    headRow.append(createElement('th', null, label));
  });
  head.append(headRow);
  table.append(head);
  const body = document.createElement('tbody');
  if (!state.study.threats.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 9;
    cell.className = 'panel-note';
    cell.textContent = 'No threats recorded yet.';
    row.append(cell);
    body.append(row);
  } else {
    state.study.threats.forEach((threat, index, all) =>
      body.append(renderThreatRow(threat, index, all.length)),
    );
  }
  table.append(body);
  tableSection.append(table);
  container.append(tableSection);

  const hvtSection = createElement('section', 'worksheet-block');
  hvtSection.append(createElement('h4', null, 'High-value targets'));
  hvtSection.append(createElement('ol', 'hvt-list'));
  container.append(hvtSection);

  const hptSection = createElement('section', 'worksheet-block');
  hptSection.append(createElement('h4', null, 'High-payoff targets'));
  hptSection.append(createElement('ol', 'hpt-list'));
  container.append(hptSection);

  renderHvtList();
}

// --- Step 4: threat courses of action ---------------------------------------

async function patchCoa(coa, body) {
  try {
    const updated = await requestJson(`${API}/studies/${coa.study_id}/coas/${coa.id}`, {
      method: 'PATCH',
      body,
    });
    Object.assign(coa, updated);
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

function selectCoa(id) {
  state.selectedCoaId = id;
  mapToolsController?.refresh();
  syncMapFeatures();
  renderToolPanel();
  renderStep4Worksheet();
}

async function createCoa(kind) {
  if (!(can('analyst') && canEditStudy())) return;
  const defaultName = kind === 'most-likely' ? 'Most likely COA' : 'Most dangerous COA';
  const name = await askText('COA name', defaultName, 'Create');
  if (!name) return;
  try {
    const coa = await requestJson(`${API}/studies/${state.studyId}/coas`, {
      method: 'POST',
      body: { name, kind },
    });
    state.study.coas.push(coa);
    renderStep4Worksheet();
    renderToolPanel();
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

async function deleteCoa(coa) {
  if (!(can('analyst') && canEditStudy())) return;
  if (!(await askConfirm(`Delete COA "${coa.name}"? Its events are removed too.`))) return;
  try {
    await requestJson(`${API}/studies/${coa.study_id}/coas/${coa.id}`, { method: 'DELETE' });
    state.study.coas = state.study.coas.filter((entry) => String(entry.id) !== String(coa.id));
    state.study.events = state.study.events.filter(
      (event) => String(event.coa_id) !== String(coa.id),
    );
    if (String(state.selectedCoaId) === String(coa.id)) {
      state.selectedCoaId = null;
      mapToolsController?.refresh();
    }
    syncMapFeatures();
    renderStep4Worksheet();
    renderToolPanel();
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

function renderCoaCard(coa, index, total) {
  const card = createElement('article', 'coa-card');
  const isSelected = String(coa.id) === String(state.selectedCoaId);
  if (isSelected) card.classList.add('active');

  const header = createElement('div', 'coa-card-header');
  header.append(
    createElement(
      'span',
      `coa-kind coa-kind-${coa.kind}`,
      coa.kind === 'most-likely' ? 'Most likely' : 'Most dangerous',
    ),
  );
  header.append(
    renderReorderButtons('coas', coa, index, total, elements.worksheet4, renderStep4Worksheet),
  );
  const selectButton = createElement('button', 'icon-button', isSelected ? 'Deselect' : 'Select');
  selectButton.type = 'button';
  selectButton.addEventListener('click', () => selectCoa(isSelected ? null : coa.id));
  const deleteButton = editable(createElement('button', 'icon-button danger', 'Delete'));
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteCoa(coa));
  header.append(selectButton, deleteButton);
  card.append(header);

  const nameInput = editable(document.createElement('input'));
  nameInput.type = 'text';
  nameInput.className = 'coa-name-input';
  nameInput.value = coa.name;
  bindDebouncedCommit(nameInput, `coa:${coa.id}:name`, (value) => {
    if (!value.trim()) return;
    patchCoa(coa, { name: value.trim() });
  });
  card.append(nameInput);

  card.append(createElement('label', 'field-label', 'Narrative'));
  const narrativeArea = editable(document.createElement('textarea'));
  narrativeArea.rows = 5;
  narrativeArea.value = coa.narrative || '';
  narrativeArea.placeholder = 'Scheme of maneuver, objectives, timing…';
  const printCopy = createElement('div', 'print-copy', narrativeArea.value || '—');
  narrativeArea.addEventListener('input', () => {
    printCopy.textContent = narrativeArea.value || '—';
  });
  bindDebouncedCommit(narrativeArea, `coa:${coa.id}:narrative`, (value) => {
    patchCoa(coa, { narrative: value });
  });
  card.append(narrativeArea, printCopy);

  const sketchCount = state.study.features.filter(
    (feature) => feature.layer === 'coa' && String(feature.properties?.coa_id) === String(coa.id),
  ).length;
  card.append(
    createElement(
      'p',
      'tool-hint',
      `${sketchCount} sketch feature${sketchCount === 1 ? '' : 's'}.`,
    ),
  );

  return card;
}

function eventGroups() {
  const groups = new Map();
  state.study.events.forEach((event) => {
    const key = `${event.indicator}::${event.nai_feature_id || ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        indicator: event.indicator,
        naiFeatureId: event.nai_feature_id || null,
        events: new Map(),
      });
    }
    groups.get(key).events.set(String(event.coa_id), event);
  });
  return [...groups.values()];
}

/** Cells in flight, so a second click cannot create a duplicate matrix cell. */
const pendingEventCells = new Set();

async function cycleEventStatus(group, coa, event) {
  if (!(can('analyst') && canEditStudy())) return;
  const cellKey = `${group.indicator}|${group.naiFeatureId ?? ''}|${coa.id}`;
  if (pendingEventCells.has(cellKey)) return;
  pendingEventCells.add(cellKey);
  try {
    if (!event) {
      const created = await requestJson(`${API}/studies/${state.studyId}/events`, {
        method: 'POST',
        body: {
          coa_id: coa.id,
          nai_feature_id: group.naiFeatureId,
          indicator: group.indicator,
          observed_status: 'expected',
        },
      });
      state.study.events.push(created);
    } else {
      const nextIndex = (EVENT_STATUSES.indexOf(event.observed_status) + 1) % EVENT_STATUSES.length;
      const updated = await requestJson(`${API}/studies/${event.study_id}/events/${event.id}`, {
        method: 'PATCH',
        body: { observed_status: EVENT_STATUSES[nextIndex] },
      });
      Object.assign(event, updated);
    }
    renderStep4Worksheet();
  } catch (error) {
    showError(elements.worksheet4, error.message);
  } finally {
    pendingEventCells.delete(cellKey);
  }
}

async function addEventRow(indicator, naiFeatureId) {
  if (!(can('analyst') && canEditStudy())) return;
  const coa = state.selectedCoaId
    ? state.study.coas.find((entry) => String(entry.id) === String(state.selectedCoaId))
    : state.study.coas[0];
  if (!coa) return;
  try {
    const event = await requestJson(`${API}/studies/${state.studyId}/events`, {
      method: 'POST',
      body: {
        coa_id: coa.id,
        nai_feature_id: naiFeatureId,
        indicator,
        observed_status: 'expected',
      },
    });
    state.study.events.push(event);
    renderStep4Worksheet();
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

async function deleteEventGroup(group) {
  if (!(can('analyst') && canEditStudy())) return;
  if (!(await askConfirm(`Delete indicator "${group.indicator}"?`))) return;
  const events = [...group.events.values()];
  try {
    await Promise.all(
      events.map((event) =>
        requestJson(`${API}/studies/${event.study_id}/events/${event.id}`, { method: 'DELETE' }),
      ),
    );
    const ids = new Set(events.map((event) => String(event.id)));
    state.study.events = state.study.events.filter((event) => !ids.has(String(event.id)));
    renderStep4Worksheet();
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

function renderEventRow(group, coas) {
  const row = document.createElement('tr');
  row.append(createElement('td', null, group.indicator));
  const naiFeature = group.naiFeatureId
    ? state.study.features.find((feature) => String(feature.id) === String(group.naiFeatureId))
    : null;
  row.append(createElement('td', null, naiFeature ? naiFeature.label : '—'));
  coas.forEach((coa) => {
    const cell = document.createElement('td');
    const event = group.events.get(String(coa.id));
    const button = editable(
      createElement(
        'button',
        `status-cell status-${event ? event.observed_status : 'none'}`,
        event ? EVENT_STATUS_LABELS[event.observed_status] : '+',
      ),
      // An empty cell's "+" is purely an add action (hide it); a populated
      // cell's label is the observed status itself, so it stays visible,
      // just not clickable.
      { hide: !event },
    );
    button.type = 'button';
    button.addEventListener('click', () => cycleEventStatus(group, coa, event));
    cell.append(button);
    if (event) cell.append(renderEventTimeChip(event));
    row.append(cell);
  });
  const actionsCell = document.createElement('td');
  const deleteButton = editable(createElement('button', 'icon-button danger', 'Delete row'));
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteEventGroup(group));
  actionsCell.append(deleteButton);
  row.append(actionsCell);
  return row;
}

function renderEventMatrix(container) {
  const coas = state.study.coas;
  container.replaceChildren();
  if (!coas.length) {
    container.append(
      createElement('p', 'panel-note', 'Create a COA before building the event matrix.'),
    );
    return;
  }

  const table = document.createElement('table');
  table.className = 'data-table event-matrix';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.append(createElement('th', null, 'Indicator'), createElement('th', null, 'NAI'));
  coas.forEach((coa) => headRow.append(createElement('th', null, coa.name)));
  headRow.append(createElement('th', null, ''));
  head.append(headRow);
  table.append(head);

  const body = document.createElement('tbody');
  const groups = sortEventGroups(eventGroups(), state.study.study.h_hour);
  if (!groups.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = coas.length + 3;
    cell.className = 'panel-note';
    cell.textContent = 'No indicators recorded yet.';
    row.append(cell);
    body.append(row);
  } else {
    groups.forEach((group) => body.append(renderEventRow(group, coas)));
  }
  table.append(body);

  const foot = document.createElement('tfoot');
  const tallyRow = document.createElement('tr');
  tallyRow.append(createElement('th', null, 'Tally'), createElement('td', null, ''));
  coas.forEach((coa) => {
    const events = state.study.events.filter((event) => String(event.coa_id) === String(coa.id));
    const observed = events.filter((event) => event.observed_status === 'observed').length;
    const notObserved = events.filter((event) => event.observed_status === 'not-observed').length;
    const expected = events.filter((event) => event.observed_status === 'expected').length;
    let verdict = 'Inconclusive';
    if (observed > notObserved) verdict = 'Trending confirmed';
    else if (notObserved > observed) verdict = 'Trending denied';
    const cell = document.createElement('td');
    cell.className = 'tally-cell';
    // The flex layout lives on this inner wrapper, not the <td> itself:
    // a flex-display table cell confuses Chromium's print pagination once
    // the row lands on a page break, collapsing every column into one.
    const inner = createElement('div', 'tally-cell-inner');
    inner.append(
      createElement(
        'span',
        null,
        `Observed ${observed} · Not observed ${notObserved} · Pending ${expected}`,
      ),
      createElement('strong', null, verdict),
    );
    cell.append(inner);
    tallyRow.append(cell);
  });
  tallyRow.append(createElement('td', null, ''));
  foot.append(tallyRow);

  const addRow = document.createElement('tr');
  addRow.className = 'add-row';
  const indicatorCell = document.createElement('td');
  const indicatorInput = document.createElement('input');
  indicatorInput.type = 'text';
  indicatorInput.placeholder = 'Indicator…';
  indicatorCell.append(indicatorInput);
  const naiCell = document.createElement('td');
  const naiSelect = document.createElement('select');
  const noneOption = document.createElement('option');
  noneOption.value = '';
  noneOption.textContent = 'No NAI';
  naiSelect.append(noneOption);
  state.study.features
    .filter((feature) => feature.layer === 'nai')
    .forEach((feature) => {
      const option = document.createElement('option');
      option.value = String(feature.id);
      option.textContent = feature.label;
      naiSelect.append(option);
    });
  naiCell.append(naiSelect);
  const addCell = document.createElement('td');
  addCell.colSpan = coas.length + 1;
  const addButton = createElement('button', 'chip-button', '+ Add row');
  addButton.type = 'button';
  addButton.addEventListener('click', () => {
    const indicator = indicatorInput.value.trim();
    if (!indicator) return;
    addEventRow(indicator, naiSelect.value ? Number(naiSelect.value) : null);
    indicatorInput.value = '';
  });
  addCell.append(addButton);
  addRow.append(indicatorCell, naiCell, addCell);
  editable(addRow, { hide: true });
  foot.append(addRow);
  table.append(foot);

  container.append(table);
}

function renderStep4Tools() {
  const container = createElement('div', 'tool-section');

  const coaGroup = createElement('div', 'field-group');
  coaGroup.append(createElement('h3', null, 'Courses of action'));
  const likelyButton = editable(createElement('button', 'chip-button', '+ Most likely COA'));
  likelyButton.type = 'button';
  likelyButton.addEventListener('click', () => createCoa('most-likely'));
  const dangerousButton = editable(createElement('button', 'chip-button', '+ Most dangerous COA'));
  dangerousButton.type = 'button';
  dangerousButton.addEventListener('click', () => createCoa('most-dangerous'));
  coaGroup.append(likelyButton, dangerousButton);
  container.append(coaGroup);

  const sketchGroup = createElement('div', 'field-group');
  sketchGroup.append(createElement('h3', null, 'COA sketch'));
  if (!state.selectedCoaId) {
    sketchGroup.append(
      createElement('p', 'tool-hint', 'Select a COA in the worksheet to sketch onto it.'),
    );
  }
  sketchGroup.append(renderDrawButtons('coa'));
  container.append(sketchGroup);

  const naiGroup = createElement('div', 'field-group');
  naiGroup.append(createElement('h3', null, 'Named / target areas of interest'));
  const naiRow = createElement('div', 'oakoc-tool-row');
  naiRow.append(createElement('span', 'oakoc-tool-label', 'NAI'), renderDrawButtons('nai'));
  const taiRow = createElement('div', 'oakoc-tool-row');
  taiRow.append(createElement('span', 'oakoc-tool-label', 'TAI'), renderDrawButtons('tai'));
  naiGroup.append(naiRow, taiRow);
  container.append(naiGroup);

  container.append(
    renderSitempTools({ threats: state.study.threats, canEdit: can('analyst') && canEditStudy() }),
  );

  return container;
}

function renderStep4Worksheet() {
  const container = elements.worksheet4;
  container.replaceChildren();
  if (!state.study) return;
  container.append(createElement('h3', null, '4 · Determine threat courses of action'));

  container.append(
    renderHHourField(state.study.study, { canEdit: can('analyst') && canEditStudy() }),
  );

  const coaSection = createElement('section', 'worksheet-block');
  coaSection.append(createElement('h4', null, 'Courses of action'));
  if (!state.study.coas.length) {
    coaSection.append(createElement('p', 'panel-note', 'No COAs created yet.'));
  } else {
    const cards = createElement('div', 'coa-cards');
    state.study.coas.forEach((coa, index, all) =>
      cards.append(renderCoaCard(coa, index, all.length)),
    );
    coaSection.append(cards);
  }
  container.append(coaSection);

  const naiSection = createElement('section', 'worksheet-block');
  naiSection.append(createElement('h4', null, 'NAI / TAI'));
  ['nai', 'tai'].forEach((layer) => {
    const features = state.study.features.filter((feature) => feature.layer === layer);
    const group = createElement('div', 'oakoc-group');
    group.append(createElement('h5', null, `${FEATURE_LAYERS[layer].label} (${features.length})`));
    if (features.length) {
      const list = createElement('ul', 'feature-list');
      features.forEach((feature) => list.append(renderFeatureRow(feature)));
      group.append(list);
    } else {
      group.append(createElement('p', 'panel-note', 'None drawn yet.'));
    }
    naiSection.append(group);
  });
  container.append(naiSection);

  container.append(
    renderSitempWorksheet({
      threats: state.study.threats,
      canEdit: can('analyst') && canEditStudy(),
    }),
  );

  container.append(
    renderGraphicsAndRingsList({
      createElement,
      requestJson,
      showError,
      askText,
      askConfirm,
      can: can('analyst') && canEditStudy(),
      mapController,
      renderRowMenu,
      features: state.study.features,
      onChanged: (deletedId) => {
        if (deletedId !== undefined) {
          state.study.features = state.study.features.filter((feature) => feature.id !== deletedId);
        }
        syncMapFeatures();
        renderStep4Worksheet();
      },
    }),
  );

  const matrixSection = createElement('section', 'worksheet-block');
  matrixSection.append(createElement('h4', null, 'Event matrix'));
  const matrixContainer = createElement('div', 'event-matrix-wrap');
  matrixSection.append(matrixContainer);
  container.append(matrixSection);
  renderEventMatrix(matrixContainer);

  container.append(renderPhasesSection(can('analyst') && canEditStudy()));
  container.append(renderDecisionPointsSection(can('analyst') && canEditStudy()));
  container.append(renderTimelineStripSection());
}

// --- Tool panel dispatch -----------------------------------------------------

function renderToolPanel() {
  elements.toolPanel.replaceChildren();
  if (!state.study) {
    elements.toolPanel.append(
      createElement('p', 'panel-note', 'Select or create a study to begin.'),
    );
    return;
  }
  const renderers = {
    1: renderStep1Tools,
    2: renderStep2Tools,
    3: renderStep3Tools,
    4: renderStep4Tools,
  };
  elements.toolPanel.append(renderers[state.step]());
}

// --- Custom layers -------------------------------------------------------------

/** Distinct, print-safe colours offered to new layers in turn. */
const LAYER_COLORS = ['#d35400', '#8e44ad', '#16a085', '#c0392b', '#2c3e50', '#b7950b'];
const POINT_ID_PREFIX = 'point-';

function pointMapId(point) {
  return `${POINT_ID_PREFIX}${point.id}`;
}

function findPoint(mapId) {
  if (!String(mapId).startsWith(POINT_ID_PREFIX)) return null;
  const id = Number(String(mapId).slice(POINT_ID_PREFIX.length));
  return state.study?.points.find((point) => point.id === id) ?? null;
}

function findLayer(id) {
  return state.study?.layers.find((layer) => layer.id === id) ?? null;
}

/** Points of the visible custom layers, as map features coloured by layer. */
function customLayerFeatures() {
  if (!state.study) return [];
  const visible = new Map(
    state.study.layers.filter((layer) => layer.visible).map((layer) => [layer.id, layer]),
  );
  return state.study.points
    .filter((point) => visible.has(point.layer_id))
    .map((point) => ({
      id: pointMapId(point),
      layer: 'custom',
      kind: 'point',
      label: point.name,
      geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
      properties: { color: visible.get(point.layer_id).color },
    }));
}

/** Re-render everything that shows custom layers. */
function refreshCustomLayers() {
  syncMapFeatures();
  renderCustomLayers();
  renderLayersPrint();
}

async function createLayer() {
  if (!(can('analyst') && canEditStudy())) return null;
  const name = await askText('Name of the new layer', '', 'Create');
  if (!name) return null;
  const color = LAYER_COLORS[state.study.layers.length % LAYER_COLORS.length];
  try {
    const layer = await requestJson(`${API}/studies/${state.studyId}/layers`, {
      method: 'POST',
      body: { name, color },
    });
    state.study.layers.push(layer);
    state.activeLayerId = layer.id;
    refreshCustomLayers();
    return layer;
  } catch (error) {
    showError(elements.customLayers, error.message);
    return null;
  }
}

async function updateLayer(layer, patch) {
  if (!(can('analyst') && canEditStudy())) return;
  try {
    Object.assign(
      layer,
      await requestJson(`${API}/studies/${layer.study_id}/layers/${layer.id}`, {
        method: 'PATCH',
        body: patch,
      }),
    );
    refreshCustomLayers();
  } catch (error) {
    showError(elements.customLayers, error.message);
  }
}

async function renameLayer(layer) {
  const name = await askText('Rename layer', layer.name);
  if (name && name !== layer.name) updateLayer(layer, { name });
}

async function deleteLayer(layer) {
  if (!(can('analyst') && canEditStudy())) return;
  const count = state.study.points.filter((point) => point.layer_id === layer.id).length;
  const message = count
    ? `Delete layer "${layer.name}" and its ${count} point${count === 1 ? '' : 's'}?`
    : `Delete layer "${layer.name}"?`;
  if (!(await askConfirm(message))) return;
  try {
    await requestJson(`${API}/studies/${layer.study_id}/layers/${layer.id}`, { method: 'DELETE' });
    state.study.layers = state.study.layers.filter((entry) => entry.id !== layer.id);
    state.study.points = state.study.points.filter((point) => point.layer_id !== layer.id);
    if (state.activeLayerId === layer.id) state.activeLayerId = null;
    if (state.tool?.type === 'point-add' && state.tool.layerId === layer.id) cancelActiveTool();
    refreshCustomLayers();
  } catch (error) {
    showError(elements.customLayers, error.message);
  }
}

/**
 * Ask for a point's name, position and note. `initial` fills the fields;
 * an unreadable position asks again, keeping what was typed. Resolves to
 * `{ name, note, lon, lat }`, or null when cancelled.
 */
async function askPoint(title, initial) {
  let values = {
    name: initial.name ?? '',
    position: formatMgrs(initial.lon, initial.lat),
    note: initial.note ?? '',
  };
  let message = title;
  for (;;) {
    const answer = await askFields(message, [
      { id: 'name', label: 'Name', value: values.name, placeholder: 'e.g. OP 1' },
      { id: 'position', label: 'Position (MGRS, UTM or DD)', value: values.position },
      { id: 'note', label: 'Note', value: values.note, multiline: true },
    ]);
    if (!answer) return null;
    values = answer;
    const parsed = parseCoordinate(answer.position);
    if (!answer.name) message = `${title} — a name is required.`;
    else if (!parsed) message = `${title} — could not read the position "${answer.position}".`;
    else return { name: answer.name, note: answer.note || null, lon: parsed.lon, lat: parsed.lat };
  }
}

async function createPoint(layerId, values) {
  if (!(can('analyst') && canEditStudy())) return null;
  try {
    const point = await requestJson(`${API}/studies/${state.studyId}/points`, {
      method: 'POST',
      body: { layer_id: layerId, ...values },
    });
    state.study.points.push(point);
    const layer = findLayer(layerId);
    // A point added to a hidden layer should not silently vanish.
    if (layer && !layer.visible) await updateLayer(layer, { visible: true });
    state.activeLayerId = layerId;
    refreshCustomLayers();
    return point;
  } catch (error) {
    showError(elements.customLayers, error.message);
    return null;
  }
}

/** Ask for name and note of a point at a clicked position, then save it. */
async function addPointAt(layerId, lon, lat) {
  const layer = findLayer(layerId);
  if (!layer) return;
  const values = await askPoint(`New point in "${layer.name}"`, { lon, lat });
  if (values) await createPoint(layerId, values);
}

/** Add to a layer chosen from the context menu; "New layer…" creates one first. */
async function addPointToNewLayer(lon, lat) {
  const layer = await createLayer();
  if (layer) await addPointAt(layer.id, lon, lat);
}

async function updatePoint(point, patch) {
  if (!(can('analyst') && canEditStudy())) return;
  try {
    Object.assign(
      point,
      await requestJson(`${API}/studies/${point.study_id}/points/${point.id}`, {
        method: 'PATCH',
        body: patch,
      }),
    );
    refreshCustomLayers();
  } catch (error) {
    showError(elements.customLayers, error.message);
  }
}

async function editPoint(point) {
  const values = await askPoint('Edit point', point);
  if (values) await updatePoint(point, values);
}

async function deletePoint(point) {
  if (!(can('analyst') && canEditStudy())) return;
  if (!(await askConfirm(`Delete point "${point.name}"?`))) return;
  try {
    await requestJson(`${API}/studies/${point.study_id}/points/${point.id}`, { method: 'DELETE' });
    state.study.points = state.study.points.filter((entry) => entry.id !== point.id);
    refreshCustomLayers();
  } catch (error) {
    showError(elements.customLayers, error.message);
  }
}

/** Drag one point to a new position; saved on release, then the mode ends. */
function armPointMove(point) {
  if (!(can('analyst') && canEditStudy())) return;
  cancelActiveTool();
  state.tool = { type: 'point-move', pointId: point.id };
  mapController.startModify(pointMapId(point));
  renderMapHint(`Drag "${point.name}" to its new position. Press Escape to cancel.`);
}

/** Keep adding points to `layerId` with each map click until Escape. */
function armPointAdd(layerId) {
  if (!(can('analyst') && canEditStudy())) return;
  const armed = state.tool?.type === 'point-add' && state.tool.layerId === layerId;
  cancelActiveTool();
  if (armed) return;
  state.tool = { type: 'point-add', layerId };
  renderMapHint(
    `Click the map to add points to "${findLayer(layerId).name}". Press Escape when done.`,
  );
  renderCustomLayers();
}

function centreOnPoint(point) {
  jumpToCoordinate(point.lon, point.lat);
  mapController.selectFeature(pointMapId(point));
}

function renderCustomLayers() {
  const container = elements.customLayers;
  container.hidden = !state.study;
  container.replaceChildren();
  if (!state.study) return;

  const header = createElement('div', 'custom-layers-header');
  header.append(createElement('h3', null, 'Custom layers'));
  const create = editable(createElement('button', 'text-button', '+ New layer'));
  create.type = 'button';
  create.addEventListener('click', createLayer);
  header.append(create);
  container.append(header);

  const { layers, points } = state.study;
  if (!layers.length) {
    container.append(
      createElement(
        'p',
        'tool-hint',
        'Your own named layers of points (observation posts, contacts, landmarks…), each point with a name and a note. Create a layer, then add points by MGRS or by clicking the map; or right-click the map: Add point here.',
      ),
    );
    return;
  }

  const list = createElement('ul', 'custom-layer-list');
  for (const layer of layers) {
    const layerPoints = points.filter((point) => point.layer_id === layer.id);
    const active = state.activeLayerId === layer.id;
    const item = createElement('li', 'custom-layer');
    item.classList.toggle('active', active);

    const row = createElement('div', 'custom-layer-row');
    const visible = document.createElement('input');
    visible.type = 'checkbox';
    visible.checked = layer.visible;
    visible.title = 'Show on the map';
    visible.setAttribute('aria-label', `Show ${layer.name} on the map`);
    editable(visible);
    visible.addEventListener('change', () => updateLayer(layer, { visible: visible.checked }));
    const color = document.createElement('input');
    color.type = 'color';
    color.value = layer.color;
    color.title = 'Layer colour';
    color.setAttribute('aria-label', `Colour of ${layer.name}`);
    editable(color);
    color.addEventListener('change', () => updateLayer(layer, { color: color.value }));
    const name = createElement('button', 'custom-layer-name', layer.name);
    name.type = 'button';
    name.setAttribute('aria-expanded', String(active));
    name.append(createElement('small', null, ` ${layerPoints.length}`));
    name.addEventListener('click', () => {
      state.activeLayerId = active ? null : layer.id;
      renderCustomLayers();
    });
    const menu = renderRowMenu([
      { label: 'Rename', action: () => renameLayer(layer) },
      { label: 'Delete', action: () => deleteLayer(layer) },
    ]);
    row.append(visible, color, name);
    if (menu) row.append(menu);
    item.append(row);
    if (active) item.append(renderLayerEditor(layer, layerPoints));
    list.append(item);
  }
  container.append(list);
}

function renderLayerEditor(layer, layerPoints) {
  const editor = createElement('div', 'custom-layer-editor');

  const form = createElement('div', 'custom-point-form');
  const input = (placeholder, label) => {
    const control = document.createElement('input');
    control.type = 'text';
    control.placeholder = placeholder;
    control.setAttribute('aria-label', label);
    return control;
  };
  const nameInput = editable(input('Name', 'Point name'), { hide: true });
  const positionInput = editable(input('MGRS, UTM or DD', 'Point position'), { hide: true });
  const noteInput = editable(input('Note (optional)', 'Point note'), { hide: true });
  const add = editable(createElement('button', 'chip-button', 'Add'));
  add.type = 'button';
  const error = createElement('p', 'inline-error');
  error.hidden = true;
  const submit = async () => {
    const parsed = parseCoordinate(positionInput.value.trim());
    const problem = !nameInput.value.trim()
      ? 'A name is required.'
      : !parsed
        ? 'Could not read that position.'
        : null;
    error.hidden = !problem;
    if (problem) {
      error.textContent = problem;
      return;
    }
    const point = await createPoint(layer.id, {
      name: nameInput.value.trim(),
      note: noteInput.value.trim() || null,
      lon: parsed.lon,
      lat: parsed.lat,
    });
    if (point) centreOnPoint(point);
  };
  add.addEventListener('click', submit);
  for (const control of [nameInput, positionInput, noteInput]) {
    control.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
  }
  const armed = state.tool?.type === 'point-add' && state.tool.layerId === layer.id;
  const byClick = editable(
    createElement('button', 'chip-button', armed ? 'Stop adding' : 'Add on map'),
  );
  byClick.title = 'Each click on the map adds a point to this layer';
  byClick.type = 'button';
  byClick.setAttribute('aria-pressed', String(armed));
  byClick.addEventListener('click', () => armPointAdd(layer.id));
  form.append(nameInput, positionInput, noteInput, add);
  editor.append(form, error, byClick);

  const list = createElement('ul', 'custom-point-list');
  for (const point of layerPoints) {
    const item = createElement('li', 'custom-point');
    const primary = createElement('button', 'custom-point-text');
    primary.type = 'button';
    primary.title = 'Go to this point';
    primary.append(
      createElement('strong', null, point.name),
      createElement('span', 'custom-point-position', formatMgrs(point.lon, point.lat)),
    );
    if (point.note) primary.append(createElement('span', 'custom-point-note', point.note));
    primary.addEventListener('click', () => centreOnPoint(point));
    const menu = renderRowMenu([
      { label: 'Edit', action: () => editPoint(point) },
      { label: 'Move', action: () => armPointMove(point) },
      { label: 'Delete', action: () => deletePoint(point) },
    ]);
    const row = createElement('div', 'custom-point-row');
    row.append(primary);
    if (menu) row.append(menu);
    item.append(row);
    list.append(item);
  }
  if (!layerPoints.length) {
    editor.append(createElement('p', 'tool-hint', 'No points yet.'));
  }
  editor.append(list);
  return editor;
}

/** Every custom layer with points, as a table, for print. */
function renderLayersPrint() {
  const container = elements.layersPrint;
  container.replaceChildren();
  const layers = (state.study?.layers ?? []).filter((layer) =>
    state.study.points.some((point) => point.layer_id === layer.id),
  );
  if (!layers.length) return;
  container.append(createElement('h3', null, 'Custom layers'));
  for (const layer of layers) {
    const heading = createElement('h4', null, layer.name);
    heading.style.setProperty('--chip', layer.color);
    container.append(heading);
    const table = document.createElement('table');
    table.className = 'data-table';
    const headRow = document.createElement('tr');
    for (const label of ['Name', 'MGRS', 'Note']) headRow.append(createElement('th', null, label));
    const head = document.createElement('thead');
    head.append(headRow);
    const body = document.createElement('tbody');
    for (const point of state.study.points.filter((entry) => entry.layer_id === layer.id)) {
      const row = document.createElement('tr');
      row.append(
        createElement('td', null, point.name),
        createElement('td', null, formatMgrs(point.lon, point.lat)),
        createElement('td', 'custom-point-note', point.note ?? ''),
      );
      body.append(row);
    }
    table.append(head, body);
    container.append(table);
  }
}

// --- Print -----------------------------------------------------------------

function printWorksheet() {
  window.print();
}

/**
 * Snapshot the live map into the print-only figure. Runs on `beforeprint`, so
 * Ctrl+P gets the map too, not only the Print button. The figure holds the
 * composited canvas itself (drawn immediately, nothing to decode) and a
 * caption that says what the map shows.
 */
function preparePrintMap() {
  elements.printMap.replaceChildren();
  const frame = state.study && mapController?.exportCanvas();
  if (!frame) return;
  const { canvas, attributions } = frame;
  const [lon, lat] = mapController.getCenter();
  const basemap = BASEMAPS.find((entry) => entry.id === state.basemap)?.label ?? state.basemap;
  const spec = overlaySpec();
  const overlays = [
    ...OVERLAYS.filter((overlay) => spec[overlay.id]).map((overlay) => overlay.label),
    ...weatherCaption(),
  ];
  const caption = createElement('figcaption');
  caption.append(
    createElement('strong', null, `${state.study.study.name} — ${STEP_NAMES[state.step]}`),
    createElement(
      'span',
      null,
      [
        state.study.study.classification || null,
        `Centre ${formatMgrs(lon, lat)}`,
        `Basemap: ${basemap}`,
        overlays.length ? `Overlays: ${overlays.join(', ')}` : null,
        state.grid ? 'MGRS grid' : null,
        `Printed ${formatDtg(Date.now())}`,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
  );
  if (attributions.length) {
    caption.append(createElement('small', null, attributions.join(' · ')));
  }
  elements.printMap.append(canvas, caption);
}

function clearPrintMap() {
  elements.printMap?.replaceChildren();
}

// --- Keyboard shortcuts ------------------------------------------------------

function isTypingTarget(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function handleOutsideClick(event) {
  const path = event.composedPath();
  if (
    !elements.studyMenu.hidden &&
    !path.includes(elements.studyMenu) &&
    !path.includes(elements.studyToggle)
  ) {
    closeStudyMenu();
  }
  if (
    !elements.mapPopover.hidden &&
    !path.includes(elements.mapPopover) &&
    !path.includes(elements.mapMenuToggle)
  ) {
    closeMapPopover();
  }
  if (
    !elements.infoPopover.hidden &&
    !path.includes(elements.infoPopover) &&
    !path.includes(elements.infoToggle)
  ) {
    closeInfoPopover();
  }
}

function onGlobalKeydown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (dialogNode?.open) return;
  const typing = isTypingTarget(event.target);
  if (event.key === '/' && !typing) {
    event.preventDefault();
    toggleStudyMenu(true);
    return;
  }
  if ((event.key === '[' || event.key === ']') && !typing) {
    event.preventDefault();
    toggleSheet(event.key === '[' ? 'tools' : 'worksheet');
    return;
  }
  if (['1', '2', '3', '4'].includes(event.key) && !typing) {
    const step = Number(event.key);
    if (canUseStep(step)) switchStep(step);
    return;
  }
  if (event.key === 'Escape' && !typing) {
    if (!elements.mapPopover.hidden) {
      closeMapPopover();
      elements.mapMenuToggle.focus();
      return;
    }
    if (!elements.infoPopover.hidden) {
      closeInfoPopover();
      elements.infoToggle.focus();
      return;
    }
    cancelActiveTool();
  }
}

/** Arrow-key roving within the Map popover's basemap radio group. */
function onBasemapSwitchKeydown(event) {
  if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) return;
  const options = [...elements.basemapSwitch.querySelectorAll('[role="radio"]:not(:disabled)')];
  if (!options.length) return;
  event.preventDefault();
  const index = options.indexOf(document.activeElement);
  const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
  const next = options[(index + delta + options.length) % options.length];
  next.focus();
  applyBasemap(next.dataset.basemap);
}

// --- Mount -------------------------------------------------------------------

export function mount({ root, status }) {
  root.innerHTML = template;
  state = createState();
  elements = queryElements(root);
  elements.moduleRoot = root;
  // Static markup (not re-rendered per role): gated once, here.
  editable(elements.createStudy);
  editable(elements.mapEmptyCreate);
  const { session } = state;

  buildMastheadStatus(status);
  createDialogNode(root);

  elements.printButton.addEventListener('click', printWorksheet);
  window.addEventListener('beforeprint', preparePrintMap);
  window.addEventListener('afterprint', clearPrintMap);
  elements.studyToggle.addEventListener('click', () => toggleStudyMenu());
  elements.mapMenuToggle.addEventListener('click', () => toggleMapPopover());
  elements.infoToggle.addEventListener('click', () => toggleInfoPopover());
  // Zoom +/- proxy the map's own (native OpenLayers) zoom control rather than
  // duplicating its logic, so the status bar's buttons stay in one place
  // without a second zoom code path.
  elements.zoomIn.addEventListener('click', () =>
    elements.mapTarget.querySelector('.ol-zoom-in')?.click(),
  );
  elements.zoomOut.addEventListener('click', () =>
    elements.mapTarget.querySelector('.ol-zoom-out')?.click(),
  );
  elements.mapEmptyCreate.addEventListener('click', createStudy);
  elements.createStudy.addEventListener('click', createStudy);
  elements.studySearch.addEventListener('input', () => {
    state.studyQuery = elements.studySearch.value;
    renderStudyList();
  });
  elements.studySearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeStudyMenu();
    }
  });
  document.addEventListener('click', handleOutsideClick);
  elements.stepNav.addEventListener('click', (event) => {
    const button = event.target.closest('.step-tab');
    if (!button || button.disabled) return;
    switchStep(Number(button.dataset.step));
  });
  document.addEventListener('keydown', onGlobalKeydown);
  elements.toolsToggle.addEventListener('click', () => toggleSheet('tools'));
  elements.worksheetToggle.addEventListener('click', () => toggleSheet('worksheet'));
  const narrowQuery = window.matchMedia(NARROW_QUERY);
  narrowQuery.addEventListener('change', renderSheets, { signal: session.signal });
  renderSheets();

  mapController = createMap({
    target: elements.mapTarget,
    basemapUrl: `${TERRAIN_API}/tiles/vector.pmtiles`,
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    onClick: onMapClick,
    onContextMenu: onMapContextMenu,
    onFeatureChange: onMapFeatureChange,
    onDraw: onMapDraw,
    onPointerMove: onMapPointerMove,
    onViewChange: onWeatherViewChange,
    coveredInsets,
  });
  mapController.setMgrsGrid(state.grid);
  elements.gridToggle.setAttribute('aria-pressed', String(state.grid));
  mapController.setSymbolSize(SYMBOL_SIZES[state.symbolSize]);
  elements.symbolSizeSwitch.querySelector(`input[value="${state.symbolSize}"]`).checked = true;
  elements.symbolSizeSwitch.addEventListener('change', (event) => {
    state.symbolSize = event.target.value;
    mapController.setSymbolSize(SYMBOL_SIZES[state.symbolSize]);
    saveMapView();
  });
  const teardownSitemp = initSitemp(elements.mapTarget);
  // OL's own Zoom/Attribution controls stay put and are only proxy-clicked
  // (above); its bare ScaleLine control has no fixed home of its own, so it
  // moves into the status bar and is restyled there (styles.css).
  const scaleLine = elements.mapTarget.querySelector('.ipb-scale');
  if (scaleLine) elements.statusBar.querySelector('.status-left')?.append(scaleLine);

  mapToolsController = initMapToolbar({
    root: elements.mapTools,
    mapController,
    requestJson,
    createElement,
    showError,
    can: () => can('analyst') && canEditStudy(),
    getStudy: () => state.study,
    getStudyId: () => state.studyId,
    getSelectedCoaId: () => state.selectedCoaId,
    onFeaturesChanged: (feature) => {
      syncMapFeatures();
      reRenderContainingWorksheet(feature.layer);
    },
  });

  // Restores a persisted "on" situation overlay before the Layers panel's
  // first render, so its checkbox and the map layer agree from the start.
  setSituationEnabled(state.overlays.situation);
  renderBasemapSwitch();
  renderOverlayList();
  elements.basemapSwitch.addEventListener('click', (event) => {
    const button = event.target.closest('[data-basemap]');
    if (button && !button.disabled) applyBasemap(button.dataset.basemap);
  });
  elements.basemapSwitch.addEventListener('keydown', onBasemapSwitchKeydown);
  elements.overlayList.addEventListener('change', (event) => {
    const id = event.target.dataset.overlay;
    if (!id) return;
    if (id === 'situation') {
      state.overlays.situation = event.target.checked;
      setSituationEnabled(event.target.checked);
      renderOverlayList();
      saveMapView();
      return;
    }
    if (WEATHER_BY_ID.has(id)) {
      toggleWeather(id, event.target.checked);
      return;
    }
    state.overlays[id] = event.target.checked;
    applyOverlays();
    saveMapView();
  });
  elements.overlayList.addEventListener('input', (event) => {
    if (event.target.dataset.radar !== 'frame') return;
    setRadarPlaying(false);
    showRadarFrame(Number(event.target.value));
  });
  elements.overlayList.addEventListener('click', (event) => {
    if (event.target.closest('[data-radar="play"]')) {
      setRadarPlaying(!state.weather.radar.playing);
    }
  });
  refreshWeather();
  scheduleWeatherRefresh();
  elements.gridToggle.addEventListener('click', () => {
    state.grid = !state.grid;
    elements.gridToggle.setAttribute('aria-pressed', String(state.grid));
    mapController.setMgrsGrid(state.grid);
    saveMapView();
  });

  // Activating/deactivating a scenario happens in the Exercise tab, in another render of this
  // same page (or another tab); refetch whenever this one becomes visible again so it shows up
  // without a reload.
  const onScenarioRefresh = () => {
    if (document.visibilityState === 'visible') loadScenario();
  };
  document.addEventListener('visibilitychange', onScenarioRefresh, { signal: session.signal });
  window.addEventListener('focus', onScenarioRefresh, { signal: session.signal });

  // Live updates (C2): another client's ipb mutation refetches the open
  // study, so e.g. a second analyst's edit shows up here without a reload.
  // A plain `selectStudy(state.studyId)` won't do this: it short-circuits
  // when the requested id is already the open one, which is exactly this
  // case, so this reloads the study data directly instead.
  const unsubscribeLive = subscribe((event) => event.module === 'ipb', refetchOpenStudy);

  readLocation();
  renderStepChrome();
  renderEmptyState();

  const initialStudyId = state.studyId;

  Promise.all([
    requestJson(`${TERRAIN_API}/meta`).then(
      (meta) => {
        state.terrainMeta = meta;
        // Now that attribution and local tile sources are known.
        applyBasemap(state.basemap);
      },
      (error) => {
        if (error.name === 'AbortError') throw error;
        // Non-critical: without terrain data (not built yet) studies still
        // open; the Map popover's overlays say what is missing.
      },
    ),
    loadStudies(),
    loadEquipmentBookmarks().then(() => {
      if (state.step === 3) renderToolPanel();
    }),
    loadScenario(),
  ])
    .then(() => {
      if (
        initialStudyId &&
        state.studies.some((study) => String(study.id) === String(initialStudyId))
      ) {
        return selectStudy(initialStudyId, { preserveFeature: true });
      }
      if (!state.studies.length) toggleStudyMenu(true);
      return null;
    })
    .catch((error) => {
      if (error.name === 'AbortError') return;
      showError(elements.toolPanel, error.message);
    });

  return () => {
    state.timers.forEach((id) => window.clearTimeout(id));
    state.timers.clear();
    window.clearTimeout(toastTimer);
    window.clearTimeout(pointerElevationTimer);
    pointerElevationController?.abort();
    document.removeEventListener('keydown', onGlobalKeydown);
    document.removeEventListener('click', handleOutsideClick);
    window.removeEventListener('beforeprint', preparePrintMap);
    window.removeEventListener('afterprint', clearPrintMap);
    closeContextMenu();
    closeRowMenu();
    elements.moduleRoot?.querySelector(':scope > .ipb-toast')?.remove();
    destroyTimeline();
    destroySituation();
    unsubscribeLive();
    teardownSitemp();
    session.abort();
    mapToolsController?.destroy();
    mapToolsController = null;
    mapController?.destroy();
    mapController = null;
    dialogNode = null;
    root.replaceChildren();
  };
}

// --- Shared internals for sibling IPB client modules -------------------------
//
// `sitemp.js`, `timeline.js`, `situation.js` and `threatSymbols.js` (wave 2's
// threat/SITEMP/time/situation features) and IpbClientA's own new files need
// a handful of this module's internals — the live-bound `state`/`elements`/
// `mapController` (reassigned in `mount()`, so a plain re-export keeps every
// importer in sync with the current instance) and its shared DOM/request/
// dialog helpers. Exporting them here, in one place, is the alternative to
// duplicating `createElement`/`requestJson`/the dialog machinery in every
// new file, or threading them through as parameters everywhere.
export {
  state,
  elements,
  mapController,
  API,
  EXERCISE_API,
  canEditStudy,
  createElement,
  editable,
  renderRowMenu,
  showError,
  askText,
  askConfirm,
  askFields,
  requestJson,
  bindDebouncedCommit,
  renderReorderButtons,
  syncMapFeatures,
  renderStep3Worksheet,
  renderStep4Worksheet,
  renderToolPanel,
  renderStep1Worksheet,
  polygonAreaSquareKm,
  jumpToCoordinate,
  renderMapHint,
  cancelActiveTool,
  showToast,
  deleteFeature,
  armFeatureModify,
  renderOverlayList,
  applyOverlays,
  saveMapView,
};
