/**
 * An ORBAT on the map (step 4): choose an ORBAT and some of its units, then
 * place them one click at a time, or lay the rest out below one click. Each
 * placed unit is a SITEMP unit feature linked back to its ORBAT unit
 * (`properties.orbat_id`/`orbat_unit_id`), so a later change in the ORBAT
 * shows as "changed in the ORBAT" and one action brings the copies up to
 * date. The link is a copy, not a live view: another cell that can see the
 * study but not the ORBAT still sees the units as they were placed.
 *
 * The pure parts (`orbatUnitProperties`, `orbatLinkStatus`, `layoutUnits`)
 * have no DOM and are unit-tested.
 */
import { withAffiliation } from '../../../src/symbols/sidc.js';
import { symbolElement } from '../../../src/symbols/symbol.js';
import { cellLabel } from '../../../src/session.js';
import { buildUnitTree, unitDisplayName, unitsInTreeOrder } from './threatSymbols.js';

/** The unit properties an ORBAT copy keeps in step with its ORBAT unit. */
export const ORBAT_SYNCED_KEYS = [
  'sidc',
  'designation',
  'higher_formation',
  'reinforced',
  'additional',
];

const AFFILIATION_LABELS = {
  orbat: 'As in the ORBAT',
  hostile: 'Hostile',
  friendly: 'Friend',
  neutral: 'Neutral',
  unknown: 'Unknown',
};

/**
 * A map unit's properties and label for ORBAT `unit` (the ORBAT API shape),
 * its affiliation forced unless `affiliation` is 'orbat'.
 */
export function orbatUnitProperties(unit, { orbatId, affiliation = 'orbat' }) {
  return {
    label: unitDisplayName(unit),
    properties: {
      sidc: affiliation === 'orbat' ? unit.sidc : withAffiliation(unit.sidc, affiliation),
      designation: unit.designation || null,
      higher_formation: unit.higherFormation || null,
      reinforced: unit.reinforced || null,
      additional: unit.additional || null,
      orbat_id: orbatId,
      orbat_unit_id: unit.id,
      orbat_affiliation: affiliation,
    },
  };
}

/**
 * Where a placed unit stands against its ORBAT. `orbats` maps an ORBAT id
 * to its unit list, or to null when this user can't load it (deleted, or not
 * visible to this cell). Returns null for a unit with no ORBAT link, else
 * `{ status: 'current' | 'changed' | 'missing' | 'unavailable', update }`;
 * `update` is `{ label, properties }` for 'changed' (the feature's
 * properties with the ORBAT's values applied), otherwise null.
 */
export function orbatLinkStatus(feature, orbats) {
  const properties = feature.properties ?? {};
  const { orbat_id: orbatId, orbat_unit_id: unitId } = properties;
  if (orbatId == null || unitId == null) return null;
  if (!orbats.has(orbatId)) return null;
  const units = orbats.get(orbatId);
  if (units === null) return { status: 'unavailable', update: null };
  const unit = units.find((entry) => entry.id === unitId);
  if (!unit) return { status: 'missing', update: null };
  const fresh = orbatUnitProperties(unit, {
    orbatId,
    affiliation: properties.orbat_affiliation ?? 'orbat',
  });
  const changed =
    fresh.label !== feature.label ||
    ORBAT_SYNCED_KEYS.some((key) => (properties[key] ?? null) !== fresh.properties[key]);
  if (!changed) return { status: 'current', update: null };
  return {
    status: 'changed',
    update: { label: fresh.label, properties: { ...properties, ...fresh.properties } },
  };
}

/**
 * Screen offsets (px) for laying `units` out below one point: a row per
 * command level (a unit's depth counts only its ancestors in `units`), HQs
 * above their subordinates, each row centred, rows wrapping after `perRow`.
 * `units` must be in tree order; returns `[{ unit, dx, dy }]` in that order.
 */
export function layoutUnits(units, { spacingX = 110, spacingY = 90, perRow = 8 } = {}) {
  const ids = new Set(units.map((unit) => unit.id));
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const depthOf = (unit) => {
    let depth = 0;
    let parent = unit.parentId;
    while (parent != null && ids.has(parent)) {
      depth += 1;
      parent = byId.get(parent).parentId;
    }
    return depth;
  };
  const levels = [];
  for (const unit of units) {
    const depth = depthOf(unit);
    (levels[depth] ??= []).push(unit);
  }
  const placed = new Map();
  let row = 0;
  for (const level of levels.filter(Boolean)) {
    for (let start = 0; start < level.length; start += perRow) {
      const slice = level.slice(start, start + perRow);
      slice.forEach((unit, index) => {
        placed.set(unit.id, {
          dx: (index - (slice.length - 1) / 2) * spacingX,
          dy: row * spacingY,
        });
      });
      row += 1;
    }
  }
  return units.map((unit) => ({ unit, ...placed.get(unit.id) }));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Chooses what to place: an ORBAT, some of its units and how they show.
 * Its own `<dialog>` in `root`. Resolves to `{ orbatId, units, affiliation }`
 * (`units` in tree order) or null on cancel.
 */
export function openOrbatPlaceDialog({ root, requestJson, orbatApi = '/api/orbat' }) {
  return new Promise((resolve) => {
    const dialog = element('dialog', 'workspace-dialog orbat-place-dialog');
    const form = element('form');
    form.method = 'dialog';
    form.append(element('h2', 'dialog-message', 'Place an ORBAT on the map'));

    const orbatField = element('label', 'dialog-field');
    orbatField.append(element('span', null, 'ORBAT'));
    const orbatSelect = element('select', 'dialog-input');
    orbatField.append(orbatSelect);

    const affiliationField = element('label', 'dialog-field');
    affiliationField.append(element('span', null, 'Show units as'));
    const affiliationSelect = element('select', 'dialog-input');
    for (const [value, label] of Object.entries(AFFILIATION_LABELS)) {
      affiliationSelect.append(new Option(label, value));
    }
    affiliationField.append(affiliationSelect);

    const status = element('p', 'panel-note orbat-import-status');
    status.setAttribute('role', 'status');
    const selectRow = element('div', 'orbat-place-select');
    const all = element('button', 'text-button', 'Select all');
    all.type = 'button';
    const none = element('button', 'text-button', 'Clear');
    none.type = 'button';
    selectRow.append(all, none);
    const tree = element('ul', 'orbat-import-tree');

    const actions = element('div', 'dialog-actions');
    const cancel = element('button', 'text-button', 'Cancel');
    cancel.type = 'button';
    const accept = element('button', 'dialog-accept', 'Place units');
    accept.type = 'submit';
    accept.disabled = true;
    actions.append(cancel, accept);

    form.append(orbatField, affiliationField, status, selectRow, tree, actions);
    dialog.append(form);
    root.append(dialog);

    let units = [];
    const checked = new Set();
    const refresh = () => {
      accept.disabled = checked.size === 0;
      accept.textContent = checked.size
        ? `Place ${checked.size} unit${checked.size === 1 ? '' : 's'}`
        : 'Place units';
    };
    const paintTree = () => {
      tree.replaceChildren();
      buildUnitTree(tree, units, checked, (id, on) => {
        if (on) checked.add(id);
        else checked.delete(id);
        refresh();
      });
      refresh();
    };

    async function loadOrbat(orbatId) {
      units = [];
      checked.clear();
      paintTree();
      if (!orbatId) return;
      status.textContent = 'Loading…';
      try {
        const doc = await requestJson(`${orbatApi}/orbats/${orbatId}`);
        units = doc.units;
        units.forEach((unit) => checked.add(unit.id));
        status.textContent = units.length ? '' : 'This ORBAT has no units yet.';
        paintTree();
      } catch (error) {
        status.textContent = error.message;
      }
    }

    (async () => {
      status.textContent = 'Loading…';
      try {
        const orbats = await requestJson(`${orbatApi}/orbats`);
        orbatSelect.replaceChildren(
          ...orbats.map(
            (orbat) =>
              new Option(
                `[${cellLabel(orbat.owner_cell)}] ${orbat.name} (${orbat.unitCount} unit${orbat.unitCount === 1 ? '' : 's'})`,
                String(orbat.id),
              ),
          ),
        );
        if (!orbats.length) {
          status.textContent = 'No ORBATs yet: build one in the ORBAT module.';
          return;
        }
        await loadOrbat(Number(orbatSelect.value));
      } catch (error) {
        status.textContent = error.message;
      }
    })();

    orbatSelect.addEventListener('change', () => loadOrbat(Number(orbatSelect.value)));
    all.addEventListener('click', () => {
      units.forEach((unit) => checked.add(unit.id));
      paintTree();
    });
    none.addEventListener('click', () => {
      checked.clear();
      paintTree();
    });

    let result = null;
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!checked.size) return;
      result = {
        orbatId: Number(orbatSelect.value),
        units: unitsInTreeOrder(units).filter((unit) => checked.has(unit.id)),
        affiliation: affiliationSelect.value,
      };
      dialog.close();
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
    orbatSelect.focus();
  });
}

/** The next queued unit as a small symbol + name, for the tools panel. */
export function renderNextOrbatUnit(entry) {
  const line = element('span', 'orbat-place-next');
  line.append(
    symbolElement(entry.properties.sidc, { size: 22 }),
    element('span', null, entry.label),
  );
  return line;
}
