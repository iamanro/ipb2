// Exercise: the Geography panel (fictional countries and renamed places over Czechia).

import polygonClipping from 'polygon-clipping';
import { buildScenarioNameIndex, createMap, matchScenarioPlace } from '../../../src/map.js';
import { can } from '../../../src/session.js';

import {
  API,
  askConfirm,
  askText,
  createElement,
  elements,
  requestJson,
  showError,
  state,
} from './view.js';

const TERRAIN_API = '/api/terrain';
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

/** The Geography tab's map controller: created on entering the tab, destroyed on leaving it
 * (never torn down by the shared renderPanel() wipe-and-redraw that every other tab uses). */
let geoMap;

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

export function onGeoKeydown(event) {
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

export function renderGeographyPanel() {
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

export function destroyGeoMap() {
  geoMap?.destroy();
  geoMap = null;
  elements.geoBasemapSwitch = null;
  elements.geoSidebar = null;
  state.geo.mode = null;
  state.geo.activeCountryId = null;
}
