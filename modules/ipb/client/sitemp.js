/**
 * Step 4 SITEMP: units on the map. A unit is a `unit`-layer `symbol`-kind
 * feature (`src/map.js`/`modules/ipb/server`) carrying `properties.sidc`,
 * its APP-6 amplifiers (`src/symbols/unitProperties.js`), `coa_id` (null:
 * shown on every COA, e.g. own positions) and, when it came from one,
 * `threat_id` or an ORBAT link (`orbatPlacement.js`).
 *
 * Placing stays armed: every map click places another unit until Escape or
 * Done. A threat can also be dragged from the tools panel onto the map.
 *
 * Everything here reaches into `./view.js`'s shared internals (state,
 * elements, mapController, the request/dialog helpers) via its live export
 * block — see the comment above that block for why.
 */
import './units.css';

import { subscribe } from '../../../src/live.js';
import { can } from '../../../src/session.js';
import { openSymbolPicker } from '../../../src/symbols/picker.js';
import { affiliationOf } from '../../../src/symbols/sidc.js';
import { symbolElement } from '../../../src/symbols/symbol.js';
import {
  layoutUnits,
  openOrbatPlaceDialog,
  orbatLinkStatus,
  orbatUnitProperties,
  renderNextOrbatUnit,
} from './orbatPlacement.js';
import { EVERY_COA, openUnitDialog } from './unitDialog.js';
import {
  API,
  armFeatureModify,
  cancelActiveTool,
  canEditStudy,
  createElement,
  deleteFeature,
  elements,
  mapController,
  renderMapHint,
  renderRowMenu,
  renderStep4Worksheet,
  renderToolPanel,
  requestJson,
  showError,
  showToast,
  state,
  syncMapFeatures,
} from './view.js';

/** Drag-and-drop payload type for a threat dragged from the tools panel onto the map. */
const THREAT_DRAG_TYPE = 'application/x-ipb-threat';

/** Custom-symbol affiliations offered in the tools panel (the picker can still change it). */
const CUSTOM_AFFILIATIONS = [
  ['hostile', 'Hostile'],
  ['friendly', 'Friend'],
  ['neutral', 'Neutral'],
  ['unknown', 'Unknown'],
];

/** The COA a placed unit (or a map-A graphic) should be tagged with — null
 * when none is selected. Exported for the tactical graphics palette. */
export function selectedCoaId() {
  return state.selectedCoaId;
}

/** Pure: which of `features` should be visible given the COA filter. A
 * feature with no COA (`coa_id` null) belongs to every COA and always shows. */
export function filterByCoa(features, selectedId, showAll) {
  if (!selectedId || showAll) return features;
  return features.filter(
    (feature) =>
      feature.properties?.coa_id == null ||
      String(feature.properties.coa_id) === String(selectedId),
  );
}

function canEdit() {
  return can('analyst') && canEditStudy();
}

function unitFeatures() {
  return state.study?.features.filter((feature) => feature.layer === 'unit') ?? [];
}

/** The COA new units go on: the selected COA, unless "every COA" is chosen or none is selected. */
function placementCoaId() {
  return state.unitsOnEveryCoa ? null : (state.selectedCoaId ?? null);
}

function coaName(coaId) {
  return state.study.coas.find((coa) => String(coa.id) === String(coaId))?.name ?? null;
}

function placementTarget() {
  const coaId = placementCoaId();
  return coaId == null ? 'every COA' : coaName(coaId);
}

// -- creating units -------------------------------------------------------------

/** POSTs one unit; `template` is `{ label, properties }` (without `coa_id`). */
async function createUnit(template, lon, lat, coaId) {
  const feature = await requestJson(`${API}/studies/${state.studyId}/features`, {
    method: 'POST',
    body: {
      layer: 'unit',
      kind: 'symbol',
      label: template.label,
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { ...template.properties, coa_id: coaId },
    },
  });
  state.study.features.push(feature);
  return feature;
}

function afterUnitsChanged() {
  syncMapFeatures();
  renderStep4Worksheet();
}

/** A threat's unit: its symbol, named by the threat (the label, not the T amplifier). */
function threatTemplate(threat) {
  return { label: threat.name, properties: { sidc: threat.sidc, threat_id: threat.id } };
}

/** Arms placement of `template` (`{ label, properties }`): each map click places one. */
function armPlacement(template, name) {
  if (!canEdit()) return;
  cancelActiveTool();
  state.tool = { type: 'place-unit', template, name, count: 0 };
  renderMapHint(`Click the map to place ${name} on ${placementTarget()}. Press Escape when done.`);
  renderToolPanel();
}

export function armPlaceThreat(threat) {
  if (!threat.sidc) return;
  armPlacement(threatTemplate(threat), threat.name);
}

async function armPlaceCustom(affiliation) {
  if (!canEdit()) return;
  const sidc = await openSymbolPicker({ affiliation, title: 'Choose a unit symbol' });
  if (!sidc) return;
  armPlacement({ label: '', properties: { sidc } }, 'the unit');
}

/** `onMapClick` for the SITEMP tools; true when it consumed the click. */
export function handleSitempClick(lon, lat) {
  const tool = state.tool;
  if (tool?.type === 'place-unit') {
    placeArmedUnit(tool, lon, lat);
    return true;
  }
  if (tool?.type === 'place-orbat') {
    placeOrbatClick(tool, lon, lat);
    return true;
  }
  return false;
}

async function placeArmedUnit(tool, lon, lat) {
  if (!canEdit()) return;
  try {
    await createUnit(tool.template, lon, lat, placementCoaId());
    tool.count += 1;
    afterUnitsChanged();
    if (state.tool === tool) {
      renderMapHint(
        `${tool.count} placed. Click to place another ${tool.name}, or press Escape when done.`,
      );
    }
  } catch (error) {
    showError(elements.toolPanel, error.message);
  }
}

/** Drops a threat dragged from the tools panel at the map point under the pointer. */
function onMapDragOver(event) {
  if (!event.dataTransfer?.types.includes(THREAT_DRAG_TYPE) || !canEdit()) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
}

async function onMapDrop(event) {
  if (!event.dataTransfer?.types.includes(THREAT_DRAG_TYPE) || !canEdit()) return;
  event.preventDefault();
  const threatId = event.dataTransfer.getData(THREAT_DRAG_TYPE);
  const threat = state.study?.threats.find((entry) => String(entry.id) === threatId);
  const lonLat = mapController.lonLatAtClient(event.clientX, event.clientY);
  if (!threat?.sidc || !lonLat) return;
  try {
    await createUnit(threatTemplate(threat), lonLat[0], lonLat[1], placementCoaId());
    afterUnitsChanged();
    showToast(`Placed ${threat.name} on ${placementTarget()}`);
  } catch (error) {
    showError(elements.toolPanel, error.message);
  }
}

// -- ORBAT placement --------------------------------------------------------------

async function startOrbatPlacement() {
  if (!canEdit()) return;
  const choice = await openOrbatPlaceDialog({ root: elements.moduleRoot, requestJson });
  if (!choice) return;
  cancelActiveTool();
  const queue = choice.units.map((unit) => ({
    unit,
    ...orbatUnitProperties(unit, { orbatId: choice.orbatId, affiliation: choice.affiliation }),
  }));
  state.tool = { type: 'place-orbat', queue, placed: 0, layout: false };
  state.orbatUnits.set(choice.orbatId, choice.units);
  showOrbatHint(state.tool);
  renderToolPanel();
}

function showOrbatHint(tool) {
  const next = tool.queue[0];
  if (!next) return;
  renderMapHint(
    tool.layout
      ? `Click the map where the top of the ${tool.queue.length} remaining units goes. Press Escape to stop.`
      : `Click the map to place ${next.label} (${tool.placed + 1} of ${tool.placed + tool.queue.length}). Press Escape to stop.`,
  );
}

function finishOrbatPlacement(tool) {
  if (state.tool !== tool) return;
  state.tool = null;
  renderMapHint('');
  showToast(`Placed ${tool.placed} unit${tool.placed === 1 ? '' : 's'} from the ORBAT`);
  renderToolPanel();
}

async function placeOrbatClick(tool, lon, lat) {
  if (!canEdit() || tool.busy) return;
  tool.busy = true;
  const coaId = placementCoaId();
  try {
    if (tool.layout) {
      const layout = layoutUnits(tool.queue.map((entry) => entry.unit));
      const byId = new Map(tool.queue.map((entry) => [entry.unit.id, entry]));
      const features = layout.map(({ unit, dx, dy }) => {
        const entry = byId.get(unit.id);
        return {
          layer: 'unit',
          kind: 'symbol',
          label: entry.label,
          geometry: {
            type: 'Point',
            coordinates: mapController.offsetLonLat([lon, lat], dx, dy),
          },
          properties: { ...entry.properties, coa_id: coaId },
        };
      });
      const created = await requestJson(`${API}/studies/${state.studyId}/features/bulk`, {
        method: 'POST',
        body: { features },
      });
      state.study.features.push(...created.items);
      tool.placed += created.items.length;
      tool.queue = [];
    } else {
      const entry = tool.queue[0];
      await createUnit(entry, lon, lat, coaId);
      tool.queue.shift();
      tool.placed += 1;
    }
    afterUnitsChanged();
  } catch (error) {
    showError(elements.toolPanel, error.message);
  } finally {
    tool.busy = false;
  }
  if (!tool.queue.length) finishOrbatPlacement(tool);
  else if (state.tool === tool) {
    showOrbatHint(tool);
    renderToolPanel();
  }
}

function renderOrbatQueue(container, tool) {
  const box = createElement('div', 'unit-placing');
  box.setAttribute('role', 'status');
  const next = tool.queue[0];
  box.append(
    createElement(
      'p',
      'tool-hint',
      tool.layout
        ? `${tool.queue.length} units will be laid out below your next click, HQs above their subordinates.`
        : `Next (${tool.placed + 1} of ${tool.placed + tool.queue.length}):`,
    ),
  );
  if (next && !tool.layout) box.append(renderNextOrbatUnit(next));
  const actions = createElement('div', 'inline-form');
  if (!tool.layout) {
    const skip = createElement('button', 'chip-button', 'Skip');
    skip.type = 'button';
    skip.addEventListener('click', () => {
      tool.queue.shift();
      if (!tool.queue.length) finishOrbatPlacement(tool);
      else {
        showOrbatHint(tool);
        renderToolPanel();
      }
    });
    const layout = createElement('button', 'chip-button', 'Lay out the rest');
    layout.type = 'button';
    layout.addEventListener('click', () => {
      tool.layout = true;
      showOrbatHint(tool);
      renderToolPanel();
    });
    actions.append(skip, layout);
  }
  const done = createElement('button', 'chip-button', 'Stop');
  done.type = 'button';
  done.addEventListener('click', () => cancelActiveTool());
  actions.append(done);
  box.append(actions);
  container.append(box);
}

// -- ORBAT links: "changed in the ORBAT" --------------------------------------------

/** Reloads every ORBAT the study's units link to; unloadable ones are recorded as null. */
export async function refreshOrbatLinks() {
  const ids = [
    ...new Set(
      unitFeatures()
        .map((feature) => feature.properties?.orbat_id)
        .filter((id) => id != null),
    ),
  ];
  const studyId = state.studyId;
  const loaded = await Promise.all(
    ids.map(async (id) => {
      try {
        return [id, (await requestJson(`/api/orbat/orbats/${id}`)).units];
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        return [id, null];
      }
    }),
  );
  if (state.studyId !== studyId) return;
  state.orbatUnits = new Map(loaded);
  if (state.step === 4) renderStep4Worksheet();
}

function linkStatus(feature) {
  return orbatLinkStatus(feature, state.orbatUnits);
}

async function patchUnit(feature, body) {
  const updated = await requestJson(`${API}/studies/${feature.study_id}/features/${feature.id}`, {
    method: 'PATCH',
    body,
  });
  Object.assign(feature, updated);
}

async function updateFromOrbat(features) {
  if (!canEdit()) return;
  const changed = features
    .map((feature) => [feature, linkStatus(feature)])
    .filter(([, link]) => link?.status === 'changed');
  try {
    for (const [feature, link] of changed) await patchUnit(feature, link.update);
    afterUnitsChanged();
    showToast(`Updated ${changed.length} unit${changed.length === 1 ? '' : 's'} from the ORBAT`);
  } catch (error) {
    showError(elements.worksheet4, error.message);
    afterUnitsChanged();
  }
}

// -- editing ------------------------------------------------------------------------

/** The label a unit is listed under: its designation, else what it was placed as. */
function unitLabel(feature, properties) {
  if (properties.orbat_unit_id != null) return feature.label;
  return properties.designation || feature.label;
}

export async function editUnit(feature) {
  if (!canEdit()) return;
  const result = await openUnitDialog({
    root: elements.moduleRoot,
    title: 'Edit unit',
    properties: feature.properties ?? {},
    coas: state.study.coas,
    coaId: feature.properties?.coa_id ?? null,
  });
  if (!result) return;
  const properties = { ...feature.properties, ...result.properties, coa_id: result.coaId };
  try {
    await patchUnit(feature, { label: unitLabel(feature, properties), properties });
    afterUnitsChanged();
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

async function changeUnitSymbol(feature) {
  if (!canEdit()) return;
  const sidc = await openSymbolPicker({ initial: feature.properties?.sidc, title: 'Unit symbol' });
  if (!sidc || sidc === feature.properties?.sidc) return;
  try {
    await patchUnit(feature, { properties: { ...feature.properties, sidc } });
    afterUnitsChanged();
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

/** Right-click and row-menu items for a placed unit (view.js filters them by role). */
export function unitMenuItems(feature) {
  const items = [
    { label: 'Edit unit…', action: () => editUnit(feature) },
    { label: 'Change symbol…', action: () => changeUnitSymbol(feature) },
    { label: 'Move (drag)', action: () => armFeatureModify(feature) },
  ];
  if (linkStatus(feature)?.status === 'changed') {
    items.push({ label: 'Update from ORBAT', action: () => updateFromOrbat([feature]) });
  }
  items.push({ label: 'Delete', action: () => deleteFeature(feature) });
  return items;
}

// -- tools panel ------------------------------------------------------------------

function renderThreatChips(container, threats, editable) {
  const placeable = threats.filter((threat) => threat.sidc);
  if (!placeable.length) {
    container.append(
      createElement(
        'p',
        'tool-hint',
        threats.length
          ? 'Give your threats a symbol in step 3 to place them here.'
          : 'No threats yet: add them in step 3, or place a custom symbol.',
      ),
    );
    return;
  }
  const list = createElement('ul', 'unit-chip-list');
  list.setAttribute('aria-label', 'Threats to place');
  for (const threat of placeable) {
    const item = createElement('li');
    const chip = createElement('button', 'unit-chip');
    chip.type = 'button';
    chip.disabled = !editable;
    chip.setAttribute(
      'aria-pressed',
      String(state.tool?.template?.properties?.threat_id === threat.id),
    );
    chip.append(symbolElement(threat.sidc, { size: 22 }), createElement('span', null, threat.name));
    chip.title = `Place ${threat.name}: click here, then the map; or drag onto the map`;
    chip.draggable = editable;
    chip.addEventListener('click', () => armPlaceThreat(threat));
    chip.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData(THREAT_DRAG_TYPE, String(threat.id));
      event.dataTransfer.effectAllowed = 'copy';
    });
    item.append(chip);
    list.append(item);
  }
  container.append(list);
}

function renderCoaChoice(container) {
  const label = createElement('label', 'field-label-inline unit-coa-choice');
  label.append(createElement('span', null, 'Place on'));
  const select = document.createElement('select');
  select.className = 'text-input';
  if (state.selectedCoaId) {
    select.append(new Option(coaName(state.selectedCoaId) ?? 'Selected COA', 'coa'));
  }
  select.append(new Option('Every COA', EVERY_COA));
  select.value = state.selectedCoaId && !state.unitsOnEveryCoa ? 'coa' : EVERY_COA;
  select.addEventListener('change', () => {
    state.unitsOnEveryCoa = select.value === EVERY_COA;
  });
  label.append(select);
  container.append(label);
}

/** The tools-panel block: threats to place (click or drag), a custom symbol
 * of any affiliation, a whole ORBAT, and the "show all COAs" toggle. */
export function renderSitempTools({ threats, canEdit: editable }) {
  const container = createElement('div', 'field-group');
  container.append(createElement('h3', null, 'Units (SITEMP)'));

  if (editable) {
    renderCoaChoice(container);
    if (!state.selectedCoaId) {
      container.append(
        createElement(
          'p',
          'tool-hint',
          'Select a COA in the worksheet to place units on it; until then they show on every COA.',
        ),
      );
    }
  }

  const tool = state.tool;
  if (tool?.type === 'place-orbat') {
    renderOrbatQueue(container, tool);
  } else {
    renderThreatChips(container, threats, editable);
    if (editable) {
      container.append(
        createElement(
          'p',
          'tool-hint',
          'Click a threat, then the map (each click places one); or drag it onto the map.',
        ),
      );
      const custom = createElement('div', 'inline-form');
      const affiliation = document.createElement('select');
      affiliation.className = 'text-input';
      affiliation.setAttribute('aria-label', 'Affiliation of the custom symbol');
      for (const [value, text] of CUSTOM_AFFILIATIONS) affiliation.append(new Option(text, value));
      affiliation.value = state.customAffiliation ?? 'hostile';
      affiliation.addEventListener('change', () => {
        state.customAffiliation = affiliation.value;
      });
      const customButton = createElement('button', 'chip-button', 'Custom symbol…');
      customButton.type = 'button';
      customButton.addEventListener('click', () => armPlaceCustom(affiliation.value));
      const orbatButton = createElement('button', 'chip-button', 'Place ORBAT…');
      orbatButton.type = 'button';
      orbatButton.addEventListener('click', startOrbatPlacement);
      custom.append(affiliation, customButton);
      container.append(custom, orbatButton);
    }
    if (tool?.type === 'place-unit') {
      const placing = createElement('div', 'unit-placing');
      placing.setAttribute('role', 'status');
      placing.append(createElement('span', 'tool-hint', `Placing ${tool.name}.`));
      const done = createElement('button', 'chip-button', 'Done');
      done.type = 'button';
      done.addEventListener('click', () => cancelActiveTool());
      placing.append(done);
      container.append(placing);
    }
  }

  const showAllLabel = createElement('label', 'toggle-field');
  const showAllInput = document.createElement('input');
  showAllInput.type = 'checkbox';
  showAllInput.checked = Boolean(state.showAllCoas);
  showAllInput.addEventListener('change', () => {
    state.showAllCoas = showAllInput.checked;
    syncMapFeatures();
    renderStep4Worksheet();
  });
  showAllLabel.append(showAllInput, document.createTextNode('Show all COAs on the map'));
  container.append(showAllLabel);

  return container;
}

// -- worksheet ----------------------------------------------------------------------

const LINK_NOTES = {
  changed: 'Changed in the ORBAT',
  missing: 'No longer in the ORBAT',
  unavailable: 'ORBAT not available',
};

function unitRow(feature, threatsById, editable) {
  const row = createElement('li', 'feature-row');
  const icon = createElement('span', 'threat-symbol-preview');
  const name = feature.label || feature.properties?.designation || 'Unnamed unit';
  icon.append(symbolElement(feature.properties?.sidc, { size: 24 }, `${name} symbol`));
  const threat = feature.properties?.threat_id
    ? threatsById.get(String(feature.properties.threat_id))
    : null;
  const text = createElement('button', 'feature-label', name);
  text.type = 'button';
  text.title = 'Zoom to this unit';
  text.addEventListener('click', () => mapController.fitFeature(feature.id));
  row.append(icon, text);
  if (threat && threat.name !== name)
    row.append(createElement('span', 'panel-note', `(${threat.name})`));
  const affiliation = affiliationOf(feature.properties?.sidc);
  if (affiliation && affiliation !== 'hostile') {
    row.append(
      createElement('span', 'coa-kind', affiliation === 'friendly' ? 'Friend' : affiliation),
    );
  }
  if (feature.properties?.coa_id == null) {
    row.append(createElement('span', 'coa-kind', 'All COAs'));
  } else if (state.showAllCoas) {
    const coa = coaName(feature.properties.coa_id);
    if (coa) row.append(createElement('span', 'coa-kind', coa));
  }
  const link = linkStatus(feature);
  if (link && link.status !== 'current') {
    row.append(
      createElement('span', `unit-link-note unit-link-${link.status}`, LINK_NOTES[link.status]),
    );
  }
  if (editable) {
    const menu = renderRowMenu(unitMenuItems(feature));
    if (menu) row.append(menu);
  }
  return row;
}

/** The worksheet block listing placed units, filtered like the map. */
export function renderSitempWorksheet({ threats, canEdit: editable }) {
  const section = createElement('section', 'worksheet-block');
  section.append(createElement('h4', null, 'Units placed'));
  const filtered = filterByCoa(unitFeatures(), state.selectedCoaId, state.showAllCoas);
  if (!filtered.length) {
    section.append(createElement('p', 'panel-note', 'No units placed yet.'));
    return section;
  }
  const changed = unitFeatures().filter((feature) => linkStatus(feature)?.status === 'changed');
  if (changed.length && editable) {
    const bar = createElement('div', 'unit-link-bar');
    bar.append(
      createElement(
        'p',
        'panel-note',
        `${changed.length} unit${changed.length === 1 ? '' : 's'} changed in the ORBAT since placed.`,
      ),
    );
    const update = createElement('button', 'chip-button', 'Update from ORBAT');
    update.type = 'button';
    update.title = "Apply the ORBAT's symbol and amplifiers; positions stay";
    update.addEventListener('click', () => updateFromOrbat(changed));
    bar.append(update);
    section.append(bar);
  }
  const threatsById = new Map(threats.map((threat) => [String(threat.id), threat]));
  const list = createElement('ul', 'feature-list');
  filtered.forEach((feature) => list.append(unitRow(feature, threatsById, editable)));
  section.append(list);
  return section;
}

/** Map drop target and ORBAT live refresh; returns the teardown. */
export function initSitemp(mapTarget) {
  mapTarget.addEventListener('dragover', onMapDragOver);
  mapTarget.addEventListener('drop', onMapDrop);
  const unsubscribe = subscribe(
    (event) => event.module === 'orbat',
    () => {
      if (state.study) refreshOrbatLinks().catch(() => {});
    },
  );
  return () => {
    mapTarget.removeEventListener('dragover', onMapDragOver);
    mapTarget.removeEventListener('drop', onMapDrop);
    unsubscribe();
  };
}
