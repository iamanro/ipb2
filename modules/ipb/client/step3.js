// IPB step 3, evaluate the threat: threat models, ORBAT and HVTs.

import { can } from '../../../src/session.js';
import { renderThreatSymbolCell } from './threatSymbols.js';

import {
  API,
  askConfirm,
  bindDebouncedCommit,
  canEditStudy,
  createElement,
  editable,
  elements,
  requestJson,
  showError,
  state,
} from './view.js';
import { refreshGuideStatus } from './toolPanel.js';

const EQUIPMENT_API = '/api/equipment';

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

export function renderReorderButtons(kind, item, index, total, worksheetElement, rerender) {
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

export async function addManualThreat(name) {
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

export function renderEquipmentResults(container) {
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

export async function loadEquipmentBookmarks() {
  try {
    const result = await requestJson(`${EQUIPMENT_API}/bookmarks`);
    state.equipmentBookmarks = result.items;
  } catch (error) {
    if (error.name === 'AbortError') return;
    // Non-critical: the lookup still works by search without it.
    state.equipmentBookmarks = [];
  }
}

export function renderBookmarkedEquipment(container) {
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

export async function searchEquipment(query, container) {
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

export function renderStep3Worksheet() {
  const container = elements.worksheet3;
  container.replaceChildren();
  if (!state.study) return;
  refreshGuideStatus();
  container.append(createElement('h3', null, '3 · Evaluate the threat'));

  const tableSection = createElement('section', 'worksheet-block threat-table-block');
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
