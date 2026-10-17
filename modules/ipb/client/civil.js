/**
 * Civil considerations worksheet (step 2): an ASCOPE × PMESII-PT grid of 48
 * cells, each an upserted `civil_considerations` row (`POST
 * studies/:id/civil-considerations {ascope, pmesii, text}`, `DELETE
 * studies/:id/civil-considerations/:id` to clear a cell). Rather than 48
 * always-visible textareas, the worksheet shows only the filled cells as an
 * entry list grouped by ASCOPE, plus an add/edit form; a "View matrix"
 * dialog shows the full 6×8 grid read-only for a quick scan and as a way to
 * jump into editing any pair. Indexing/counting/grouping helpers are pure
 * and exported for tests; `renderCivilConsiderationsMatrix` builds the DOM.
 */
import './tools.css';

const API = '/api/ipb';

export const ASCOPE_ROWS = [
  { id: 'areas', label: 'Areas' },
  { id: 'structures', label: 'Structures' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'organizations', label: 'Organizations' },
  { id: 'people', label: 'People' },
  { id: 'events', label: 'Events' },
];

export const PMESII_COLUMNS = [
  { id: 'political', label: 'Political' },
  { id: 'military', label: 'Military' },
  { id: 'economic', label: 'Economic' },
  { id: 'social', label: 'Social' },
  { id: 'information', label: 'Information' },
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'physical-environment', label: 'Physical env.' },
  { id: 'time', label: 'Time' },
];

/** `civil_considerations` rows keyed `"ascope|pmesii"`, for O(1) cell lookup. */
export function indexCivilConsiderations(rows) {
  const index = new Map();
  for (const row of rows ?? []) index.set(`${row.ascope}|${row.pmesii}`, row);
  return index;
}

/** Count of cells with non-blank text, for the "N of 48 filled" readout. */
export function countFilledCells(rows) {
  return (rows ?? []).filter((row) => row.text && row.text.trim()).length;
}

/**
 * Filled rows grouped by ASCOPE in display order, each group's entries in
 * PMESII-PT column order — the shape the entry list renders. ASCOPE groups
 * with no filled cells are omitted entirely; the worksheet shows one empty
 * state instead when every group comes back empty.
 */
export function groupFilledConsiderations(rows) {
  const pmesiiOrder = new Map(PMESII_COLUMNS.map((column, index) => [column.id, index]));
  const filled = (rows ?? []).filter((row) => row.text && row.text.trim());
  return ASCOPE_ROWS.map((ascope) => ({
    ascope: ascope.id,
    label: ascope.label,
    entries: filled
      .filter((row) => row.ascope === ascope.id)
      .sort((a, b) => pmesiiOrder.get(a.pmesii) - pmesiiOrder.get(b.pmesii)),
  })).filter((group) => group.entries.length > 0);
}

function pmesiiLabel(id) {
  return PMESII_COLUMNS.find((column) => column.id === id)?.label ?? id;
}

function ascopeLabel(id) {
  return ASCOPE_ROWS.find((row) => row.id === id)?.label ?? id;
}

/**
 * The worksheet block: a heading with the filled-cell count, the entry
 * list, an add/edit form, and a "View matrix" button that opens the full
 * grid in a dialog. `study` is `state.study` (the aggregate payload) —
 * cells are pushed into/removed from `study.civil_considerations` in place
 * on save/delete, matching the view's own autosave convention, so the
 * caller never has to re-fetch. `can` gates editing (observers get a
 * read-only list with no add form or row menus).
 */
export function renderCivilConsiderationsMatrix({
  createElement,
  requestJson,
  showError,
  askConfirm,
  renderRowMenu,
  can,
  study,
  studyId,
  getStudyId,
}) {
  const rows = study.civil_considerations;
  const total = ASCOPE_ROWS.length * PMESII_COLUMNS.length;

  const block = createElement('section', 'worksheet-block civil-matrix-block');
  block.append(createElement('h4', null, 'Civil considerations (ASCOPE × PMESII-PT)'));
  const countNote = createElement(
    'p',
    'panel-note',
    `${countFilledCells(rows)} of ${total} cells filled.`,
  );
  block.append(countNote);

  const actions = createElement('div', 'civil-matrix-actions');
  const viewMatrixButton = createElement('button', 'text-button', 'View matrix');
  viewMatrixButton.type = 'button';
  actions.append(viewMatrixButton);
  block.append(actions);

  const listWrap = createElement('div', 'civil-groups');
  block.append(listWrap);

  function cellFor(ascope, pmesii) {
    return rows.find((row) => row.ascope === ascope && row.pmesii === pmesii);
  }

  function renderList() {
    listWrap.replaceChildren();
    const groups = groupFilledConsiderations(rows);
    if (!groups.length) {
      listWrap.append(
        createElement(
          'p',
          'panel-note',
          'ASCOPE (areas, structures, capabilities, organizations, people, events) crossed ' +
            'with PMESII-PT (political, military, economic, social, information, infrastructure, ' +
            'physical environment, time). Add the first consideration below.',
        ),
      );
      return;
    }
    groups.forEach((group) => {
      const groupEl = createElement('div', 'field-group civil-group');
      groupEl.append(createElement('h5', null, `${group.label} (${group.entries.length})`));
      const list = createElement('ul', 'civil-considerations-list');
      group.entries.forEach((row) => list.append(renderEntryRow(row)));
      groupEl.append(list);
      listWrap.append(groupEl);
    });
  }

  function renderEntryRow(row) {
    const li = createElement('li', 'civil-row');
    const text = createElement('div', 'civil-row-text');
    text.append(createElement('span', 'civil-row-tag', pmesiiLabel(row.pmesii)));
    text.append(createElement('p', 'civil-row-body', row.text));
    li.append(text);
    if (can && renderRowMenu) {
      const menu = renderRowMenu([
        { label: 'Edit', action: () => startEdit(row.ascope, row.pmesii) },
        { label: 'Delete', action: () => deleteRow(row) },
      ]);
      if (menu) li.append(menu);
    }
    return li;
  }

  // -- Add/edit form --------------------------------------------------------

  const formGroup = createElement('div', 'field-group civil-add-form');
  formGroup.append(createElement('h5', null, 'Add consideration'));

  const ascopeLabelEl = createElement('label', 'civil-field');
  ascopeLabelEl.append(createElement('span', null, 'ASCOPE'));
  const ascopeSelect = document.createElement('select');
  ASCOPE_ROWS.forEach((row) => ascopeSelect.append(new Option(row.label, row.id)));
  ascopeLabelEl.append(ascopeSelect);

  const pmesiiLabelEl = createElement('label', 'civil-field');
  pmesiiLabelEl.append(createElement('span', null, 'PMESII-PT'));
  const pmesiiSelect = document.createElement('select');
  PMESII_COLUMNS.forEach((column) => pmesiiSelect.append(new Option(column.label, column.id)));
  pmesiiLabelEl.append(pmesiiSelect);

  const selectRow = createElement('div', 'civil-field-row');
  selectRow.append(ascopeLabelEl, pmesiiLabelEl);
  formGroup.append(selectRow);

  const replaceNote = createElement('p', 'panel-note civil-replace-note');
  replaceNote.hidden = true;
  formGroup.append(replaceNote);

  const textLabelEl = createElement('label', 'civil-field');
  textLabelEl.append(createElement('span', null, 'Text'));
  const textarea = document.createElement('textarea');
  textarea.rows = 4;
  textarea.disabled = !can;
  textLabelEl.append(textarea);
  formGroup.append(textLabelEl);

  const saveButton = createElement('button', 'primary-button', 'Save');
  saveButton.type = 'button';
  saveButton.disabled = !can;
  formGroup.append(saveButton);

  if (!can) {
    ascopeSelect.disabled = true;
    pmesiiSelect.disabled = true;
  }

  function syncFormToSelection() {
    const existing = cellFor(ascopeSelect.value, pmesiiSelect.value);
    textarea.value = existing?.text ?? '';
    if (existing?.text && existing.text.trim()) {
      replaceNote.hidden = false;
      replaceNote.textContent =
        `Editing the saved ${ascopeLabel(ascopeSelect.value)} × ` +
        `${pmesiiLabel(pmesiiSelect.value)} entry; Save replaces it.`;
    } else {
      replaceNote.hidden = true;
    }
  }
  ascopeSelect.addEventListener('change', syncFormToSelection);
  pmesiiSelect.addEventListener('change', syncFormToSelection);
  syncFormToSelection();

  function startEdit(ascope, pmesii) {
    ascopeSelect.value = ascope;
    pmesiiSelect.value = pmesii;
    syncFormToSelection();
    textarea.focus();
  }

  saveButton.addEventListener('click', async () => {
    const ascope = ascopeSelect.value;
    const pmesii = pmesiiSelect.value;
    const text = textarea.value;
    try {
      const saved = await requestJson(`${API}/studies/${studyId}/civil-considerations`, {
        method: 'POST',
        body: { ascope, pmesii, text },
      });
      if (getStudyId && getStudyId() !== studyId) return;
      const existingIndex = rows.findIndex((row) => row.ascope === ascope && row.pmesii === pmesii);
      if (existingIndex === -1) rows.push(saved);
      else rows[existingIndex] = saved;
      countNote.textContent = `${countFilledCells(rows)} of ${total} cells filled.`;
      renderList();
      syncFormToSelection();
      refreshMatrixDialog();
    } catch (error) {
      if (error.name !== 'AbortError') showError(block, error.message);
    }
  });

  async function deleteRow(row) {
    if (
      askConfirm &&
      !(await askConfirm(
        `Delete this ${ascopeLabel(row.ascope)} × ${pmesiiLabel(row.pmesii)} entry?`,
      ))
    ) {
      return;
    }
    try {
      await requestJson(`${API}/studies/${studyId}/civil-considerations/${row.id}`, {
        method: 'DELETE',
      });
      if (getStudyId && getStudyId() !== studyId) return;
      const index = rows.findIndex((entry) => entry.id === row.id);
      if (index !== -1) rows.splice(index, 1);
      countNote.textContent = `${countFilledCells(rows)} of ${total} cells filled.`;
      renderList();
      syncFormToSelection();
      refreshMatrixDialog();
    } catch (error) {
      if (error.name !== 'AbortError') showError(block, error.message);
    }
  }

  if (can) block.append(formGroup);
  renderList();

  // -- "View matrix" dialog --------------------------------------------------

  const dialog = document.createElement('dialog');
  dialog.className = 'civil-matrix-dialog';
  const dialogHeader = createElement('div', 'civil-matrix-dialog-header');
  dialogHeader.append(createElement('h3', null, 'ASCOPE × PMESII-PT matrix'));
  const closeButton = createElement('button', 'icon-button', '✕');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.addEventListener('click', () => dialog.close());
  dialogHeader.append(closeButton);
  dialog.append(dialogHeader);

  const table = document.createElement('table');
  table.className = 'data-table civil-matrix';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.append(createElement('th', null, 'ASCOPE \\ PMESII-PT'));
  PMESII_COLUMNS.forEach((column) => headRow.append(createElement('th', null, column.label)));
  head.append(headRow);
  const body = document.createElement('tbody');
  table.append(head, body);
  dialog.append(table);
  block.append(dialog);

  function refreshMatrixDialog() {
    body.replaceChildren();
    for (const ascope of ASCOPE_ROWS) {
      const tr = document.createElement('tr');
      tr.append(createElement('th', 'civil-matrix-row-label', ascope.label));
      for (const pmesii of PMESII_COLUMNS) {
        const td = document.createElement('td');
        const cellRow = cellFor(ascope.id, pmesii.id);
        const text = cellRow?.text?.trim() ? cellRow.text : '';
        const cellButton = createElement('button', 'civil-matrix-cell');
        cellButton.append(createElement('span', 'civil-matrix-cell-text', text || '—'));
        cellButton.type = 'button';
        cellButton.setAttribute(
          'aria-label',
          `${ascope.label} × ${pmesii.label}: ${text || 'empty'}`,
        );
        if (cellRow?.text?.trim()) cellButton.title = cellRow.text;
        cellButton.addEventListener('click', () => {
          dialog.close();
          startEdit(ascope.id, pmesii.id);
        });
        td.append(cellButton);
        tr.append(td);
      }
      body.append(tr);
    }
  }
  refreshMatrixDialog();

  viewMatrixButton.addEventListener('click', () => dialog.showModal());

  return block;
}
