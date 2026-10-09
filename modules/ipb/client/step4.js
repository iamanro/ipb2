// IPB step 4, threat courses of action: COAs, event templates and matrix.

import { can } from '../../../src/session.js';
import { renderGraphicsAndRingsList } from './mapTools.js';
import { renderSitempWorksheet } from './sitemp.js';
import {
  renderDecisionPointsSection,
  renderEventTimeChip,
  renderHHourField,
  renderPhasesSection,
  renderTimelineStripSection,
  sortEventGroups,
} from './timeline.js';

import {
  API,
  FEATURE_LAYERS,
  askConfirm,
  askText,
  bindDebouncedCommit,
  canEditStudy,
  createElement,
  editable,
  elements,
  mapController,
  mapToolsController,
  renderFeatureRow,
  requestJson,
  showError,
  state,
  syncMapFeatures,
} from './view.js';
import { renderRowMenu } from './menus.js';
import { renderReorderButtons } from './step3.js';
import { refreshGuideStatus, renderToolPanel } from './toolPanel.js';

const EVENT_STATUSES = ['expected', 'observed', 'not-observed'];

const EVENT_STATUS_LABELS = {
  expected: 'Expected',
  observed: 'Observed',
  'not-observed': 'Not observed',
};

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

export async function createCoa(kind) {
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

export function renderStep4Worksheet() {
  const container = elements.worksheet4;
  container.replaceChildren();
  if (!state.study) return;
  refreshGuideStatus();
  container.append(createElement('h3', null, '4 · Determine threat courses of action'));

  container.append(
    renderHHourField(state.study.study, { canEdit: can('analyst') && canEditStudy() }),
  );

  const coaSection = createElement('section', 'worksheet-block coa-list');
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

  const matrixSection = createElement('section', 'worksheet-block event-matrix-block');
  matrixSection.append(createElement('h4', null, 'Event matrix'));
  const matrixContainer = createElement('div', 'event-matrix-wrap');
  matrixSection.append(matrixContainer);
  container.append(matrixSection);
  renderEventMatrix(matrixContainer);

  container.append(renderPhasesSection(can('analyst') && canEditStudy()));
  container.append(renderDecisionPointsSection(can('analyst') && canEditStudy()));
  container.append(renderTimelineStripSection());
}
