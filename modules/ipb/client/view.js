import './styles.css';
import './staff.css';
import template from './view.html?raw';
import { formatDtg } from '../../../src/dtg.js';
import { formatMetres, formatMgrs } from '../../../src/geo.js';
import { clientId, subscribe } from '../../../src/live.js';
import { SYMBOL_SIZES, createMap } from '../../../src/map.js';
import { canEditClient, renderCellBadge, renderReleaseControl } from '../../../src/release.js';
import {
  can,
  cellLabel,
  currentUser,
  handleUnauthorized,
  isWhite,
  sessionMode,
} from '../../../src/session.js';
import { applyClassificationBanner } from './exchange.js';
import { initMapToolbar } from './mapTools.js';
import { areaFeatures } from './areas.js';
import { filterByCoa, initSitemp, refreshOrbatLinks } from './sitemp.js';
import { destroySituation, renderSituationOverlayRow, setSituationEnabled } from './situation.js';
import { destroyTimeline } from './timeline.js';
import { customLayerFeatures, renderCustomLayers, renderLayersPrint } from './customLayers.js';
import {
  armFeatureModify,
  closeContextMenu,
  closeRowMenu,
  onMapClick,
  onMapContextMenu,
  onMapDraw,
  onMapFeatureChange,
  onMapPointerMove,
  pointerElevationController,
  pointerElevationTimer,
  renderRowMenu,
} from './menus.js';
import {
  localDateInputValue,
  renderStep1Worksheet,
  replaceForecastBlock,
  siteKey,
  weatherPoint,
} from './step1.js';
import { keyTerrainLabel, renderStep2Worksheet } from './step2.js';
import { loadEquipmentBookmarks, renderReorderButtons, renderStep3Worksheet } from './step3.js';
import { renderStep4Worksheet } from './step4.js';
import { refreshGuideStatus, renderToolPanel } from './toolPanel.js';
import {
  applyBasemap,
  onWeatherViewChange,
  refreshWeather,
  renderBasemapSwitch,
  renderScenarioChip,
  renderWeatherRows,
  scenarioBlocksBasemap,
  scheduleWeatherRefresh,
  setRadarPlaying,
  showRadarFrame,
  toggleWeather,
  weatherCaption,
} from './weatherLayers.js';

const API = '/api/ipb';
export const TERRAIN_API = '/api/terrain';
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

export const BASEMAPS = [
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

export const MINUTE = 60_000;

/**
 * Online weather overlays. Each request tells the service which area is being
 * looked at, so they stay off until switched on. `refresh` is how often the
 * newest image (or wind readings) is checked while on.
 */
export const WEATHER_OVERLAYS = [
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

export const WEATHER_BY_ID = new Map(WEATHER_OVERLAYS.map((overlay) => [overlay.id, overlay]));
export const WEATHER_UNAVAILABLE = 'Unavailable: no connection, or the service is down';

export const CLOCK = new Intl.DateTimeFormat(undefined, {
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

export const FEATURE_LAYERS = {
  'key-terrain': { label: 'Key terrain', kinds: ['point', 'polygon'] },
  avenue: { label: 'Avenue of approach', kinds: ['line'] },
  obstacle: { label: 'Obstacle', kinds: ['point', 'line', 'polygon'] },
  nai: { label: 'Named area of interest', kinds: ['point', 'polygon'] },
  tai: { label: 'Target area of interest', kinds: ['point', 'polygon'] },
  coa: { label: 'COA sketch', kinds: ['point', 'line', 'polygon'] },
};

export const OAKOC_LAYERS = ['key-terrain', 'avenue', 'obstacle'];

let state;

let elements;

let mapController;

export let mapToolsController;

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
    studyFromUrl: false,
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
    /** The guide: the task open per step (a step absent: its first task to do), and
     * whether "More tools" is unfolded. Per session, like the selected COA. */
    guide: { open: {}, more: false },
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
      /** ČHMÚ measurements nearest the weather point, per quantity (modules/ipb/server/chmi.js). */
      measured: { key: null, dataKey: null, data: null, loading: false, error: null },
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
 * study's cell). Mirrors `server/policy.ts`'s `canEdit`. */
function canEditStudy() {
  return !state.study || canEditClient(state.study.study);
}

export function canSwitchStudies() {
  return isWhite();
}

function configureStudyAccess() {
  const canSwitch = canSwitchStudies();
  elements.studyToggle.disabled = !canSwitch;
  elements.studyToggle.setAttribute('aria-haspopup', canSwitch ? 'true' : 'false');
  elements.studyToggle.title = canSwitch
    ? 'Switch study (/)'
    : 'Your cell study opens automatically';
  elements.createStudy.hidden = !canSwitch || !can('analyst');
  elements.mapEmptyCreate.hidden = !canSwitch || !can('analyst');
  if (!canSwitch) closeStudyMenu();
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

/**
 * Every request dies with its mount, so a stale view never touches a newer one.
 * `X-Client-Id` (live-update echo suppression) goes to this server only: on
 * a cross-origin request (Open-Meteo, RainViewer) a custom header forces a
 * CORS preflight those services refuse, and the browser drops the request.
 */
async function requestJson(path, { method = 'GET', body, signal = state.session.signal } = {}) {
  const sameOrigin = new URL(path, window.location.href).origin === window.location.origin;
  const options = { method, signal, headers: sameOrigin ? { 'X-Client-Id': clientId } : {} };
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
export function aoiCentre(geometry) {
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

/**
 * The study and step each signed-in user last had open, per browser: the
 * module link in the masthead is a bare `/ipb/`, so without this every
 * return to IPB started with no study open.
 */
const LAST_STUDY_KEY = 'ipb.lastStudy';

function lastStudyOwner() {
  return currentUser()?.name ?? 'local';
}

function loadLastStudy() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(LAST_STUDY_KEY) ?? 'null');
    return saved?.[lastStudyOwner()] ?? null;
  } catch {
    return null;
  }
}

function saveLastStudy() {
  if (!canSwitchStudies()) return;
  try {
    const saved = JSON.parse(window.localStorage.getItem(LAST_STUDY_KEY) ?? 'null') ?? {};
    saved[lastStudyOwner()] = state.studyId ? { study: state.studyId, step: state.step } : null;
    window.localStorage.setItem(LAST_STUDY_KEY, JSON.stringify(saved));
  } catch {
    // Storage full or blocked: IPB just opens without a study next time.
  }
}

/** The URL's study and step; with no study in it, switch-capable users reopen their last study. */
function readLocation() {
  const params = new URLSearchParams(window.location.search);
  state.studyFromUrl = params.has('study');
  const last = canSwitchStudies() && !state.studyFromUrl ? loadLastStudy() : null;
  state.studyId = params.get('study') || last?.study || null;
  const step = Number.parseInt(params.get('step') ?? last?.step, 10);
  state.step = [1, 2, 3, 4].includes(step) ? step : 1;
  const hash = window.location.hash;
  state.selectedFeatureId = hash.startsWith('#feature=') ? hash.slice(9) : null;
}

function writeLocation() {
  const params = new URLSearchParams();
  if (state.studyId) params.set('study', state.studyId);
  params.set('step', String(state.step));
  const search = params.toString();
  saveLastStudy();
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
  if (!canSwitchStudies()) return;
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
  elements.studyMenu.hidden = true;
  elements.studyToggle.setAttribute('aria-expanded', 'false');
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
        state.studies.length
          ? 'No studies match.'
          : canSwitchStudies()
            ? 'No studies yet. Create one below.'
            : 'Your cell study is opened automatically.',
      ),
    );
  }
}

async function loadStudies() {
  const list = await requestJson(`${API}/studies`);
  state.studies = list.items;
  renderStudyList();
}

export async function createStudy() {
  if (!can('analyst') || !canSwitchStudies()) return;
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
  clearError(elements.studyMenu);
  try {
    const study = await requestJson(`${API}/studies`, {
      method: 'POST',
      body: { name: values.name, owner_cell: values.owner_cell },
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

function beginStudyLoad(id, { preserveFeature = false } = {}) {
  state.studyRequest?.abort();
  const controller = new AbortController();
  state.studyRequest = controller;
  state.studyId = id === null ? null : String(id);
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
  state.guide.open = {};
  renderEmptyState();
  return controller;
}

function finishStudyLoad(payload, controller) {
  if (controller.signal.aborted) return false;
  state.studyId = String(payload.study.id);
  state.study = payload;
  renderStudyLoaded();
  writeLocation();
  refreshOrbatLinks().catch(() => {});
  return true;
}

async function selectStudy(id, { preserveFeature = false, showErrors = true } = {}) {
  if (String(state.studyId) === String(id) && state.study) return true;
  const controller = beginStudyLoad(id, { preserveFeature });
  try {
    const payload = await requestJson(`${API}/studies/${id}`, {
      signal: AbortSignal.any([controller.signal, state.session.signal]),
    });
    return finishStudyLoad(payload, controller);
  } catch (error) {
    if (error.name === 'AbortError') return false;
    if (showErrors) showError(elements.toolPanel, error.message);
    return false;
  }
}

async function selectCurrentCellStudy({ preserveFeature = false } = {}) {
  const controller = beginStudyLoad(null, { preserveFeature });
  try {
    const payload = await requestJson(`${API}/studies/current`, {
      signal: AbortSignal.any([controller.signal, state.session.signal]),
    });
    return finishStudyLoad(payload, controller);
  } catch (error) {
    if (error.name !== 'AbortError') showError(elements.toolPanel, error.message);
    return false;
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
  const emptyTitle = elements.mapEmpty.querySelector('h2');
  const emptyCopy = elements.mapEmpty.querySelector('p:nth-of-type(2)');
  if (emptyTitle)
    emptyTitle.textContent = canSwitchStudies()
      ? 'Create or select a study'
      : 'Opening your cell study';
  if (emptyCopy) {
    emptyCopy.textContent = canSwitchStudies()
      ? 'The map and worksheet activate once a study is open.'
      : 'The map and worksheet activate automatically for your cell’s study.';
  }
  renderStudyReleaseControl();
  updateStepNavAvailability();
  renderToolPanel();
  [1, 2, 3, 4].forEach((step) => {
    elements[`worksheet${step}`].replaceChildren(
      createElement(
        'p',
        'panel-note',
        canSwitchStudies()
          ? 'Select or create a study to see this step.'
          : 'Your cell study is opening automatically.',
      ),
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

export function switchStep(step) {
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

export function toggleSheet(name) {
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
  refreshGuideStatus();
}

export function reRenderContainingWorksheet(layer) {
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

export async function showElevationReadout(lon, lat) {
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
export function basemapSpec(id) {
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
export function closeAllPopovers() {
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

// --- Shared feature list / draw button widgets --------------------------

function selectAndZoomFeature(feature) {
  state.selectedFeatureId = feature.id;
  mapController.selectFeature(feature.id);
  mapController.fitFeature(feature.id);
  writeLocation();
  reRenderContainingWorksheet(feature.layer);
}

export function renderFeatureRow(feature) {
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

export async function renameFeature(feature) {
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

export function armFeatureDraw(layer, kind) {
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

export function renderDrawButtons(layer) {
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
  configureStudyAccess();
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
    .then(async () => {
      if (initialStudyId && (state.studyFromUrl || canSwitchStudies())) {
        const opened = await selectStudy(initialStudyId, {
          preserveFeature: true,
          showErrors: canSwitchStudies(),
        });
        if (opened) return true;
      }
      // Everyone starts in their cell workspace; White can switch afterward.
      if (!initialStudyId) return selectCurrentCellStudy();
      if (!canSwitchStudies()) {
        if (state.studyFromUrl) state.selectedFeatureId = null;
        return selectCurrentCellStudy();
      }
      // The only study this switch-capable user can see: open it rather than ask.
      if (state.studies.length === 1) return selectStudy(state.studies[0].id);
      if (state.studyId) {
        // Remembered or linked, but gone or not visible to this cell.
        state.studyId = null;
        switchStep(1);
      }
      writeLocation();
      toggleStudyMenu(true);
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
