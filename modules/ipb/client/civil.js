/**
 * Civil considerations worksheet (step 2): an ASCOPE (rows) × PMESII-PT
 * (columns) matrix. Each cell is a textarea that autosaves as one upserted
 * `civil_considerations` row (`POST studies/:id/civil-considerations
 * {ascope, pmesii, text}`). Indexing/counting helpers are pure and exported
 * for tests; `renderCivilConsiderationsMatrix` builds the on-screen/print DOM.
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

/** Count of non-blank cells in one ASCOPE row, for the print collapse rule. */
export function countFilledInRow(rows, ascope) {
  return (rows ?? []).filter((row) => row.ascope === ascope && row.text && row.text.trim()).length;
}

/**
 * The worksheet block: a heading with the filled-cell count, then the
 * matrix table. `study` is `state.study` (the aggregate payload) — cells are
 * pushed into `study.civil_considerations` in place on save, matching the
 * view's own autosave convention, so the caller never has to re-fetch.
 * `can` gates editing (observers get read-only textareas).
 */
export function renderCivilConsiderationsMatrix({
  createElement,
  requestJson,
  showError,
  can,
  study,
  studyId,
  getStudyId,
}) {
  const rows = study.civil_considerations;
  const block = createElement('section', 'worksheet-block civil-matrix-block');
  block.append(createElement('h4', null, 'Civil considerations (ASCOPE × PMESII-PT)'));
  const total = ASCOPE_ROWS.length * PMESII_COLUMNS.length;
  const countNote = createElement('p', 'panel-note', `${countFilledCells(rows)} of ${total} cells filled.`);
  block.append(countNote);

  const timers = new Map();
  const wrap = createElement('div', 'civil-matrix-wrap');
  const table = document.createElement('table');
  table.className = 'data-table civil-matrix';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.append(createElement('th', null, 'ASCOPE \\ PMESII-PT'));
  PMESII_COLUMNS.forEach((column) => headRow.append(createElement('th', null, column.label)));
  head.append(headRow);
  const body = document.createElement('tbody');

  for (const ascope of ASCOPE_ROWS) {
    const tr = document.createElement('tr');
    tr.dataset.filled = String(countFilledInRow(rows, ascope.id));
    tr.append(createElement('th', 'civil-matrix-row-label', ascope.label));
    for (const pmesii of PMESII_COLUMNS) {
      const td = document.createElement('td');
      const cellRow = rows.find((row) => row.ascope === ascope.id && row.pmesii === pmesii.id);
      const textarea = document.createElement('textarea');
      textarea.rows = 3;
      textarea.value = cellRow?.text ?? '';
      textarea.disabled = !can;
      textarea.setAttribute('aria-label', `${ascope.label} × ${pmesii.label}`);
      // Print hides the textarea (an input control makes no sense on paper)
      // and shows this plain-text copy instead, the same convention as the
      // step 1 notes field's `.print-copy`.
      const printCopy = createElement('div', 'print-copy', textarea.value);
      const key = `${ascope.id}|${pmesii.id}`;
      textarea.addEventListener('input', () => {
        printCopy.textContent = textarea.value;
        window.clearTimeout(timers.get(key));
        timers.set(
          key,
          window.setTimeout(async () => {
            try {
              const saved = await requestJson(`${API}/studies/${studyId}/civil-considerations`, {
                method: 'POST',
                body: { ascope: ascope.id, pmesii: pmesii.id, text: textarea.value },
              });
              if (getStudyId && getStudyId() !== studyId) return;
              const existingIndex = rows.findIndex((row) => row.ascope === ascope.id && row.pmesii === pmesii.id);
              if (existingIndex === -1) rows.push(saved);
              else rows[existingIndex] = saved;
              countNote.textContent = `${countFilledCells(rows)} of ${total} cells filled.`;
              tr.dataset.filled = String(countFilledInRow(rows, ascope.id));
            } catch (error) {
              if (error.name !== 'AbortError') showError(block, error.message);
            }
          }, 180),
        );
      });
      td.append(textarea, printCopy);
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body);
  wrap.append(table);
  block.append(wrap);
  return block;
}
