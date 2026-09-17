import './styles.css';
import template from './view.html?raw';

import { createMap } from '../../../src/map.js';
import { formatArea, formatMetres, formatMgrs, parseCoordinate } from '../../../src/geo.js';

const API = '/api/ipb';
const TERRAIN_API = '/api/terrain';
const EQUIPMENT_API = '/api/equipment';

const DEFAULT_CENTER = [17.5, 49.7];
const DEFAULT_ZOOM = 11;

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
const VIEWSHED_PALETTE = {
  0: 'rgba(31, 65, 76, 0.35)',
  1: 'rgba(216, 91, 43, 0.55)',
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

// --- State & elements ------------------------------------------------------

function createState() {
  return {
    session: new AbortController(),
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
    viewshedResult: null,
    mobility: { cell: 100, opacity: 0.55, grid: null, running: false },
    selectedFeatureId: null,
    selectedCoaId: null,
    terrainMeta: null,
    equipmentQuery: '',
    equipmentResults: [],
    equipmentLoading: false,
    equipmentRequest: null,
    equipmentBookmarks: [],
    studyRequest: null,
    timers: new Map(),
  };
}

function queryElements(root) {
  const pick = (selector) => root.querySelector(selector);
  return {
    printButton: pick('#print-worksheet'),
    studyToggle: pick('#study-toggle'),
    studyName: pick('#study-name'),
    studyMenu: pick('#study-menu'),
    studySearch: pick('#study-search'),
    studyList: pick('#study-list'),
    createStudy: pick('#create-study'),
    stepTitle: pick('#step-title'),
    stepNav: pick('#step-nav'),
    toolPanel: pick('#tool-panel'),
    mapTarget: pick('#map-target'),
    pointerMgrs: pick('#pointer-mgrs'),
    mapHint: pick('#map-hint'),
    mapClickInfo: pick('#map-click-info'),
    mapEmpty: pick('#map-empty'),
    mapEmptyCreate: pick('#map-empty-create'),
    worksheetStudyName: pick('#worksheet-study-name'),
    worksheet1: pick('#worksheet-1'),
    worksheet2: pick('#worksheet-2'),
    worksheet3: pick('#worksheet-3'),
    worksheet4: pick('#worksheet-4'),
  };
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
  const actions = createElement('div', 'dialog-actions');
  const cancel = createElement('button', 'text-button', 'Cancel');
  cancel.type = 'submit';
  cancel.value = 'cancel';
  const accept = createElement('button', 'dialog-accept');
  accept.type = 'submit';
  accept.value = 'accept';
  actions.append(cancel, accept);
  form.append(message, input, actions);
  dialogNode.append(form);
  root.append(dialogNode);
}

function openDialog({ message, initial, accept, withInput }) {
  dialogNode.querySelector('.dialog-message').textContent = message;
  const input = dialogNode.querySelector('.dialog-input');
  input.hidden = !withInput;
  input.value = initial ?? '';
  dialogNode.querySelector('.dialog-accept').textContent = accept;
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

function askConfirm(message, accept = 'Delete') {
  return openDialog({ message, accept, withInput: false });
}

/** Every request dies with its mount, so a stale view never touches a newer one. */
async function requestJson(path, { method = 'GET', body, signal = state.session.signal } = {}) {
  const options = { method, signal };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
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
  source.append(light, createElement('span', null, 'Local workbench'));
  const list = createElement('dl', 'header-stats');
  list.setAttribute('aria-label', 'Workspace status');
  const studyTerm = createElement('div');
  elements.statusStudy = createElement('dd', null, 'None');
  studyTerm.append(createElement('dt', null, 'Study'), elements.statusStudy);
  const datasetTerm = createElement('div');
  elements.statusDataset = createElement('dd', null, '—');
  datasetTerm.append(createElement('dt', null, 'Elevation'), elements.statusDataset);
  const pointerTerm = createElement('div');
  elements.statusPointer = createElement('dd', null, '—');
  pointerTerm.append(createElement('dt', null, 'Pointer'), elements.statusPointer);
  list.append(studyTerm, datasetTerm, pointerTerm);
  status.replaceChildren(source, list);
}

// --- Study management ------------------------------------------------------

function toggleStudyMenu(force) {
  const next = force ?? elements.studyMenu.hidden;
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
  body.append(open, meta);
  const actions = createElement('div', 'study-row-actions');
  const rename = createElement('button', 'icon-button', 'Rename');
  rename.type = 'button';
  rename.addEventListener('click', () => renameStudy(study));
  const remove = createElement('button', 'icon-button danger', 'Delete');
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
  const name = await askText('Name for the new study', '', 'Create');
  if (!name) return;
  clearError(elements.studyMenu);
  try {
    const study = await requestJson(`${API}/studies`, { method: 'POST', body: { name } });
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
      elements.statusStudy.textContent = name;
    }
    renderStudyList();
  } catch (error) {
    showError(elements.studyMenu, error.message);
  }
}

async function deleteStudy(study) {
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
  state.losPicks = [];
  state.losResult = null;
  state.viewshedResult = null;
  state.mobility.grid = null;
  state.tool = null;
  renderEmptyState();
  try {
    const payload = await requestJson(`${API}/studies/${id}`, {
      signal: AbortSignal.any([controller.signal, state.session.signal]),
    });
    if (controller.signal.aborted) return;
    state.study = payload;
    renderStudyLoaded();
    writeLocation();
  } catch (error) {
    if (error.name === 'AbortError') return;
    showError(elements.toolPanel, error.message);
  }
}

function renderEmptyState() {
  elements.mapEmpty.hidden = false;
  elements.studyName.textContent = 'No study selected';
  elements.worksheetStudyName.textContent = 'No study open';
  elements.statusStudy.textContent = 'None';
  updateStepNavAvailability();
  renderToolPanel();
  [1, 2, 3, 4].forEach((step) => {
    elements[`worksheet${step}`].replaceChildren(
      createElement('p', 'panel-note', 'Select or create a study to see this step.'),
    );
  });
  if (mapController) {
    mapController.setFeatures([]);
    mapController.clearGrid('mobility');
    mapController.clearGrid('viewshed');
  }
}

function renderStudyLoaded() {
  const study = state.study.study;
  elements.studyName.textContent = study.name;
  elements.worksheetStudyName.textContent = study.name;
  elements.statusStudy.textContent = study.name;
  elements.mapEmpty.hidden = true;
  updateStepNavAvailability();
  renderToolPanel();
  renderStep1Worksheet();
  renderStep2Worksheet();
  renderStep3Worksheet();
  renderStep4Worksheet();
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
  elements.stepTitle.textContent = STEP_NAMES[state.step];
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
  state.step = step;
  renderStepChrome();
  writeLocation();
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
  if (study.aoi) {
    features.push({
      id: 'aoi',
      layer: 'aoi',
      kind: 'polygon',
      label: 'AOI',
      geometry: study.aoi,
      properties: {},
    });
  }
  const byLayer = (layer) => state.study.features.filter((feature) => feature.layer === layer);
  OAKOC_LAYERS.forEach((layer) => features.push(...byLayer(layer)));
  if (state.step === 4) {
    // NAI and TAI stay visible: the event template ties them to the COAs.
    features.push(...byLayer('nai'), ...byLayer('tai'));
    const sketches = byLayer('coa');
    features.push(
      ...(state.selectedCoaId
        ? sketches.filter(
            (feature) => String(feature.properties?.coa_id) === String(state.selectedCoaId),
          )
        : sketches),
    );
  }
  state.losPicks.forEach((pick, index) => {
    features.push({
      id: `los-pick-${index}`,
      layer: 'note',
      kind: 'point',
      label: index === 0 ? 'Observer' : 'Target',
      geometry: { type: 'Point', coordinates: [pick.lon, pick.lat] },
      properties: {},
    });
  });
  return features;
}

function syncMapFeatures() {
  mapController?.setFeatures(visibleFeatures());
}

function reRenderContainingWorksheet(layer) {
  if (OAKOC_LAYERS.includes(layer)) renderStep2Worksheet();
  else if (layer === 'nai' || layer === 'tai' || layer === 'coa') renderStep4Worksheet();
}

function cancelActiveTool() {
  if (!state.tool) return;
  if (state.tool.type === 'draw-feature') mapController.cancelDraw();
  state.tool = null;
  state.losPicks = [];
  renderMapHint('');
  syncMapFeatures();
  renderToolPanel();
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

function onMapPointerMove({ lon, lat }) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  const label = formatMgrs(lon, lat);
  elements.pointerMgrs.textContent = label;
  if (elements.statusPointer) elements.statusPointer.textContent = label;
}

function onMapClick({ lon, lat }) {
  const tool = state.tool;
  if (!tool) {
    if (state.step === 2) showElevationReadout(lon, lat);
    return;
  }
  if (tool.type === 'los-pick') {
    handleLosPick(lon, lat);
    return;
  }
  if (tool.type === 'viewshed-pick') {
    handleViewshedPick(lon, lat);
  }
}

async function handleAoiDrawn(geometry) {
  state.tool = null;
  renderMapHint('');
  const bounds = geometryBounds(geometry);
  try {
    const updated = await requestJson(`${API}/studies/${state.studyId}`, {
      method: 'PATCH',
      body: { aoi: geometry, bounds },
    });
    state.study.study = { ...state.study.study, ...updated, aoi: geometry, bounds };
    syncMapFeatures();
    renderStep1Worksheet();
    if (state.step === 2) renderToolPanel();
    mapController.fitExtent(bounds);
  } catch (error) {
    showError(elements.worksheet1, error.message);
  }
}

async function handleFeatureDrawn(tool, kind, geometry) {
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
  const tool = state.tool;
  if (!tool || tool.type !== 'draw-feature') return;
  if (tool.layer === 'aoi') {
    handleAoiDrawn(geometry);
    return;
  }
  handleFeatureDrawn(tool, kind, geometry);
}

async function handleFeatureModified(id, geometry) {
  const feature = state.study.features.find((entry) => String(entry.id) === String(id));
  if (!feature) return;
  try {
    const updated = await requestJson(`${API}/features/${id}`, {
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
  if (id === 'aoi') {
    handleAoiDrawn(geometry);
    return;
  }
  handleFeatureModified(id, geometry);
}

// --- Shared feature list / draw button widgets --------------------------

function renderFeatureRow(feature) {
  const row = createElement('li', 'feature-row');
  if (String(feature.id) === String(state.selectedFeatureId)) row.classList.add('active');
  row.append(createElement('span', 'feature-label', feature.label));
  const actions = createElement('span', 'row-actions');
  const selectButton = createElement('button', 'icon-button', 'Select');
  selectButton.type = 'button';
  selectButton.addEventListener('click', () => {
    state.selectedFeatureId = feature.id;
    mapController.selectFeature(feature.id);
    writeLocation();
    reRenderContainingWorksheet(feature.layer);
  });
  const zoomButton = createElement('button', 'icon-button', 'Zoom');
  zoomButton.type = 'button';
  zoomButton.addEventListener('click', () => mapController.fitFeature(feature.id));
  const renameButton = createElement('button', 'icon-button', 'Rename');
  renameButton.type = 'button';
  renameButton.addEventListener('click', () => renameFeature(feature));
  const deleteButton = createElement('button', 'icon-button danger', 'Delete');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteFeature(feature));
  actions.append(selectButton, zoomButton, renameButton, deleteButton);
  row.append(actions);
  return row;
}

async function renameFeature(feature) {
  const label = await askText('Rename', feature.label);
  if (!label || label === feature.label) return;
  try {
    const updated = await requestJson(`${API}/features/${feature.id}`, {
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
  if (!(await askConfirm(`Delete "${feature.label}"?`))) return;
  try {
    await requestJson(`${API}/features/${feature.id}`, { method: 'DELETE' });
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
  const coaId = layer === 'coa' ? state.selectedCoaId : undefined;
  state.tool = { type: 'draw-feature', layer, kind, coaId };
  mapController.startDraw(kind, { layer });
  renderMapHint(
    `Draw a ${KIND_LABELS[kind].toLowerCase()} ${FEATURE_LAYERS[layer].label.toLowerCase()}. Press Escape to cancel.`,
  );
}

function renderDrawButtons(layer) {
  const group = createElement('div', 'draw-buttons');
  FEATURE_LAYERS[layer].kinds.forEach((kind) => {
    const button = createElement('button', 'chip-button', KIND_LABELS[kind]);
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

  const aoiGroup = createElement('div', 'field-group');
  aoiGroup.append(createElement('h3', null, 'Area of interest'));
  const drawButton = createElement('button', 'primary-button', 'Draw AOI');
  drawButton.type = 'button';
  drawButton.addEventListener('click', () => {
    state.tool = { type: 'draw-feature', layer: 'aoi', kind: 'polygon' };
    mapController.startDraw('polygon', { layer: 'aoi' });
    renderMapHint('Draw the area of interest polygon. Press Escape to cancel.');
  });
  aoiGroup.append(
    drawButton,
    createElement('p', 'tool-hint', 'Redrawing replaces the current AOI.'),
  );
  container.append(aoiGroup);

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

  return container;
}

function renderStep1Worksheet() {
  const container = elements.worksheet1;
  container.replaceChildren();
  if (!state.study) return;
  const study = state.study.study;
  container.append(createElement('h3', null, '1 · Define the operational environment'));

  const facts = createElement('dl', 'fact-list');
  const bounds = study.bounds;
  facts.append(
    createElement('dt', null, 'AOI envelope'),
    createElement(
      'dd',
      null,
      bounds
        ? `${formatMgrs(bounds[0], bounds[1])} → ${formatMgrs(bounds[2], bounds[3])}`
        : 'Not drawn yet',
    ),
    createElement('dt', null, 'AOI area'),
    createElement('dd', null, study.aoi ? formatArea(polygonAreaSquareKm(study.aoi)) : '—'),
  );
  container.append(facts);

  const noteLabel = createElement('label', 'field-label', 'Environment notes');
  noteLabel.setAttribute('for', 'step1-note');
  const textarea = document.createElement('textarea');
  textarea.id = 'step1-note';
  textarea.className = 'note-field';
  textarea.rows = 10;
  textarea.placeholder = 'Terrain, weather, civil considerations…';
  textarea.value = study.notes?.step1 || '';
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

function armViewshedTool() {
  state.tool = { type: 'viewshed-pick' };
  state.viewshedResult = null;
  renderMapHint('Click the observer position.');
  renderToolPanel();
}

async function handleViewshedPick(lon, lat) {
  state.tool = null;
  renderMapHint('');
  const params = new URLSearchParams({
    at: `${lon},${lat}`,
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
    const visibleAreaKm = (grid.visibleCells * grid.cellMetres * grid.cellMetres) / 1_000_000;
    const analysis = await requestJson(`${API}/studies/${state.studyId}/analyses`, {
      method: 'POST',
      body: {
        kind: 'viewshed',
        params: { lon, lat, ...state.viewshedForm },
        summary: {
          visibleCells: grid.visibleCells,
          cellMetres: grid.cellMetres,
          radiusMetres: grid.radiusMetres,
          visibleAreaSquareKm: visibleAreaKm,
        },
      },
    });
    state.study.analyses.push(analysis);
  } catch (error) {
    showError(elements.worksheet2, error.message);
  } finally {
    renderToolPanel();
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

    const runButton = createElement(
      'button',
      'primary-button',
      state.mobility.running ? 'Running…' : 'Run MCOO',
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
  const losButton = createElement(
    'button',
    'chip-button',
    state.tool?.type === 'los-pick' ? 'Picking…' : 'Pick two points',
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
  const viewshedButton = createElement(
    'button',
    'chip-button',
    state.tool?.type === 'viewshed-pick' ? 'Picking…' : 'Pick observer',
  );
  viewshedButton.type = 'button';
  viewshedButton.addEventListener('click', armViewshedTool);
  viewshedGroup.append(viewshedButton);
  container.append(viewshedGroup);

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
  if (!state.viewshedResult && savedViewshed) {
    const summary = savedViewshed.summary;
    viewshedSection.append(
      createElement(
        'p',
        null,
        `Visible area ${formatArea(summary.visibleAreaSquareKm)} within ${formatMetres(summary.radiusMetres)} of the observer.`,
      ),
      createElement('p', 'panel-note', 'Saved run. Pick an observer to paint it again.'),
    );
  } else if (!state.viewshedResult) {
    viewshedSection.append(createElement('p', 'panel-note', 'No viewshed computed yet.'));
  } else {
    const visibleAreaKm =
      (state.viewshedResult.visibleCells * state.viewshedResult.cellMetres ** 2) / 1_000_000;
    viewshedSection.append(
      createElement(
        'p',
        null,
        `Visible area ${formatArea(visibleAreaKm)} within ${formatMetres(state.viewshedResult.radiusMetres)} of the observer.`,
      ),
    );
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
async function reorderChild(kind, id, direction, worksheetElement, rerender) {
  try {
    const result = await requestJson(`${API}/${kind}/${id}/reorder`, {
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
  const wrap = createElement('span', 'reorder-buttons');
  const up = createElement('button', 'icon-button', '↑');
  up.type = 'button';
  up.title = 'Move up';
  up.disabled = index === 0;
  up.addEventListener('click', () => reorderChild(kind, item.id, 'up', worksheetElement, rerender));
  const down = createElement('button', 'icon-button', '↓');
  down.type = 'button';
  down.title = 'Move down';
  down.disabled = index === total - 1;
  down.addEventListener('click', () =>
    reorderChild(kind, item.id, 'down', worksheetElement, rerender),
  );
  wrap.append(up, down);
  return wrap;
}

async function patchThreat(threat, body) {
  try {
    const updated = await requestJson(`${API}/threats/${threat.id}`, { method: 'PATCH', body });
    Object.assign(threat, updated);
  } catch (error) {
    showError(elements.worksheet3, error.message);
  }
}

async function deleteThreat(threat) {
  if (!(await askConfirm(`Delete "${threat.name}"?`))) return;
  try {
    await requestJson(`${API}/threats/${threat.id}`, { method: 'DELETE' });
    state.study.threats = state.study.threats.filter(
      (entry) => String(entry.id) !== String(threat.id),
    );
    renderStep3Worksheet();
  } catch (error) {
    showError(elements.worksheet3, error.message);
  }
}

async function addManualThreat(name) {
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
  const row = createElement('button', 'equipment-result');
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
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Unit or system name…';
  const addButton = createElement('button', 'chip-button', 'Add');
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
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = threat.name;
  bindDebouncedCommit(nameInput, `threat:${threat.id}:name`, (value) => {
    if (!value.trim()) return;
    patchThreat(threat, { name: value.trim() });
  });
  nameCell.append(nameInput);
  row.append(nameCell);

  const echelonCell = document.createElement('td');
  const echelonSelect = document.createElement('select');
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
  const roleInput = document.createElement('input');
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
  hvtInput.addEventListener('change', async () => {
    await patchThreat(threat, { hvt: hvtInput.checked });
    renderHvtList();
  });
  hvtCell.append(hvtInput);
  row.append(hvtCell);

  const notesCell = document.createElement('td');
  const notesArea = document.createElement('textarea');
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
  const deleteButton = createElement('button', 'icon-button danger', 'Delete');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteThreat(threat));
  actionsCell.append(deleteButton);
  row.append(actionsCell);

  return row;
}

function renderHvtList() {
  const list = elements.worksheet3.querySelector('.hvt-list');
  if (!list) return;
  const hvts = state.study.threats.filter((threat) => threat.hvt);
  list.replaceChildren();
  if (!hvts.length) {
    list.append(createElement('li', 'panel-note', 'None designated yet.'));
    return;
  }
  hvts.forEach((threat) => {
    list.append(
      createElement('li', null, `${threat.name}${threat.role ? ` — ${threat.role}` : ''}`),
    );
  });
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
  ['Name', 'Echelon', 'Role', 'Equipment', 'HVT', 'Notes', ''].forEach((label) => {
    headRow.append(createElement('th', null, label));
  });
  head.append(headRow);
  table.append(head);
  const body = document.createElement('tbody');
  if (!state.study.threats.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
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
  renderHvtList();
}

// --- Step 4: threat courses of action ---------------------------------------

async function patchCoa(coa, body) {
  try {
    const updated = await requestJson(`${API}/coas/${coa.id}`, { method: 'PATCH', body });
    Object.assign(coa, updated);
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

function selectCoa(id) {
  state.selectedCoaId = id;
  syncMapFeatures();
  renderToolPanel();
  renderStep4Worksheet();
}

async function createCoa(kind) {
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
  if (!(await askConfirm(`Delete COA "${coa.name}"? Its events are removed too.`))) return;
  try {
    await requestJson(`${API}/coas/${coa.id}`, { method: 'DELETE' });
    state.study.coas = state.study.coas.filter((entry) => String(entry.id) !== String(coa.id));
    state.study.events = state.study.events.filter(
      (event) => String(event.coa_id) !== String(coa.id),
    );
    if (String(state.selectedCoaId) === String(coa.id)) state.selectedCoaId = null;
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
  const deleteButton = createElement('button', 'icon-button danger', 'Delete');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteCoa(coa));
  header.append(selectButton, deleteButton);
  card.append(header);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'coa-name-input';
  nameInput.value = coa.name;
  bindDebouncedCommit(nameInput, `coa:${coa.id}:name`, (value) => {
    if (!value.trim()) return;
    patchCoa(coa, { name: value.trim() });
  });
  card.append(nameInput);

  card.append(createElement('label', 'field-label', 'Narrative'));
  const narrativeArea = document.createElement('textarea');
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
      const updated = await requestJson(`${API}/events/${event.id}`, {
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
  if (!(await askConfirm(`Delete indicator "${group.indicator}"?`))) return;
  const events = [...group.events.values()];
  try {
    await Promise.all(
      events.map((event) => requestJson(`${API}/events/${event.id}`, { method: 'DELETE' })),
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
    const button = createElement(
      'button',
      `status-cell status-${event ? event.observed_status : 'none'}`,
      event ? EVENT_STATUS_LABELS[event.observed_status] : '+',
    );
    button.type = 'button';
    button.addEventListener('click', () => cycleEventStatus(group, coa, event));
    cell.append(button);
    row.append(cell);
  });
  const actionsCell = document.createElement('td');
  const deleteButton = createElement('button', 'icon-button danger', 'Delete row');
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
  const groups = eventGroups();
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
  foot.append(addRow);
  table.append(foot);

  container.append(table);
}

function renderStep4Tools() {
  const container = createElement('div', 'tool-section');

  const coaGroup = createElement('div', 'field-group');
  coaGroup.append(createElement('h3', null, 'Courses of action'));
  const likelyButton = createElement('button', 'chip-button', '+ Most likely COA');
  likelyButton.type = 'button';
  likelyButton.addEventListener('click', () => createCoa('most-likely'));
  const dangerousButton = createElement('button', 'chip-button', '+ Most dangerous COA');
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

  return container;
}

function renderStep4Worksheet() {
  const container = elements.worksheet4;
  container.replaceChildren();
  if (!state.study) return;
  container.append(createElement('h3', null, '4 · Determine threat courses of action'));

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

  const matrixSection = createElement('section', 'worksheet-block');
  matrixSection.append(createElement('h4', null, 'Event matrix'));
  const matrixContainer = createElement('div', 'event-matrix-wrap');
  matrixSection.append(matrixContainer);
  container.append(matrixSection);
  renderEventMatrix(matrixContainer);
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

// --- Print -----------------------------------------------------------------

function printWorksheet() {
  window.print();
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
  if (elements.studyMenu.hidden) return;
  const path = event.composedPath();
  if (path.includes(elements.studyMenu) || path.includes(elements.studyToggle)) return;
  closeStudyMenu();
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
  if (['1', '2', '3', '4'].includes(event.key) && !typing) {
    const step = Number(event.key);
    if (canUseStep(step)) switchStep(step);
    return;
  }
  if (event.key === 'Escape' && !typing) {
    cancelActiveTool();
  }
}

// --- Mount -------------------------------------------------------------------

export function mount({ root, status }) {
  root.innerHTML = template;
  state = createState();
  elements = queryElements(root);
  const { session } = state;

  buildMastheadStatus(status);
  createDialogNode(root);

  elements.printButton.addEventListener('click', printWorksheet);
  elements.studyToggle.addEventListener('click', () => toggleStudyMenu());
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

  mapController = createMap({
    target: elements.mapTarget,
    basemapUrl: `${TERRAIN_API}/tiles/vector.pmtiles`,
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    onClick: onMapClick,
    onFeatureChange: onMapFeatureChange,
    onDraw: onMapDraw,
    onPointerMove: onMapPointerMove,
  });

  readLocation();
  renderStepChrome();
  renderEmptyState();

  const initialStudyId = state.studyId;

  Promise.all([
    requestJson(`${TERRAIN_API}/meta`).then((meta) => {
      state.terrainMeta = meta;
      elements.statusDataset.textContent = meta.elevation.dataset;
    }),
    loadStudies(),
    loadEquipmentBookmarks().then(() => {
      if (state.step === 3) renderToolPanel();
    }),
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
    document.removeEventListener('keydown', onGlobalKeydown);
    document.removeEventListener('click', handleOutsideClick);
    session.abort();
    mapController?.destroy();
    mapController = null;
    dialogNode = null;
    root.replaceChildren();
  };
}
