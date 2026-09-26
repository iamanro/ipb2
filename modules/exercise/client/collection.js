/**
 * The Collection tab: collectors, taskings against SIR×NAI×time, the ISR
 * synchronization matrix (`syncMatrix.js`) and the generated SOR list for
 * print. Owns its own state — `createCollectionController(ctx)` returns
 * `{ enter(container), leave() }`, mirroring the Geography tab's map
 * controller in `view.js` (created once, entered/left with the tab).
 *
 * `ctx` supplies the shared plumbing view.js already has: `requestJson`,
 * `createElement`, `askText`, `askConfirm`, `showError`, `formatDate`, and
 * the `${API}` base.
 */
import { parseHOffset } from '../../../src/dtg.js';
import { createDtgInput, readDtgValue, setDtgValue } from '../../../src/dtgField.js';
import { subscribe } from '../../../src/live.js';
import { canEditClient, renderCellBadge } from '../../../src/release.js';
import { can, currentUser, sessionMode } from '../../../src/session.js';

import { appendOwnerReassign } from './ownerReassign.js';
import './staff.css';
import {
  buildMatrixRows,
  computeTimeWindow,
  DISCIPLINE_COLOR,
  DISCIPLINE_TAG,
  findUncoveredSirs,
  renderSyncMatrixSvg,
  ZOOM_PRESETS,
  zoomWindow,
} from './syncMatrix.js';

const DISCIPLINES = ['HUMINT', 'SIGINT', 'IMINT', 'GEOINT', 'OSINT', 'MASINT', 'UAS', 'RECCE', 'OP', 'OTHER'];
const TASKING_STATUSES = ['planned', 'tasked', 'active', 'complete', 'cancelled'];
const QUICK_OFFSETS = ['+1h', '+6h', '+12h', '+24h'];

/** See reportForm.js's own copy of this check for why "no cell" is
 * defensive, not the real gate. */
function hasCell() {
  if (sessionMode() !== 'on') return true;
  const user = currentUser();
  return Boolean(user?.admin) || Boolean(user?.cell);
}

export function createCollectionController(ctx) {
  const { requestJson, createElement, askText, askConfirm, showError, formatDate, api } = ctx;

  const data = {
    collectors: [],
    taskings: [],
    requirements: [],
    nais: [],
    conflicts: { overlaps: [], outside: [] },
    reports: [],
    clock: null,
  };
  let zoomHours = null; // null = auto-fit
  let unsubscribe = null;
  let panel = null;

  async function load() {
    const [collectors, taskings, requirements, nais, conflicts, reports, clock] = await Promise.all([
      requestJson(`${api}/collectors`),
      requestJson(`${api}/taskings`),
      requestJson(`${api}/requirements`),
      requestJson(`${api}/nais`),
      requestJson(`${api}/collection/conflicts`),
      requestJson(`${api}/reports`),
      requestJson(`${api}/clock`),
    ]);
    Object.assign(data, { collectors, taskings, requirements, nais, conflicts, reports, clock });
  }

  /** Scenario "now" (ms), the reference for short DTGs and the quick offsets. */
  function scenarioNow() {
    const now = data.clock ? Date.parse(data.clock.now) : NaN;
    return Number.isFinite(now) ? now : Date.now();
  }

  // -- collectors -----------------------------------------------------------

  async function createCollector(form, container) {
    const name = form.querySelector('[name=name]').value.trim();
    const discipline = form.querySelector('[name=discipline]').value;
    const unit = form.querySelector('[name=unit]').value.trim();
    const rangeText = form.querySelector('[name=range_km]').value.trim();
    if (!name) return;
    try {
      const availableFrom = readDtgValue(form.querySelector('[name=available_from]'));
      const availableTo = readDtgValue(form.querySelector('[name=available_to]'));
      await requestJson(`${api}/collectors`, {
        method: 'POST',
        body: {
          name,
          discipline,
          unit: unit || null,
          range_km: rangeText ? Number.parseFloat(rangeText) : null,
          available_from: availableFrom,
          available_to: availableTo,
        },
      });
      await load();
      render();
    } catch (error) {
      showError(container, error.message);
    }
  }

  async function deleteCollector(id) {
    if (!(await askConfirm('Delete this collector and its taskings?'))) return;
    await requestJson(`${api}/collectors/${id}`, { method: 'DELETE' });
    await load();
    render();
  }

  async function reassignCollectorOwner(collector, ownerCell) {
    await requestJson(`${api}/collectors/${collector.id}/owner`, { method: 'PATCH', body: { owner_cell: ownerCell } });
    await load();
    render();
  }

  async function editCollectorNotes(collector, container) {
    const text = await askText('Notes', collector.notes ?? '');
    if (text === null) return;
    try {
      await requestJson(`${api}/collectors/${collector.id}`, { method: 'PATCH', body: { notes: text } });
      await load();
      render();
    } catch (error) {
      showError(container, error.message);
    }
  }

  function renderCollectorsSection(container) {
    const section = createElement('section', 'field-group');
    section.append(createElement('h3', null, 'Collectors'));
    if (can('collection-manager') && hasCell()) {
      const form = createElement('div', 'requirement-form');
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.name = 'name';
      nameInput.placeholder = 'Collector / asset name…';
      const disciplineSelect = document.createElement('select');
      disciplineSelect.name = 'discipline';
      DISCIPLINES.forEach((d) => disciplineSelect.append(new Option(d, d)));
      const unitInput = document.createElement('input');
      unitInput.type = 'text';
      unitInput.name = 'unit';
      unitInput.placeholder = 'Parent unit…';
      const rangeInput = document.createElement('input');
      rangeInput.type = 'number';
      rangeInput.name = 'range_km';
      rangeInput.min = '0';
      rangeInput.step = '0.1';
      rangeInput.placeholder = 'Range (km)';
      const fromInput = createDtgInput({ name: 'available_from', label: 'Available from', reference: scenarioNow });
      const toInput = createDtgInput({ name: 'available_to', label: 'Available to', reference: scenarioNow });
      const addButton = createElement('button', 'primary-button', 'Add collector');
      addButton.type = 'button';
      addButton.addEventListener('click', () => createCollector(form, section));
      form.append(nameInput, disciplineSelect, unitInput, rangeInput, fromInput, toInput, addButton);
      section.append(form);
    } else {
      section.append(createElement('p', 'panel-note', 'Adding collectors needs the collection-manager role.'));
    }

    if (!data.collectors.length) {
      section.append(createElement('p', 'panel-note', 'No collectors yet.'));
      container.append(section);
      return;
    }
    const table = document.createElement('table');
    table.className = 'data-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['Name', 'Discipline', 'Unit', 'Range', 'Available', 'Cell', 'Notes', ''].forEach((label) =>
      headRow.append(createElement('th', null, label)),
    );
    head.append(headRow);
    const body = document.createElement('tbody');
    data.collectors.forEach((collector) => {
      const row = document.createElement('tr');
      const availability =
        collector.available_from || collector.available_to
          ? `${collector.available_from ? formatDate(collector.available_from) : '—'} to ${
              collector.available_to ? formatDate(collector.available_to) : '—'
            }`
          : 'Unrestricted';
      row.append(
        createElement('td', null, collector.name),
        createElement('td', null, collector.discipline),
        createElement('td', null, collector.unit || '—'),
        createElement('td', null, collector.range_km ? `${collector.range_km} km` : '—'),
        createElement('td', null, availability),
      );
      const cellCell = document.createElement('td');
      cellCell.append(renderCellBadge(collector.owner_cell));
      appendOwnerReassign(cellCell, collector.owner_cell, (ownerCell) => reassignCollectorOwner(collector, ownerCell));
      row.append(cellCell);
      const notesCell = document.createElement('td');
      const notesButton = createElement('button', 'text-button', collector.notes ? 'Edit notes' : 'Add notes');
      notesButton.type = 'button';
      // C2b: release grants read only (moot for collectors today — they
      // have no release endpoint — but the store enforces canEdit
      // regardless, so mirror it here rather than leave a dead click).
      notesButton.disabled = !can('collection-manager') || !canEditClient(collector);
      notesButton.addEventListener('click', () => editCollectorNotes(collector, section));
      notesCell.append(notesButton);
      row.append(notesCell);
      const actionsCell = document.createElement('td');
      if (can('collection-manager') && canEditClient(collector)) {
        const deleteButton = createElement('button', 'icon-button danger', 'Delete');
        deleteButton.type = 'button';
        deleteButton.addEventListener('click', () => deleteCollector(collector.id));
        actionsCell.append(deleteButton);
      }
      row.append(actionsCell);
      body.append(row);
    });
    table.append(head, body);
    section.append(table);
    container.append(section);
  }

  // -- taskings ---------------------------------------------------------------

  function resolveQuickTime(offsetText, baseMs) {
    const minutes = parseHOffset(`H${offsetText}`);
    return minutes === null ? null : new Date(baseMs + minutes * 60_000).toISOString();
  }

  async function createTasking(form, container) {
    const collectorId = Number.parseInt(form.querySelector('[name=collector_id]').value, 10);
    const sirId = Number.parseInt(form.querySelector('[name=sir_id]').value, 10);
    const naiId = form.querySelector('[name=nai_id]').value;
    const notes = form.querySelector('[name=notes]').value.trim();
    if (!collectorId || !sirId) return showError(container, 'Choose a collector and a SIR.');
    try {
      const startAt = readDtgValue(form.querySelector('[name=start_at]'));
      const endAt = readDtgValue(form.querySelector('[name=end_at]'));
      if (!startAt || !endAt) throw new Error('A tasking needs a start and an end DTG.');
      await requestJson(`${api}/taskings`, {
        method: 'POST',
        body: {
          collector_id: collectorId,
          sir_id: sirId,
          nai_id: naiId ? Number.parseInt(naiId, 10) : null,
          start_at: startAt,
          end_at: endAt,
          notes: notes || null,
        },
      });
      await load();
      render();
    } catch (error) {
      showError(container, error.message);
    }
  }

  async function updateTaskingStatus(tasking, status) {
    await requestJson(`${api}/taskings/${tasking.id}`, { method: 'PATCH', body: { status } });
    await load();
    render();
  }

  async function linkTaskingReport(tasking, container) {
    const options = data.reports.map((r) => `#${r.id} ${r.text.slice(0, 40)}`).join(', ') || 'none yet';
    const idText = await askText(`Report id to link (available: ${options})`, tasking.report_id ?? '');
    if (idText === null) return;
    const reportId = idText.trim() ? Number.parseInt(idText, 10) : null;
    try {
      await requestJson(`${api}/taskings/${tasking.id}`, { method: 'PATCH', body: { report_id: reportId } });
      await load();
      render();
    } catch (error) {
      showError(container, error.message);
    }
  }

  async function deleteTasking(id) {
    if (!(await askConfirm('Delete this tasking?'))) return;
    await requestJson(`${api}/taskings/${id}`, { method: 'DELETE' });
    await load();
    render();
  }

  function copySor(text, button) {
    navigator.clipboard?.writeText(text).then(
      () => {
        const original = button.textContent;
        button.textContent = 'Copied';
        setTimeout(() => {
          button.textContent = original;
        }, 1200);
      },
      () => {},
    );
  }

  function allSirOptions() {
    const options = [];
    for (const requirement of data.requirements) {
      for (const sir of requirement.sirs ?? []) {
        options.push({ id: sir.id, label: `${requirement.text.slice(0, 30)} — ${sir.text.slice(0, 40)}`, sir });
      }
    }
    return options;
  }

  function renderTaskingsSection(container) {
    const section = createElement('section', 'field-group');
    section.append(createElement('h3', null, 'Taskings'));
    const sirOptions = allSirOptions();

    if (can('collection-manager') && hasCell()) {
      const form = createElement('div', 'requirement-form');
      const collectorSelect = document.createElement('select');
      collectorSelect.name = 'collector_id';
      collectorSelect.append(new Option('Collector…', ''));
      data.collectors.forEach((c) => collectorSelect.append(new Option(`${c.name} (${c.discipline})`, c.id)));
      const sirSelect = document.createElement('select');
      sirSelect.name = 'sir_id';
      sirSelect.append(new Option('SIR…', ''));
      sirOptions.forEach((o) => sirSelect.append(new Option(o.label, o.id)));
      const naiSelect = document.createElement('select');
      naiSelect.name = 'nai_id';
      naiSelect.append(new Option('NAI (default: SIR\u2019s)', ''));
      data.nais.forEach((n) => naiSelect.append(new Option(`${n.label} (${n.kind.toUpperCase()})`, n.id)));
      sirSelect.addEventListener('change', () => {
        const sir = sirOptions.find((o) => String(o.id) === sirSelect.value)?.sir;
        naiSelect.value = sir?.nai_id ? String(sir.nai_id) : '';
      });
      const startInput = createDtgInput({ name: 'start_at', label: 'Start', reference: scenarioNow });
      const endInput = createDtgInput({ name: 'end_at', label: 'End', reference: scenarioNow });
      const quickWrap = createElement('div', 'inline-form quick-offsets');
      QUICK_OFFSETS.forEach((offset) => {
        const button = createElement('button', 'text-button', offset);
        button.type = 'button';
        button.addEventListener('click', () => {
          if (!data.clock) return;
          const base = scenarioNow();
          const value = resolveQuickTime(offset, base);
          if (!startInput.value) setDtgValue(startInput, base);
          if (value) setDtgValue(endInput, value);
        });
        quickWrap.append(button);
      });
      const notesInput = document.createElement('input');
      notesInput.type = 'text';
      notesInput.name = 'notes';
      notesInput.placeholder = 'Notes (optional)…';
      const addButton = createElement('button', 'primary-button', 'Task');
      addButton.type = 'button';
      addButton.addEventListener('click', () => createTasking(form, section));
      form.append(collectorSelect, sirSelect, naiSelect, startInput, endInput, notesInput, addButton);
      section.append(form, quickWrap);
    } else {
      section.append(createElement('p', 'panel-note', 'Tasking collectors needs the collection-manager role.'));
    }

    if (!data.taskings.length) {
      section.append(createElement('p', 'panel-note', 'No taskings yet.'));
      container.append(section);
      return;
    }

    const conflictIds = new Set([
      ...data.conflicts.overlaps.flatMap((c) => c.tasking_ids),
      ...data.conflicts.outside.map((c) => c.tasking_id),
    ]);
    const collectorsById = new Map(data.collectors.map((c) => [c.id, c]));

    const list = createElement('div', 'tasking-list');
    data.taskings.forEach((tasking) => {
      const row = createElement('article', `tasking-row status-${tasking.status}`);
      if (conflictIds.has(tasking.id)) row.classList.add('has-conflict');
      const header = createElement('div', 'tasking-header');
      const collector = collectorsById.get(tasking.collector_id);
      header.append(
        createElement('span', 'tasking-collector', collector?.name ?? `#${tasking.collector_id}`),
        createElement('span', `tasking-status status-${tasking.status}`, tasking.status),
      );
      if (conflictIds.has(tasking.id)) {
        const warn = createElement('span', 'conflict-badge', '\u26A0 Conflict');
        warn.title = 'Overlaps another tasking of the same collector, or is outside its availability window.';
        header.append(warn);
      }
      row.append(header);
      row.append(
        createElement(
          'p',
          'panel-note',
          `${formatDate(tasking.start_at)} \u2192 ${formatDate(tasking.end_at)}${tasking.notes ? ` · ${tasking.notes}` : ''}`,
        ),
      );
      const sorBlock = createElement('div', 'sor-block');
      const sorText = createElement('code', 'sor-text', tasking.sor);
      const copyButton = createElement('button', 'text-button', 'Copy SOR');
      copyButton.type = 'button';
      copyButton.addEventListener('click', () => copySor(tasking.sor, copyButton));
      sorBlock.append(sorText, copyButton);
      row.append(sorBlock);

      // C2b: release grants read only (moot for taskings today — no
      // release endpoint — but mirror the store's canEdit gate anyway).
      if (can('collection-manager') && canEditClient(tasking)) {
        const actions = createElement('div', 'inline-form');
        const statusSelect = document.createElement('select');
        TASKING_STATUSES.forEach((s) => statusSelect.append(new Option(s, s)));
        statusSelect.value = tasking.status;
        statusSelect.addEventListener('change', () => updateTaskingStatus(tasking, statusSelect.value));
        actions.append(statusSelect);
        if (tasking.status === 'complete') {
          const linkButton = createElement(
            'button',
            'chip-button',
            tasking.report_id ? `Report #${tasking.report_id}` : 'Link report',
          );
          linkButton.type = 'button';
          linkButton.addEventListener('click', () => linkTaskingReport(tasking, row));
          actions.append(linkButton);
        }
        const deleteButton = createElement('button', 'icon-button danger', 'Delete');
        deleteButton.type = 'button';
        deleteButton.addEventListener('click', () => deleteTasking(tasking.id));
        actions.append(deleteButton);
        row.append(actions);
      } else if (tasking.report_id) {
        row.append(createElement('p', 'panel-note', `Linked report #${tasking.report_id}`));
      }
      list.append(row);
    });
    section.append(list);
    container.append(section);
  }

  // -- sync matrix ------------------------------------------------------------

  function renderMatrixSection(container) {
    const section = createElement('section', 'field-group sync-matrix-section');
    const header = createElement('div', 'panel-header-row');
    header.append(createElement('h3', null, 'ISR synchronization matrix'));
    const zoomControls = createElement('div', 'inline-form');
    const autoButton = createElement('button', `chip-button${zoomHours === null ? ' active' : ''}`, 'Auto-fit');
    autoButton.type = 'button';
    autoButton.addEventListener('click', () => {
      zoomHours = null;
      render();
    });
    zoomControls.append(autoButton);
    ZOOM_PRESETS.forEach((hours) => {
      const button = createElement('button', `chip-button${zoomHours === hours ? ' active' : ''}`, `${hours} h`);
      button.type = 'button';
      button.addEventListener('click', () => {
        zoomHours = hours;
        render();
      });
      zoomControls.append(button);
    });
    header.append(zoomControls);
    section.append(header);

    const rows = buildMatrixRows(data.requirements, data.taskings, data.nais);
    if (!rows.length) {
      section.append(createElement('p', 'panel-note', 'No SIRs to schedule yet — import from IPB or add one on the Requirements tab.'));
      container.append(section);
      return;
    }
    const ltiovTimes = rows.filter((r) => r.kind === 'pir' && r.ltiov !== null).map((r) => r.ltiov);
    const now = data.clock ? new Date(data.clock.now).getTime() : Date.now();
    const timeWindow =
      zoomHours === null ? computeTimeWindow(data.taskings, ltiovTimes, now) : zoomWindow(now, zoomHours);

    const collectorsById = new Map(data.collectors.map((c) => [c.id, c]));
    const taskingsById = new Map(data.taskings.map((t) => [t.id, t]));
    const svg = renderSyncMatrixSvg({
      rows,
      window: timeWindow,
      now,
      conflicts: data.conflicts,
      collectorsById,
      taskingsById,
    });
    const svgWrap = createElement('div', 'sync-matrix-wrap');
    svgWrap.append(svg);
    section.append(svgWrap);

    const legend = createElement('ul', 'sync-legend');
    Object.entries(DISCIPLINE_COLOR).forEach(([discipline, color]) => {
      const item = createElement('li', null);
      const swatch = createElement('span', 'sync-legend-swatch');
      swatch.style.setProperty('--swatch', color);
      item.append(swatch, document.createTextNode(`${discipline} (${DISCIPLINE_TAG[discipline]})`));
      legend.append(item);
    });
    section.append(legend);
    const statusLegend = createElement(
      'p',
      'panel-note',
      'Bar style: outline = planned, solid = active, hatched = complete. Red tick = LTIOV. Vertical amber line = scenario now.',
    );
    section.append(statusLegend);

    const uncovered = findUncoveredSirs(rows);
    if (uncovered.length) {
      const uncoveredBox = createElement('div', 'uncovered-box');
      uncoveredBox.append(createElement('h4', null, 'Uncovered SIRs'));
      const list = createElement('ul', null);
      uncovered.forEach((row) => list.append(createElement('li', null, row.label)));
      uncoveredBox.append(list);
      section.append(uncoveredBox);
    }
    container.append(section);
  }

  function renderSorPrintSection(container) {
    const section = createElement('section', 'field-group sor-print-section');
    section.append(createElement('h3', null, 'SOR list (print)'));
    const list = createElement('ol', 'sor-print-list');
    data.taskings.forEach((tasking) => list.append(createElement('li', null, tasking.sor)));
    section.append(list);
    container.append(section);
  }

  function render() {
    if (!panel) return;
    panel.replaceChildren();
    const header = createElement('div', 'panel-header-row');
    header.append(createElement('h2', null, 'Collection plan'));
    const printButton = createElement('button', 'chip-button', 'Print matrix + SOR');
    printButton.type = 'button';
    printButton.addEventListener('click', () => window.print());
    header.append(printButton);
    panel.append(header);
    renderMatrixSection(panel);
    renderCollectorsSection(panel);
    renderTaskingsSection(panel);
    renderSorPrintSection(panel);
  }

  async function enter(container) {
    panel = container;
    panel.replaceChildren(createElement('p', 'panel-note', 'Loading collection plan\u2026'));
    try {
      await load();
    } catch (error) {
      if (error.name === 'AbortError') return;
      panel.replaceChildren(createElement('p', 'inline-error', error.message));
      return;
    }
    render();
    unsubscribe = subscribe(
      (event) => event.module === 'exercise',
      () => {
        load()
          .then(render)
          .catch(() => {});
      },
    );
  }

  function leave() {
    unsubscribe?.();
    unsubscribe = null;
    panel = null;
  }

  return { enter, leave };
}
