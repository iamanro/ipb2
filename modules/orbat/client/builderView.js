import './builder.css';
import { canEditClient, renderReleaseControl } from '../../../src/release.js';
import { cellLabel, currentUser, isWhite } from '../../../src/session.js';
import { EXAMPLES } from './examples.js';
import { API, createElement, downloadFile, fileSlug, requestJson } from './dom.js';
import {
  CONTEXTS,
  ECHELONS,
  ENTITIES,
  ENTITY_GROUPS,
  HQTFD,
  IDENTITIES,
  MODIFIERS_1,
  MODIFIERS_2,
  REINFORCED,
  STATUSES,
  lookup,
} from '../../../src/symbols/symbology.js';
import { describeSidc, parseSidc, withFields } from '../../../src/symbols/sidc.js';
import { symbolElement } from '../../../src/symbols/symbol.js';
import {
  DEFAULT_LAYOUT_OPTIONS,
  exportSvgString,
  layoutTree,
  measureUnit,
  renderChart,
} from './chart.js';

const TEXT_SAVE_DEBOUNCE = 400;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.15;

function el(tag, className, text) {
  return createElement(tag, className, text);
}

function option(value, text, selected) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = text;
  if (selected) node.selected = true;
  return node;
}

function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

/** All units of an ORBAT, keyed by id, with a `children` array of ids in position order. */
function indexUnits(units) {
  const byId = new Map(units.map((u) => [u.id, u]));
  const childIds = new Map();
  for (const u of units) {
    const key = u.parentId ?? 'root';
    if (!childIds.has(key)) childIds.set(key, []);
    childIds.get(key).push(u.id);
  }
  for (const list of childIds.values())
    list.sort((a, b) => byId.get(a).position - byId.get(b).position);
  return { byId, childIds };
}

/** Build the tree `layoutTree`/the outline walk over: nodes carry the symbology fields chart.js needs, `children` pruned for collapsed units. */
function buildTree(rootIds, byId, childIds, collapsedIds) {
  const node = (id) => {
    const unit = byId.get(id);
    const kids = collapsedIds.has(id) ? [] : (childIds.get(id) || []).map(node);
    return {
      id: unit.id,
      sidc: unit.sidc,
      name: unit.name,
      designation: unit.designation,
      higherFormation: unit.higherFormation,
      reinforced: unit.reinforced,
      additional: unit.additional,
      children: kids,
    };
  };
  return rootIds.map(node);
}

function echelonRank(code) {
  return lookup.echelon.get(code)?.rank ?? 0;
}

export function mountBuilder({ root, params, confirm }) {
  const controller = new AbortController();
  const { signal } = controller;

  const state = {
    orbats: [],
    doc: null, // { orbat, units }
    byId: new Map(),
    childIds: new Map(),
    selectedUnitId: null,
    collapsedIds: new Set(),
    zoom: 1,
    saveTimers: new Map(),
    pendingPatches: new Map(),
  };

  root.innerHTML = `
    <div class="builder-layout">
      <aside class="builder-pane builder-outline" aria-label="ORBATs and unit outline">
        <div class="orbat-switcher"></div>
        <div class="outline-toolbar" role="toolbar" aria-label="Unit tree actions"></div>
        <div class="outline-scroll">
          <ul class="outline-tree" role="tree" aria-label="Unit outline" tabindex="-1"></ul>
          <p class="panel-note outline-empty" hidden>No units yet. Use “Add unit” to start the tree.</p>
        </div>
      </aside>
      <section class="builder-pane builder-chart" aria-label="Wire diagram">
        <div class="chart-toolbar" role="toolbar" aria-label="Chart view controls"></div>
        <div class="chart-scroll" tabindex="0"></div>
        <p class="panel-note chart-empty" hidden>Select or create an ORBAT to see its wire diagram.</p>
      </section>
      <aside class="builder-pane builder-inspector" aria-label="Unit inspector">
        <div class="inspector-body"></div>
      </aside>
    </div>
    <dialog class="workspace-dialog" id="orbat-form-dialog">
      <form method="dialog" class="orbat-form">
        <h2 class="orbat-form-title">New ORBAT</h2>
        <label class="field"><span>Name</span><input class="text-input" name="name" required maxlength="120" /></label>
        <label class="field"><span>Description</span><textarea class="text-input" name="description" maxlength="2000"></textarea></label>
        <label class="field owner-field" hidden>
          <span>Owner</span>
          <select class="text-input" name="owner_cell">
            <option value="white">White</option>
            <option value="blue">Blue</option>
            <option value="red">Red</option>
          </select>
        </label>
        <p class="inline-error orbat-form-error" hidden></p>
        <div class="dialog-actions">
          <button class="text-button" type="submit" value="cancel">Cancel</button>
          <button class="primary-button" type="submit" value="save">Save</button>
        </div>
      </form>
    </dialog>
    <input type="file" class="import-file-input" accept="application/json" hidden />
  `;

  const switcherEl = root.querySelector('.orbat-switcher');
  const outlineToolbarEl = root.querySelector('.outline-toolbar');
  const outlineTreeEl = root.querySelector('.outline-tree');
  const outlineEmptyEl = root.querySelector('.outline-empty');
  const chartToolbarEl = root.querySelector('.chart-toolbar');
  const chartScrollEl = root.querySelector('.chart-scroll');
  const chartEmptyEl = root.querySelector('.chart-empty');
  const inspectorBodyEl = root.querySelector('.inspector-body');
  const formDialog = root.querySelector('#orbat-form-dialog');
  const formTitle = formDialog.querySelector('.orbat-form-title');
  const formEl = formDialog.querySelector('.orbat-form');
  const formError = formDialog.querySelector('.orbat-form-error');
  const ownerField = formDialog.querySelector('.owner-field');
  const importInput = root.querySelector('.import-file-input');

  /** C2b: whether the currently open ORBAT is editable for this client —
   * release grants read access only, so an ORBAT visible only because it
   * was released to your cell locks every mutating control the same way a
   * below-analyst role does. True with nothing open. Mirrors
   * `server/policy.ts`'s `canEdit`. */
  function canEditOrbat() {
    return !state.doc || canEditClient(state.doc.orbat);
  }

  // --- URL <-> selection -----------------------------------------------------

  function writeSelection() {
    params.write({ orbat: state.doc?.orbat.id ?? null, unit: state.selectedUnitId ?? null });
  }

  // --- data loading ------------------------------------------------------------

  async function loadOrbatList() {
    state.orbats = await requestJson(`${API}/orbats`, { signal });
  }

  async function loadDocument(id) {
    const doc = await requestJson(`${API}/orbats/${id}`, { signal });
    applyDocument(doc);
  }

  function applyDocument(doc) {
    state.doc = doc;
    const { byId, childIds } = indexUnits(doc.units);
    state.byId = byId;
    state.childIds = childIds;
    if (state.selectedUnitId && !byId.has(state.selectedUnitId)) state.selectedUnitId = null;
  }

  /** The generated release/reassign endpoints answer with the ORBAT alone
   * (no units): merge it into the open document rather than replacing one. */
  function applyOrbatFields(orbat) {
    state.doc = { ...state.doc, orbat };
  }

  // --- rendering: ORBAT switcher -----------------------------------------------

  function renderSwitcher() {
    switcherEl.replaceChildren();
    const row = el('div', 'switcher-row');
    const select = document.createElement('select');
    select.className = 'text-input orbat-select';
    select.setAttribute('aria-label', 'Select ORBAT');
    select.append(
      option('', state.orbats.length ? 'Choose an ORBAT…' : 'No ORBATs yet', !state.doc),
    );
    for (const o of state.orbats)
      select.append(
        option(
          String(o.id),
          `[${cellLabel(o.owner_cell)}] ${o.name} (${o.unitCount})`,
          state.doc?.orbat.id === o.id,
        ),
      );
    select.addEventListener('change', () => {
      if (select.value) selectOrbat(Number(select.value));
    });
    row.append(select);
    switcherEl.append(row);

    const actions = el('div', 'switcher-actions');
    const newButton = el('button', 'chip-button', 'New');
    newButton.type = 'button';
    newButton.addEventListener('click', () => openOrbatForm('create'));
    actions.append(newButton);

    const exampleSelect = document.createElement('select');
    exampleSelect.className = 'text-input example-select';
    exampleSelect.setAttribute('aria-label', 'New from example');
    exampleSelect.append(option('', 'New from example…', true));
    for (const example of EXAMPLES) exampleSelect.append(option(example.id, example.name));
    exampleSelect.addEventListener('change', async () => {
      const id = exampleSelect.value;
      exampleSelect.value = '';
      if (!id) return;
      const example = EXAMPLES.find((e) => e.id === id);
      if (!example) return;
      try {
        const doc = await requestJson(`${API}/orbats/import`, {
          method: 'POST',
          body: example.build(),
          signal,
        });
        await loadOrbatList();
        state.selectedUnitId = null;
        applyDocument(doc);
        writeSelection();
        renderAll();
      } catch (error) {
        if (error.name !== 'AbortError') window.alert(error.message);
      }
    });
    actions.append(exampleSelect);

    const importButton = el('button', 'chip-button', 'Import');
    importButton.type = 'button';
    importButton.addEventListener('click', () => importInput.click());
    actions.append(importButton);

    if (state.doc) {
      const exportButton = el('button', 'chip-button', 'Export');
      exportButton.type = 'button';
      exportButton.addEventListener('click', exportCurrentOrbat);
      actions.append(exportButton);

      if (canEditOrbat()) {
        const renameButton = el('button', 'icon-button', 'Rename');
        renameButton.type = 'button';
        renameButton.addEventListener('click', () => openOrbatForm('rename'));
        actions.append(renameButton);

        const deleteButton = el('button', 'icon-button danger', 'Delete');
        deleteButton.type = 'button';
        deleteButton.addEventListener('click', deleteCurrentOrbat);
        actions.append(deleteButton);
      }
    }
    switcherEl.append(actions);

    if (state.doc) {
      const meta = el('p', 'orbat-meta');
      meta.textContent = `${state.doc.orbat.unitCount} unit${state.doc.orbat.unitCount === 1 ? '' : 's'} · updated ${formatDate(state.doc.orbat.updatedAt)}`;
      switcherEl.append(meta);
      if (state.doc.orbat.description) {
        const desc = el('p', 'orbat-description', state.doc.orbat.description);
        switcherEl.append(desc);
      }
      switcherEl.append(renderOrbatReleaseControl());
    }
  }

  /** The owner badge, release control and (White-only) reassign select for
   * the currently open ORBAT. */
  function renderOrbatReleaseControl() {
    const orbat = state.doc.orbat;
    const control = renderReleaseControl({
      item: orbat,
      onRelease: async (cells) => {
        try {
          const updated = await requestJson(`${API}/orbats/${orbat.id}/release`, {
            method: 'POST',
            body: { cells },
            signal,
          });
          applyOrbatFields(updated);
          renderAll();
        } catch (error) {
          if (error.name !== 'AbortError') window.alert(error.message);
        }
      },
    });
    if (isWhite()) {
      const label = el('span', 'release-control-label', 'Reassign');
      const select = document.createElement('select');
      select.className = 'text-input release-owner-select';
      for (const cell of ['white', 'blue', 'red']) {
        select.append(option(cell, cellLabel(cell), cell === orbat.owner_cell));
      }
      select.addEventListener('change', async () => {
        try {
          const updated = await requestJson(`${API}/orbats/${orbat.id}/owner`, {
            method: 'PATCH',
            body: { owner_cell: select.value },
            signal,
          });
          applyOrbatFields(updated);
          renderAll();
        } catch (error) {
          if (error.name !== 'AbortError') window.alert(error.message);
        }
      });
      control.append(label, select);
    }
    if (canEditOrbat()) return control;
    const wrap = el('div', 'orbat-release-wrap');
    wrap.append(
      control,
      el('p', 'read-only-note', `Read-only — owned by ${cellLabel(orbat.owner_cell)}.`),
    );
    return wrap;
  }

  let formMode = 'create';
  function openOrbatForm(mode) {
    formMode = mode;
    formError.hidden = true;
    formTitle.textContent = mode === 'create' ? 'New ORBAT' : 'Rename ORBAT';
    formEl.name.value = mode === 'rename' ? state.doc.orbat.name : '';
    formEl.description.value = mode === 'rename' ? state.doc.orbat.description : '';
    // The owner is chosen only on create, and only White gets a choice;
    // everyone else's ORBAT lands in their own cell (no control shown).
    // Reassigning an existing ORBAT's owner is the switcher's own control.
    ownerField.hidden = !(mode === 'create' && isWhite());
    if (!ownerField.hidden) formEl.owner_cell.value = currentUser()?.cell ?? 'white';
    formDialog.showModal();
    formEl.name.focus();
  }

  formEl.addEventListener('submit', async (event) => {
    const submitter = event.submitter;
    if (!submitter || submitter.value !== 'save') return; // let the dialog close on cancel
    event.preventDefault();
    const name = formEl.name.value.trim();
    const description = formEl.description.value;
    if (!name) {
      formError.hidden = false;
      formError.textContent = 'Name is required.';
      return;
    }
    try {
      if (formMode === 'create') {
        const body = { name, description };
        if (!ownerField.hidden) body.owner_cell = formEl.owner_cell.value;
        const doc = await requestJson(`${API}/orbats`, {
          method: 'POST',
          body,
          signal,
        });
        await loadOrbatList();
        state.selectedUnitId = null;
        applyDocument(doc);
      } else {
        const doc = await requestJson(`${API}/orbats/${state.doc.orbat.id}`, {
          method: 'PATCH',
          body: { name, description },
          signal,
        });
        await loadOrbatList();
        applyDocument(doc);
      }
      formDialog.close();
      writeSelection();
      renderAll();
    } catch (error) {
      if (error.name === 'AbortError') return;
      formError.hidden = false;
      formError.textContent = error.message;
    }
  });

  async function selectOrbat(id) {
    try {
      state.selectedUnitId = null;
      state.collapsedIds = new Set();
      await loadDocument(id);
      writeSelection();
      renderAll();
    } catch (error) {
      if (error.name !== 'AbortError') window.alert(error.message);
    }
  }

  async function deleteCurrentOrbat() {
    const ok = await confirm(
      `Delete “${state.doc.orbat.name}” and all its units? This cannot be undone.`,
    );
    if (!ok) return;
    try {
      await requestJson(`${API}/orbats/${state.doc.orbat.id}`, { method: 'DELETE', signal });
      state.doc = null;
      state.selectedUnitId = null;
      await loadOrbatList();
      writeSelection();
      renderAll();
    } catch (error) {
      if (error.name !== 'AbortError') window.alert(error.message);
    }
  }

  function exportCurrentOrbat() {
    requestJson(`${API}/orbats/${state.doc.orbat.id}/export`, { signal })
      .then((body) =>
        downloadFile(
          `${fileSlug(state.doc.orbat.name)}.orbat.json`,
          JSON.stringify(body, null, 2),
          'application/json',
        ),
      )
      .catch((error) => {
        if (error.name !== 'AbortError') window.alert(error.message);
      });
  }

  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const body = JSON.parse(text);
      const doc = await requestJson(`${API}/orbats/import`, { method: 'POST', body, signal });
      await loadOrbatList();
      state.selectedUnitId = null;
      applyDocument(doc);
      writeSelection();
      renderAll();
    } catch (error) {
      if (error.name === 'AbortError') return;
      window.alert(error instanceof SyntaxError ? 'That file is not valid JSON.' : error.message);
    }
  });

  // --- unit mutations ------------------------------------------------------------

  async function addUnit(parentId, position) {
    if (!canEditOrbat()) return;
    const body = { parentId };
    if (position !== undefined) body.position = position;
    try {
      const result = await requestJson(`${API}/orbats/${state.doc.orbat.id}/units`, {
        method: 'POST',
        body,
        signal,
      });
      applyDocument({ orbat: result.orbat, units: result.units });
      state.selectedUnitId = result.unitId;
      await loadOrbatList();
      writeSelection();
      renderAll();
      focusOutlineRow(result.unitId);
    } catch (error) {
      if (error.name !== 'AbortError') window.alert(error.message);
    }
  }

  async function deleteUnit(id) {
    if (!canEditOrbat()) return;
    const unit = state.byId.get(id);
    if (!unit) return;
    const childCount = (state.childIds.get(id) || []).length;
    const message = childCount
      ? `Delete “${unit.name || unit.designation || 'this unit'}” and its ${childCount} subordinate${childCount === 1 ? '' : 's'}?`
      : `Delete “${unit.name || unit.designation || 'this unit'}”?`;
    const ok = await confirm(message);
    if (!ok) return;
    try {
      const doc = await requestJson(`${API}/orbats/${state.doc.orbat.id}/units/${id}`, {
        method: 'DELETE',
        signal,
      });
      applyDocument(doc);
      if (state.selectedUnitId === id) state.selectedUnitId = null;
      await loadOrbatList();
      writeSelection();
      renderAll();
    } catch (error) {
      if (error.name !== 'AbortError') window.alert(error.message);
    }
  }

  async function duplicateUnit(id) {
    if (!canEditOrbat()) return;
    try {
      const result = await requestJson(
        `${API}/orbats/${state.doc.orbat.id}/units/${id}/duplicate`,
        {
          method: 'POST',
          signal,
        },
      );
      applyDocument({ orbat: result.orbat, units: result.units });
      state.selectedUnitId = result.unitId;
      await loadOrbatList();
      writeSelection();
      renderAll();
      focusOutlineRow(result.unitId);
    } catch (error) {
      if (error.name !== 'AbortError') window.alert(error.message);
    }
  }

  async function moveUnit(id, parentId, position) {
    if (!canEditOrbat()) return;
    try {
      const doc = await requestJson(`${API}/orbats/${state.doc.orbat.id}/units/${id}`, {
        method: 'PATCH',
        body: { parentId, position },
        signal,
      });
      applyDocument(doc);
      await loadOrbatList();
      renderAll();
    } catch (error) {
      if (error.name !== 'AbortError') window.alert(error.message);
    }
  }

  /** Immediate (selects) or debounced (typed text) PATCH of one unit's fields; refreshes without rebuilding a focused inspector input. */
  function saveUnit(id, patch, { immediate = false } = {}) {
    if (!canEditOrbat()) return;
    const merged = { ...state.pendingPatches.get(id), ...patch };
    state.pendingPatches.set(id, merged);
    // Optimistic: reflect the edit locally right away so the outline/chart/preview follow typing.
    const unit = state.byId.get(id);
    if (unit) Object.assign(unit, patch);
    renderOutline();
    renderChartPane();
    refreshInspectorPreview();

    const flush = async () => {
      const toSend = state.pendingPatches.get(id);
      state.pendingPatches.delete(id);
      state.saveTimers.delete(id);
      if (!toSend) return;
      try {
        const doc = await requestJson(`${API}/orbats/${state.doc.orbat.id}/units/${id}`, {
          method: 'PATCH',
          body: toSend,
          signal,
        });
        applyDocument(doc);
        await loadOrbatList();
        renderSwitcher();
        renderOutline();
        renderChartPane();
        setInspectorError(null);
      } catch (error) {
        if (error.name === 'AbortError') return;
        setInspectorError(error.message);
      }
    };

    const existingTimer = state.saveTimers.get(id);
    if (existingTimer) window.clearTimeout(existingTimer);
    if (immediate) {
      flush();
    } else {
      state.saveTimers.set(id, window.setTimeout(flush, TEXT_SAVE_DEBOUNCE));
    }
  }

  // --- outline (accessible tree) ------------------------------------------------

  function rootIds() {
    return state.childIds.get('root') || [];
  }

  function outlineRows() {
    const rows = [];
    const walk = (id, level) => {
      rows.push({ id, level });
      if (state.collapsedIds.has(id)) return;
      for (const childId of state.childIds.get(id) || []) walk(childId, level + 1);
    };
    for (const id of rootIds()) walk(id, 1);
    return rows;
  }

  function renderOutline() {
    outlineTreeEl.replaceChildren();
    const rows = state.doc ? outlineRows() : [];
    outlineEmptyEl.hidden = rows.length > 0;
    outlineEmptyEl.textContent = canEditOrbat()
      ? 'No units yet. Use “Add unit” to start the tree.'
      : 'No units yet.';
    const activeId = state.selectedUnitId ?? rows[0]?.id;
    for (const { id, level } of rows) {
      const unit = state.byId.get(id);
      const hasChildren = (state.childIds.get(id) || []).length > 0;
      const collapsed = state.collapsedIds.has(id);
      const li = document.createElement('li');
      li.setAttribute('role', 'treeitem');
      li.setAttribute('aria-level', String(level));
      li.setAttribute('aria-selected', String(id === state.selectedUnitId));
      if (hasChildren) li.setAttribute('aria-expanded', String(!collapsed));
      li.tabIndex = id === activeId ? 0 : -1;
      li.dataset.unitId = String(id);
      li.className = 'outline-row';
      li.draggable = canEditOrbat();

      if (hasChildren) {
        const toggle = el('button', 'outline-toggle', collapsed ? '▸' : '▾');
        toggle.type = 'button';
        toggle.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
        toggle.tabIndex = -1;
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          toggleCollapse(id);
        });
        li.append(toggle);
      } else {
        li.append(el('span', 'outline-toggle-spacer'));
      }

      li.append(symbolElement(unit.sidc, { size: 18 }));
      const echelon = lookup.echelon.get(unit.sidc.slice(8, 10));
      const labelParts = [unit.designation, unit.name].filter(Boolean);
      const label = el('span', 'outline-label', labelParts.join(' · ') || 'Unnamed unit');
      li.append(label);
      if (echelon && echelon.code !== '00')
        li.append(el('span', 'outline-echelon', echelon.marker));

      li.addEventListener('click', () => selectUnit(id));
      li.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', String(id));
        event.dataTransfer.effectAllowed = 'move';
      });
      li.addEventListener('dragover', (event) => {
        event.preventDefault();
        const zone = dropZone(event, li);
        li.classList.toggle('drop-before', zone === 'before');
        li.classList.toggle('drop-after', zone === 'after');
        li.classList.toggle('drop-inside', zone === 'inside');
      });
      li.addEventListener('dragleave', () => {
        li.classList.remove('drop-before', 'drop-after', 'drop-inside');
      });
      li.addEventListener('drop', (event) => {
        event.preventDefault();
        li.classList.remove('drop-before', 'drop-after', 'drop-inside');
        const draggedId = Number(event.dataTransfer.getData('text/plain'));
        if (!draggedId || draggedId === id) return;
        const zone = dropZone(event, li);
        handleDrop(draggedId, id, zone);
      });

      outlineTreeEl.append(li);
    }
  }

  function dropZone(event, li) {
    const rect = li.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    if (ratio < 0.25) return 'before';
    if (ratio > 0.75) return 'after';
    return 'inside';
  }

  function handleDrop(draggedId, targetId, zone) {
    if (!canEditOrbat()) return;
    const target = state.byId.get(targetId);
    if (!target) return;
    if (zone === 'inside') {
      const count = (state.childIds.get(targetId) || []).length;
      moveUnit(draggedId, targetId, count);
    } else {
      const parentId = target.parentId;
      const siblingIds = state.childIds.get(parentId ?? 'root') || [];
      const targetIndex = siblingIds.indexOf(targetId);
      const position = zone === 'before' ? targetIndex : targetIndex + 1;
      moveUnit(draggedId, parentId, position);
    }
  }

  function toggleCollapse(id) {
    const refocus = outlineTreeEl.contains(document.activeElement);
    if (state.collapsedIds.has(id)) state.collapsedIds.delete(id);
    else state.collapsedIds.add(id);
    renderOutline();
    renderChartPane();
    if (refocus) focusOutlineRow(id);
  }

  function focusOutlineRow(id) {
    requestAnimationFrame(() => {
      const row = outlineTreeEl.querySelector(`[data-unit-id="${id}"]`);
      row?.focus();
    });
  }

  function selectUnit(id) {
    // Re-rendering replaces the rows; keep keyboard focus in the tree if it was there.
    const refocus = outlineTreeEl.contains(document.activeElement);
    state.selectedUnitId = id;
    writeSelection();
    renderOutline();
    renderOutlineToolbar();
    renderChartPane();
    renderInspector();
    if (refocus) focusOutlineRow(id);
  }

  outlineTreeEl.addEventListener('keydown', (event) => {
    const rows = outlineRows();
    if (!rows.length) return;
    const current = event.target.closest('[role="treeitem"]');
    const currentId = current ? Number(current.dataset.unitId) : rows[0].id;
    const index = rows.findIndex((r) => r.id === currentId);
    const unit = state.byId.get(currentId);
    const hasChildren = (state.childIds.get(currentId) || []).length > 0;

    const focusIndex = (i) => {
      const row = rows[i];
      if (!row) return;
      outlineTreeEl.querySelectorAll('[role="treeitem"]').forEach((n) => (n.tabIndex = -1));
      const node = outlineTreeEl.querySelector(`[data-unit-id="${row.id}"]`);
      if (node) {
        node.tabIndex = 0;
        node.focus();
      }
    };

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusIndex(Math.min(index + 1, rows.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusIndex(Math.max(index - 1, 0));
        break;
      case 'ArrowRight':
        event.preventDefault();
        if (hasChildren && state.collapsedIds.has(currentId)) toggleCollapse(currentId);
        else if (hasChildren) focusIndex(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (hasChildren && !state.collapsedIds.has(currentId)) toggleCollapse(currentId);
        else if (unit.parentId) selectUnit(unit.parentId);
        break;
      case 'Enter':
      case 'F2':
        event.preventDefault();
        selectUnit(currentId);
        inspectorBodyEl.querySelector('input, select, textarea')?.focus();
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        deleteUnit(currentId);
        break;
      case ' ':
        event.preventDefault();
        selectUnit(currentId);
        break;
      default:
        return;
    }
  });

  // --- outline toolbar -----------------------------------------------------------

  function toolbarButton(label, title, onClick) {
    const button = el('button', 'icon-button', label);
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', onClick);
    return button;
  }

  function renderOutlineToolbar() {
    outlineToolbarEl.replaceChildren();
    const selected = state.selectedUnitId ? state.byId.get(state.selectedUnitId) : null;
    const disabled = !state.doc || !canEditOrbat();

    const addTop = toolbarButton('+ Top', 'Add top-level unit', () => addUnit(null));
    const addSub = toolbarButton(
      '+ Sub',
      'Add subordinate',
      () => selected && addUnit(selected.id),
    );
    const addSibling = toolbarButton(
      '+ Sibling',
      'Add sibling',
      () => selected && addUnit(selected.parentId, selected.position + 1),
    );
    const duplicate = toolbarButton(
      'Dup',
      'Duplicate',
      () => selected && duplicateUnit(selected.id),
    );
    const moveUp = toolbarButton('↑', 'Move up', () => selected && reorder(selected, -1));
    const moveDown = toolbarButton('↓', 'Move down', () => selected && reorder(selected, 1));
    const outdent = toolbarButton('⇤', 'Outdent', () => selected && outdentUnit(selected));
    const indent = toolbarButton('⇥', 'Indent', () => selected && indentUnit(selected));
    const del = toolbarButton('Delete', 'Delete', () => selected && deleteUnit(selected.id));
    del.classList.add('danger');

    for (const button of [
      addTop,
      addSub,
      addSibling,
      duplicate,
      moveUp,
      moveDown,
      outdent,
      indent,
      del,
    ]) {
      button.disabled = disabled || (button !== addTop && !selected);
      outlineToolbarEl.append(button);
    }
  }

  function reorder(unit, delta) {
    const siblingIds = state.childIds.get(unit.parentId ?? 'root') || [];
    const index = siblingIds.indexOf(unit.id);
    const target = index + delta;
    if (target < 0 || target >= siblingIds.length) return;
    moveUnit(unit.id, unit.parentId, target);
  }

  function outdentUnit(unit) {
    if (unit.parentId === null) return;
    const parent = state.byId.get(unit.parentId);
    moveUnit(unit.id, parent.parentId, parent.position + 1);
  }

  function indentUnit(unit) {
    const siblingIds = state.childIds.get(unit.parentId ?? 'root') || [];
    const index = siblingIds.indexOf(unit.id);
    if (index <= 0) return;
    const newParentId = siblingIds[index - 1];
    const count = (state.childIds.get(newParentId) || []).length;
    moveUnit(unit.id, newParentId, count);
  }

  // --- chart -----------------------------------------------------------------

  function renderChartToolbar() {
    chartToolbarEl.replaceChildren();
    const zoomOut = toolbarButton('−', 'Zoom out', () => setZoom(state.zoom - ZOOM_STEP));
    const zoomIn = toolbarButton('+', 'Zoom in', () => setZoom(state.zoom + ZOOM_STEP));
    const zoomReset = toolbarButton('100%', '100%', () => setZoom(1));
    const zoomFit = toolbarButton('Fit', 'Fit to window', fitZoom);
    const exportSvg = toolbarButton('Export SVG', 'Export SVG', exportChartSvg);
    const print = toolbarButton('Print', 'Print', () => window.print());
    for (const button of [zoomOut, zoomIn, zoomReset, zoomFit, exportSvg, print]) {
      button.disabled = !state.doc;
      chartToolbarEl.append(button);
    }
    const zoomLabel = el('span', 'zoom-readout', `${Math.round(state.zoom * 100)}%`);
    chartToolbarEl.append(zoomLabel);
  }

  function setZoom(value) {
    state.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
    applyZoom();
    renderChartToolbar();
  }

  function applyZoom() {
    const svg = chartScrollEl.querySelector('svg');
    if (svg) svg.style.transform = `scale(${state.zoom})`;
  }

  function fitZoom() {
    const svg = chartScrollEl.querySelector('svg');
    if (!svg) return;
    const width = Number(svg.getAttribute('width'));
    const height = Number(svg.getAttribute('height'));
    const scale = Math.min(
      (chartScrollEl.clientWidth - 32) / width,
      (chartScrollEl.clientHeight - 32) / height,
      ZOOM_MAX,
    );
    setZoom(Math.max(ZOOM_MIN, scale));
  }

  function currentTree() {
    return buildTree(rootIds(), state.byId, state.childIds, state.collapsedIds);
  }

  function renderChartPane() {
    chartScrollEl.replaceChildren();
    chartEmptyEl.hidden = Boolean(state.doc);
    if (!state.doc) return;
    const roots = currentTree();
    if (!roots.length) {
      chartScrollEl.append(
        el(
          'p',
          'panel-note chart-pane-empty',
          canEditOrbat()
            ? 'No units yet. Use the outline toolbar to add the first one.'
            : 'No units yet.',
        ),
      );
      return;
    }
    const layout = layoutTree(roots, (unit) => measureUnit(unit, {}), DEFAULT_LAYOUT_OPTIONS);
    const svg = renderChart(layout, {
      selectedId: state.selectedUnitId,
      collapsedIds: state.collapsedIds,
      onSelectUnit: selectUnit,
      onToggleCollapse: toggleCollapse,
    });
    svg.style.transformOrigin = 'top left';
    chartScrollEl.append(svg);
    applyZoom();
  }

  function exportChartSvg() {
    const roots = currentTree();
    if (!roots.length) return;
    const layout = layoutTree(roots, (unit) => measureUnit(unit, {}), DEFAULT_LAYOUT_OPTIONS);
    const svgString = exportSvgString(layout, {
      selectedId: state.selectedUnitId,
      collapsedIds: state.collapsedIds,
    });
    downloadFile(`${fileSlug(state.doc.orbat.name)}.svg`, svgString, 'image/svg+xml');
  }

  // --- inspector -----------------------------------------------------------------

  let inspectorErrorEl = null;

  function setInspectorError(message) {
    if (!inspectorErrorEl) return;
    inspectorErrorEl.hidden = !message;
    inspectorErrorEl.textContent = message || '';
  }

  function hqtfdCodeFor(hq, tf, dummy) {
    const match = HQTFD.find((h) => h.hq === hq && h.tf === tf && h.dummy === dummy);
    return match ? match.code : '0';
  }

  function refreshInspectorPreview() {
    const unit = state.selectedUnitId ? state.byId.get(state.selectedUnitId) : null;
    if (!unit) return;
    const preview = inspectorBodyEl.querySelector('.inspector-preview');
    if (preview)
      preview.replaceChildren(
        symbolElement(unit.sidc, {
          size: 72,
          uniqueDesignation: unit.designation,
          higherFormation: unit.higherFormation,
          reinforcedReduced: unit.reinforced,
          additionalInformation: unit.additional,
        }),
      );
    const sidcOut = inspectorBodyEl.querySelector('.sidc-input');
    if (sidcOut && document.activeElement !== sidcOut) sidcOut.value = unit.sidc;
    const descList = inspectorBodyEl.querySelector('.sidc-describe');
    if (descList) renderSidcDescription(descList, unit.sidc);
    const warning = inspectorBodyEl.querySelector('.echelon-warning');
    if (warning) updateEchelonWarning(warning, unit);
  }

  function updateEchelonWarning(node, unit) {
    const parent = unit.parentId ? state.byId.get(unit.parentId) : null;
    if (!parent) {
      node.hidden = true;
      return;
    }
    const parentEchelon = parent.sidc.slice(8, 10);
    const ownEchelon = unit.sidc.slice(8, 10);
    if (ownEchelon === '00' || parentEchelon === '00') {
      node.hidden = true;
      return;
    }
    const warn = echelonRank(ownEchelon) >= echelonRank(parentEchelon);
    node.hidden = !warn;
    if (warn)
      node.textContent = `⚠ Echelon (${lookup.echelon.get(ownEchelon)?.name}) is not smaller than the parent's (${lookup.echelon.get(parentEchelon)?.name}).`;
  }

  function renderSidcDescription(list, sidc) {
    list.replaceChildren();
    const fields = describeSidc(sidc);
    if (!fields) return;
    for (const field of fields) {
      const row = el('div', 'sidc-field-row');
      row.append(el('span', 'sidc-field-label', field.label));
      row.append(el('span', 'sidc-field-value', field.meaning || `(${field.code})`));
      list.append(row);
    }
  }

  function fieldWithLabel(labelText, inputEl) {
    const label = el('label', 'field');
    label.append(el('span', null, labelText));
    label.append(inputEl);
    return label;
  }

  function textField(labelText, value, onInput, { maxLength, debounce = true } = {}) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.value = value || '';
    if (maxLength) input.maxLength = maxLength;
    input.addEventListener('input', () => onInput(input.value, { immediate: !debounce }));
    return fieldWithLabel(labelText, input);
  }

  /** A short, muted hint for an entry's `in2525E` tag (see symbology.js), or '' when current. */
  function editionHint(choice) {
    if (choice.in2525E === 'removed') return 'not in 2525E';
    if (choice.in2525E === 'common') return '2525E common';
    return '';
  }

  function selectField(labelText, choices, value, onChange, { ariaLabel } = {}) {
    const select = document.createElement('select');
    select.className = 'text-input';
    if (ariaLabel) select.setAttribute('aria-label', ariaLabel);
    for (const choice of choices) {
      const hint = editionHint(choice);
      select.append(
        option(choice.code, hint ? `${choice.name} (${hint})` : choice.name, choice.code === value),
      );
    }
    select.addEventListener('change', () => onChange(select.value));
    return labelText ? fieldWithLabel(labelText, select) : select;
  }

  /**
   * Searchable entity combobox (ARIA 1.2 pattern): focus stays in the input,
   * arrows move `aria-activedescendant` through the options, Enter picks,
   * Escape closes.
   */
  function renderEntityPicker(container, unit, onPick) {
    container.replaceChildren();
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'text-input entity-search';
    search.placeholder = 'Filter entities…';
    search.autocomplete = 'off';
    search.setAttribute('role', 'combobox');
    search.setAttribute('aria-expanded', 'false');
    search.setAttribute('aria-controls', 'entity-listbox');
    search.setAttribute('aria-autocomplete', 'list');
    let currentCode = unit.sidc.slice(10, 16);
    let currentEntity = lookup.entity.get(currentCode);
    search.value = currentEntity ? currentEntity.name : '';

    const listbox = document.createElement('ul');
    listbox.className = 'entity-listbox';
    listbox.id = 'entity-listbox';
    listbox.setAttribute('role', 'listbox');
    listbox.setAttribute('aria-label', 'Entity');
    let options = [];
    let active = -1;

    function setActive(index) {
      options[active]?.classList.remove('active');
      active = index;
      const item = options[active];
      if (!item) {
        search.removeAttribute('aria-activedescendant');
        return;
      }
      item.classList.add('active');
      search.setAttribute('aria-activedescendant', item.id);
      item.scrollIntoView({ block: 'nearest' });
    }

    function setOpen(open) {
      listbox.hidden = !open;
      search.setAttribute('aria-expanded', String(open));
      if (!open) setActive(-1);
    }

    function pick(entity) {
      currentCode = entity.code;
      currentEntity = entity;
      search.value = entity.name;
      setOpen(false);
      onPick(entity.code);
    }

    function renderList(filterText) {
      listbox.replaceChildren();
      options = [];
      active = -1;
      search.removeAttribute('aria-activedescendant');
      const needle = filterText.trim().toLowerCase();
      const matches = ENTITIES.filter(
        (e) => !needle || e.name.toLowerCase().includes(needle) || e.code.includes(needle),
      );
      const groups = new Map();
      for (const entity of matches) {
        if (!groups.has(entity.group)) groups.set(entity.group, []);
        groups.get(entity.group).push(entity);
      }
      // Current entries first, ones 2525E(1) dropped after, within each group.
      for (const list of groups.values())
        list.sort((a, b) => Number(a.in2525E === 'removed') - Number(b.in2525E === 'removed'));
      for (const group of ENTITY_GROUPS) {
        const entities = groups.get(group.code);
        if (!entities || !entities.length) continue;
        const heading = el('li', 'entity-group-heading', group.name);
        heading.setAttribute('role', 'presentation');
        listbox.append(heading);
        for (const entity of entities) {
          const hint = editionHint(entity);
          const item = document.createElement('li');
          item.id = `entity-option-${entity.code}`;
          item.setAttribute('role', 'option');
          item.className = hint ? 'entity-option entity-option-noted' : 'entity-option';
          item.dataset.code = entity.code;
          item.setAttribute('aria-selected', String(entity.code === currentCode));
          const previewSidc = withFields(unit.sidc, { entity: entity.code });
          item.append(symbolElement(previewSidc, { size: 18 }));
          item.append(el('span', null, entity.name));
          if (hint) item.append(el('span', 'entity-option-hint', hint));
          // mousedown, not click: keep focus in the input so the blur handler doesn't close first.
          item.addEventListener('mousedown', (event) => {
            event.preventDefault();
            pick(entity);
          });
          options.push(item);
          listbox.append(item);
        }
      }
      if (!options.length) listbox.append(el('li', 'entity-group-heading', 'No matches'));
    }

    search.addEventListener('input', () => {
      renderList(search.value);
      setOpen(true);
      if (options.length) setActive(0);
    });
    search.addEventListener('focus', () => {
      search.select();
      renderList('');
      setOpen(true);
      const selected = options.findIndex((item) => item.dataset.code === currentCode);
      if (selected >= 0) setActive(selected);
    });
    search.addEventListener('blur', () => {
      setOpen(false);
      search.value = currentEntity ? currentEntity.name : '';
    });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (listbox.hidden) setOpen(true);
        if (!options.length) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive(Math.min(Math.max(active + step, 0), options.length - 1));
      } else if (event.key === 'Enter') {
        if (listbox.hidden || active < 0) return;
        event.preventDefault();
        pick(lookup.entity.get(options[active].dataset.code));
      } else if (event.key === 'Escape' && !listbox.hidden) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    });

    setOpen(false);
    container.append(fieldWithLabel('Entity', search));
    container.append(listbox);
  }

  function renderInspector() {
    inspectorBodyEl.replaceChildren();
    const unit = state.selectedUnitId ? state.byId.get(state.selectedUnitId) : null;
    if (!state.doc) {
      inspectorBodyEl.append(el('p', 'panel-note', 'Choose or create an ORBAT to start editing.'));
      return;
    }
    if (!unit) {
      inspectorBodyEl.append(
        el('p', 'panel-note', 'Select a unit in the outline or on the chart to edit it.'),
      );
      return;
    }

    const preview = el('div', 'inspector-preview');
    inspectorBodyEl.append(preview);

    if (!canEditOrbat()) {
      inspectorBodyEl.append(
        el(
          'p',
          'panel-note read-only-note',
          `Read-only — owned by ${cellLabel(state.doc.orbat.owner_cell)}.`,
        ),
      );
      const facts = el('dl', 'inspector-facts');
      for (const [label, value] of [
        ['Name', unit.name || '—'],
        ['Unique designation (T)', unit.designation || '—'],
        ['Higher formation (M)', unit.higherFormation || '—'],
        ['Reinforced / reduced (F)', unit.reinforced || '—'],
        ['Additional information (H)', unit.additional || '—'],
        ['Notes', unit.notes || '—'],
      ]) {
        facts.append(el('dt', null, label), el('dd', null, value));
      }
      inspectorBodyEl.append(facts);
      const describeList = el('div', 'sidc-describe');
      renderSidcDescription(describeList, unit.sidc);
      inspectorBodyEl.append(describeList);
      refreshInspectorPreview();
      return;
    }

    inspectorErrorEl = el('p', 'inline-error');
    inspectorErrorEl.hidden = true;
    inspectorBodyEl.append(inspectorErrorEl);

    const warning = el('p', 'panel-note echelon-warning');
    warning.hidden = true;
    inspectorBodyEl.append(warning);

    const form = el('div', 'inspector-form');
    form.append(
      textField('Name', unit.name, (value, opts) => saveUnit(unit.id, { name: value }, opts)),
    );
    form.append(
      textField(
        'Unique designation (T)',
        unit.designation,
        (value, opts) => saveUnit(unit.id, { designation: value }, opts),
        { maxLength: 40 },
      ),
    );
    form.append(
      textField(
        'Higher formation (M)',
        unit.higherFormation,
        (value, opts) => saveUnit(unit.id, { higherFormation: value }, opts),
        { maxLength: 40 },
      ),
    );
    form.append(
      selectField('Reinforced / reduced (F)', REINFORCED, unit.reinforced, (value) =>
        saveUnit(unit.id, { reinforced: value }, { immediate: true }),
      ),
    );
    form.append(
      textField(
        'Additional information (H)',
        unit.additional,
        (value, opts) => saveUnit(unit.id, { additional: value }, opts),
        { maxLength: 80 },
      ),
    );

    const notesLabel = el('label', 'field');
    notesLabel.append(el('span', null, 'Notes'));
    const notes = document.createElement('textarea');
    notes.className = 'text-input';
    notes.value = unit.notes || '';
    notes.maxLength = 4000;
    notes.addEventListener('input', () => saveUnit(unit.id, { notes: notes.value }));
    notesLabel.append(notes);
    form.append(notesLabel);
    inspectorBodyEl.append(form);

    const symbolSection = el('div', 'inspector-symbol-editor');
    symbolSection.append(el('h3', 'inspector-heading', 'Symbol'));

    const parts = parseSidc(unit.sidc);
    const applySidcChange = (changes) => {
      const nextSidc = withFields(unit.sidc, changes);
      saveUnit(unit.id, { sidc: nextSidc }, { immediate: true });
    };

    symbolSection.append(
      selectField('Context', CONTEXTS, parts.context, (v) => applySidcChange({ context: v })),
    );
    symbolSection.append(
      selectField('Standard identity', IDENTITIES, parts.identity, (v) =>
        applySidcChange({ identity: v }),
      ),
    );
    symbolSection.append(
      selectField('Status', STATUSES, parts.status, (v) => applySidcChange({ status: v })),
    );
    symbolSection.append(
      selectField('Echelon', ECHELONS, parts.amplifier, (v) => applySidcChange({ amplifier: v })),
    );

    const entityContainer = el('div', 'entity-picker');
    renderEntityPicker(entityContainer, unit, (code) => applySidcChange({ entity: code }));
    symbolSection.append(entityContainer);

    symbolSection.append(
      selectField('Sector 1 modifier', MODIFIERS_1, parts.modifier1, (v) =>
        applySidcChange({ modifier1: v }),
      ),
    );
    symbolSection.append(
      selectField('Sector 2 modifier', MODIFIERS_2, parts.modifier2, (v) =>
        applySidcChange({ modifier2: v }),
      ),
    );

    const hqRow = el('div', 'hqtfd-row');
    const current = lookup.hqtfd.get(parts.hqtfd) || HQTFD[0];
    const hqCheck = checkbox('Headquarters', current.hq, (checked) =>
      applySidcChange({ hqtfd: hqtfdCodeFor(checked, current.tf, current.dummy) }),
    );
    const tfCheck = checkbox('Task force', current.tf, (checked) =>
      applySidcChange({ hqtfd: hqtfdCodeFor(current.hq, checked, current.dummy) }),
    );
    const dummyCheck = checkbox('Feint / dummy', current.dummy, (checked) =>
      applySidcChange({ hqtfd: hqtfdCodeFor(current.hq, current.tf, checked) }),
    );
    hqRow.append(hqCheck, tfCheck, dummyCheck);
    symbolSection.append(hqRow);

    const sidcField = el('label', 'field');
    sidcField.append(el('span', null, 'Raw SIDC (20 digits)'));
    const sidcInput = document.createElement('input');
    sidcInput.type = 'text';
    sidcInput.className = 'text-input sidc-input';
    sidcInput.value = unit.sidc;
    sidcInput.spellcheck = false;
    const sidcError = el('span', 'inline-error sidc-input-error');
    sidcError.hidden = true;
    sidcInput.addEventListener('input', () => {
      const candidate = parseSidc(sidcInput.value);
      if (!candidate) {
        sidcInput.setAttribute('aria-invalid', 'true');
        sidcError.hidden = false;
        sidcError.textContent = 'Must be 20 digits.';
        return;
      }
      sidcInput.removeAttribute('aria-invalid');
      sidcError.hidden = true;
      saveUnit(unit.id, { sidc: sidcInput.value.replace(/[\s-]/g, '') }, { immediate: true });
    });
    sidcField.append(sidcInput, sidcError);
    symbolSection.append(sidcField);

    const describeList = el('div', 'sidc-describe');
    renderSidcDescription(describeList, unit.sidc);
    symbolSection.append(describeList);

    inspectorBodyEl.append(symbolSection);

    refreshInspectorPreview();
  }

  function checkbox(labelText, checked, onChange) {
    const label = el('label', 'check-field');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    label.append(input, document.createTextNode(labelText));
    return label;
  }

  // --- narrow layout: inspector toggle -----------------------------------------

  function renderAll() {
    renderSwitcher();
    renderOutlineToolbar();
    renderOutline();
    renderChartToolbar();
    renderChartPane();
    renderInspector();
  }

  const onResize = () => applyZoom();
  window.addEventListener('resize', onResize, { signal });

  // --- boot ----------------------------------------------------------------------

  async function boot() {
    await loadOrbatList();
    const urlParams = params.read();
    const orbatId = Number(urlParams.get('orbat'));
    const unitId = Number(urlParams.get('unit'));
    if (orbatId && state.orbats.some((o) => o.id === orbatId)) {
      await loadDocument(orbatId);
      if (unitId && state.byId.has(unitId)) state.selectedUnitId = unitId;
    } else if (state.orbats.length) {
      await loadDocument(state.orbats[0].id);
    }
    writeSelection();
    renderAll();
  }

  boot().catch((error) => {
    if (error.name === 'AbortError') return;
    inspectorBodyEl.replaceChildren(el('p', 'inline-error', error.message));
  });

  return () => {
    controller.abort();
    for (const timer of state.saveTimers.values()) window.clearTimeout(timer);
    root.replaceChildren();
  };
}
