/**
 * Step 4 SITEMP: place threat units on the map, per COA. A unit is a
 * `unit`-layer `symbol`-kind feature (`src/map.js`/`modules/ipb/server`)
 * carrying `properties.{sidc, designation, threat_id?, coa_id}`.
 *
 * Everything here reaches into `./view.js`'s shared internals (state,
 * elements, mapController, the request/dialog helpers) via its live export
 * block — see the comment above that block for why.
 */
import { openSymbolPicker } from '../../../src/symbols/picker.js';
import { can } from '../../../src/session.js';
import { symbolElement } from '../../../src/symbols/symbol.js';
import {
  API,
  armFeatureModify,
  askText,
  canEditStudy,
  createElement,
  deleteFeature,
  elements,
  mapController,
  renderRowMenu,
  renderStep4Worksheet,
  requestJson,
  showError,
  state,
  syncMapFeatures,
} from './view.js';

/** The COA a placed unit (or a map-A graphic) should be tagged with — null
 * when none is selected. Exported for the tactical graphics palette. */
export function selectedCoaId() {
  return state.selectedCoaId;
}

/** Pure: which of `features` should be visible given the COA filter — unit
 * tests cover this without touching the map or the DOM. */
export function filterByCoa(features, selectedId, showAll) {
  if (!selectedId || showAll) return features;
  return features.filter((feature) => String(feature.properties?.coa_id) === String(selectedId));
}

function unitFeatures() {
  return state.study?.features.filter((feature) => feature.layer === 'unit') ?? [];
}

/** Arms map-click placement: `threat` seeds the symbol and default
 * designation; pass null to choose an ad-hoc symbol via the picker instead. */
export async function armPlaceUnit(threat) {
  if (!(can('analyst') && canEditStudy()) || !state.selectedCoaId) return;
  let sidc = threat?.sidc;
  if (!sidc) {
    sidc = await openSymbolPicker({ affiliation: 'hostile', title: 'Choose a unit symbol' });
    if (!sidc) return;
  }
  const designation = await askText(
    'Designation shown on the map (optional)',
    threat?.name ?? '',
    'Place',
  );
  if (designation === null) return;
  state.tool = {
    type: 'place-unit',
    sidc,
    designation: designation || null,
    threatId: threat?.id ?? null,
    coaId: state.selectedCoaId,
  };
  mapController.startDraw('point', { layer: 'unit' });
  elements.mapHint.hidden = false;
  elements.mapHint.textContent = 'Click the map to place the unit. Press Escape to cancel.';
}

/** `onMapDraw`'s `place-unit` branch: creates the feature, ends the tool. */
export async function handleUnitPlaced(tool, geometry) {
  state.tool = null;
  if (!(can('analyst') && canEditStudy())) return;
  elements.mapHint.hidden = true;
  try {
    const feature = await requestJson(`${API}/studies/${state.studyId}/features`, {
      method: 'POST',
      body: {
        layer: 'unit',
        kind: 'symbol',
        label: tool.designation || 'Unit',
        geometry,
        properties: {
          sidc: tool.sidc,
          designation: tool.designation,
          ...(tool.threatId ? { threat_id: tool.threatId } : {}),
          coa_id: tool.coaId,
        },
      },
    });
    state.study.features.push(feature);
    syncMapFeatures();
    renderStep4Worksheet();
  } catch (error) {
    showError(elements.toolPanel, error.message);
  }
}

async function renameUnit(feature) {
  if (!(can('analyst') && canEditStudy())) return;
  const current = feature.properties?.designation ?? '';
  const designation = await askText('Designation shown on the map', current, 'Save');
  if (designation === null || designation === current) return;
  try {
    const updated = await requestJson(`${API}/features/${feature.id}`, {
      method: 'PATCH',
      body: {
        label: designation || 'Unit',
        properties: { ...feature.properties, designation: designation || null },
      },
    });
    Object.assign(feature, updated);
    syncMapFeatures();
    renderStep4Worksheet();
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

function moveUnit(feature) {
  armFeatureModify(feature);
}

/** The tools-panel block: "Place unit" (from a threat or an ad-hoc symbol)
 * plus the "show all COAs" toggle shared with the graphics palette. */
export function renderSitempTools({ threats, canEdit }) {
  const container = createElement('div', 'field-group');
  container.append(createElement('h3', null, 'Units (SITEMP)'));
  if (!state.selectedCoaId) {
    container.append(
      createElement('p', 'tool-hint', 'Select a COA in the worksheet to place units on it.'),
    );
  }
  if (canEdit) {
    const row = createElement('div', 'inline-form');
    const select = document.createElement('select');
    select.className = 'text-input';
    select.disabled = !state.selectedCoaId;
    const custom = document.createElement('option');
    custom.value = '';
    custom.textContent = 'Custom symbol…';
    select.append(custom);
    threats.forEach((threat) => {
      const option = document.createElement('option');
      option.value = String(threat.id);
      option.textContent = threat.name;
      select.append(option);
    });
    const placeButton = createElement('button', 'chip-button', 'Place unit');
    placeButton.type = 'button';
    placeButton.disabled = !state.selectedCoaId;
    placeButton.addEventListener('click', () => {
      const threat = threats.find((entry) => String(entry.id) === select.value) ?? null;
      armPlaceUnit(threat);
    });
    row.append(select, placeButton);
    container.append(row);
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

function unitRow(feature, threatsById, canEdit) {
  const row = createElement('li', 'feature-row');
  const icon = createElement('span', 'threat-symbol-preview');
  icon.append(
    symbolElement(
      feature.properties?.sidc,
      { size: 24 },
      feature.properties?.designation || 'Unit',
    ),
  );
  const threat = feature.properties?.threat_id ? threatsById.get(String(feature.properties.threat_id)) : null;
  const text = createElement(
    'button',
    'feature-label',
    feature.properties?.designation || threat?.name || 'Unnamed unit',
  );
  text.type = 'button';
  text.title = 'Zoom to this unit';
  text.addEventListener('click', () => mapController.fitFeature(feature.id));
  row.append(icon, text);
  if (threat) row.append(createElement('span', 'panel-note', `(${threat.name})`));
  if (state.showAllCoas) {
    const coa = state.study.coas.find((entry) => String(entry.id) === String(feature.properties?.coa_id));
    if (coa) row.append(createElement('span', 'coa-kind', coa.name));
  }
  if (canEdit) {
    const menu = renderRowMenu([
      { label: 'Rename', action: () => renameUnit(feature) },
      { label: 'Move', action: () => moveUnit(feature) },
      { label: 'Delete', action: () => deleteFeature(feature) },
    ]);
    if (menu) row.append(menu);
  }
  return row;
}

/** The worksheet-block listing placed units, filtered like the map. */
export function renderSitempWorksheet({ threats, canEdit }) {
  const section = createElement('section', 'worksheet-block');
  section.append(createElement('h4', null, 'Units placed'));
  const filtered = filterByCoa(unitFeatures(), state.selectedCoaId, state.showAllCoas);
  if (!filtered.length) {
    section.append(createElement('p', 'panel-note', 'No units placed yet.'));
    return section;
  }
  const threatsById = new Map(threats.map((threat) => [String(threat.id), threat]));
  const list = createElement('ul', 'feature-list');
  filtered.forEach((feature) => list.append(unitRow(feature, threatsById, canEdit)));
  section.append(list);
  return section;
}
