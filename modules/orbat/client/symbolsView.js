import './symbols.css';
import { createElement } from './dom.js';
import {
  DEFAULT_SIDC,
  describeSidc,
  formatSidc,
  parseSidc,
  withFields,
} from '../../../src/symbols/sidc.js';
import {
  AMPLIFIER_LAYOUT,
  AMPLIFIERS,
  CONTEXTS,
  ECHELONS,
  ENTITIES,
  ENTITY_GROUPS,
  HQTFD,
  IDENTITIES,
  MODIFIERS_1,
  MODIFIERS_2,
  STATUSES,
  SIDC_FIELDS,
  SYMBOL_SETS,
  FRAME_SETS,
  VERSIONS,
  lookup,
} from '../../../src/symbols/symbology.js';
import { symbolElement } from '../../../src/symbols/symbol.js';

/** Land unit symbol set: the only set with a catalogued entity/modifier table. */
const LAND_SET = '10';
/** Infantry, from the default SIDC: the stand-in entity used across the reference sections. */
const DEMO_ENTITY = '121100';

const SECTIONS_META = [
  { id: 'sidc-explorer', title: 'SIDC explorer' },
  { id: 'anatomy', title: 'Anatomy' },
  { id: 'identity-frames', title: 'Standard identity & frames' },
  { id: 'status', title: 'Status' },
  { id: 'hq-tf-dummy', title: 'HQ / task force / dummy' },
  { id: 'echelons', title: 'Echelons' },
  { id: 'icon-catalogue', title: 'Icon catalogue' },
  { id: 'modifiers', title: 'Modifiers' },
];

// --- shared helpers ----------------------------------------------------------

/** A short accessible name for a symbol, e.g. "Friend, land unit, infantry, battalion". */
function accessibleLabel(sidc) {
  const parts = parseSidc(sidc);
  if (!parts) return 'Symbol';
  const bits = [];
  const identity = lookup.identity.get(parts.identity)?.name;
  const set = lookup.symbolSet.get(parts.symbolSet);
  if (identity) bits.push(identity);
  if (set) bits.push(set.name.toLowerCase());
  if (parts.symbolSet === LAND_SET) {
    const entity = lookup.entity.get(parts.entity)?.name;
    if (entity) bits.push(entity.toLowerCase());
  }
  if (set?.unit) {
    const echelon = lookup.echelon.get(parts.amplifier);
    if (echelon && echelon.code !== '00') bits.push(echelon.name.toLowerCase());
  }
  return bits.join(', ') || 'Symbol';
}

/** How the standard's text is cited on this page: title plus a table/paragraph reference. */
const STANDARD = 'MIL-STD-2525E w/ Change 1';

/**
 * A small badge for a catalogue card whose code MIL-STD-2525E(1) no longer
 * lists among land unit entities/modifiers (`'removed'`) or moved into the
 * common-modifier tables A-IX/A-X (`'common'`, modifiers only). Both remain
 * valid to write in the version-10 codes this page and the ORBAT builder use.
 */
function editionBadge(state) {
  if (state === 'removed') {
    const badge = createElement('span', 'edition-badge is-removed', 'Not in 2525E');
    badge.title = `Dropped from ${STANDARD}’s land unit tables (appendix A). Still a valid version-10 code.`;
    return badge;
  }
  const badge = createElement('span', 'edition-badge is-common', '2525E: common modifier');
  badge.title = `${STANDARD} moved this into the common-modifier tables (A-IX/A-X), coded there with a position 21/22 flag. Still a valid version-10 code here.`;
  return badge;
}

function createFigcaption(text) {
  const node = document.createElement('figcaption');
  node.textContent = text;
  return node;
}

function tableHead(labels) {
  const thead = document.createElement('thead');
  const row = document.createElement('tr');
  for (const label of labels) row.append(createElement('th', null, label));
  thead.append(row);
  return thead;
}

// --- SIDC explorer -------------------------------------------------------------

const MODE_DEPENDENT_FIELDS = new Set(['amplifier', 'entity', 'modifier1', 'modifier2']);

function createSelect({ key, items, value, label, note, onChange }) {
  const wrapper = createElement('label', 'field');
  wrapper.dataset.field = key;
  wrapper.append(createElement('span', null, label));
  const select = document.createElement('select');
  select.className = 'text-input';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.code;
    option.textContent = item.released
      ? `${item.code} — ${item.name} (${item.released})`
      : `${item.code} — ${item.name}`;
    select.append(option);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  wrapper.append(select);
  if (note) wrapper.append(createElement('p', 'field-note', note));
  return { element: wrapper, control: select, setValue: (v) => (select.value = v) };
}

function createDigitInput({ key, length, value, label, note, onChange }) {
  const wrapper = createElement('label', 'field');
  wrapper.dataset.field = key;
  wrapper.append(createElement('span', null, label));
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'text-input code';
  input.inputMode = 'numeric';
  input.maxLength = length;
  input.autocomplete = 'off';
  input.value = value;
  const pattern = new RegExp(`^\\d{${length}}$`);
  const validate = () => input.setAttribute('aria-invalid', String(!pattern.test(input.value)));
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, length);
    if (digits !== input.value) input.value = digits;
    validate();
    if (pattern.test(digits)) onChange(digits);
  });
  validate();
  wrapper.append(input);
  if (note) wrapper.append(createElement('p', 'field-note', note));
  return {
    element: wrapper,
    control: input,
    setValue: (v) => {
      input.value = v;
      validate();
    },
  };
}

/** A searchable combobox over the land unit entity table (~220 entries). */
function createEntityCombobox({ value, onChange }) {
  const wrapper = createElement('label', 'field');
  wrapper.dataset.field = 'entity';
  wrapper.append(createElement('span', null, 'Entity · type · subtype'));

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'text-input code';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', 'explorer-entity-listbox');

  const listbox = document.createElement('ul');
  listbox.id = 'explorer-entity-listbox';
  listbox.className = 'combo-listbox';
  listbox.setAttribute('role', 'listbox');
  listbox.hidden = true;

  wrapper.append(input, listbox);

  let filtered = [];
  let activeIndex = -1;

  const labelFor = (code) => {
    const entity = lookup.entity.get(code);
    return entity ? `${entity.code} — ${entity.name}` : code;
  };

  function setValue(code, { silent } = {}) {
    input.value = labelFor(code);
    input.setAttribute('aria-invalid', String(!lookup.entity.has(code)));
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
      input.setAttribute('aria-activedescendant', `explorer-entity-opt-${index}`);
      listbox.children[index]?.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function openList(query) {
    const needle = query.trim().toLowerCase();
    filtered = (
      needle
        ? ENTITIES.filter((e) => e.code.includes(needle) || e.name.toLowerCase().includes(needle))
        : ENTITIES
    ).slice(0, 60);
    listbox.replaceChildren(
      ...filtered.map((entity, index) => {
        const li = createElement('li', 'combo-option', `${entity.code} — ${entity.name}`);
        li.id = `explorer-entity-opt-${index}`;
        li.setAttribute('role', 'option');
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
    } else if (event.key === 'Escape') {
      closeList();
    }
  });

  setValue(value, { silent: true });
  return { element: wrapper, control: input, setValue: (v) => setValue(v, { silent: true }) };
}

function fieldControl(key, parts, setField) {
  const isLand = parts.symbolSet === LAND_SET;
  const set = lookup.symbolSet.get(parts.symbolSet);
  switch (key) {
    case 'version':
      return createSelect({
        key,
        items: VERSIONS,
        value: parts.version,
        label: 'Version',
        note: 'Land unit icons draw the same for every version. milsymbol 3.0.4 changes only details: version 13 draws suspect (identity 5) the 2525E way; 14–16 are drawn like 10.',
        onChange: (v) => setField('version', v),
      });
    case 'context':
      return createSelect({
        key,
        items: CONTEXTS,
        value: parts.context,
        label: 'Context',
        onChange: (v) => setField('context', v),
      });
    case 'identity':
      return createSelect({
        key,
        items: IDENTITIES,
        value: parts.identity,
        label: 'Standard identity',
        onChange: (v) => setField('identity', v),
      });
    case 'symbolSet':
      return createSelect({
        key,
        items: SYMBOL_SETS,
        value: parts.symbolSet,
        label: 'Symbol set',
        onChange: (v) => setField('symbolSet', v),
      });
    case 'status':
      return createSelect({
        key,
        items: STATUSES,
        value: parts.status,
        label: 'Status',
        onChange: (v) => setField('status', v),
      });
    case 'hqtfd':
      return createSelect({
        key,
        items: HQTFD,
        value: parts.hqtfd,
        label: 'HQ / task force / dummy',
        onChange: (v) => setField('hqtfd', v),
      });
    case 'amplifier':
      if (set?.unit) {
        return createSelect({
          key,
          items: ECHELONS,
          value: parts.amplifier,
          label: 'Echelon',
          onChange: (v) => setField('amplifier', v),
        });
      }
      return createDigitInput({
        key,
        length: 2,
        value: parts.amplifier,
        label: 'Mobility',
        note: 'Equipment mobility code; not catalogued for this symbol set — enter it from the standard directly.',
        onChange: (v) => setField('amplifier', v),
      });
    case 'entity':
      if (isLand)
        return createEntityCombobox({
          value: parts.entity,
          onChange: (v) => setField('entity', v),
        });
      return createDigitInput({
        key,
        length: 6,
        value: parts.entity,
        label: 'Entity · type · subtype',
        note: 'Only land unit entities (symbol set 10) are catalogued here — enter the code from this set’s own entity table.',
        onChange: (v) => setField('entity', v),
      });
    case 'modifier1':
      if (isLand) {
        return createSelect({
          key,
          items: MODIFIERS_1,
          value: parts.modifier1,
          label: 'Sector 1 modifier',
          onChange: (v) => setField('modifier1', v),
        });
      }
      return createDigitInput({
        key,
        length: 2,
        value: parts.modifier1,
        label: 'Sector 1 modifier',
        note: 'Only land unit modifiers are catalogued here.',
        onChange: (v) => setField('modifier1', v),
      });
    case 'modifier2':
      if (isLand) {
        return createSelect({
          key,
          items: MODIFIERS_2,
          value: parts.modifier2,
          label: 'Sector 2 modifier',
          onChange: (v) => setField('modifier2', v),
        });
      }
      return createDigitInput({
        key,
        length: 2,
        value: parts.modifier2,
        label: 'Sector 2 modifier',
        note: 'Only land unit modifiers are catalogued here.',
        onChange: (v) => setField('modifier2', v),
      });
    default:
      return null;
  }
}

function buildExplorerSection({ initialSidc, params }) {
  const section = createElement('section', 'symbols-section explorer-section');
  section.id = 'sidc-explorer';
  section.append(createElement('h2', null, 'SIDC explorer'));
  section.append(
    createElement(
      'p',
      'panel-note',
      'Every APP-6(D) symbol is described by a 20-digit numeric SIDC: ten fields, each a fixed span of digits. ' +
        'Build one field at a time below, or paste a code to decode it. The preview and every table on this page are ' +
        'drawn live by milsymbol from the same code.',
    ),
  );

  let sidc = initialSidc;
  let lastIsLand = null;
  let lastIsUnit = null;
  const controls = {};
  const controlSlots = {};
  const segmentEls = {};

  // -- preview + copy --
  const previewColumn = createElement('div', 'explorer-preview');
  const previewSymbol = createElement('div', 'explorer-symbol');
  const previewActions = createElement('div', 'explorer-preview-actions');
  const copyButton = createElement('button', 'chip-button', 'Copy SIDC');
  copyButton.type = 'button';
  const copyStatus = createElement('span', 'copy-status');
  copyStatus.setAttribute('aria-live', 'polite');
  let copyTimer = null;
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(sidc);
      copyStatus.textContent = 'Copied.';
    } catch {
      copyStatus.textContent = 'Copy failed — select and copy the code manually.';
    }
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => (copyStatus.textContent = ''), 3000);
  });
  previewActions.append(copyButton, copyStatus);
  previewColumn.append(previewSymbol, previewActions);

  // -- doc panel --
  const docPanel = createElement('div', 'field-doc');
  const docTitle = createElement('h3', null, '');
  const docBody = createElement('p', null, '');
  const docRef = createElement('p', 'field-doc-ref', '');
  docPanel.append(docTitle, docBody, docRef);
  function resetDoc() {
    docTitle.textContent = 'Hover or focus a field';
    docBody.textContent =
      'Point at a segment below, or at one of its controls, to read what that part of the SIDC means.';
    docRef.textContent = '';
    for (const field of SIDC_FIELDS)
      segmentEls[field.key].button.classList.remove('is-highlighted');
  }
  function showDoc(key) {
    const field = SIDC_FIELDS.find((f) => f.key === key);
    if (!field) return resetDoc();
    docTitle.textContent = field.label;
    docBody.textContent = field.doc;
    docRef.textContent = field.ref ? `${STANDARD}, ${field.ref}` : '';
    for (const f of SIDC_FIELDS)
      segmentEls[f.key].button.classList.toggle('is-highlighted', f.key === key);
  }

  const explorerTop = createElement('div', 'explorer-top');
  explorerTop.append(previewColumn, docPanel);
  section.append(explorerTop);

  // -- paste box --
  const pasteWrapper = createElement('label', 'field explorer-paste-field');
  pasteWrapper.append(createElement('span', null, 'Full SIDC'));
  const pasteInput = document.createElement('input');
  pasteInput.type = 'text';
  pasteInput.className = 'text-input code';
  pasteInput.autocomplete = 'off';
  pasteInput.spellcheck = false;
  pasteInput.setAttribute('aria-describedby', 'sidc-paste-error');
  const pasteError = createElement(
    'p',
    'inline-error',
    'Enter exactly 20 digits (spaces and dashes are OK).',
  );
  pasteError.id = 'sidc-paste-error';
  pasteError.hidden = true;
  pasteInput.addEventListener('input', () => {
    const parsed = parseSidc(pasteInput.value);
    if (parsed) {
      pasteInput.setAttribute('aria-invalid', 'false');
      pasteError.hidden = true;
      applyFields(parsed);
    } else {
      pasteInput.setAttribute('aria-invalid', 'true');
      pasteError.hidden = false;
    }
  });
  pasteWrapper.append(pasteInput, pasteError);
  section.append(pasteWrapper);

  // -- segments --
  const segmentsRow = createElement('div', 'sidc-segments');
  for (const field of SIDC_FIELDS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sidc-segment';
    button.dataset.field = field.key;
    const digits = createElement('span', 'sidc-segment-digits');
    button.append(digits, createElement('span', 'sidc-segment-label', field.label));
    button.addEventListener('click', () => {
      const control = controls[field.key]?.control;
      control?.focus();
      control?.scrollIntoView?.({ block: 'nearest' });
    });
    segmentEls[field.key] = { button, digits };
    segmentsRow.append(button);
  }

  // -- controls --
  const controlsGrid = createElement('div', 'explorer-controls');
  for (const field of SIDC_FIELDS) {
    const slot = createElement('div', 'explorer-control-slot');
    controlSlots[field.key] = slot;
    controlsGrid.append(slot);
  }

  const interactive = createElement('div', 'explorer-interactive');
  interactive.append(segmentsRow, controlsGrid);
  interactive.addEventListener('mouseover', (event) => {
    const el = event.target.closest('[data-field]');
    if (el) showDoc(el.dataset.field);
  });
  interactive.addEventListener('mouseout', (event) => {
    if (!interactive.contains(event.relatedTarget)) resetDoc();
  });
  interactive.addEventListener('focusin', (event) => {
    const el = event.target.closest('[data-field]');
    if (el) showDoc(el.dataset.field);
  });
  interactive.addEventListener('focusout', (event) => {
    if (!interactive.contains(event.relatedTarget)) resetDoc();
  });
  section.append(interactive);
  resetDoc();

  // -- decoded table --
  section.append(createElement('h3', null, 'Decoded'));
  const decodedTable = document.createElement('table');
  decodedTable.className = 'decoded-table';
  decodedTable.append(tableHead(['Field', 'Digits', 'Meaning']));
  const decodedBody = document.createElement('tbody');
  decodedTable.append(decodedBody);
  section.append(decodedTable);

  function setField(key, value) {
    applyFields({ [key]: value });
  }

  function syncControls(parts) {
    const isLand = parts.symbolSet === LAND_SET;
    const isUnit = Boolean(lookup.symbolSet.get(parts.symbolSet)?.unit);
    const modeChanged = isLand !== lastIsLand || isUnit !== lastIsUnit;
    lastIsLand = isLand;
    lastIsUnit = isUnit;
    for (const field of SIDC_FIELDS) {
      const key = field.key;
      if (MODE_DEPENDENT_FIELDS.has(key) && modeChanged) {
        const descriptor = fieldControl(key, parts, setField);
        controlSlots[key].replaceChildren(descriptor.element);
        controls[key] = descriptor;
      } else if (controls[key]) {
        controls[key].setValue(parts[key]);
      } else {
        const descriptor = fieldControl(key, parts, setField);
        controlSlots[key].replaceChildren(descriptor.element);
        controls[key] = descriptor;
      }
    }
  }

  function applySidc(nextSidc) {
    sidc = nextSidc;
    const parts = parseSidc(sidc);
    previewSymbol.replaceChildren(symbolElement(sidc, { size: 180 }, accessibleLabel(sidc)));
    for (const field of SIDC_FIELDS) segmentEls[field.key].digits.textContent = parts[field.key];
    syncControls(parts);
    decodedBody.replaceChildren(
      ...(describeSidc(sidc) ?? []).map((row) => {
        const tr = document.createElement('tr');
        const th = createElement('th', 'code', row.label);
        th.scope = 'row';
        tr.append(
          th,
          createElement('td', 'code', row.code),
          createElement('td', null, row.meaning ?? '—'),
        );
        return tr;
      }),
    );
    if (document.activeElement !== pasteInput) {
      pasteInput.value = sidc;
      pasteInput.setAttribute('aria-invalid', 'false');
      pasteError.hidden = true;
    }
    params.write({ sidc });
  }

  function applyFields(partial) {
    let next;
    try {
      next = formatSidc({ ...parseSidc(sidc), ...partial });
    } catch {
      return;
    }
    applySidc(next);
  }

  applySidc(sidc);

  return {
    element: section,
    applyFields,
    // preventScroll: the caller scrolls the explorer's top (the preview) into view.
    focus: (key) => controls[key]?.control?.focus({ preventScroll: true }),
  };
}

// --- Anatomy -------------------------------------------------------------------

const PLACEMENT_COLUMNS = ['left', 'centre', 'right'];

/**
 * A diagram of where each land unit amplifier sits around the frame,
 * `AMPLIFIER_LAYOUT` (MIL-STD-2525E figure E-3) laid out as a grid: the
 * frame itself spans the centre column's rows 2–6, with `A`/`AA` drawn
 * inside it. Pointing at a letter shows its Table E-II description.
 */
function buildAmplifierPlacementDiagram() {
  const wrapper = createElement('div', 'amplifier-placement');
  wrapper.append(createElement('h4', null, 'Placement'));
  wrapper.append(
    createElement(
      'p',
      'panel-note',
      `${STANDARD}, figure E-3. Point at a letter for its Table E-II description.`,
    ),
  );

  const grid = createElement('div', 'placement-grid');
  const frameBox = createElement('div', 'placement-frame');
  // Layout rows 2–6 are 0-based; CSS grid lines are 1-based.
  frameBox.style.gridRow = '3 / 8';
  frameBox.style.gridColumn = '2';
  grid.append(frameBox);

  const docBox = createElement('div', 'placement-doc');
  const docTitle = createElement('strong', null, 'Point at a letter');
  const docBody = createElement('span', null, 'to read its description.');
  docBox.append(docTitle, docBody);

  function showAmplifierDoc(fieldCode) {
    const amp = AMPLIFIERS.find((a) => a.field === fieldCode);
    if (!amp) return;
    docTitle.textContent = `${amp.field} — ${amp.name}`;
    docBody.textContent = amp.doc;
  }
  function resetAmplifierDoc() {
    docTitle.textContent = 'Point at a letter';
    docBody.textContent = 'to read its description.';
  }

  AMPLIFIER_LAYOUT.forEach((row, rowIndex) => {
    row.forEach((cellFields, colIndex) => {
      if (!cellFields) return;
      const cell = createElement('div', `placement-cell placement-${PLACEMENT_COLUMNS[colIndex]}`);
      cell.style.gridRow = String(rowIndex + 1);
      cell.style.gridColumn = String(colIndex + 1);
      for (const fieldCode of cellFields) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'placement-chip';
        chip.textContent = fieldCode;
        const amp = AMPLIFIERS.find((a) => a.field === fieldCode);
        chip.setAttribute('aria-label', amp ? `${fieldCode}, ${amp.name}` : fieldCode);
        chip.addEventListener('mouseenter', () => showAmplifierDoc(fieldCode));
        chip.addEventListener('focus', () => showAmplifierDoc(fieldCode));
        chip.addEventListener('mouseleave', resetAmplifierDoc);
        chip.addEventListener('blur', resetAmplifierDoc);
        cell.append(chip);
      }
      grid.append(cell);
    });
  });

  wrapper.append(grid, docBox);
  return wrapper;
}

function buildAnatomySection() {
  const section = createElement('section', 'symbols-section');
  section.id = 'anatomy';
  section.append(createElement('h2', null, 'Anatomy'));
  section.append(
    createElement(
      'p',
      'panel-note',
      'A symbol is built in layers: frame and fill carry the standard identity and status; the icon inside names the ' +
        'entity; modifiers, echelon and staff/task-force marks refine it; text amplifiers add unit-specific detail ' +
        'around the frame. milsymbol renders every layer from the same SIDC plus the text-amplifier options below.',
    ),
  );

  const base = {
    version: '10',
    context: '0',
    identity: '3',
    symbolSet: LAND_SET,
    status: '0',
    hqtfd: '0',
    amplifier: '00',
    entity: DEMO_ENTITY,
    modifier1: '00',
    modifier2: '00',
  };
  const steps = [
    {
      sidc: formatSidc(base),
      options: { icon: false },
      caption:
        'Frame and fill: standard identity (friend, blue rectangle) and status (present, solid frame).',
    },
    {
      sidc: formatSidc(base),
      options: {},
      caption: '+ main icon: the entity, read from the symbol set’s entity table (infantry).',
    },
    {
      sidc: formatSidc({ ...base, modifier1: '01' }),
      options: {},
      caption:
        '+ sector 1 modifier: a capability drawn in the upper frame (airmobile / air assault).',
    },
    {
      sidc: formatSidc({ ...base, modifier1: '01', modifier2: '27' }),
      options: {},
      caption: '+ sector 2 modifier: a mobility or size qualifier in the lower frame (mountain).',
    },
    {
      sidc: formatSidc({ ...base, modifier1: '01', modifier2: '27', amplifier: '16' }),
      options: {},
      caption: '+ echelon: unit size, marked above the frame (battalion / squadron, II).',
    },
    {
      sidc: formatSidc({ ...base, modifier1: '01', modifier2: '27', amplifier: '16', hqtfd: '6' }),
      options: {},
      caption:
        '+ HQ staff and task force: a line to the true HQ location, and a bracket marking a temporary grouping.',
    },
    {
      sidc: formatSidc({ ...base, modifier1: '01', modifier2: '27', amplifier: '16', hqtfd: '6' }),
      options: { uniqueDesignation: '42', higherFormation: '4', reinforcedReduced: '(+)' },
      caption:
        '+ text amplifiers: unique designation (42), higher formation (4) and reinforced (+), around the frame.',
    },
  ];
  const strip = createElement('div', 'anatomy-strip');
  steps.forEach((step, index) => {
    const figure = document.createElement('figure');
    figure.className = 'anatomy-step';
    figure.append(
      symbolElement(step.sidc, { size: 90, ...step.options }, accessibleLabel(step.sidc)),
    );
    figure.append(createFigcaption(step.caption));
    strip.append(figure);
    if (index < steps.length - 1) strip.append(createElement('span', 'anatomy-arrow', '→'));
  });
  section.append(strip);

  section.append(createElement('h3', null, 'Text and graphic amplifiers'));
  section.append(
    createElement(
      'p',
      'panel-note',
      `Amplifiers add information around the frame without changing the icon (${STANDARD}, appendix E table ` +
        'E-II). Each has a fixed place around the frame; milsymbol draws it from the matching option, or straight ' +
        'from the SIDC for the echelon, task-force and feint/dummy marks.',
    ),
  );
  const amplifierReference = createElement('div', 'amplifier-reference');
  const sampleOptions = Object.fromEntries(
    AMPLIFIERS.filter((a) => a.option && a.sample).map((a) => [a.option, a.sample]),
  );
  const demoSidc = formatSidc({ ...base, hqtfd: '6', amplifier: '16' });
  const demoFigure = createElement('div', 'amplifier-demo');
  demoFigure.append(
    symbolElement(demoSidc, { size: 90, ...sampleOptions }, accessibleLabel(demoSidc)),
  );

  const amplifierVisuals = createElement('div', 'amplifier-visuals');
  amplifierVisuals.append(demoFigure, buildAmplifierPlacementDiagram());
  amplifierReference.append(amplifierVisuals);

  const table = document.createElement('table');
  table.className = 'amplifier-table';
  table.append(tableHead(['Field', 'Name', 'Description']));
  const tbody = document.createElement('tbody');
  for (const amp of AMPLIFIERS) {
    const tr = document.createElement('tr');
    const th = createElement('th', 'code', amp.field);
    th.scope = 'row';
    tr.append(th, createElement('td', null, amp.name), createElement('td', null, amp.doc));
    tbody.append(tr);
  }
  table.append(tbody);
  amplifierReference.append(table);
  section.append(amplifierReference);

  return section;
}

// --- Standard identity & frames --------------------------------------------------

function buildFramesSection() {
  const section = createElement('section', 'symbols-section');
  section.id = 'identity-frames';
  section.append(createElement('h2', null, 'Standard identity & frames'));
  section.append(
    createElement(
      'p',
      'panel-note',
      'The standard identity (SIDC digit 4) sets frame shape and colour: it is the first thing an analyst reads off ' +
        'a symbol, independent of what the symbol represents. Frame shape carries the same meaning in every framed ' +
        'symbol set.',
    ),
  );

  const table = document.createElement('table');
  table.className = 'frame-matrix';
  const headRow = document.createElement('tr');
  headRow.append(createElement('th', null, 'Symbol set'));
  for (const identity of IDENTITIES) headRow.append(createElement('th', null, identity.name));
  const thead = document.createElement('thead');
  thead.append(headRow);
  table.append(thead);
  const tbody = document.createElement('tbody');
  for (const setCode of FRAME_SETS) {
    const setInfo = lookup.symbolSet.get(setCode);
    const tr = document.createElement('tr');
    const th = createElement('th', null, setInfo.name);
    th.scope = 'row';
    tr.append(th);
    for (const identity of IDENTITIES) {
      const sidc = formatSidc({
        version: '10',
        context: '0',
        identity: identity.code,
        symbolSet: setCode,
        status: '0',
        hqtfd: '0',
        amplifier: '00',
        entity: '000000',
        modifier1: '00',
        modifier2: '00',
      });
      const td = document.createElement('td');
      td.append(
        symbolElement(
          sidc,
          { size: 44, icon: false },
          `${identity.name}, ${setInfo.name.toLowerCase()}`,
        ),
      );
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  section.append(table);

  section.append(createElement('h3', null, 'Standard identities'));
  const identityList = document.createElement('dl');
  identityList.className = 'identity-doc-list';
  for (const identity of IDENTITIES) {
    identityList.append(
      createElement('dt', null, identity.name),
      createElement('dd', null, identity.doc),
    );
  }
  section.append(identityList);

  section.append(createElement('h3', null, 'Exercise: joker and faker'));
  section.append(
    createElement(
      'p',
      'panel-note',
      'In an exercise context (SIDC digit 3 = 1), the suspect and hostile identities are read as joker and faker: ' +
        'friendly forces role-playing an opposing force. The frame stays blue (friend); a letter marks the role.',
    ),
  );
  const jokerFaker = createElement('div', 'anatomy-strip');
  for (const [code, name] of [
    ['5', 'Joker — friend exercising as suspect'],
    ['6', 'Faker — friend exercising as hostile'],
  ]) {
    const sidc = formatSidc({
      version: '10',
      context: '1',
      identity: code,
      symbolSet: LAND_SET,
      status: '0',
      hqtfd: '0',
      amplifier: '00',
      entity: DEMO_ENTITY,
      modifier1: '00',
      modifier2: '00',
    });
    const figure = document.createElement('figure');
    figure.className = 'anatomy-step';
    figure.append(symbolElement(sidc, { size: 90 }, name));
    figure.append(createFigcaption(name));
    jokerFaker.append(figure);
  }
  section.append(jokerFaker);

  return section;
}

// --- Status ----------------------------------------------------------------------

function buildStatusSection() {
  const section = createElement('section', 'symbols-section');
  section.id = 'status';
  section.append(createElement('h2', null, 'Status'));
  section.append(
    createElement(
      'p',
      'panel-note',
      'Status (SIDC digit 7) marks whether an object is present or only planned, and — for a present object — an ' +
        'optional operational-condition bar under the frame. It answers "is this real and ready", independent of ' +
        'identity or type.',
    ),
  );
  const grid = createElement('div', 'ladder-grid');
  for (const status of STATUSES) {
    const sidc = formatSidc({
      version: '10',
      context: '0',
      identity: '3',
      symbolSet: LAND_SET,
      status: status.code,
      hqtfd: '0',
      amplifier: '15',
      entity: DEMO_ENTITY,
      modifier1: '00',
      modifier2: '00',
    });
    const figure = document.createElement('figure');
    figure.className = 'ladder-step';
    figure.append(
      symbolElement(sidc, { size: 76 }, `Friend, infantry company, ${status.name.toLowerCase()}`),
    );
    const caption = document.createElement('figcaption');
    caption.append(
      createElement('strong', null, status.name),
      document.createTextNode(` — ${status.doc}`),
    );
    figure.append(caption);
    grid.append(figure);
  }
  section.append(grid);
  return section;
}

// --- HQ / task force / dummy ------------------------------------------------------

function buildHqtfdSection() {
  const section = createElement('section', 'symbols-section');
  section.id = 'hq-tf-dummy';
  section.append(createElement('h2', null, 'HQ / task force / dummy'));
  section.append(
    createElement(
      'p',
      'panel-note',
      'SIDC digit 8 combines three independent marks: headquarters (a staff line to the unit’s true location), ' +
        'task force (a bracket over the echelon, for a temporary grouping) and feint/dummy (a chevron, for a ' +
        'deception measure). The eight codes cover every combination.',
    ),
  );
  const grid = createElement('div', 'ladder-grid');
  for (const item of HQTFD) {
    const sidc = formatSidc({
      version: '10',
      context: '0',
      identity: '3',
      symbolSet: LAND_SET,
      status: '0',
      hqtfd: item.code,
      amplifier: '16',
      entity: DEMO_ENTITY,
      modifier1: '00',
      modifier2: '00',
    });
    const figure = document.createElement('figure');
    figure.className = 'ladder-step';
    figure.append(
      symbolElement(sidc, { size: 76 }, `Friend, infantry battalion, ${item.name.toLowerCase()}`),
    );
    figure.append(createFigcaption(item.name));
    grid.append(figure);
  }
  section.append(grid);
  return section;
}

// --- Echelons --------------------------------------------------------------------

function buildEchelonSection() {
  const section = createElement('section', 'symbols-section');
  section.id = 'echelons';
  section.append(createElement('h2', null, 'Echelons'));
  section.append(
    createElement(
      'p',
      'panel-note',
      'Echelon (SIDC digits 9–10) marks unit size above the frame, from a two-person team to an army group. On ' +
        'equipment symbol sets the same digits instead carry a mobility code — see the SIDC explorer.',
    ),
  );
  const ladder = createElement('div', 'echelon-ladder');
  for (const echelon of ECHELONS) {
    const sidc = formatSidc({
      version: '10',
      context: '0',
      identity: '3',
      symbolSet: LAND_SET,
      status: '0',
      hqtfd: '0',
      amplifier: echelon.code,
      entity: DEMO_ENTITY,
      modifier1: '00',
      modifier2: '00',
    });
    const row = createElement('div', 'echelon-row');
    row.append(
      symbolElement(sidc, { size: 56 }, `Friend, infantry, ${echelon.name.toLowerCase()}`),
    );
    row.append(createElement('span', 'echelon-name', echelon.name));
    row.append(createElement('span', 'echelon-marker code', echelon.marker || '—'));
    ladder.append(row);
  }
  section.append(ladder);
  return section;
}

// --- Icon catalogue ---------------------------------------------------------------

function buildIconCatalogueSection({ onPick }) {
  const section = createElement('section', 'symbols-section');
  section.id = 'icon-catalogue';
  section.append(createElement('h2', null, 'Icon catalogue'));
  section.append(
    createElement(
      'p',
      'panel-note',
      `${ENTITIES.length} land unit entities (symbol set 10), grouped by branch, ${STANDARD} appendix A table ` +
        'A-XXIII. Search by name or code, or filter to a branch; select a card to load that entity into the SIDC ' +
        'explorer above. A plain card is still in 2525E(1)’s own land unit tables; a dashed "Not in 2525E" card ' +
        'was dropped from them; a dashed "2525E: common modifier" card (modifier catalogues only, below) moved ' +
        'into 2525E’s shared common-modifier tables instead. All three remain valid version-10 codes.',
    ),
  );

  const controlsRow = createElement('div', 'catalogue-controls');
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'text-input catalogue-search';
  searchInput.placeholder = 'Search entities…';
  searchInput.setAttribute('aria-label', 'Search icon catalogue');
  controlsRow.append(searchInput);
  section.append(controlsRow);

  const chipsRow = createElement('div', 'catalogue-chips');
  chipsRow.setAttribute('role', 'group');
  chipsRow.setAttribute('aria-label', 'Filter by branch');
  const allChip = createElement('button', 'chip-button is-active', 'All branches');
  allChip.type = 'button';
  allChip.setAttribute('aria-pressed', 'true');
  chipsRow.append(allChip);
  const groupChips = new Map();
  for (const group of ENTITY_GROUPS) {
    const chip = createElement('button', 'chip-button', group.name);
    chip.type = 'button';
    chip.title = group.doc;
    chip.setAttribute('aria-pressed', 'false');
    chipsRow.append(chip);
    groupChips.set(group.code, chip);
  }
  section.append(chipsRow);

  const groupsContainer = createElement('div', 'catalogue-groups');
  const groupBlocks = new Map();
  const cardEntries = [];
  for (const group of ENTITY_GROUPS) {
    const entities = ENTITIES.filter((e) => e.group === group.code);
    if (!entities.length) continue;
    const block = createElement('div', 'catalogue-group');
    block.append(
      createElement('h3', null, group.name),
      createElement('p', 'panel-note', group.doc),
    );
    const grid = createElement('div', 'catalogue-grid');
    for (const entity of entities) {
      const sidc = withFields(DEFAULT_SIDC, { entity: entity.code });
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'catalogue-card';
      card.dataset.search = `${entity.code} ${entity.name}`.toLowerCase();
      card.append(symbolElement(sidc, { size: 46 }));
      card.append(createElement('span', 'catalogue-card-name', entity.name));
      card.append(createElement('span', 'catalogue-card-code code', entity.code));
      let ariaLabel = `${entity.name}, land unit, code ${entity.code}`;
      if (entity.in2525E) {
        card.classList.add('is-edition-flagged');
        card.append(editionBadge(entity.in2525E));
        ariaLabel +=
          entity.in2525E === 'removed' ? ', not in MIL-STD-2525E' : ', 2525E common modifier';
      }
      card.setAttribute('aria-label', ariaLabel);
      card.addEventListener('click', () => onPick(entity.code));
      grid.append(card);
      cardEntries.push({ code: entity.code, group: group.code, card });
    }
    block.append(grid);
    groupsContainer.append(block);
    groupBlocks.set(group.code, block);
  }
  section.append(groupsContainer);

  const emptyState = createElement(
    'p',
    'panel-note catalogue-empty',
    'No entities match that search.',
  );
  emptyState.hidden = true;
  section.append(emptyState);

  let activeGroup = null;
  function applyFilter() {
    const needle = searchInput.value.trim().toLowerCase();
    let anyVisible = false;
    for (const entry of cardEntries) {
      const visible =
        (!activeGroup || entry.group === activeGroup) &&
        (!needle || entry.card.dataset.search.includes(needle));
      entry.card.hidden = !visible;
      if (visible) anyVisible = true;
    }
    for (const [code, block] of groupBlocks) {
      const groupMatches = !activeGroup || activeGroup === code;
      const hasVisibleCard =
        groupMatches && [...block.querySelectorAll('.catalogue-card')].some((c) => !c.hidden);
      block.hidden = !hasVisibleCard;
    }
    emptyState.hidden = anyVisible;
  }
  function selectGroup(code) {
    activeGroup = code;
    allChip.classList.toggle('is-active', code === null);
    allChip.setAttribute('aria-pressed', String(code === null));
    for (const [otherCode, chip] of groupChips) {
      chip.classList.toggle('is-active', otherCode === code);
      chip.setAttribute('aria-pressed', String(otherCode === code));
    }
    applyFilter();
  }
  searchInput.addEventListener('input', applyFilter);
  allChip.addEventListener('click', () => selectGroup(null));
  for (const [code, chip] of groupChips) chip.addEventListener('click', () => selectGroup(code));

  return section;
}

// --- Modifiers ---------------------------------------------------------------------

function buildModifierSubCatalogue({ title, intro, items, fieldKey, onPick }) {
  const wrapper = createElement('div', 'modifier-catalogue');
  wrapper.append(createElement('h3', null, title), createElement('p', 'panel-note', intro));

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'text-input catalogue-search';
  searchInput.placeholder = `Search ${title.toLowerCase()}…`;
  searchInput.setAttribute('aria-label', `Search ${title}`);
  wrapper.append(searchInput);

  const grid = createElement('div', 'catalogue-grid');
  const cards = [];
  for (const item of items) {
    const sidc = withFields(DEFAULT_SIDC, { [fieldKey]: item.code });
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'catalogue-card';
    card.dataset.search = `${item.code} ${item.name}`.toLowerCase();
    card.append(symbolElement(sidc, { size: 46, icon: false }));
    card.append(createElement('span', 'catalogue-card-name', item.name));
    card.append(createElement('span', 'catalogue-card-code code', item.code));
    let ariaLabel = `${item.name}, code ${item.code}`;
    if (item.in2525E) {
      card.classList.add('is-edition-flagged');
      card.append(editionBadge(item.in2525E));
      ariaLabel +=
        item.in2525E === 'removed' ? ', not in MIL-STD-2525E' : ', 2525E common modifier';
    }
    card.setAttribute('aria-label', ariaLabel);
    card.addEventListener('click', () => onPick(item.code));
    grid.append(card);
    cards.push(card);
  }
  wrapper.append(grid);

  const emptyState = createElement(
    'p',
    'panel-note catalogue-empty',
    'No modifiers match that search.',
  );
  emptyState.hidden = true;
  wrapper.append(emptyState);
  searchInput.addEventListener('input', () => {
    const needle = searchInput.value.trim().toLowerCase();
    let any = false;
    for (const card of cards) {
      const visible = !needle || card.dataset.search.includes(needle);
      card.hidden = !visible;
      if (visible) any = true;
    }
    emptyState.hidden = any;
  });

  return wrapper;
}

function buildModifiersSection({ onPickModifier1, onPickModifier2 }) {
  const section = createElement('section', 'symbols-section');
  section.id = 'modifiers';
  section.append(createElement('h2', null, 'Modifiers'));
  section.append(
    createElement(
      'p',
      'panel-note',
      'Sector modifiers refine a unit icon without changing it: sector 1 (upper frame) usually marks a capability ' +
        'or role, sector 2 (lower frame) a mobility or size qualifier. Both are catalogued for land units only ' +
        `(symbol set 10, ${STANDARD} appendix A tables A-XXIV and A-XXV); cards below are drawn on a bare ` +
        'friendly frame — icon hidden — so the modifier reads clearly. A dashed "2525E: common modifier" card ' +
        'moved into 2525E’s shared common-modifier tables (A-IX/A-X) rather than its own land unit table; a ' +
        'dashed "Not in 2525E" card was dropped outright. Select a card to apply it in the SIDC explorer above.',
    ),
  );
  section.append(
    buildModifierSubCatalogue({
      title: 'Sector 1 modifiers',
      intro: `${MODIFIERS_1.length} capability and role modifiers, drawn in the upper part of the frame.`,
      items: MODIFIERS_1,
      fieldKey: 'modifier1',
      onPick: onPickModifier1,
    }),
  );
  section.append(
    buildModifierSubCatalogue({
      title: 'Sector 2 modifiers',
      intro: `${MODIFIERS_2.length} mobility and size modifiers, drawn in the lower part of the frame.`,
      items: MODIFIERS_2,
      fieldKey: 'modifier2',
      onPick: onPickModifier2,
    }),
  );
  return section;
}

// --- Mount -----------------------------------------------------------------------

export function mountSymbols({ root, params }) {
  const view = createElement('div', 'symbols-view');

  const toc = createElement('nav', 'symbols-toc');
  toc.setAttribute('aria-label', 'Symbology sections');
  const list = document.createElement('ol');
  const tocLinks = new Map();
  for (const meta of SECTIONS_META) {
    const li = document.createElement('li');
    const a = createElement('a', 'toc-link', meta.title);
    a.href = `#${meta.id}`;
    li.append(a);
    list.append(li);
    tocLinks.set(meta.id, a);
  }
  toc.append(list);

  const content = createElement('div', 'symbols-content');
  const header = createElement('header', 'symbols-header');
  header.append(
    createElement('h1', null, 'Symbology'),
    createElement(
      'p',
      null,
      `A working reference for the harmonized NATO APP-6 / MIL-STD-2525 military symbol standard, checked against ` +
        `${STANDARD} (appendix A, figure A-1). This page and the ORBAT builder write version 10 codes ` +
        '(APP-6(D)(1) / MIL-STD-2525D): positions 1–20 — the ten fields below — keep the same structure in 2525E, ' +
        'which adds positions 21–30 (sector common-modifier identifiers, frame shape, country) not used here. ' +
        'Every symbol on this page is drawn live by milsymbol 3.0.4, in APP-6 style, from the SIDC shown ' +
        'beside it.',
    ),
  );
  content.append(header);

  const storedSidc = parseSidc(params.read().get('sidc'));
  const initialSidc = storedSidc ? formatSidc(storedSidc) : DEFAULT_SIDC;
  const explorer = buildExplorerSection({ initialSidc, params });

  function jumpTo(id) {
    content.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function loadEntity(code) {
    explorer.applyFields({ symbolSet: LAND_SET, entity: code });
    jumpTo('sidc-explorer');
    explorer.focus('entity');
  }
  function loadModifier(fieldKey, code) {
    explorer.applyFields({ symbolSet: LAND_SET, [fieldKey]: code });
    jumpTo('sidc-explorer');
    explorer.focus(fieldKey);
  }

  content.append(
    explorer.element,
    buildAnatomySection(),
    buildFramesSection(),
    buildStatusSection(),
    buildHqtfdSection(),
    buildEchelonSection(),
    buildIconCatalogueSection({ onPick: loadEntity }),
    buildModifiersSection({
      onPickModifier1: (code) => loadModifier('modifier1', code),
      onPickModifier2: (code) => loadModifier('modifier2', code),
    }),
  );

  view.append(toc, content);
  root.append(view);

  function onTocClick(event) {
    const link = event.target.closest('.toc-link');
    if (!link) return;
    event.preventDefault();
    jumpTo(link.getAttribute('href').slice(1));
  }
  list.addEventListener('click', onTocClick);

  const order = SECTIONS_META.map((m) => m.id);
  const visible = new Set();
  function updateHighlight() {
    // Near a section boundary, both the outgoing and incoming section can
    // intersect the shrunk root at once; prefer the one later in reading
    // order so the highlight follows the section actually at the top.
    const activeId = order.findLast((id) => visible.has(id));
    for (const [id, link] of tocLinks) {
      const isActive = id === activeId;
      link.classList.toggle('is-active', isActive);
      if (isActive) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      updateHighlight();
    },
    { root: content, rootMargin: '0px 0px -70% 0px', threshold: 0 },
  );
  for (const id of order) {
    const el = content.querySelector(`#${id}`);
    if (el) observer.observe(el);
  }
  updateHighlight();

  return () => {
    observer.disconnect();
    list.removeEventListener('click', onTocClick);
  };
}
