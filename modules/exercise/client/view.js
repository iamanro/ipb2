import polygonClipping from 'polygon-clipping';

import { formatDtg, formatPlannedTime } from '../../../src/dtg.js';
import { createDtgInput, readDtgValue } from '../../../src/dtgField.js';
import { clientId, subscribe } from '../../../src/live.js';
import { buildScenarioNameIndex, createMap, matchScenarioPlace } from '../../../src/map.js';
import { canEditClient, renderCellBadge, renderReleaseControl } from '../../../src/release.js';
import {
  can,
  currentUser,
  handleUnauthorized,
  isWhite,
  sessionMode,
} from '../../../src/session.js';

import { createCollectionController } from './collection.js';
import { appendOwnerReassign } from './ownerReassign.js';
import { createProductsController } from './products.js';
import {
  appendCredibilityOptions,
  appendReliabilityOptions,
  createReportFieldset,
  createReportsController,
  formatReportLocationMgrs,
} from './reportForm.js';
import { createSituationController } from './situation.js';
import './styles.css';
import template from './view.html?raw';

const API = '/api/exercise';
const IPB_API = '/api/ipb';
const TERRAIN_API = '/api/terrain';
const TABS = [
  'requirements',
  'geography',
  'reports',
  'situation',
  'rfi',
  'collection',
  'products',
  'scenario',
  'activity',
];

const AFFILIATIONS = ['friendly', 'hostile', 'neutral', 'unknown'];
/** Must match the server's defaults — sent explicitly so a picked colour round-trips. */
const AFFILIATION_COLOR = {
  friendly: '#3d8bff',
  hostile: '#ff4d4d',
  neutral: '#3fbf5f',
  unknown: '#e6c229',
};
const AFFILIATION_LABEL = {
  friendly: 'Friendly',
  hostile: 'Hostile',
  neutral: 'Neutral',
  unknown: 'Unknown',
};

/** UI affordance only: the server (rfiMachine.js) is the actual guard. */
const RFI_NEXT = {
  draft: ['submitted'],
  submitted: ['assigned', 'rejected'],
  assigned: ['in_collection', 'rejected'],
  in_collection: ['answered'],
  answered: ['closed', 'reopened'],
  reopened: ['assigned'],
  closed: [],
  rejected: [],
};

let state;
let elements;
let dialogNode;
/** The Geography tab's map controller: created on entering the tab, destroyed on leaving it
 * (never torn down by the shared renderPanel() wipe-and-redraw that every other tab uses). */
let geoMap;
/** Collection/Products tab controllers (collection.js/products.js): built once in mount()
 * with the shared `ctx`, entered/left like geoMap — see CONTROLLER_TABS/switchTab. */
let collectionController;
let productsController;
let reportsController;
let situationController;
/** The Scenario tab's 'report'-kind inject form fieldset (reportForm.js's
 * createReportFieldset): owns a locationField + its map-pick dialog, so it must be
 * destroyed before the next one is built — renderScenarioPanel runs on every
 * loadAll()+renderPanel() cycle, not just on entering the tab. */
let injectReportFieldset;

/** True when the user may create a cell-owned item at all: off mode's
 * fixed operator and White always can; a member of any cell can; an admin
 * with no membership acts as White (C1) and still can. Only a signed-in
 * non-admin with no exercise membership can't — and that case is already
 * turned away before this module ever mounts (403 upstream), so this is
 * belt-and-braces for hiding create controls, not the real gate. */
function hasCell() {
  if (sessionMode() !== 'on') return true;
  const user = currentUser();
  return Boolean(user?.admin) || Boolean(user?.cell);
}

// --- State & elements --------------------------------------------------------

function createState() {
  return {
    session: new AbortController(),
    tab: 'requirements',
    requirements: [],
    reports: [],
    rfis: [],
    messages: [],
    clock: null,
    scenarioEvents: [],
    activity: [],
    importSummary: null,
    unsubscribeTick: null,
    // The game-master's audit view (Activity tab, LAN/auth mode only) — loaded lazily,
    // separate from `activity` (the exercise module's own per-object log).
    audit: { items: [], total: 0, offset: 0, limit: 50, loaded: false },
    geo: {
      scenarios: [],
      scenario: null,
      regions: null,
      regionsError: null,
      regionLevel: 'kraj',
      // null | 'pick-regions' | 'edit-border' | 'draw-area'; place renaming has no mode,
      // it is just the map's default click behaviour while nothing else is armed.
      mode: null,
      activeCountryId: null,
      basemap: 'roads',
      terrainMeta: null,
      loading: false,
      error: null,
    },
  };
}

function queryElements(root) {
  return {
    tabNav: root.querySelector('#tab-nav'),
    panel: root.querySelector('#panel'),
  };
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Every exercise time reads as a Zulu DTG, like the SORs and INTSUMs built from it. */
function formatDate(value) {
  if (!value) return '—';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? formatDtg(ms) : value;
}

/** Scenario "now" (ms): the reference for short DTGs typed into time fields. */
function scenarioNow() {
  const now = state.clock ? Date.parse(state.clock.now) : NaN;
  return Number.isFinite(now) ? now : Date.now();
}

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

function showError(container, message) {
  let node = container.querySelector(':scope > .inline-error');
  if (!node) {
    node = createElement('p', 'inline-error');
    container.prepend(node);
  }
  node.textContent = message;
}

// --- Prompts -----------------------------------------------------------------

/** One reusable <dialog>, built in JS (not view.html) so it survives every tab's
 * template swap: focus trap, Escape and backdrop come for free. */
function createDialogNode(root) {
  dialogNode = createElement('dialog', 'workspace-dialog');
  const form = createElement('form');
  form.method = 'dialog';
  const message = createElement('p', 'dialog-message');
  const input = createElement('input', 'dialog-input');
  input.type = 'text';
  input.autocomplete = 'off';
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
  form.append(message, input, actions);
  dialogNode.append(form);
  root.append(dialogNode);
}

function openDialog({ message, initial, accept, withInput, destructive = false }) {
  dialogNode.querySelector('.dialog-message').textContent = message;
  const input = dialogNode.querySelector(':scope form > .dialog-input');
  input.hidden = !withInput;
  input.value = initial ?? '';
  const acceptButton = dialogNode.querySelector('.dialog-accept');
  acceptButton.textContent = accept;
  acceptButton.classList.toggle('danger', destructive);
  return new Promise((resolve) => {
    const settle = () => {
      dialogNode.removeEventListener('close', settle);
      const accepted = dialogNode.returnValue === 'accept';
      if (!withInput) return resolve(accepted);
      return resolve(accepted ? input.value.trim() : null);
    };
    dialogNode.addEventListener('close', settle);
    dialogNode.showModal();
    if (withInput) {
      input.focus();
      input.select();
    }
  });
}

/** Resolves to the trimmed text, or null when the analyst cancels. */
function askText(message, initial = '', accept = 'Save') {
  return openDialog({ message, initial, accept, withInput: true });
}

/** Every confirmation here guards a delete, so its accept reads as one. */
function askConfirm(message, accept = 'Delete') {
  return openDialog({ message, accept, withInput: false, destructive: true });
}

// --- URL state -----------------------------------------------------------

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  state.tab = TABS.includes(tab) ? tab : 'requirements';
}

function writeLocation() {
  const params = new URLSearchParams();
  params.set('tab', state.tab);
  window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
}

// --- Loading -----------------------------------------------------------------

async function loadAll() {
  // Scenario events carry inject text — the server itself needs game-master
  // to read them (server/access.js), so a training-audience role never even
  // asks; the Scenario tab shows only the clock to them (renderScenarioPanel).
  const canSeeInjects = can('game-master');
  const [requirements, reports, rfis, messages, clock, scenarioEvents, activity] =
    await Promise.all([
      requestJson(`${API}/requirements`),
      requestJson(`${API}/reports`),
      requestJson(`${API}/rfis`),
      requestJson(`${API}/messages`),
      requestJson(`${API}/clock`),
      canSeeInjects ? requestJson(`${API}/scenario-events`) : Promise.resolve([]),
      requestJson(`${API}/activity`),
    ]);
  state.requirements = requirements;
  state.reports = reports;
  state.rfis = rfis;
  state.messages = messages;
  state.clock = clock;
  state.scenarioEvents = scenarioEvents;
  state.activity = activity;
}

// --- Tab chrome ----------------------------------------------------------------

function renderTabNav() {
  elements.tabNav.querySelectorAll('.tab-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === state.tab);
  });
}

/** Tabs whose panel is owned by a `{ enter(container), leave() }` controller
 * (collection.js, products.js) instead of the plain renderers map below —
 * same "lives across renders, torn down on leaving the tab" shape as the
 * Geography tab's map controller. */
const CONTROLLER_TABS = {
  collection: () => collectionController,
  products: () => productsController,
  reports: () => reportsController,
  situation: () => situationController,
};

function switchTab(tab) {
  // The map controller lives across renders of the Geography tab (see
  // renderGeographyPanel); every other tab is a plain wipe-and-redraw, so it
  // only needs tearing down when actually leaving the tab that owns it.
  if (state.tab === 'geography' && tab !== 'geography') destroyGeoMap();
  const leavingController = CONTROLLER_TABS[state.tab];
  if (leavingController && state.tab !== tab) leavingController().leave();
  state.tab = tab;
  writeLocation();
  renderTabNav();
  renderPanel();
}

function renderPanel() {
  elements.panel.replaceChildren();
  elements.panel.classList.toggle('panel-geo', state.tab === 'geography');
  elements.panel.classList.toggle('panel-situation', state.tab === 'situation');
  const enterController = CONTROLLER_TABS[state.tab];
  if (enterController) {
    enterController().enter(elements.panel);
    return;
  }
  const renderers = {
    requirements: renderRequirementsPanel,
    geography: renderGeographyPanel,
    rfi: renderRfiPanel,
    scenario: renderScenarioPanel,
    activity: renderActivityPanel,
  };
  renderers[state.tab]();
}

// --- Geography panel (fictional countries + renamed places) ---
//
// The one place a scenario's countries and places are drawn and edited.
// Unlike every other tab, this one owns a live map controller (`geoMap`)
// that survives its own re-renders — `renderGeoSidebar()` rebuilds the
// side panel after every change, but the map is only created on entering
// the tab and destroyed on leaving it (see switchTab/destroyGeoMap).

/** Approximate centre of Czechia, for the map's first view before any scenario is picked. */
const CZECHIA_CENTER = [15.47, 49.82];
const CZECHIA_ZOOM = 7;

// -- Geometry helpers: regions.json / country geometry, via polygon-clipping --

/** GeoJSON Polygon/MultiPolygon -> polygon-clipping's MultiPolygon coordinate array. */
function toClipCoords(geometry) {
  if (!geometry) return [];
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

/** 1e-6° ≈ 10 cm: far below the 5-decimal region data, far above float noise. */
const SNAP = 1e6;
/** Square degrees, ~0.8 ha at 50°N: clip results smaller than this are slivers. */
const SLIVER_AREA = 1e-6;

function snapCoords(multiPolygon) {
  return multiPolygon.map((polygon) =>
    polygon.map((ring) =>
      ring.map(([x, y]) => [Math.round(x * SNAP) / SNAP, Math.round(y * SNAP) / SNAP]),
    ),
  );
}

/**
 * polygon-clipping `op` on two clip-coords shapes. It can fail ("Unable to
 * complete output ring") on near-coincident segments, which hand-edited
 * borders beside a neighbour produce; snapping both to a fine grid first
 * resolves those.
 */
function clip(op, a, b) {
  let result;
  try {
    result = polygonClipping[op](a, b);
  } catch {
    try {
      result = polygonClipping[op](snapCoords(a), snapCoords(b));
    } catch {
      throw new Error('These borders could not be combined. Try a simpler outline.');
    }
  }
  // Clipping along a shared border leaves hairline slivers; no real piece of territory is this small.
  return result.filter((polygon) => Math.abs(ringArea(polygon[0])) >= SLIVER_AREA);
}

function ringArea(ring) {
  let twice = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    twice += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return twice / 2;
}

/** `existing` (GeoJSON geometry or null) unioned with a clip-coords shape, back to GeoJSON or null. */
function unionGeometry(existing, addCoords) {
  if (!addCoords.length) return existing;
  const base = toClipCoords(existing);
  const merged = base.length ? clip('union', base, addCoords) : addCoords;
  return merged.length ? { type: 'MultiPolygon', coordinates: merged } : null;
}

/** `existing` minus a clip-coords shape, back to GeoJSON or null. */
function differenceGeometry(existing, subtractCoords) {
  const base = toClipCoords(existing);
  if (!base.length || !subtractCoords.length) return existing;
  const remaining = clip('difference', base, subtractCoords);
  return remaining.length ? { type: 'MultiPolygon', coordinates: remaining } : null;
}

/** Planar ring-area sum in square degrees; only compared with itself, to detect a change. */
function geometryArea(geometry) {
  let total = 0;
  for (const polygon of toClipCoords(geometry)) {
    polygon.forEach((ring, index) => {
      total += (index === 0 ? 1 : -1) * Math.abs(ringArea(ring));
    });
  }
  return total;
}

function extentsOverlap(a, b) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** [minLon, minLat, maxLon, maxLat] of a GeoJSON Polygon/MultiPolygon. */
function geometryExtent(geometry) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (coords) => {
    if (typeof coords[0] === 'number') {
      const [x, y] = coords;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      return;
    }
    coords.forEach(walk);
  };
  walk(geometry.coordinates);
  return [minX, minY, maxX, maxY];
}

function unionExtent(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function regionGeometryFor(regionId) {
  return (
    state.geo.regions?.features.find((feature) => feature.properties.id === regionId)?.geometry ??
    null
  );
}

/** Every region id -> the colour of the country that currently owns it, for setRegions' tint. */
function regionOwnerColors() {
  const owner = new Map();
  for (const country of state.geo.scenario?.countries ?? []) {
    for (const regionId of country.regions) owner.set(regionId, country.color);
  }
  return owner;
}

// -- Map wiring -------------------------------------------------------------

/** Pushes the selected scenario (and, in "Pick regions" mode, the region outlines) onto the map. */
function updateGeoMapScenario() {
  if (!geoMap) return;
  geoMap.setScenario(state.geo.scenario, { editing: true });
  if (state.geo.mode === 'pick-regions') {
    geoMap.setRegions(state.geo.regions, {
      level: state.geo.regionLevel,
      owner: regionOwnerColors(),
    });
  }
}

function fitGeoScenario() {
  const countries = state.geo.scenario?.countries.filter((country) => country.geometry) ?? [];
  if (!countries.length || !geoMap) return;
  const extent = countries
    .map((country) => geometryExtent(country.geometry))
    .reduce((acc, next) => (acc ? unionExtent(acc, next) : next), null);
  if (extent) geoMap.fitExtent(extent);
}

/** Cancels "Pick regions"/"Edit border"/"Draw area"; always safe to call. */
function stopGeoMode() {
  state.geo.mode = null;
  state.geo.activeCountryId = null;
  geoMap?.stopEditing();
  geoMap?.setRegions(null);
  renderGeoSidebar();
}

function onGeoKeydown(event) {
  if (event.key !== 'Escape' || state.tab !== 'geography' || !state.geo.mode) return;
  stopGeoMode();
}

/** A click on the geography map: region picking in "Pick regions" mode, otherwise a real
 * place label to rename — Edit border/Draw area consume clicks through their own OL
 * interaction instead, so they are ignored here. */
function onGeoMapClick({ pixel }) {
  if (!geoMap || !state.geo.scenario) return;
  if (state.geo.mode === 'edit-border' || state.geo.mode === 'draw-area') return;
  if (state.geo.mode === 'pick-regions') {
    const regionId = geoMap.regionAt(pixel);
    if (regionId) toggleGeoRegion(regionId);
    return;
  }
  const picked = geoMap.placeAt(pixel);
  if (picked) openPlaceRename(picked);
}

/** The geo map's basemap spec for an id, or null while its data is missing (mirrors ipb view's basemapSpec). */
function geoBasemapSpec(id) {
  const meta = state.geo.terrainMeta;
  const vector = { attributions: meta?.basemap.attribution };
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
  return { vector };
}

function renderGeoBasemapSwitch() {
  if (!elements.geoBasemapSwitch) return;
  const options = [
    { id: 'roads', label: 'Roads' },
    { id: 'satellite', label: 'Satellite' },
  ];
  elements.geoBasemapSwitch.replaceChildren(
    ...options.map((option) => {
      const available = Boolean(geoBasemapSpec(option.id));
      const button = createElement('button', 'basemap-option', option.label);
      button.type = 'button';
      button.dataset.geoBasemap = option.id;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(state.geo.basemap === option.id));
      button.disabled = !available;
      return button;
    }),
  );
}

function applyGeoBasemap(id) {
  const spec = geoBasemapSpec(id);
  if (!spec) {
    if (id !== 'roads') applyGeoBasemap('roads');
    return;
  }
  state.geo.basemap = id;
  geoMap.setBasemap(spec);
  renderGeoBasemapSwitch();
}

// -- Data loading -------------------------------------------------------------

async function loadGeoScenarios() {
  try {
    const { items } = await requestJson(`${API}/scenarios`);
    state.geo.scenarios = items;
  } catch (error) {
    state.geo.error = error.message;
  }
}

async function loadGeoRegions() {
  try {
    state.geo.regions = await requestJson(`${API}/regions`);
    state.geo.regionsError = null;
  } catch (error) {
    state.geo.regions = null;
    state.geo.regionsError = error.message;
  }
}

/** Reloads the selected scenario and the list (counts/updated_at/active change together) after any edit. */
async function reloadGeoScenario(id) {
  try {
    state.geo.scenario = await requestJson(`${API}/scenarios/${id}`);
    const { items } = await requestJson(`${API}/scenarios`);
    state.geo.scenarios = items;
    state.geo.error = null;
  } catch (error) {
    state.geo.error = error.message;
  }
  renderGeoSidebar();
  updateGeoMapScenario();
}

// -- Scenario actions -----------------------------------------------------

async function createGeoScenario() {
  const name = await askText('New scenario name', '', 'Create');
  if (!name) return;
  try {
    const scenario = await requestJson(`${API}/scenarios`, { method: 'POST', body: { name } });
    await loadGeoScenarios();
    state.geo.scenario = scenario;
    state.geo.error = null;
  } catch (error) {
    state.geo.error = error.message;
  }
  renderGeoSidebar();
  updateGeoMapScenario();
}

async function addExampleGeoScenario() {
  try {
    const scenario = await requestJson(`${API}/scenarios/example`, { method: 'POST' });
    await loadGeoScenarios();
    state.geo.scenario = scenario;
    state.geo.error = null;
  } catch (error) {
    state.geo.error = error.message;
    renderGeoSidebar();
    return;
  }
  renderGeoSidebar();
  updateGeoMapScenario();
  fitGeoScenario();
}

async function duplicateGeoScenario(item) {
  try {
    const scenario = await requestJson(`${API}/scenarios/${item.id}/duplicate`, { method: 'POST' });
    await loadGeoScenarios();
    state.geo.scenario = scenario;
    state.geo.error = null;
  } catch (error) {
    state.geo.error = error.message;
  }
  renderGeoSidebar();
  updateGeoMapScenario();
}

async function renameGeoScenario(item) {
  const name = await askText('Rename scenario', item.name, 'Rename');
  if (!name || name === item.name) return;
  try {
    await requestJson(`${API}/scenarios/${item.id}`, { method: 'PATCH', body: { name } });
    await loadGeoScenarios();
    if (state.geo.scenario?.id === item.id) state.geo.scenario.name = name;
    state.geo.error = null;
  } catch (error) {
    state.geo.error = error.message;
  }
  renderGeoSidebar();
}

async function deleteGeoScenario(item) {
  if (!(await askConfirm(`Delete scenario "${item.name}"? This deletes its countries and places.`)))
    return;
  try {
    await requestJson(`${API}/scenarios/${item.id}`, { method: 'DELETE' });
    await loadGeoScenarios();
    state.geo.error = null;
    if (state.geo.scenario?.id === item.id) {
      state.geo.mode = null;
      state.geo.activeCountryId = null;
      state.geo.scenario = null;
    }
  } catch (error) {
    state.geo.error = error.message;
  }
  renderGeoSidebar();
  updateGeoMapScenario();
}

async function toggleActiveGeoScenario(item) {
  try {
    await requestJson(`${API}/scenarios/${item.id}`, {
      method: 'PATCH',
      body: { active: !item.active },
    });
    await loadGeoScenarios();
    if (state.geo.scenario?.id === item.id) state.geo.scenario.active = !item.active;
    state.geo.error = null;
  } catch (error) {
    state.geo.error = error.message;
  }
  renderGeoSidebar();
}

async function selectGeoScenario(id) {
  stopGeoMode();
  try {
    state.geo.scenario = await requestJson(`${API}/scenarios/${id}`);
    state.geo.error = null;
  } catch (error) {
    state.geo.scenario = null;
    state.geo.error = error.message;
  }
  renderGeoSidebar();
  updateGeoMapScenario();
  fitGeoScenario();
}

// -- Country actions ----------------------------------------------------------

async function createGeoCountry(form, container) {
  const scenario = state.geo.scenario;
  if (!scenario) return;
  const nameInput = form.querySelector('[name=name]');
  const name = nameInput.value.trim();
  const affiliation = form.querySelector('[name=affiliation]').value;
  const color = form.querySelector('[name=color]').value;
  if (!name) return;
  try {
    await requestJson(`${API}/scenarios/${scenario.id}/countries`, {
      method: 'POST',
      body: { name, affiliation, color },
    });
    nameInput.value = '';
    await reloadGeoScenario(scenario.id);
  } catch (error) {
    showError(container, error.message);
  }
}

async function renameGeoCountry(country) {
  const name = await askText('Rename country', country.name, 'Rename');
  if (!name || name === country.name) return;
  await updateGeoCountryField(country, { name });
}

async function updateGeoCountryField(country, patch) {
  try {
    await requestJson(`${API}/scenario-countries/${country.id}`, { method: 'PATCH', body: patch });
    await reloadGeoScenario(state.geo.scenario.id);
  } catch (error) {
    state.geo.error = error.message;
    renderGeoSidebar();
  }
}

async function deleteGeoCountry(country) {
  if (!(await askConfirm(`Delete country "${country.name}"?`))) return;
  if (state.geo.activeCountryId === country.id) stopGeoMode();
  try {
    await requestJson(`${API}/scenario-countries/${country.id}`, { method: 'DELETE' });
    await reloadGeoScenario(state.geo.scenario.id);
  } catch (error) {
    state.geo.error = error.message;
    renderGeoSidebar();
  }
}

/**
 * Save a country's new shape. It takes the ground it now covers: every other
 * country loses its overlap (and `takenRegion`, if given, from its region
 * list), so no point is ever in two countries. `shape()` computes the new
 * geometry; everything is computed before anything is written, so a clipping
 * failure changes nothing.
 */
async function saveCountryShape(country, shape, regions = country.regions, takenRegion = null) {
  try {
    const geometry = shape();
    const extent = geometry && geometryExtent(geometry);
    const neighbours = [];
    for (const other of state.geo.scenario.countries) {
      if (other.id === country.id) continue;
      const nextRegions = other.regions.filter((id) => id !== takenRegion);
      let nextGeometry = other.geometry;
      if (geometry && other.geometry && extentsOverlap(extent, geometryExtent(other.geometry))) {
        const remaining = differenceGeometry(other.geometry, toClipCoords(geometry));
        if (!remaining || geometryArea(remaining) < geometryArea(other.geometry) - 1e-12) {
          nextGeometry = remaining;
        }
      }
      if (nextGeometry !== other.geometry || nextRegions.length !== other.regions.length) {
        neighbours.push({ id: other.id, body: { regions: nextRegions, geometry: nextGeometry } });
      }
    }
    // Neighbours first: if a write fails midway, the map shows a gap, never an overlap.
    for (const { id, body } of neighbours) {
      await requestJson(`${API}/scenario-countries/${id}`, { method: 'PATCH', body });
    }
    await requestJson(`${API}/scenario-countries/${country.id}`, {
      method: 'PATCH',
      body: { regions, geometry },
    });
    await reloadGeoScenario(state.geo.scenario.id);
  } catch (error) {
    state.geo.error = error.message;
    renderGeoSidebar();
  }
}

// -- Region picking / border editing -----------------------------------------

function enterPickRegions(country) {
  if (!state.geo.regions) {
    state.geo.error = state.geo.regionsError || 'Regions data not loaded yet.';
    renderGeoSidebar();
    return;
  }
  geoMap.stopEditing();
  state.geo.mode = 'pick-regions';
  state.geo.activeCountryId = country.id;
  geoMap.setRegions(state.geo.regions, {
    level: state.geo.regionLevel,
    owner: regionOwnerColors(),
  });
  renderGeoSidebar();
}

function setGeoRegionLevel(level) {
  state.geo.regionLevel = level;
  if (state.geo.mode === 'pick-regions') {
    geoMap.setRegions(state.geo.regions, { level, owner: regionOwnerColors() });
  }
  renderGeoSidebar();
}

/** Toggles one kraj/okres in or out of the active country: union/difference (polygon-clipping),
 * stealing it (a difference on the loser) from any other country that already owns it. */
async function toggleGeoRegion(regionId) {
  const scenario = state.geo.scenario;
  const country = scenario?.countries.find((entry) => entry.id === state.geo.activeCountryId);
  if (!country) return;
  const regionGeometry = regionGeometryFor(regionId);
  if (!regionGeometry) return;
  const regionCoords = toClipCoords(regionGeometry);
  if (country.regions.includes(regionId)) {
    await saveCountryShape(
      country,
      () => differenceGeometry(country.geometry, regionCoords),
      country.regions.filter((id) => id !== regionId),
    );
  } else {
    await saveCountryShape(
      country,
      () => unionGeometry(country.geometry, regionCoords),
      [...country.regions, regionId],
      regionId,
    );
  }
}

function enterEditBorder(country) {
  if (!country.geometry) return;
  state.geo.mode = 'edit-border';
  state.geo.activeCountryId = country.id;
  geoMap.setRegions(null);
  geoMap.editCountry(country.geometry, {
    onChange: (geometry) => saveCountryShape(country, () => geometry),
  });
  renderGeoSidebar();
}

function enterDrawArea(country) {
  state.geo.mode = 'draw-area';
  state.geo.activeCountryId = country.id;
  geoMap.setRegions(null);
  geoMap.drawArea({
    onDone: async (drawnGeometry) => {
      await saveCountryShape(country, () =>
        unionGeometry(country.geometry, toClipCoords(drawnGeometry)),
      );
      stopGeoMode();
    },
  });
  renderGeoSidebar();
}

async function resetToRegions(country) {
  if (
    !(await askConfirm(
      `Reset "${country.name}"'s border to the union of its picked regions? Freehand edits are lost.`,
      'Reset',
    ))
  ) {
    return;
  }
  await saveCountryShape(country, () => {
    const merged = country.regions
      .map((id) => toClipCoords(regionGeometryFor(id)))
      .filter((coords) => coords.length)
      .reduce((acc, coords) => (acc.length ? clip('union', acc, coords) : coords), []);
    return merged.length ? { type: 'MultiPolygon', coordinates: merged } : null;
  });
}

// -- Place renaming -------------------------------------------------------------

function placeKindLabel(kind) {
  if (kind === 'peak') return 'Peak';
  if (kind === 'water') return 'Water';
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Clicking a real label: rename it if it is already matched to a scenario place (same
 * match rule as the map), otherwise create a new one at that point. */
async function openPlaceRename(picked) {
  const scenario = state.geo.scenario;
  if (!scenario) return;
  const index = buildScenarioNameIndex(scenario);
  const match = matchScenarioPlace(index, picked.real_name, picked.lon, picked.lat);
  const name = await askText(
    `Scenario name for "${picked.real_name}"`,
    match ? match.name : '',
    'Save',
  );
  if (!name) return;
  try {
    if (match) {
      await requestJson(`${API}/scenario-places/${match.id}`, { method: 'PATCH', body: { name } });
    } else {
      await requestJson(`${API}/scenarios/${scenario.id}/places`, {
        method: 'POST',
        body: {
          real_name: picked.real_name,
          kind: picked.kind,
          lon: picked.lon,
          lat: picked.lat,
          name,
        },
      });
    }
    await reloadGeoScenario(scenario.id);
  } catch (error) {
    state.geo.error = error.message;
    renderGeoSidebar();
  }
}

async function renameGeoPlace(place) {
  const name = await askText(`Rename "${place.real_name}"`, place.name, 'Rename');
  if (!name || name === place.name) return;
  try {
    await requestJson(`${API}/scenario-places/${place.id}`, { method: 'PATCH', body: { name } });
    await reloadGeoScenario(state.geo.scenario.id);
  } catch (error) {
    state.geo.error = error.message;
    renderGeoSidebar();
  }
}

async function deleteGeoPlace(place) {
  if (!(await askConfirm(`Delete the rename for "${place.real_name}"?`))) return;
  try {
    await requestJson(`${API}/scenario-places/${place.id}`, { method: 'DELETE' });
    await reloadGeoScenario(state.geo.scenario.id);
  } catch (error) {
    state.geo.error = error.message;
    renderGeoSidebar();
  }
}

// -- Rendering ------------------------------------------------------------------

function affiliationSelectFor(selected) {
  const select = document.createElement('select');
  AFFILIATIONS.forEach((value) =>
    select.append(new Option(AFFILIATION_LABEL[value], value, false, value === selected)),
  );
  return select;
}

function renderGeoScenarioRow(item) {
  const selected = state.geo.scenario?.id === item.id;
  const row = createElement('div', `geo-scenario-row${selected ? ' selected' : ''}`);
  const selectButton = createElement('button', 'text-button geo-scenario-select', item.name);
  selectButton.type = 'button';
  selectButton.setAttribute('aria-pressed', String(selected));
  selectButton.addEventListener('click', () => selectGeoScenario(item.id));
  row.append(selectButton);
  if (item.example) row.append(createElement('span', 'source-badge', 'EXAMPLE'));
  row.append(
    createElement(
      'span',
      'panel-note',
      `${item.country_count} countries · ${item.place_count} places`,
    ),
  );
  row.append(
    createElement(
      'span',
      `geo-active-badge${item.active ? ' is-active' : ''}`,
      item.active ? 'ACTIVE on all maps' : 'Inactive',
    ),
  );
  const toggle = createElement('button', 'chip-button', item.active ? 'Deactivate' : 'Activate');
  toggle.type = 'button';
  toggle.addEventListener('click', () => toggleActiveGeoScenario(item));
  const duplicate = createElement('button', 'icon-button', 'Duplicate');
  duplicate.type = 'button';
  duplicate.addEventListener('click', () => duplicateGeoScenario(item));
  const rename = createElement('button', 'icon-button', 'Rename');
  rename.type = 'button';
  rename.addEventListener('click', () => renameGeoScenario(item));
  const remove = createElement('button', 'icon-button danger', 'Delete');
  remove.type = 'button';
  remove.addEventListener('click', () => deleteGeoScenario(item));
  row.append(toggle, duplicate, rename, remove);
  return row;
}

function renderGeoCountryRow(country) {
  const active = state.geo.activeCountryId === country.id;
  const mode = active ? state.geo.mode : null;
  const row = createElement('div', `geo-country-row${active ? ' active' : ''}`);

  const header = createElement('div', 'geo-country-header');
  const swatch = createElement('span', 'geo-color-swatch');
  swatch.style.background = country.color;
  header.append(swatch, createElement('strong', null, country.name));
  const renameButton = createElement('button', 'icon-button', 'Rename');
  renameButton.type = 'button';
  renameButton.addEventListener('click', () => renameGeoCountry(country));
  const deleteButton = createElement('button', 'icon-button danger', 'Delete');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteGeoCountry(country));
  header.append(renameButton, deleteButton);
  row.append(header);

  const fields = createElement('div', 'inline-form');
  const affiliationSelect = affiliationSelectFor(country.affiliation);
  affiliationSelect.addEventListener('change', () =>
    updateGeoCountryField(country, { affiliation: affiliationSelect.value }),
  );
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = country.color;
  colorInput.setAttribute('aria-label', `${country.name} colour`);
  colorInput.addEventListener('change', () =>
    updateGeoCountryField(country, { color: colorInput.value }),
  );
  fields.append(affiliationSelect, colorInput);
  row.append(fields);

  row.append(
    createElement(
      'p',
      'panel-note',
      `${country.regions.length} region${country.regions.length === 1 ? '' : 's'}${country.geometry ? '' : ' · no border yet'}`,
    ),
  );

  const actions = createElement('div', 'inline-form');
  const pickButton = createElement(
    'button',
    'chip-button',
    mode === 'pick-regions' ? 'Done picking' : 'Pick regions',
  );
  pickButton.type = 'button';
  pickButton.addEventListener('click', () =>
    mode === 'pick-regions' ? stopGeoMode() : enterPickRegions(country),
  );
  const editButton = createElement(
    'button',
    'chip-button',
    mode === 'edit-border' ? 'Done editing' : 'Edit border',
  );
  editButton.type = 'button';
  editButton.disabled = !country.geometry && mode !== 'edit-border';
  editButton.title = editButton.disabled ? 'Pick regions first, or draw an area.' : '';
  editButton.addEventListener('click', () =>
    mode === 'edit-border' ? stopGeoMode() : enterEditBorder(country),
  );
  const drawButton = createElement(
    'button',
    'chip-button',
    mode === 'draw-area' ? 'Cancel draw' : 'Draw area',
  );
  drawButton.type = 'button';
  drawButton.addEventListener('click', () =>
    mode === 'draw-area' ? stopGeoMode() : enterDrawArea(country),
  );
  const resetButton = createElement('button', 'chip-button', 'Reset to regions');
  resetButton.type = 'button';
  resetButton.disabled = !country.regions.length;
  resetButton.addEventListener('click', () => resetToRegions(country));
  actions.append(pickButton, editButton, drawButton, resetButton);
  row.append(actions);

  if (mode === 'pick-regions') {
    const levelRow = createElement('div', 'inline-form');
    [
      ['kraj', 'Kraje'],
      ['okres', 'Okresy'],
    ].forEach(([level, label]) => {
      const button = createElement(
        'button',
        `chip-button${state.geo.regionLevel === level ? ' active' : ''}`,
        label,
      );
      button.type = 'button';
      button.addEventListener('click', () => setGeoRegionLevel(level));
      levelRow.append(button);
    });
    row.append(
      levelRow,
      createElement('p', 'panel-note', 'Click a region on the map to add or remove it.'),
    );
  } else if (mode === 'edit-border') {
    row.append(createElement('p', 'panel-note', 'Drag a vertex on the map to reshape the border.'));
  } else if (mode === 'draw-area') {
    row.append(
      createElement(
        'p',
        'panel-note',
        'Click to place vertices on the map, double-click to finish.',
      ),
    );
  }
  return row;
}

/** Posts to state.geo.scenario at click time, not capture time — no scenario param needed. */
function renderGeoCountryForm() {
  const section = createElement('section', 'field-group');
  section.append(createElement('h3', null, 'New country'));
  const form = createElement('div', 'inline-form');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.name = 'name';
  nameInput.placeholder = 'Country name…';
  const affiliationSelect = affiliationSelectFor('friendly');
  affiliationSelect.name = 'affiliation';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.name = 'color';
  colorInput.value = AFFILIATION_COLOR.friendly;
  colorInput.setAttribute('aria-label', 'Country colour');
  // The colour follows the affiliation's default until the analyst picks one themselves.
  let colorTouched = false;
  colorInput.addEventListener('input', () => {
    colorTouched = true;
  });
  affiliationSelect.addEventListener('change', () => {
    if (!colorTouched) colorInput.value = AFFILIATION_COLOR[affiliationSelect.value];
  });
  const addButton = createElement('button', 'primary-button', 'Add country');
  addButton.type = 'button';
  addButton.addEventListener('click', () => createGeoCountry(form, section));
  form.append(nameInput, affiliationSelect, colorInput, addButton);
  section.append(form);
  return section;
}

function renderGeoPlacesSection(scenario) {
  const section = createElement('section', 'field-group');
  section.append(createElement('h3', null, `Renamed places (${scenario.places.length})`));
  section.append(createElement('p', 'panel-note', 'Click a place name on the map to rename it.'));
  if (!scenario.places.length) {
    section.append(createElement('p', 'panel-note', 'No places renamed yet.'));
    return section;
  }
  const table = document.createElement('table');
  table.className = 'data-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Real name', 'Kind', 'Scenario name', ''].forEach((label) =>
    headRow.append(createElement('th', null, label)),
  );
  head.append(headRow);
  table.append(head);
  const body = document.createElement('tbody');
  scenario.places.forEach((place) => {
    const row = document.createElement('tr');
    const actions = document.createElement('td');
    const renameButton = createElement('button', 'icon-button', 'Rename');
    renameButton.type = 'button';
    renameButton.addEventListener('click', () => renameGeoPlace(place));
    const deleteButton = createElement('button', 'icon-button danger', 'Delete');
    deleteButton.type = 'button';
    deleteButton.addEventListener('click', () => deleteGeoPlace(place));
    actions.append(renameButton, deleteButton);
    row.append(
      createElement('td', null, place.real_name),
      createElement('td', null, placeKindLabel(place.kind)),
      createElement('td', null, place.name),
      actions,
    );
    body.append(row);
  });
  table.append(body);
  section.append(table);
  return section;
}

function renderGeoSidebar() {
  const sidebar = elements.geoSidebar;
  if (!sidebar) return;
  sidebar.replaceChildren();

  if (state.geo.error) sidebar.append(createElement('p', 'inline-error', state.geo.error));
  if (state.geo.regionsError) {
    sidebar.append(
      createElement('p', 'inline-error', `Regions data unavailable: ${state.geo.regionsError}`),
    );
  }

  const scenarioSection = createElement('section', 'field-group');
  const scenarioHeader = createElement('div', 'panel-header-row');
  scenarioHeader.append(createElement('h3', null, 'Scenarios'));
  if (can('game-master')) {
    const newButton = createElement('button', 'chip-button', 'New');
    newButton.type = 'button';
    newButton.addEventListener('click', createGeoScenario);
    const exampleButton = createElement('button', 'chip-button', 'Add example');
    exampleButton.type = 'button';
    exampleButton.disabled = Boolean(state.geo.regionsError);
    exampleButton.title = state.geo.regionsError ? 'Regions data not built yet.' : '';
    exampleButton.addEventListener('click', addExampleGeoScenario);
    scenarioHeader.append(newButton, exampleButton);
  }
  scenarioSection.append(scenarioHeader);
  if (!can('game-master')) {
    scenarioSection.append(
      createElement('p', 'panel-note', 'Editing scenario geography needs the game-master role.'),
    );
  }

  if (state.geo.loading && !state.geo.scenarios.length) {
    scenarioSection.append(createElement('p', 'panel-note', 'Loading scenarios…'));
  } else if (!state.geo.scenarios.length) {
    scenarioSection.append(
      createElement(
        'p',
        'panel-note',
        'No scenarios yet. Create one, or add the EXAMPLE scenario.',
      ),
    );
  } else {
    const list = createElement('div', 'geo-scenario-list');
    state.geo.scenarios.forEach((item) => list.append(renderGeoScenarioRow(item)));
    scenarioSection.append(list);
  }
  sidebar.append(scenarioSection);

  const scenario = state.geo.scenario;
  if (!scenario) {
    sidebar.append(
      createElement('p', 'panel-note', 'Select a scenario above to edit its countries and places.'),
    );
    return;
  }

  const countriesSection = createElement('section', 'field-group');
  countriesSection.append(createElement('h3', null, `Countries (${scenario.countries.length})`));
  if (!scenario.countries.length) {
    countriesSection.append(
      createElement('p', 'panel-note', 'No countries yet. Add one below, then pick its regions.'),
    );
  } else {
    const list = createElement('div', 'geo-country-list');
    scenario.countries.forEach((country) => list.append(renderGeoCountryRow(country)));
    countriesSection.append(list);
  }
  sidebar.append(
    countriesSection,
    ...(can('game-master') ? [renderGeoCountryForm()] : []),
    renderGeoPlacesSection(scenario),
  );
}

// -- Mount / unmount ------------------------------------------------------------

async function initGeoTab() {
  state.geo.loading = true;
  renderGeoSidebar();
  await Promise.all([
    loadGeoScenarios(),
    loadGeoRegions(),
    requestJson(`${TERRAIN_API}/meta`)
      .then((meta) => {
        state.geo.terrainMeta = meta;
        applyGeoBasemap(state.geo.basemap);
      })
      .catch(() => {}),
  ]);
  state.geo.loading = false;
  renderGeoSidebar();
  updateGeoMapScenario();
}

function renderGeographyPanel() {
  const container = elements.panel;
  const layout = createElement('div', 'geo-layout');
  const mapWrap = createElement('div', 'geo-map-wrap');
  const mapTarget = createElement('div', 'geo-map-target');
  const mapChrome = createElement('div', 'geo-map-chrome');
  const basemapSwitch = createElement('div', 'basemap-switch geo-basemap-switch');
  basemapSwitch.setAttribute('role', 'radiogroup');
  basemapSwitch.setAttribute('aria-label', 'Basemap');
  mapChrome.append(basemapSwitch);
  mapWrap.append(mapTarget, mapChrome);
  const sidebar = createElement('aside', 'geo-sidebar');
  layout.append(mapWrap, sidebar);
  container.append(layout);

  elements.geoBasemapSwitch = basemapSwitch;
  elements.geoSidebar = sidebar;

  basemapSwitch.addEventListener('click', (event) => {
    const button = event.target.closest('[data-geo-basemap]');
    if (button && !button.disabled) applyGeoBasemap(button.dataset.geoBasemap);
  });

  geoMap = createMap({
    target: mapTarget,
    basemapUrl: `${TERRAIN_API}/tiles/vector.pmtiles`,
    center: CZECHIA_CENTER,
    zoom: CZECHIA_ZOOM,
    onClick: onGeoMapClick,
  });
  // Roads/place names visible over any basemap: the editor needs real labels to click, and
  // to see roads even over the satellite option — see geoBasemapSpec.
  geoMap.setOverlays({ roads: true, places: true });
  renderGeoBasemapSwitch();
  renderGeoSidebar();
  updateGeoMapScenario();

  initGeoTab();
}

function destroyGeoMap() {
  geoMap?.destroy();
  geoMap = null;
  elements.geoBasemapSwitch = null;
  elements.geoSidebar = null;
  state.geo.mode = null;
  state.geo.activeCountryId = null;
}

// --- Requirements panel ----------------------------------------------------

function fulfillmentBar(fulfillment) {
  const wrap = createElement('div', `fulfillment-bar state-${fulfillment.state}`);
  const fill = createElement('div', 'fulfillment-fill');
  fill.style.width = `${fulfillment.percent}%`;
  const label = createElement(
    'span',
    'fulfillment-label',
    `${fulfillment.covered}/${fulfillment.total} SIRs · ${fulfillment.percent}% · ${fulfillment.state}`,
  );
  wrap.append(fill, label);
  return wrap;
}

async function addSir(requirementId, text, container) {
  if (!text.trim()) return;
  try {
    await requestJson(`${API}/requirements/${requirementId}/sirs`, {
      method: 'POST',
      body: { text: text.trim() },
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

async function deleteSir(requirementId, id) {
  if (!(await askConfirm('Delete this SIR and its indicators?'))) return;
  await requestJson(`${API}/requirements/${requirementId}/sirs/${id}`, { method: 'DELETE' });
  await loadAll();
  renderPanel();
}

async function addIndicator(requirementId, sirId, description, container) {
  if (!description.trim()) return;
  try {
    await requestJson(`${API}/requirements/${requirementId}/indicators`, {
      method: 'POST',
      body: { sir_id: sirId, description: description.trim() },
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

async function toggleIndicator(requirementId, indicator) {
  await requestJson(`${API}/requirements/${requirementId}/indicators/${indicator.id}`, {
    method: 'PATCH',
    body: { observed: !indicator.observed },
  });
  await loadAll();
  renderPanel();
}

async function deleteIndicator(requirementId, id) {
  await requestJson(`${API}/requirements/${requirementId}/indicators/${id}`, { method: 'DELETE' });
  await loadAll();
  renderPanel();
}

/** A relation badge plus the cited report (or "Report withdrawn" once the
 * report that supported it has been deleted — the link itself outlives the
 * report it cites, docs/adr/0002 + CONTEXT.md). Shown under the requirement
 * (blanket links) and each of its SIRs (`links` from the server shape). */
function renderEvidenceLinks(container, requirement, links) {
  if (!links.length) return;
  const list = createElement('ul', 'evidence-list');
  links.forEach((link) => {
    const item = createElement('li', 'evidence-item');
    item.append(createElement('span', `relation-badge relation-${link.relation}`, link.relation));
    if (link.withdrawn) {
      item.append(createElement('span', 'panel-note', 'Report withdrawn'));
    } else if (link.report) {
      item.append(
        createElement(
          'span',
          null,
          `${link.report.text} (Admiralty ${link.report.reliability}${link.report.credibility})`,
        ),
      );
    } else {
      item.append(createElement('span', 'panel-note', 'Report not visible'));
    }
    if (can('analyst') && canEditClient(requirement)) {
      const remove = createElement('button', 'icon-button danger', '×');
      remove.type = 'button';
      remove.title = 'Remove evidence link';
      remove.setAttribute('aria-label', 'Remove evidence link');
      remove.addEventListener('click', async () => {
        await requestJson(`${API}/requirements/${link.requirement_id}/evidence/${link.id}`, {
          method: 'DELETE',
        });
        await loadAll();
        renderPanel();
      });
      item.append(remove);
    }
    list.append(item);
  });
  container.append(list);
}

function renderSirRow(sir, requirement) {
  // C2b: release grants read only, so SIR/indicator edit/delete/add
  // controls need canEditClient on the parent requirement, not just the
  // analyst role — a cell it was only released to still sees them, greyed.
  const editable = can('analyst') && canEditClient(requirement);
  const row = createElement('div', 'sir-row');
  const header = createElement('div', 'sir-row-header');
  header.append(createElement('strong', null, sir.text));
  if (editable) {
    const deleteButton = createElement('button', 'icon-button danger', 'Delete');
    deleteButton.type = 'button';
    deleteButton.addEventListener('click', () => deleteSir(requirement.id, sir.id));
    header.append(deleteButton);
  }
  row.append(header, fulfillmentBar(sir.fulfillment));

  const indicatorList = createElement('ul', 'indicator-list');
  sir.indicators.forEach((indicator) => {
    const item = createElement('li', 'indicator-item');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = indicator.observed;
    checkbox.disabled = !editable;
    checkbox.addEventListener('change', () => toggleIndicator(requirement.id, indicator));
    const label = createElement('span', null, indicator.description);
    item.append(checkbox, label);
    if (editable) {
      const remove = createElement('button', 'icon-button danger', '×');
      remove.type = 'button';
      remove.title = 'Delete indicator';
      remove.setAttribute('aria-label', `Delete indicator ${indicator.description}`);
      remove.addEventListener('click', () => deleteIndicator(requirement.id, indicator.id));
      item.append(remove);
    }
    indicatorList.append(item);
  });
  row.append(indicatorList);
  renderEvidenceLinks(row, requirement, sir.links);

  if (editable) {
    const indicatorForm = createElement('div', 'inline-form');
    const indicatorInput = document.createElement('input');
    indicatorInput.type = 'text';
    indicatorInput.placeholder = 'Observable indicator…';
    const indicatorAdd = createElement('button', 'chip-button', 'Add indicator');
    indicatorAdd.type = 'button';
    indicatorAdd.addEventListener('click', () => {
      const value = indicatorInput.value;
      indicatorInput.value = '';
      addIndicator(requirement.id, sir.id, value, row);
    });
    indicatorForm.append(indicatorInput, indicatorAdd);
    row.append(indicatorForm);
  }

  return row;
}

async function deleteRequirement(id) {
  if (!(await askConfirm('Delete this requirement, its SIRs, and indicators?'))) return;
  await requestJson(`${API}/requirements/${id}`, { method: 'DELETE' });
  await loadAll();
  renderPanel();
}

function renderRequirementCard(requirement) {
  const card = createElement('article', 'requirement-card');
  const header = createElement('div', 'requirement-header');
  header.append(
    createElement('span', `kind-badge kind-${requirement.kind}`, requirement.kind),
    createElement('span', 'requirement-priority', `Priority ${requirement.priority}`),
    renderCellBadge(requirement.owner_cell),
  );
  if (requirement.source?.startsWith('ipb:')) {
    const badge = createElement('span', 'source-badge', 'From IPB');
    badge.title =
      'Derived from an IPB event matrix; re-importing that study refreshes its wording.';
    header.append(badge);
  }
  if (can('analyst') && canEditClient(requirement)) {
    const deleteButton = createElement('button', 'icon-button danger', 'Delete');
    deleteButton.type = 'button';
    deleteButton.addEventListener('click', () => deleteRequirement(requirement.id));
    header.append(deleteButton);
  }
  card.append(header);
  card.append(
    renderReleaseControl({
      item: requirement,
      onRelease: (cells) => releaseRequirement(requirement.id, cells),
    }),
  );
  appendOwnerReassign(card, requirement.owner_cell, (cell) =>
    reassignRequirementOwner(requirement.id, cell),
  );
  card.append(createElement('h3', null, requirement.text));
  const meta = createElement('p', 'panel-note');
  meta.textContent = `Decision point: ${requirement.decision_point || '—'} · LTIOV: ${formatDate(requirement.ltiov)}`;
  card.append(meta);
  card.append(fulfillmentBar(requirement.fulfillment));
  renderEvidenceLinks(card, requirement, requirement.links);

  const sirList = createElement('div', 'sir-list');
  requirement.sirs.forEach((sir) => sirList.append(renderSirRow(sir, requirement)));
  card.append(sirList);

  if (can('analyst') && canEditClient(requirement)) {
    const sirForm = createElement('div', 'inline-form');
    const sirInput = document.createElement('input');
    sirInput.type = 'text';
    sirInput.placeholder = 'What, where, when to observe…';
    const sirAdd = createElement('button', 'chip-button', 'Add SIR');
    sirAdd.type = 'button';
    sirAdd.addEventListener('click', () => {
      const value = sirInput.value;
      sirInput.value = '';
      addSir(requirement.id, value, card);
    });
    sirForm.append(sirInput, sirAdd);
    card.append(sirForm);
  }

  return card;
}

async function reassignRequirementOwner(id, ownerCell) {
  await requestJson(`${API}/requirements/${id}/owner`, {
    method: 'PATCH',
    body: { owner_cell: ownerCell },
  });
  await loadAll();
  renderPanel();
}

async function releaseRequirement(id, cells) {
  await requestJson(`${API}/requirements/${id}/release`, { method: 'POST', body: { cells } });
  await loadAll();
  renderPanel();
}

async function createRequirement(form, container) {
  const kind = form.querySelector('[name=kind]').value;
  const text = form.querySelector('[name=text]').value.trim();
  const priority = Number.parseInt(form.querySelector('[name=priority]').value, 10) || 0;
  const decisionPoint = form.querySelector('[name=decision_point]').value.trim();
  if (!text) return;
  try {
    const ltiov = readDtgValue(form.querySelector('[name=ltiov]'));
    await requestJson(`${API}/requirements`, {
      method: 'POST',
      body: {
        kind,
        text,
        priority,
        decision_point: decisionPoint || null,
        ltiov,
      },
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

/**
 * Sends only the event-matrix subset of the IPB study aggregate; the
 * exercise server (ipbImport.js) owns the mapping to PIR/SIR/indicator.
 * NAI *and* TAI layers go over as `nais[]` (with geometry, so `GET nais`
 * can point-in-polygon match reports and taskings can reference real
 * ground), and each event's `expected_time` is a formatted string — the
 * IPB server dropped that column, so it now lives in `expected_at` /
 * `expected_offset` plus the study's `h_hour`, resolved client-side with
 * `formatPlannedTime` because ipbImport.js still only reads text.
 */
async function importIpbStudy(studyId, container) {
  try {
    const { study, coas, events, features } = await requestJson(`${IPB_API}/studies/${studyId}`);
    const nais = features.filter((feature) => feature.layer === 'nai' || feature.layer === 'tai');
    const counts = await requestJson(`${API}/import/ipb`, {
      method: 'POST',
      body: {
        study: { id: study.id, name: study.name },
        coas: coas.map((coa) => ({ id: coa.id, name: coa.name, kind: coa.kind })),
        nais: nais.map((feature) => ({
          id: feature.id,
          label: feature.label,
          kind: feature.layer,
          geometry: feature.geometry ?? null,
        })),
        events: events.map((event) => ({
          id: event.id,
          coa_id: event.coa_id,
          nai_feature_id: event.nai_feature_id,
          indicator: event.indicator,
          expected_time: formatPlannedTime(
            { at: event.expected_at ?? null, offset: event.expected_offset ?? null },
            study.h_hour ?? null,
          ),
          observed_status: event.observed_status,
        })),
      },
    });
    state.importSummary = { study: study.name, counts, naiCount: nais.length };
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

function describeImport({ study, counts, naiCount }) {
  const part = (label, { created, updated, stale }) =>
    `${label} ${created} new, ${updated} updated${stale.length ? `, ${stale.length} no longer in IPB (kept)` : ''}`;
  const naiPart =
    naiCount === undefined ? '' : ` · ${naiCount} NAI/TAI feature${naiCount === 1 ? '' : 's'}`;
  return `Imported “${study}”: ${part('PIRs', counts.requirements)} · ${part('SIRs', counts.sirs)} · ${part('indicators', counts.indicators)}${naiPart}.`;
}

function renderIpbImport(container) {
  const section = createElement('section', 'field-group');
  section.append(
    createElement('h3', null, 'Import from IPB'),
    createElement(
      'p',
      'panel-note',
      'Each threat COA becomes a PIR, each NAI it uses a SIR, each event-matrix row an indicator. Re-importing refreshes wording and adds new rows; it never deletes, and keeps observations and evidence.',
    ),
  );
  if (!can('analyst')) {
    section.append(createElement('p', 'panel-note', 'Importing from IPB needs the analyst role.'));
    container.append(section);
    return;
  }
  const form = createElement('div', 'requirement-form');
  const select = document.createElement('select');
  select.name = 'study';
  select.disabled = true;
  select.append(new Option('Loading IPB studies…', ''));
  const button = createElement('button', 'primary-button', 'Import event matrix');
  button.type = 'button';
  button.disabled = true;
  button.addEventListener('click', () => importIpbStudy(select.value, section));
  form.append(select, button);
  section.append(form);
  if (state.importSummary) {
    section.append(createElement('p', 'panel-note', describeImport(state.importSummary)));
    const { counts } = state.importSummary;
    const stale = [...counts.requirements.stale, ...counts.sirs.stale, ...counts.indicators.stale];
    if (stale.length) {
      const list = createElement('ul', 'panel-note stale-list');
      stale.forEach((text) => list.append(createElement('li', null, text)));
      section.append(
        createElement('p', 'panel-note', 'No longer in IPB — delete below if not needed:'),
        list,
      );
    }
  }
  container.append(section);

  requestJson(`${IPB_API}/studies`)
    .then(({ items }) => {
      select.replaceChildren(
        ...(items.length
          ? items.map((study) => new Option(`${study.name} (${study.coa_count} COAs)`, study.id))
          : [new Option('No IPB studies yet', '')]),
      );
      select.disabled = button.disabled = !items.length;
    })
    .catch((error) => {
      if (error.name !== 'AbortError') showError(section, error.message);
    });
}

function renderRequirementsPanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'Requirements — CCIR / PIR / FFIR / SIR'));
  renderIpbImport(container);

  if (!can('analyst') || !hasCell()) {
    container.append(
      createElement('p', 'panel-note', 'Adding requirements needs the analyst role.'),
    );
  } else {
    const formSection = createElement('section', 'field-group');
    formSection.append(createElement('h3', null, 'New requirement'));
    const form = createElement('div', 'requirement-form');
    const kindSelect = document.createElement('select');
    kindSelect.name = 'kind';
    [
      ['PIR', 'PIR'],
      ['FFIR', 'FFIR'],
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      kindSelect.append(option);
    });
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.name = 'text';
    textInput.placeholder = 'Will the enemy attack before D+2?';
    const priorityInput = document.createElement('input');
    priorityInput.type = 'number';
    priorityInput.name = 'priority';
    priorityInput.placeholder = 'Priority';
    priorityInput.value = '0';
    const decisionInput = document.createElement('input');
    decisionInput.type = 'text';
    decisionInput.name = 'decision_point';
    decisionInput.placeholder = 'Decision point (optional)';
    const ltiovInput = createDtgInput({ name: 'ltiov', label: 'LTIOV', reference: scenarioNow });
    const addButton = createElement('button', 'primary-button', 'Add requirement');
    addButton.type = 'button';
    addButton.addEventListener('click', () => createRequirement(form, formSection));
    form.append(kindSelect, textInput, priorityInput, decisionInput, ltiovInput, addButton);
    formSection.append(form);
    container.append(formSection);
  }

  if (!state.requirements.length) {
    container.append(createElement('p', 'panel-note', 'No requirements yet.'));
    return;
  }
  const list = createElement('div', 'requirement-list');
  state.requirements.forEach((requirement) => list.append(renderRequirementCard(requirement)));
  container.append(list);
}

// --- Reports tab (reportForm.js's createReportsController owns the panel; this
// stays here because it needs state.requirements/sirs, passed through ctx.evidenceTargets) ---

function evidenceTargets() {
  const options = [];
  state.requirements.forEach((requirement) => {
    options.push({
      kind: 'requirement',
      id: requirement.id,
      // Evidence links are parts of the requirement they support
      // (CONTEXT.md): this is the `:item` reportForm.js posts/deletes
      // under, for both a blanket link and one against a SIR.
      requirement_id: requirement.id,
      label: `${requirement.kind} • ${requirement.text}`,
      // C2b: a SIR has no owner_cell of its own — it inherits the parent
      // requirement's, for reportForm.js's canEditClient gating (linking
      // evidence changes the target, not the report).
      owner_cell: requirement.owner_cell,
    });
    requirement.sirs.forEach((sir) => {
      options.push({
        kind: 'sir',
        id: sir.id,
        requirement_id: requirement.id,
        label: `↳ SIR • ${sir.text}`,
        owner_cell: requirement.owner_cell,
      });
    });
  });
  return options;
}

// --- RFI panel -----------------------------------------------------------------

async function createRfi(form, container) {
  const question = form.querySelector('[name=question]').value.trim();
  const priority = form.querySelector('[name=priority]').value;
  const target = form.querySelector('[name=target]').value;
  if (!question) return;
  const [kind, id] = target ? target.split(':') : [null, null];
  try {
    const nlt = readDtgValue(form.querySelector('[name=nlt]'));
    await requestJson(`${API}/rfis`, {
      method: 'POST',
      body: {
        question,
        priority,
        nlt,
        requirement_id: kind === 'requirement' ? Number.parseInt(id, 10) : null,
        sir_id: kind === 'sir' ? Number.parseInt(id, 10) : null,
      },
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

async function transitionRfi(rfi, toState, extra, container) {
  try {
    await requestJson(`${API}/rfis/${rfi.id}/transition`, {
      method: 'POST',
      body: { state: toState, ...extra },
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

async function deleteRfi(id) {
  if (!(await askConfirm('Delete this RFI?'))) return;
  await requestJson(`${API}/rfis/${id}`, { method: 'DELETE' });
  await loadAll();
  renderPanel();
}

async function releaseRfi(id, cells) {
  await requestJson(`${API}/rfis/${id}/release`, { method: 'POST', body: { cells } });
  await loadAll();
  renderPanel();
}

async function reassignRfiOwner(id, ownerCell) {
  await requestJson(`${API}/rfis/${id}/owner`, {
    method: 'PATCH',
    body: { owner_cell: ownerCell },
  });
  await loadAll();
  renderPanel();
}

function renderRfiRow(rfi) {
  const row = createElement('div', `rfi-row state-${rfi.state}`);
  const header = createElement('div', 'rfi-header');
  header.append(
    createElement('span', `rfi-state rfi-state-${rfi.state}`, rfi.state.replace('_', ' ')),
    createElement('span', `rfi-priority rfi-priority-${rfi.priority}`, rfi.priority),
    createElement('span', 'panel-note', `NLT: ${formatDate(rfi.nlt)}`),
    renderCellBadge(rfi.owner_cell),
  );
  if (can('analyst') && canEditClient(rfi)) {
    const deleteButton = createElement('button', 'icon-button danger', 'Delete');
    deleteButton.type = 'button';
    deleteButton.addEventListener('click', () => deleteRfi(rfi.id));
    header.append(deleteButton);
  }
  row.append(header);
  row.append(renderReleaseControl({ item: rfi, onRelease: (cells) => releaseRfi(rfi.id, cells) }));
  appendOwnerReassign(row, rfi.owner_cell, (cell) => reassignRfiOwner(rfi.id, cell));
  row.append(createElement('p', null, rfi.question));

  // C2b: release grants read only, so a cell this RFI was only released to
  // never gets transition controls; White answers, the owning cell submits/
  // assigns/rejects/closes its own.
  if (!can('analyst') || !canEditClient(rfi)) return row;
  const actions = createElement('div', 'rfi-actions');
  const nextStates = RFI_NEXT[rfi.state] || [];
  nextStates.forEach((toState) => {
    if (toState === 'answered') {
      if (!isWhite()) return;
      if (!state.reports.length) {
        actions.append(createElement('p', 'panel-note', 'Create a report to answer this RFI.'));
        return;
      }
      const select = document.createElement('select');
      state.reports.forEach((report) => {
        const option = document.createElement('option');
        option.value = String(report.id);
        option.textContent = report.text.slice(0, 40);
        select.append(option);
      });
      const answerButton = createElement('button', 'chip-button', 'Answer with report');
      answerButton.type = 'button';
      answerButton.addEventListener('click', () =>
        transitionRfi(
          rfi,
          'answered',
          { answer_report_id: Number.parseInt(select.value, 10) },
          row,
        ),
      );
      actions.append(select, answerButton);
      return;
    }
    const button = createElement('button', 'chip-button', toState.replace('_', ' '));
    button.type = 'button';
    button.addEventListener('click', () => transitionRfi(rfi, toState, {}, row));
    actions.append(button);
  });
  row.append(actions);
  return row;
}

function renderRfiPanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'RFI'));

  if (can('analyst') && hasCell()) {
    const formSection = createElement('section', 'field-group');
    formSection.append(createElement('h3', null, 'New RFI'));
    const form = createElement('div', 'requirement-form');
    const questionInput = document.createElement('input');
    questionInput.type = 'text';
    questionInput.name = 'question';
    questionInput.placeholder = 'Question…';
    const prioritySelect = document.createElement('select');
    prioritySelect.name = 'priority';
    ['routine', 'priority', 'immediate'].forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      prioritySelect.append(option);
    });
    const targetSelect = document.createElement('select');
    targetSelect.name = 'target';
    targetSelect.append(new Option('No linked requirement', ''));
    evidenceTargets().forEach((option) =>
      targetSelect.append(new Option(option.label, `${option.kind}:${option.id}`)),
    );
    const nltInput = createDtgInput({ name: 'nlt', label: 'NLT', reference: scenarioNow });
    const addButton = createElement('button', 'primary-button', 'Submit RFI');
    addButton.type = 'button';
    addButton.addEventListener('click', () => createRfi(form, formSection));
    form.append(questionInput, prioritySelect, targetSelect, nltInput, addButton);
    formSection.append(form);
    container.append(formSection);
  } else {
    container.append(createElement('p', 'panel-note', 'Submitting an RFI needs the analyst role.'));
  }

  if (!state.rfis.length) {
    container.append(createElement('p', 'panel-note', 'No RFIs yet.'));
    return;
  }
  const list = createElement('div', 'rfi-list');
  state.rfis.forEach((rfi) => list.append(renderRfiRow(rfi)));
  container.append(list);
}

// --- Scenario panel --------------------------------------------------------

function updateMastheadStatus() {
  if (!elements.statusText || !state.clock) return;
  elements.statusText.textContent = state.clock.paused
    ? 'Clock paused'
    : `Clock running ×${state.clock.rate}`;
}

async function patchClock(body, container) {
  try {
    await requestJson(`${API}/clock`, { method: 'PATCH', body });
    await loadAll();
    renderPanel();
    updateMastheadStatus();
  } catch (error) {
    showError(container, error.message);
  }
}

async function createScenarioEvent(refs, container) {
  const kind = refs.kindSelect.value;
  let triggerAt;
  try {
    triggerAt = readDtgValue(refs.triggerInput);
  } catch (error) {
    showError(container, error.message);
    return;
  }
  if (!triggerAt) return;
  let payload;
  if (kind === 'message') {
    const text = refs.textInput.value.trim();
    if (!text) return;
    payload = { text };
  } else {
    const values = refs.reportFieldset.getValue();
    if (!values.text) {
      showError(container, 'Narrative text is required.');
      return;
    }
    payload = {
      text: values.text,
      report_type: values.report_type,
      fields: values.fields,
      sidc: values.sidc,
      lon: values.lon,
      lat: values.lat,
      reliability: refs.reliabilitySelect.value,
      credibility: Number.parseInt(refs.credibilitySelect.value, 10),
    };
  }
  payload.release_to = refs.releaseTo;
  try {
    await requestJson(`${API}/scenario-events`, {
      method: 'POST',
      body: { trigger_at: triggerAt, kind, payload },
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

async function fireEventNow(id) {
  await requestJson(`${API}/scenario-events/${id}/fire`, { method: 'POST' });
  await loadAll();
  renderPanel();
}

async function cancelEvent(id) {
  await requestJson(`${API}/scenario-events/${id}/cancel`, { method: 'POST' });
  await loadAll();
  renderPanel();
}

function renderScenarioEventRow(event) {
  const row = createElement('div', `scenario-event-row state-${event.state}`);
  const mgrs = formatReportLocationMgrs(event.payload);
  const targets = event.payload.release_to || [];
  row.append(
    createElement('span', `scenario-event-kind kind-${event.kind}`, event.kind),
    createElement('span', null, formatDate(event.trigger_at)),
    createElement('span', null, event.payload.text || ''),
    createElement('span', 'panel-note', mgrs || ''),
    createElement(
      'span',
      'panel-note',
      `To: ${targets.length ? targets.map((cell) => cell[0].toUpperCase() + cell.slice(1)).join(', ') : '—'}`,
    ),
    createElement('span', `scenario-event-state`, event.state),
  );
  if (event.state === 'pending') {
    const fireButton = createElement('button', 'icon-button', 'Fire now');
    fireButton.type = 'button';
    fireButton.addEventListener('click', () => fireEventNow(event.id));
    const cancelButton = createElement('button', 'icon-button danger', 'Cancel');
    cancelButton.type = 'button';
    cancelButton.addEventListener('click', () => cancelEvent(event.id));
    row.append(fireButton, cancelButton);
  }
  return row;
}

function renderScenarioPanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'Scenario clock & injects'));

  const clockSection = createElement('section', 'field-group clock-panel');
  const clock = state.clock;
  clockSection.append(
    createElement('p', 'clock-now', `Scenario time: ${formatDate(clock.now)}`),
    createElement(
      'p',
      'panel-note',
      `Rate ${clock.rate}× · ${clock.paused ? 'Paused' : 'Running'}`,
    ),
  );
  const controls = createElement('div', 'inline-form');
  const toggleButton = createElement('button', 'primary-button', clock.paused ? 'Resume' : 'Pause');
  toggleButton.type = 'button';
  toggleButton.addEventListener('click', () => patchClock({ paused: !clock.paused }, clockSection));
  const rateInput = document.createElement('input');
  rateInput.type = 'number';
  rateInput.min = '0.1';
  rateInput.step = '0.1';
  rateInput.value = String(clock.rate);
  const rateButton = createElement('button', 'chip-button', 'Set rate');
  rateButton.type = 'button';
  rateButton.addEventListener('click', () =>
    patchClock({ rate: Number.parseFloat(rateInput.value) }, clockSection),
  );
  const jumpInput = createDtgInput({ name: 'jump_to', label: 'Jump to', reference: scenarioNow });
  const jumpButton = createElement('button', 'chip-button', 'Jump to');
  jumpButton.type = 'button';
  jumpButton.addEventListener('click', () => {
    try {
      const jumpTo = readDtgValue(jumpInput);
      if (jumpTo) patchClock({ jump_to: jumpTo }, clockSection);
    } catch (error) {
      showError(clockSection, error.message);
    }
  });
  const tickButton = createElement('button', 'chip-button', 'Fire due events now');
  tickButton.type = 'button';
  tickButton.addEventListener('click', async () => {
    // No bulk tick route (docs/adr/0002-item-scoped-requests.md): each due
    // event is announced only to its own inject's cells, so it's fired one
    // request at a time — exactly what the server's own 5-second ticker
    // does internally, just triggered now instead of waited for.
    const nowMs = scenarioNow();
    const due = state.scenarioEvents.filter(
      (event) => event.state === 'pending' && new Date(event.trigger_at).getTime() <= nowMs,
    );
    for (const event of due) {
      await requestJson(`${API}/scenario-events/${event.id}/fire`, { method: 'POST' });
    }
    await loadAll();
    renderPanel();
  });
  controls.append(toggleButton, rateInput, rateButton, jumpInput, jumpButton, tickButton);
  // Running the scenario clock is exercise control, the game-master's job.
  if (can('game-master')) clockSection.append(controls);
  container.append(clockSection);

  injectReportFieldset?.destroy();
  injectReportFieldset = null;
  const formSection = createElement('section', 'field-group');
  formSection.append(createElement('h3', null, 'Schedule an inject'));
  if (!can('game-master')) {
    formSection.append(
      createElement('p', 'panel-note', 'Game Master role required to schedule injects.'),
    );
    container.append(formSection);
  } else {
    const form = createElement('div', 'requirement-form inject-form');
    const kindSelect = document.createElement('select');
    kindSelect.setAttribute('aria-label', 'Inject kind');
    kindSelect.append(new Option('Message', 'message'), new Option('Report', 'report'));
    const triggerInput = createDtgInput({
      name: 'trigger_at',
      label: 'Trigger time',
      reference: scenarioNow,
    });
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.placeholder = 'Inject text…';
    textInput.setAttribute('aria-label', 'Inject text');
    // 'report'-kind injects reuse the Reports tab's type/fields/location/sidc
    // fieldset, so the Game Master can pre-script a located SALUTE/SPOTREP.
    injectReportFieldset = createReportFieldset({ ariaLabel: 'Inject location' });
    injectReportFieldset.element.hidden = true;
    const reliabilitySelect = document.createElement('select');
    reliabilitySelect.setAttribute('aria-label', 'Reliability');
    reliabilitySelect.hidden = true;
    appendReliabilityOptions(reliabilitySelect);
    const credibilitySelect = document.createElement('select');
    credibilitySelect.setAttribute('aria-label', 'Credibility');
    credibilitySelect.hidden = true;
    appendCredibilityOptions(credibilitySelect);
    kindSelect.addEventListener('change', () => {
      const isReport = kindSelect.value === 'report';
      textInput.hidden = isReport;
      injectReportFieldset.element.hidden = !isReport;
      reliabilitySelect.hidden = !isReport;
      credibilitySelect.hidden = !isReport;
    });
    // Who the fired inject reaches (C3): Blue by default, the usual
    // training audience; White is never offered — a White-released inject
    // to White is a no-op the owner already sees.
    const releaseFieldset = document.createElement('fieldset');
    releaseFieldset.className = 'inject-release';
    releaseFieldset.append(createElement('legend', null, 'Release to'));
    const releaseChecks = { blue: null, red: null };
    ['blue', 'red'].forEach((cell) => {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = cell;
      checkbox.checked = cell === 'blue';
      releaseChecks[cell] = checkbox;
      label.append(checkbox, ` ${cell[0].toUpperCase()}${cell.slice(1)}`);
      releaseFieldset.append(label);
    });
    const addButton = createElement('button', 'primary-button', 'Schedule');
    addButton.type = 'button';
    addButton.addEventListener('click', () =>
      createScenarioEvent(
        {
          kindSelect,
          triggerInput,
          textInput,
          reportFieldset: injectReportFieldset,
          reliabilitySelect,
          credibilitySelect,
          releaseTo: Object.entries(releaseChecks)
            .filter(([, checkbox]) => checkbox.checked)
            .map(([cell]) => cell),
        },
        formSection,
      ),
    );
    form.append(
      kindSelect,
      triggerInput,
      textInput,
      injectReportFieldset.element,
      reliabilitySelect,
      credibilitySelect,
      releaseFieldset,
      addButton,
    );
    formSection.append(form);
    container.append(formSection);
  }

  if (!state.scenarioEvents.length) {
    container.append(createElement('p', 'panel-note', 'No injects scheduled.'));
  } else {
    const list = createElement('div', 'scenario-event-list');
    state.scenarioEvents.forEach((event) => list.append(renderScenarioEventRow(event)));
    container.append(list);
  }

  renderMessagesSection(container);
}

// --- Messages panel (fired MESSAGE injects, filtered to the user's cell) ---

/** Fired MESSAGE injects the current cell can see (C1/C4): the Scenario
 * tab's own notice board, alongside the clock and the inject schedule. */
function renderMessagesSection(container) {
  const section = createElement('section', 'field-group messages-section');
  section.append(createElement('h3', null, 'Messages'));
  if (!state.messages.length) {
    section.append(createElement('p', 'panel-note', 'No messages for your cell.'));
    container.append(section);
    return;
  }
  const list = createElement('div', 'message-list');
  // Newest first (already the API's own order — listMessages sorts
  // fired_at DESC — kept explicit here so a live-pushed update can't
  // silently reorder the list out from under a re-render).
  [...state.messages]
    .sort((a, b) => (a.fired_at < b.fired_at ? 1 : a.fired_at > b.fired_at ? -1 : 0))
    .forEach((message) => {
      const row = createElement('div', 'message-row');
      row.append(createElement('span', 'message-dtg', formatDate(message.fired_at)));
      row.append(renderCellBadge(message.owner_cell));
      row.append(createElement('span', 'message-text', message.text));
      list.append(row);
    });
  section.append(list);
  container.append(section);
}

// --- Activity panel --------------------------------------------------------

function exportActivity() {
  const blob = new Blob([JSON.stringify(state.activity, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `activity-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** The game-master's cross-module audit trail (`GET /api/auth/audit`): only meaningful
 * in LAN/auth mode (`sessionMode() === 'on'`), where users and roles actually exist. */
async function loadAudit(offset = 0) {
  try {
    const result = await requestJson(`/api/auth/audit?limit=${state.audit.limit}&offset=${offset}`);
    state.audit = {
      ...state.audit,
      items: result.items,
      total: result.total,
      offset,
      loaded: true,
    };
    if (state.tab === 'activity') renderPanel();
  } catch (error) {
    if (error.name !== 'AbortError') {
      state.audit = { ...state.audit, loaded: true };
    }
  }
}

function renderAuditSection(container) {
  if (sessionMode() !== 'on' || !can('game-master')) return;
  const section = createElement('section', 'field-group audit-section');
  section.append(createElement('h3', null, 'Audit trail'));
  if (!state.audit.loaded) {
    section.append(createElement('p', 'panel-note', 'Loading audit trail\u2026'));
    container.append(section);
    loadAudit(state.audit.offset);
    return;
  }
  if (!state.audit.items.length) {
    section.append(createElement('p', 'panel-note', 'No audited requests yet.'));
    container.append(section);
    return;
  }
  const table = document.createElement('table');
  table.className = 'data-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['At', 'User', 'Method', 'Path', 'Status'].forEach((label) =>
    headRow.append(createElement('th', null, label)),
  );
  head.append(headRow);
  table.append(head);
  const body = document.createElement('tbody');
  state.audit.items.forEach((entry) => {
    const row = document.createElement('tr');
    row.append(
      createElement('td', null, formatDtg(new Date(entry.at).getTime())),
      createElement('td', null, entry.user || '—'),
      createElement('td', null, entry.method),
      createElement('td', null, entry.path),
      createElement('td', null, String(entry.status)),
    );
    body.append(row);
  });
  table.append(body);
  section.append(table);

  const pager = createElement('div', 'inline-form');
  const prevButton = createElement('button', 'chip-button', 'Newer');
  prevButton.type = 'button';
  prevButton.disabled = state.audit.offset <= 0;
  prevButton.addEventListener('click', () =>
    loadAudit(Math.max(0, state.audit.offset - state.audit.limit)),
  );
  const nextButton = createElement('button', 'chip-button', 'Older');
  nextButton.type = 'button';
  nextButton.disabled = state.audit.offset + state.audit.limit >= state.audit.total;
  nextButton.addEventListener('click', () => loadAudit(state.audit.offset + state.audit.limit));
  pager.append(
    prevButton,
    createElement(
      'span',
      'panel-note',
      `${state.audit.offset + 1}\u2013${Math.min(state.audit.offset + state.audit.limit, state.audit.total)} of ${state.audit.total}`,
    ),
    nextButton,
  );
  section.append(pager);
  container.append(section);
}

function renderActivityPanel() {
  const container = elements.panel;
  const header = createElement('div', 'panel-header-row');
  header.append(createElement('h2', null, 'Activity (AAR)'));
  const exportButton = createElement('button', 'chip-button', 'Export JSON');
  exportButton.type = 'button';
  exportButton.addEventListener('click', exportActivity);
  header.append(exportButton);
  container.append(header);

  if (!state.activity.length) {
    container.append(createElement('p', 'panel-note', 'No activity recorded yet.'));
  } else {
    const table = document.createElement('table');
    table.className = 'data-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['At', 'Action', 'Target'].forEach((label) => headRow.append(createElement('th', null, label)));
    head.append(headRow);
    table.append(head);
    const body = document.createElement('tbody');
    state.activity.forEach((entry) => {
      const row = document.createElement('tr');
      row.append(
        createElement('td', null, formatDate(entry.at)),
        createElement('td', null, entry.action),
        createElement('td', null, entry.target),
      );
      body.append(row);
    });
    table.append(body);
    container.append(table);
  }
  renderAuditSection(container);
}

// --- Mount -------------------------------------------------------------------

export function mount({ root, status }) {
  root.innerHTML = template;
  state = createState();
  elements = queryElements(root);
  createDialogNode(root);
  const { session } = state;

  // Shared plumbing every tab controller (collection.js, products.js) gets, built
  // once so they all use the exact same dialog/request/error affordances view.js
  // already has instead of re-implementing them. reportsController also needs
  // evidenceTargets() (view.js-local: reads state.requirements/sirs); situationController
  // needs switchTab to jump to the Reports tab from a linked report.
  const ctx = {
    requestJson,
    createElement,
    askText,
    askConfirm,
    showError,
    formatDate,
    api: API,
    evidenceTargets,
    switchTab,
  };
  collectionController = createCollectionController(ctx);
  productsController = createProductsController(ctx);
  reportsController = createReportsController(ctx);
  situationController = createSituationController(ctx);

  const statusLight = createElement('span', 'status-light');
  const statusText = createElement('span', null, 'Exercise workbench');
  status.replaceChildren(statusLight, statusText);
  elements.statusText = statusText;

  elements.tabNav.addEventListener('click', (event) => {
    const button = event.target.closest('.tab-button');
    if (!button) return;
    switchTab(button.dataset.tab);
  });
  document.addEventListener('keydown', onGeoKeydown);

  readLocation();
  renderTabNav();

  loadAll()
    .then(() => {
      renderPanel();
      updateMastheadStatus();
    })
    .catch((error) => {
      if (error.name === 'AbortError') return;
      elements.panel.replaceChildren(createElement('p', 'inline-error', error.message));
    });

  // The server fires due injects on scenario time (see routes.js `connect`);
  // refresh the inject list and masthead when it announces that it did —
  // one live event per fired inject now (docs/adr/0002-item-scoped-requests.md:
  // each is announced only to its own cells), not one flat tick.
  state.unsubscribeTick = subscribe(
    (event) => event.module === 'exercise' && /^scenario-events\/\d+\/fire$/.test(event.route),
    async () => {
      try {
        await loadAll();
        updateMastheadStatus();
        if (state.tab === 'scenario') renderPanel();
      } catch (error) {
        if (error.name !== 'AbortError') throw error;
      }
    },
  );

  return () => {
    state.unsubscribeTick();
    document.removeEventListener('keydown', onGeoKeydown);
    destroyGeoMap();
    collectionController.leave();
    productsController.leave();
    reportsController.leave();
    situationController.leave();
    injectReportFieldset?.destroy();
    session.abort();
    root.replaceChildren();
  };
}
