/**
 * The unit dialog: a placed unit's symbol and its APP-6 amplifiers
 * (`src/symbols/unitProperties.js`), with a live preview, and which COA it
 * belongs to. Its own `<dialog>` inside the module root (so the module's
 * stylesheet reaches it), like the shared symbol picker it opens.
 */
import { formatDtg } from '../../../src/dtg.js';
import { createDtgInput, readDtgValue } from '../../../src/dtgField.js';
import { openSymbolPicker } from '../../../src/symbols/picker.js';
import { symbolElement } from '../../../src/symbols/symbol.js';
import { UNIT_AMPLIFIERS, unitSymbolOptions } from '../../../src/symbols/unitProperties.js';

/** COA choice value for a unit shown on every COA (`coa_id: null`). */
export const EVERY_COA = '';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function amplifierControl(spec, value, reference) {
  if (spec.values) {
    const select = element('select', 'dialog-input');
    for (const option of spec.values) {
      select.append(new Option(option || 'None', option));
    }
    select.value = value ?? '';
    return select;
  }
  if (spec.key === 'dtg') {
    const input = createDtgInput({ name: spec.key, label: spec.label, reference });
    input.classList.add('dialog-input');
    input.value = value ?? '';
    return input;
  }
  const input = element('input', 'dialog-input');
  input.name = spec.key;
  input.autocomplete = 'off';
  if (spec.degrees) {
    input.type = 'number';
    input.min = '0';
    input.max = '359';
    input.step = '1';
    input.placeholder = 'Degrees from north, e.g. 90';
    input.value = Number.isInteger(value) ? String(value) : '';
  } else {
    input.type = 'text';
    input.maxLength = spec.maxLength;
    input.value = value ?? '';
  }
  return input;
}

/** The control's value as stored: trimmed text, whole degrees, a DTG, or null when empty. */
function readAmplifier(spec, control) {
  const text = control.value.trim();
  if (spec.values) return text || null;
  if (!text) return null;
  if (spec.key === 'dtg') return formatDtg(Date.parse(readDtgValue(control)));
  if (spec.degrees) {
    if (!control.checkValidity()) {
      control.reportValidity();
      throw new Error(`${spec.label}: whole degrees from 0 to 359.`);
    }
    return Number(text);
  }
  return text;
}

/**
 * Opens the dialog in `root`. `properties` seeds the symbol and amplifiers;
 * `coas` (`[{ id, name }]`) and `coaId` add the COA choice, omitted when
 * `coas` is null. Resolves to `{ properties, coaId }` — `properties` holds
 * `sidc` plus every amplifier key (null when cleared) — or null on cancel.
 */
export function openUnitDialog({
  root,
  title,
  properties = {},
  coas = null,
  coaId = null,
  accept = 'Save',
  reference = () => Date.now(),
}) {
  return new Promise((resolve) => {
    let sidc = properties.sidc;
    const dialog = element('dialog', 'workspace-dialog unit-dialog');
    const form = element('form');
    form.method = 'dialog';
    form.noValidate = true;
    form.append(element('h2', 'dialog-message', title));

    const symbolRow = element('div', 'unit-dialog-symbol');
    const preview = element('div', 'unit-dialog-preview');
    const changeSymbol = element('button', 'chip-button', 'Change symbol…');
    changeSymbol.type = 'button';
    symbolRow.append(preview, changeSymbol);
    form.append(symbolRow);

    const fields = element('div', 'unit-dialog-fields');
    const controls = new Map();
    for (const spec of UNIT_AMPLIFIERS) {
      const label = element('label', 'dialog-field');
      label.append(element('span', null, `${spec.label} (${spec.field})`));
      const control = amplifierControl(spec, properties[spec.key], reference);
      label.append(control);
      fields.append(label);
      controls.set(spec, control);
    }
    let coaSelect = null;
    if (coas) {
      const label = element('label', 'dialog-field unit-dialog-coa');
      label.append(element('span', null, 'Shown on'));
      coaSelect = element('select', 'dialog-input');
      coaSelect.append(new Option('Every COA', EVERY_COA));
      for (const coa of coas) coaSelect.append(new Option(coa.name, String(coa.id)));
      coaSelect.value = coaId == null ? EVERY_COA : String(coaId);
      label.append(coaSelect);
      fields.append(label);
    }
    form.append(fields);

    const error = element('p', 'inline-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    form.append(error);

    const actions = element('div', 'dialog-actions');
    const cancel = element('button', 'text-button', 'Cancel');
    cancel.type = 'button';
    const save = element('button', 'dialog-accept', accept);
    save.type = 'submit';
    actions.append(cancel, save);
    form.append(actions);
    dialog.append(form);
    root.append(dialog);

    /** What the controls hold now; text left as typed so the preview never throws. */
    const draft = () => {
      const values = { sidc };
      for (const [spec, control] of controls) {
        const text = control.value.trim();
        if (!text) continue;
        values[spec.key] = spec.degrees ? Number(text) : text;
      }
      if (!Number.isInteger(values.direction) || values.direction < 0 || values.direction > 359) {
        delete values.direction;
      }
      return values;
    };
    const paintPreview = () => {
      const values = draft();
      preview.replaceChildren(
        symbolElement(sidc, { size: 36, ...unitSymbolOptions(values) }, 'Symbol preview'),
      );
    };
    paintPreview();
    fields.addEventListener('input', paintPreview);
    fields.addEventListener('change', paintPreview);

    changeSymbol.addEventListener('click', async () => {
      const picked = await openSymbolPicker({ initial: sidc, title: 'Unit symbol' });
      if (!picked) return;
      sidc = picked;
      paintPreview();
    });

    let result = null;
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      try {
        const values = { sidc };
        for (const [spec, control] of controls) values[spec.key] = readAmplifier(spec, control);
        result = {
          properties: values,
          coaId: coaSelect
            ? coaSelect.value === EVERY_COA
              ? null
              : Number(coaSelect.value)
            : coaId,
        };
        dialog.close();
      } catch (caught) {
        error.textContent = caught.message;
        error.hidden = false;
      }
    });
    dialog.addEventListener(
      'close',
      () => {
        dialog.remove();
        resolve(result);
      },
      { once: true },
    );
    dialog.showModal();
    controls.values().next().value.focus();
  });
}
