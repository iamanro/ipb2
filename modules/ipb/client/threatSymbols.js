/**
 * Step 3 (evaluate the threat): a threat's own SIDC via the shared symbol
 * picker, and "Import from ORBAT" — pick units from an existing order of
 * battle and create one threat per unit, hostile affiliation forced.
 *
 * `renderThreatSymbolCell`/`importThreatsFromOrbat` take the handful of
 * view.js internals they need as parameters (dependency injection) rather
 * than importing the shared module, so this file has no load-order
 * coupling to view.js beyond the shared libraries every module uses.
 */
import { openSymbolPicker } from '../../../src/symbols/picker.js';
import { can, cellLabel } from '../../../src/session.js';
import { parseSidc, withAffiliation } from '../../../src/symbols/sidc.js';
import { symbolElement } from '../../../src/symbols/symbol.js';

/** APP-6(D) echelon amplifier code -> IPB study echelon name (the inverse of
 * `src/symbols/sidc.js`'s private `AMPLIFIER_BY_ECHELON_NAME`, duplicated
 * here read-only since that table isn't exported). */
const IPB_ECHELON_BY_AMPLIFIER = {
  11: 'team',
  12: 'squad',
  13: 'section',
  14: 'platoon',
  15: 'company',
  16: 'battalion',
  17: 'regiment',
  18: 'brigade',
  21: 'division',
  22: 'corps',
  23: 'army',
};

/** The IPB echelon name a SIDC's amplifier maps to, or null when it names no
 * such echelon (unspecified, an equipment mobility code, or an unreadable SIDC). */
export function ipbEchelonFromSidc(sidc) {
  const parts = parseSidc(sidc);
  if (!parts) return null;
  return IPB_ECHELON_BY_AMPLIFIER[Number(parts.amplifier)] ?? null;
}

/**
 * A threat row's symbol cell: the current SIDC as an icon plus a "Change
 * symbol" button opening the shared picker seeded hostile. `onChange(sidc)`
 * persists the choice (e.g. `PATCH threats/:id {sidc}`); the icon refreshes
 * once it resolves. `disabled` hides the button for roles that can't edit.
 */
export function renderThreatSymbolCell(
  threat,
  { createElement, onChange, onError, disabled = false },
) {
  const cell = createElement('td', 'threat-symbol-cell');
  const preview = createElement('span', 'threat-symbol-preview');
  const paintIcon = () => {
    preview.replaceChildren(
      threat.sidc
        ? symbolElement(threat.sidc, { size: 28 }, `${threat.name} symbol`)
        : createElement('span', 'panel-note', '—'),
    );
  };
  paintIcon();
  cell.append(preview);
  if (!disabled) {
    const button = createElement('button', 'icon-button', 'Change symbol');
    button.type = 'button';
    button.addEventListener('click', async () => {
      const sidc = await openSymbolPicker({
        initial: threat.sidc,
        affiliation: 'hostile',
        title: `Symbol for ${threat.name}`,
      });
      if (!sidc) return;
      try {
        await onChange(sidc);
        paintIcon();
      } catch (error) {
        onError?.(error);
      }
    });
    cell.append(button);
  }
  return cell;
}

/** `{ id, orbatId, parentId, position, sidc, name, designation }` -> a display line. */
function unitDisplayName(unit) {
  return unit.designation ? `${unit.name} — ${unit.designation}` : unit.name;
}

/** Depth-first children lookup, mirroring the server's own `orderedUnits` ordering. */
function childrenByParent(units) {
  const map = new Map();
  for (const unit of units) {
    const key = unit.parentId ?? null;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(unit);
  }
  return map;
}

function buildUnitTree(container, units, checked, onToggle) {
  const byParent = childrenByParent(units);
  const walk = (parentKey, depth) => {
    for (const unit of byParent.get(parentKey) ?? []) {
      const row = document.createElement('li');
      row.className = 'orbat-import-row';
      row.style.setProperty('--depth', String(depth));
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = checked.has(unit.id);
      checkbox.addEventListener('change', () => onToggle(unit.id, checkbox.checked));
      // Decorative: the adjacent text already names the unit, so the icon
      // doesn't need its own accessible name (avoiding a doubled announcement).
      label.append(checkbox, symbolElement(unit.sidc, { size: 22 }));
      const text = document.createElement('span');
      text.textContent = unitDisplayName(unit);
      label.append(text);
      row.append(label);
      container.append(row);
      walk(unit.id, depth + 1);
    }
  };
  walk(null, 0);
}

/**
 * Opens a self-contained modal (its own `<dialog>`, like `openSymbolPicker`):
 * choose an ORBAT, then a multi-select tree of its units. Resolves to the
 * threat-create bodies for the checked units — `{ name, echelon, sidc,
 * orbat_unit_id }`, hostile affiliation forced — or null if cancelled.
 */
export function openOrbatImportDialog({ requestJson, orbatApi = '/api/orbat' }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'workspace-dialog orbat-import-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'orbat-import-form';

    const heading = document.createElement('h2');
    heading.className = 'orbat-import-title';
    heading.textContent = 'Import threats from ORBAT';
    form.append(heading);

    const orbatField = document.createElement('label');
    orbatField.className = 'field';
    orbatField.append(Object.assign(document.createElement('span'), { textContent: 'ORBAT' }));
    const orbatSelect = document.createElement('select');
    orbatSelect.className = 'text-input';
    orbatField.append(orbatSelect);
    form.append(orbatField);

    const status = document.createElement('p');
    status.className = 'panel-note orbat-import-status';
    form.append(status);

    const tree = document.createElement('ul');
    tree.className = 'orbat-import-tree';
    form.append(tree);

    const actions = document.createElement('div');
    actions.className = 'symbol-picker-actions';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'text-button';
    cancelButton.textContent = 'Cancel';
    const importButton = document.createElement('button');
    importButton.type = 'submit';
    importButton.className = 'symbol-picker-accept';
    importButton.textContent = 'Import selected';
    importButton.disabled = true;
    actions.append(cancelButton, importButton);
    form.append(actions);

    dialog.append(form);
    document.body.append(dialog);

    let units = [];
    const checked = new Set();

    const updateImportEnabled = () => {
      importButton.disabled = checked.size === 0;
      importButton.textContent = checked.size
        ? `Import ${checked.size} selected`
        : 'Import selected';
    };

    async function loadDocument(orbatId) {
      units = [];
      checked.clear();
      tree.replaceChildren();
      updateImportEnabled();
      if (!orbatId) return;
      status.textContent = 'Loading…';
      try {
        const doc = await requestJson(`${orbatApi}/orbats/${orbatId}`);
        units = doc.units;
        status.textContent = units.length ? '' : 'This ORBAT has no units yet.';
        buildUnitTree(tree, units, checked, (id, isChecked) => {
          if (isChecked) checked.add(id);
          else checked.delete(id);
          updateImportEnabled();
        });
      } catch (error) {
        status.textContent = error.message;
      }
    }

    async function loadOrbats() {
      status.textContent = 'Loading…';
      try {
        const orbats = await requestJson(`${orbatApi}/orbats`);
        orbatSelect.replaceChildren(
          ...orbats.map((orbat) => {
            const option = document.createElement('option');
            option.value = String(orbat.id);
            option.textContent = `[${cellLabel(orbat.owner_cell)}] ${orbat.name} (${orbat.unitCount} unit${orbat.unitCount === 1 ? '' : 's'})`;
            return option;
          }),
        );
        status.textContent = orbats.length ? '' : 'No ORBATs yet: create one in the ORBAT module.';
        if (orbats.length) await loadDocument(Number(orbatSelect.value));
      } catch (error) {
        status.textContent = error.message;
      }
    }

    orbatSelect.addEventListener('change', () => loadDocument(Number(orbatSelect.value)));

    cancelButton.addEventListener('click', () => {
      dialog.returnValue = 'cancel';
      dialog.close();
    });

    form.addEventListener('submit', () => {
      dialog.returnValue = 'accept';
    });

    dialog.addEventListener(
      'close',
      () => {
        const result =
          dialog.returnValue === 'accept'
            ? units
                .filter((unit) => checked.has(unit.id))
                .map((unit) => ({
                  name: unitDisplayName(unit),
                  echelon: ipbEchelonFromSidc(unit.sidc),
                  sidc: withAffiliation(unit.sidc, 'hostile'),
                  orbat_unit_id: unit.id,
                }))
            : null;
        dialog.remove();
        resolve(result);
      },
      { once: true },
    );

    dialog.showModal();
    loadOrbats();
  });
}

/**
 * Runs the dialog above, then creates one threat per checked unit. Returns
 * the created threats (possibly fewer than selected, if some failed — each
 * failure is reported via `onError`), or null if the analyst cancelled.
 */
export async function importThreatsFromOrbat({ requestJson, studyId, api, onError }) {
  if (!can('analyst')) return null;
  const items = await openOrbatImportDialog({ requestJson });
  if (!items || !items.length) return null;
  const created = [];
  for (const item of items) {
    try {
      const threat = await requestJson(`${api}/studies/${studyId}/threats`, {
        method: 'POST',
        body: item,
      });
      created.push(threat);
    } catch (error) {
      onError?.(error, item);
    }
  }
  return created;
}
