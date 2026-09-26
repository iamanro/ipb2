/**
 * A shared, accessible symbol picker: `openSymbolPicker({ initial, affiliation, title })`
 * resolves to a 20-digit SIDC, or null if the analyst cancels. Every module that lets a
 * user set a symbol (ORBAT units, IPB threats, SITEMP placement, tracks…) uses this one
 * dialog so the interaction and the resulting SIDC stay consistent app-wide.
 */
import './picker.css';
import {
  DEFAULT_SIDC,
  affiliationOf,
  parseSidc,
  withAffiliation,
  withFields,
  withStatus,
} from './sidc.js';
import { ECHELONS, ENTITIES, lookup } from './symbology.js';
import { symbolElement } from './symbol.js';

const AFFILIATIONS = ['friendly', 'hostile', 'neutral', 'unknown'];
const AFFILIATION_LABELS = {
  friendly: 'Friendly',
  hostile: 'Hostile',
  neutral: 'Neutral',
  unknown: 'Unknown',
};
const STATUSES = ['present', 'planned'];
const STATUS_LABELS = { present: 'Present', planned: 'Planned' };
/** Only land unit has a catalogued entity table today (see symbology.js); equipment and
 * installation are still offered, per C4, with function search disabled until one exists. */
const SYMBOL_SET_OPTIONS = ['10', '15', '20'];
const MAX_RESULTS = 60;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A short accessible name for a symbol, e.g. "Hostile, land unit, armour, battalion". */
function accessibleLabel(sidc) {
  const parts = parseSidc(sidc);
  if (!parts) return 'Symbol';
  const bits = [];
  const identity = lookup.identity.get(parts.identity)?.name;
  const set = lookup.symbolSet.get(parts.symbolSet);
  if (identity) bits.push(identity);
  if (set) bits.push(set.name.toLowerCase());
  if (parts.symbolSet === '10') {
    const entity = lookup.entity.get(parts.entity)?.name;
    if (entity) bits.push(entity.toLowerCase());
  }
  if (set?.unit) {
    const echelon = lookup.echelon.get(parts.amplifier);
    if (echelon && echelon.code !== '00') bits.push(echelon.name.toLowerCase());
  }
  return bits.join(', ') || 'Symbol';
}

/** Build the SIDC for the picker's current field state (pure: no DOM). */
function composeSidc(state) {
  const set = lookup.symbolSet.get(state.symbolSet);
  const entity = state.symbolSet === '10' ? state.entity : '000000';
  let sidc = withFields(DEFAULT_SIDC, {
    symbolSet: state.symbolSet,
    entity,
    amplifier: set?.unit ? state.echelonCode : '00',
  });
  sidc = withAffiliation(sidc, state.affiliation);
  sidc = withStatus(sidc, state.status);
  return sidc;
}

/** The picker's field state for a starting SIDC (falls back to sensible defaults). */
function stateFromSidc(sidc) {
  const parts = parseSidc(sidc);
  if (!parts) return { affiliation: 'friendly', status: 'present', symbolSet: '10', entity: '121100', echelonCode: '00' };
  return {
    affiliation: affiliationOf(sidc) ?? 'friendly',
    status: parts.status === '1' ? 'planned' : 'present',
    symbolSet: SYMBOL_SET_OPTIONS.includes(parts.symbolSet) ? parts.symbolSet : '10',
    entity: parts.symbolSet === '10' ? parts.entity : '121100',
    echelonCode: lookup.echelon.has(parts.amplifier) ? parts.amplifier : '00',
  };
}

function buildRadioGroup({ legend, name, options, labels, value, onChange }) {
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'symbol-picker-segmented';
  fieldset.append(el('legend', null, legend));
  const row = el('div', 'symbol-picker-options');
  for (const option of options) {
    const label = el('label', 'symbol-picker-segment');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = option;
    input.checked = option === value;
    input.addEventListener('change', () => {
      if (input.checked) onChange(option);
    });
    label.append(input, document.createTextNode(labels[option]));
    row.append(label);
  }
  fieldset.append(row);
  return { element: fieldset };
}

function buildSelectField({ label, value, options, onChange }) {
  const wrapper = el('label', 'field');
  wrapper.append(el('span', null, label));
  const select = document.createElement('select');
  select.className = 'text-input';
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.text;
    select.append(node);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  wrapper.append(select);
  return { element: wrapper, control: select, setValue: (v) => (select.value = v) };
}

function entityLabel(code) {
  const entity = lookup.entity.get(code);
  return entity ? `${entity.code} — ${entity.name}` : code;
}

/** A searchable, virtualized-by-cap combobox over the land unit entity table, with an
 * icon preview per row. Disabled (with an explanatory note) for symbol sets that have
 * no catalogued entity table yet. */
function buildEntitySearch({ value, symbolSet, onChange }) {
  const wrapper = el('label', 'field symbol-picker-entity-field');
  wrapper.append(el('span', null, 'Function'));

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'text-input code symbol-picker-search';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Search by name or code…';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', 'symbol-picker-listbox');

  const listbox = document.createElement('ul');
  listbox.id = 'symbol-picker-listbox';
  listbox.className = 'combo-listbox symbol-picker-listbox';
  listbox.setAttribute('role', 'listbox');
  listbox.hidden = true;

  const note = el('p', 'field-note symbol-picker-note');

  wrapper.append(input, listbox, note);

  let currentSymbolSet = symbolSet;
  let filtered = [];
  let activeIndex = -1;

  function setValue(code, { silent } = {}) {
    input.value = entityLabel(code);
    if (!silent) onChange(code);
  }

  function closeList() {
    listbox.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  }

  function setActive(index) {
    activeIndex = index;
    [...listbox.children].forEach((li, i) => li.classList.toggle('is-active', i === index));
    if (index >= 0) {
      input.setAttribute('aria-activedescendant', `symbol-picker-opt-${index}`);
      listbox.children[index]?.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function openList(query) {
    if (currentSymbolSet !== '10') return;
    const needle = query.trim().toLowerCase();
    filtered = (
      needle
        ? ENTITIES.filter((e) => e.code.includes(needle) || e.name.toLowerCase().includes(needle))
        : ENTITIES
    ).slice(0, MAX_RESULTS);
    listbox.replaceChildren(
      ...filtered.map((entity, index) => {
        const li = el('li', 'combo-option symbol-picker-option');
        li.id = `symbol-picker-opt-${index}`;
        li.setAttribute('role', 'option');
        li.append(
          symbolElement(
            withFields(DEFAULT_SIDC, { symbolSet: currentSymbolSet, entity: entity.code }),
            { size: 22 },
          ),
          el('span', null, entity.name),
        );
        li.addEventListener('mousedown', (event) => {
          event.preventDefault();
          setValue(entity.code);
          closeList();
        });
        return li;
      }),
    );
    listbox.hidden = filtered.length === 0;
    input.setAttribute('aria-expanded', String(!listbox.hidden));
    setActive(-1);
  }

  input.addEventListener('focus', () => openList(''));
  input.addEventListener('input', () => openList(input.value));
  input.addEventListener('blur', () => window.setTimeout(closeList, 120));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (listbox.hidden) openList(input.value);
      else setActive(Math.min(activeIndex + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (event.key === 'Enter') {
      if (activeIndex >= 0 && filtered[activeIndex]) {
        event.preventDefault();
        setValue(filtered[activeIndex].code);
        closeList();
      }
    }
  });

  function refresh(state) {
    currentSymbolSet = state.symbolSet;
    input.disabled = currentSymbolSet !== '10';
    note.textContent =
      currentSymbolSet === '10'
        ? ''
        : `${lookup.symbolSet.get(currentSymbolSet)?.name} has no function catalogue yet; the symbol stays unspecified.`;
    if (currentSymbolSet === '10') setValue(state.entity, { silent: true });
    else input.value = '';
    closeList();
  }
  refresh({ symbolSet, entity: value });

  return {
    element: wrapper,
    control: input,
    refresh,
    isListOpen: () => !listbox.hidden,
    closeList,
  };
}

/**
 * Opens the symbol picker modal. `initial` seeds every field from an existing SIDC;
 * otherwise `affiliation` seeds only the affiliation and everything else defaults to a
 * present land unit, unspecified function. Resolves to the chosen SIDC, or null if the
 * analyst cancels (Escape, the Cancel button, or the close button).
 */
export function openSymbolPicker({ initial, affiliation, title = 'Choose a symbol' } = {}) {
  return new Promise((resolve) => {
    const seed =
      initial && parseSidc(initial) ? initial : withAffiliation(DEFAULT_SIDC, affiliation ?? 'friendly');
    let state = stateFromSidc(seed);

    const dialog = el('dialog', 'symbol-picker-dialog');
    dialog.setAttribute('aria-label', title);

    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'symbol-picker-form';

    const headerRow = el('div', 'symbol-picker-header');
    headerRow.append(el('h2', 'symbol-picker-title', title));
    const closeButton = el('button', 'symbol-picker-close', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Cancel');
    closeButton.addEventListener('click', () => {
      dialog.returnValue = 'cancel';
      dialog.close();
    });
    headerRow.append(closeButton);

    const fieldsRow = el('div', 'symbol-picker-fields');

    const affiliationField = buildRadioGroup({
      legend: 'Affiliation',
      name: 'symbol-picker-affiliation',
      options: AFFILIATIONS,
      labels: AFFILIATION_LABELS,
      value: state.affiliation,
      onChange: (value) => {
        state = { ...state, affiliation: value };
        refreshPreview();
      },
    });

    const statusField = buildRadioGroup({
      legend: 'Status',
      name: 'symbol-picker-status',
      options: STATUSES,
      labels: STATUS_LABELS,
      value: state.status,
      onChange: (value) => {
        state = { ...state, status: value };
        refreshPreview();
      },
    });

    const symbolSetField = buildSelectField({
      label: 'Symbol set',
      value: state.symbolSet,
      options: SYMBOL_SET_OPTIONS.map((code) => ({
        value: code,
        text: lookup.symbolSet.get(code).name,
      })),
      onChange: (value) => {
        state = { ...state, symbolSet: value };
        updateEchelonVisibility();
        entityField.refresh(state);
        refreshPreview();
      },
    });

    const echelonField = buildSelectField({
      label: 'Echelon',
      value: state.echelonCode,
      options: ECHELONS.map((echelon) => ({ value: echelon.code, text: echelon.name })),
      onChange: (value) => {
        state = { ...state, echelonCode: value };
        refreshPreview();
      },
    });

    function updateEchelonVisibility() {
      echelonField.element.hidden = !lookup.symbolSet.get(state.symbolSet)?.unit;
    }

    const entityField = buildEntitySearch({
      value: state.entity,
      symbolSet: state.symbolSet,
      onChange: (code) => {
        state = { ...state, entity: code };
        refreshPreview();
      },
    });

    fieldsRow.append(
      affiliationField.element,
      statusField.element,
      symbolSetField.element,
      echelonField.element,
      entityField.element,
    );

    const previewFigure = el('figure', 'symbol-picker-preview');
    const previewBox = el('div', 'symbol-picker-preview-symbol');
    const previewCaption = el('figcaption', 'symbol-picker-preview-caption');
    const sidcOutput = document.createElement('output');
    sidcOutput.className = 'symbol-picker-sidc';
    previewFigure.append(previewBox, previewCaption, sidcOutput);

    function refreshPreview() {
      const sidc = composeSidc(state);
      previewBox.replaceChildren(symbolElement(sidc, { size: 96 }, accessibleLabel(sidc)));
      previewCaption.textContent = accessibleLabel(sidc);
      sidcOutput.textContent = sidc;
    }

    const actions = el('div', 'symbol-picker-actions');
    const cancelButton = el('button', 'text-button', 'Cancel');
    cancelButton.type = 'button';
    cancelButton.addEventListener('click', () => {
      dialog.returnValue = 'cancel';
      dialog.close();
    });
    const acceptButton = el('button', 'symbol-picker-accept', 'Use symbol');
    acceptButton.type = 'submit';
    acceptButton.value = 'accept';
    actions.append(cancelButton, acceptButton);

    form.append(headerRow, fieldsRow, previewFigure, actions);
    dialog.append(form);
    document.body.append(dialog);

    updateEchelonVisibility();
    refreshPreview();

    // Escape closes the suggestion list first, like any combobox; only a second Escape
    // (list already closed) should cancel the whole picker.
    dialog.addEventListener('cancel', (event) => {
      if (entityField.isListOpen()) {
        event.preventDefault();
        entityField.closeList();
      }
    });

    dialog.addEventListener(
      'close',
      () => {
        const result = dialog.returnValue === 'accept' ? composeSidc(state) : null;
        dialog.remove();
        resolve(result);
      },
      { once: true },
    );

    dialog.showModal();
    entityField.control.focus();
  });
}
