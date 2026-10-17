// IPB step 2, describe the effects: MCOO, key terrain candidates, avenues of approach.

import { formatArea, formatMetres, formatMgrs } from '../../../src/geo.js';
import { matchScenarioPlace } from '../../../src/map.js';
import { can } from '../../../src/session.js';
import { renderCivilConsiderationsMatrix } from './civil.js';

import {
  API,
  FEATURE_LAYERS,
  OAKOC_LAYERS,
  TERRAIN_API,
  canEditStudy,
  cancelActiveTool,
  createElement,
  editable,
  elements,
  mapController,
  renderFeatureRow,
  renderMapHint,
  requestJson,
  showError,
  state,
  syncMapFeatures,
} from './view.js';
import { refreshGuideStatus, renderToolPanel } from './toolPanel.js';
import { scenarioPlaceIndex } from './weatherLayers.js';

/** 0 dead ground, 1 seen by one post, 2 seen by two or more (dem.js viewshed). */
const VIEWSHED_PALETTE = {
  0: 'rgba(31, 65, 76, 0.35)',
  1: 'rgba(216, 91, 43, 0.45)',
  2: 'rgba(216, 91, 43, 0.75)',
  255: null,
};

// --- Step 2: describe the effects ----------------------------------------

export function heightInput(labelText, value, onChange, min = 0, max = 500) {
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

export function paintMobility() {
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

export async function runMobility() {
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

export function armLosTool() {
  if (!(can('analyst') && canEditStudy())) return;
  state.tool = { type: 'los-pick' };
  state.losPicks = [];
  state.losResult = null;
  renderMapHint('Click the observer point, then the target point.');
  syncMapFeatures();
  renderToolPanel();
}

export function handleLosPick(lon, lat) {
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
export const MAX_VIEWSHED_POSTS = 10;

export function armViewshedTool() {
  if (!(can('analyst') && canEditStudy())) return;
  state.tool = { type: 'viewshed-pick' };
  renderMapHint('Click to add an observation post.');
  renderToolPanel();
}

/** Adds an observation post and reruns the combined viewshed. */
export function handleViewshedPick(lon, lat) {
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

export function clearViewshedPosts() {
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
export function keyTerrainLabel(candidate) {
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

export function handleAvenuePick(lon, lat) {
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

export function renderKeyTerrainTools(bounds) {
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

export function renderAvenueTools(bounds) {
  const group = createElement('div', 'field-group');
  group.append(createElement('h3', null, 'Suggested routes'));
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

export function renderStep2Worksheet() {
  const container = elements.worksheet2;
  container.replaceChildren();
  if (!state.study) return;
  refreshGuideStatus();
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
