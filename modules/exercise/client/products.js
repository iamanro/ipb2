/**
 * The Products tab: an editable INTSUM draft/save/print, the Graphic INTSUM
 * (situation map snapshot + legend, printed with `exportCanvas()` the same
 * way `modules/ipb/client/view.js` prints its worksheet map), and a
 * SPOTREP/SALUTE one-page print form. Same `{ enter(container), leave() }`
 * controller shape as `collection.js`.
 */
import { formatDtg } from '../../../src/dtg.js';
import { createDtgInput, readDtgValue } from '../../../src/dtgField.js';
import { formatMgrs } from '../../../src/geo.js';
import { subscribe } from '../../../src/live.js';
import { createMap } from '../../../src/map.js';
import { canEditClient, renderCellBadge, renderReleaseControl } from '../../../src/release.js';
import { can, currentUser, sessionMode } from '../../../src/session.js';

import { appendOwnerReassign } from './ownerReassign.js';
import './staff.css';

const TERRAIN_API = '/api/terrain';
const CZECHIA_CENTER = [15.47, 49.82];

const INTSUM_SECTIONS = [
  ['situation', 'Situation'],
  ['significant_activity', 'Significant activity'],
  ['pir_status', 'PIR status'],
  ['assessment', 'Assessment'],
  ['outlook', 'Outlook'],
];

const DEFAULT_CLASSIFICATION = 'UNCLASSIFIED // EXERCISE';

/** See reportForm.js's own copy of this check for why "no cell" is
 * defensive, not the real gate. */
function hasCell() {
  if (sessionMode() !== 'on') return true;
  const user = currentUser();
  return Boolean(user?.admin) || Boolean(user?.cell);
}

export function createProductsController(ctx) {
  const { requestJson, createElement, askConfirm, showError, formatDate, api } = ctx;

  const data = { intsums: [], draft: null, reports: [], tracks: [], nais: [], clock: null };
  let panel = null;
  let unsubscribe = null;
  let editing = null; // an intsum id being edited, or 'draft' for the unsaved draft, or null
  let draftForm = null; // { period_start, period_end, sections }
  let selectedReportId = null;
  let mapController = null;
  let mapTarget = null;
  let classification = DEFAULT_CLASSIFICATION;

  async function load() {
    const [intsums, reports, tracks, nais, clock] = await Promise.all([
      requestJson(`${api}/intsums`),
      requestJson(`${api}/reports`),
      requestJson(`${api}/tracks`),
      requestJson(`${api}/nais`),
      requestJson(`${api}/clock`),
    ]);
    Object.assign(data, { intsums, reports, tracks, nais, clock });
  }

  // -- INTSUM -------------------------------------------------------------

  /** Scenario "now" (ms): products are stamped in exercise time, not wall-clock time. */
  function scenarioNow() {
    const now = data.clock ? Date.parse(data.clock.now) : NaN;
    return Number.isFinite(now) ? now : Date.now();
  }

  /** Print one product: the page's other products are hidden for this print job only. */
  function printProduct(kind) {
    const target = panel;
    target.dataset.print = kind;
    window.addEventListener('afterprint', () => delete target.dataset.print, { once: true });
    window.print();
  }

  function defaultPeriod() {
    const now = new Date(scenarioNow());
    const to = now.toISOString();
    const from = new Date(now.getTime() - 12 * 3_600_000).toISOString();
    return { from, to };
  }

  /** PIR fulfillment lines the draft returns as `{ requirement_id, text, covered, total, percent, state }`. */
  function formatPirStatusLine(entry) {
    return `${entry.text} — ${entry.state} (${entry.covered}/${entry.total} SIRs, ${entry.percent}%)`;
  }

  /** The server returns `situation`/`significant_activity` as line arrays and `pir_status` as
   * objects; the editor's textareas need plain, editable text, so flatten each to lines here. */
  function formatDraftSections(sections) {
    const toLines = (value, formatEntry = (v) => v) =>
      Array.isArray(value) ? value.map(formatEntry).join('\n') : (value ?? '');
    return {
      situation: toLines(sections.situation),
      significant_activity: toLines(sections.significant_activity),
      pir_status: toLines(sections.pir_status, formatPirStatusLine),
      assessment: toLines(sections.assessment),
      outlook: toLines(sections.outlook),
    };
  }

  async function loadDraft(from, to, container) {
    try {
      const draft = await requestJson(
        `${api}/products/intsum-draft?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      draftForm = {
        period_start: draft.period_start,
        period_end: draft.period_end,
        dtg: formatDtg(scenarioNow()),
        author: '',
        sections: formatDraftSections(draft.sections),
      };
      editing = 'draft';
      render();
    } catch (error) {
      showError(container, error.message);
    }
  }

  async function saveIntsum(container) {
    try {
      if (editing === 'draft') {
        const saved = await requestJson(`${api}/intsums`, { method: 'POST', body: draftForm });
        editing = saved.id;
      } else {
        await requestJson(`${api}/intsums/${editing}`, {
          method: 'PATCH',
          body: { dtg: draftForm.dtg, author: draftForm.author, sections: draftForm.sections },
        });
      }
      await load();
      render();
    } catch (error) {
      showError(container, error.message);
    }
  }

  function openIntsum(intsum) {
    draftForm = {
      period_start: intsum.period_start,
      period_end: intsum.period_end,
      dtg: intsum.dtg,
      author: intsum.author ?? '',
      sections: intsum.sections,
    };
    editing = intsum.id;
    render();
  }

  async function deleteIntsum(id) {
    if (!(await askConfirm('Delete this INTSUM?'))) return;
    await requestJson(`${api}/intsums/${id}`, { method: 'DELETE' });
    if (editing === id) editing = null;
    await load();
    render();
  }

  async function releaseIntsum(intsum, cells) {
    await requestJson(`${api}/intsums/${intsum.id}/release`, { method: 'POST', body: { cells } });
    await load();
    render();
  }

  async function reassignIntsumOwner(intsum, ownerCell) {
    await requestJson(`${api}/intsums/${intsum.id}/owner`, {
      method: 'PATCH',
      body: { owner_cell: ownerCell },
    });
    await load();
    render();
  }

  function renderIntsumEditor(container) {
    const section = createElement('section', 'field-group intsum-editor');
    section.dataset.product = 'intsum-editor';
    section.append(
      createElement(
        'h3',
        null,
        editing === 'draft' ? 'New INTSUM draft' : `Editing INTSUM ${draftForm.dtg}`,
      ),
    );

    // Built alongside the editor so every field's input handler can push its
    // value straight into the matching print-sheet node — no full re-render
    // needed just to keep the print preview in sync while typing.
    const printSheet = renderIntsumPrintSheet();

    const meta = createElement('div', 'inline-form');
    const dtgInput = document.createElement('input');
    dtgInput.type = 'text';
    dtgInput.value = draftForm.dtg;
    dtgInput.placeholder = 'DTG';
    dtgInput.addEventListener('input', () => {
      draftForm.dtg = dtgInput.value;
      printSheet.heading.textContent = `INTSUM ${draftForm.dtg}`;
    });
    const authorInput = document.createElement('input');
    authorInput.type = 'text';
    authorInput.value = draftForm.author;
    authorInput.placeholder = 'Author…';
    authorInput.addEventListener('input', () => {
      draftForm.author = authorInput.value;
      printSheet.meta.textContent = `Period ${formatDate(draftForm.period_start)} \u2192 ${formatDate(draftForm.period_end)} \u00b7 Author: ${draftForm.author || '\u2014'}`;
    });
    meta.append(dtgInput, authorInput);
    section.append(meta);
    section.append(
      createElement(
        'p',
        'panel-note',
        `Period ${formatDate(draftForm.period_start)} \u2192 ${formatDate(draftForm.period_end)}`,
      ),
    );

    // C2b: release grants read only. A new draft is always editable by its
    // creator (own-cell creation); an existing INTSUM merely released to
    // this cell falls back to the same read-only rendering as a role gate.
    const editingExisting =
      editing !== 'draft' && data.intsums.find((intsum) => intsum.id === editing);
    const canEditThis =
      editing === 'draft' || (editingExisting ? canEditClient(editingExisting) : true);
    const readOnly = !can('analyst') || !canEditThis;
    INTSUM_SECTIONS.forEach(([key, label]) => {
      const field = createElement('div', 'intsum-field');
      const fieldLabel = createElement('label', null, `${label}. `);
      const textareaId = `intsum-section-${key}`;
      fieldLabel.htmlFor = textareaId;
      field.append(fieldLabel);
      const textarea = document.createElement('textarea');
      textarea.id = textareaId;
      textarea.rows = 4;
      textarea.value = draftForm.sections[key] ?? '';
      textarea.disabled = readOnly;
      textarea.addEventListener('input', () => {
        draftForm.sections[key] = textarea.value;
        printSheet.bodies[key].textContent = textarea.value || '\u2014';
      });
      field.append(textarea);
      section.append(field);
    });

    if (can('analyst') && canEditThis) {
      const saveButton = createElement(
        'button',
        'primary-button',
        editing === 'draft' ? 'Save INTSUM' : 'Save changes',
      );
      saveButton.type = 'button';
      saveButton.addEventListener('click', () => saveIntsum(section));
      section.append(saveButton);
    } else if (!can('analyst')) {
      section.append(createElement('p', 'panel-note', 'Editing INTSUMs needs the analyst role.'));
    } else {
      section.append(createElement('p', 'panel-note', 'Released to your cell for reading only.'));
    }
    const printButton = createElement('button', 'chip-button', 'Print preview');
    printButton.type = 'button';
    printButton.addEventListener('click', () => printProduct('intsum'));
    section.append(printButton);
    container.append(section);
    container.append(printSheet.element);
  }

  /**
   * A print-only rendering of the same draft, in the standard INTSUM shape
   * the analyst expects on paper: classification banner, DTG/period/author
   * header, then sections numbered 1-5 — the live `<textarea>`s above stay
   * on-screen only (CSS hides them in print). Returns the container plus the
   * live-bound nodes `renderIntsumEditor`'s input handlers update directly.
   */
  function renderIntsumPrintSheet() {
    const sheet = createElement('div', 'intsum-print-sheet');
    sheet.dataset.product = 'intsum';
    sheet.append(createElement('p', 'classification-banner', classification));
    const heading = createElement('h3', null, `INTSUM ${draftForm.dtg}`);
    sheet.append(heading);
    const meta = createElement(
      'p',
      'panel-note',
      `Period ${formatDate(draftForm.period_start)} \u2192 ${formatDate(draftForm.period_end)} \u00b7 Author: ${draftForm.author || '\u2014'}`,
    );
    sheet.append(meta);
    const bodies = {};
    INTSUM_SECTIONS.forEach(([key, label], index) => {
      sheet.append(createElement('h4', null, `${index + 1}. ${label}`));
      const body = createElement('p', 'intsum-print-body', draftForm.sections[key] || '\u2014');
      bodies[key] = body;
      sheet.append(body);
    });
    sheet.append(createElement('p', 'classification-banner', classification));
    return { element: sheet, heading, meta, bodies };
  }

  function renderIntsumSection(container) {
    const section = createElement('section', 'field-group');
    section.dataset.product = 'intsum-form';
    section.append(createElement('h3', null, 'INTSUM'));
    if (can('analyst') && hasCell()) {
      const form = createElement('div', 'requirement-form');
      const { from: defaultFrom, to: defaultTo } = defaultPeriod();
      const fromInput = createDtgInput({
        name: 'period_from',
        label: 'Period from',
        value: defaultFrom,
      });
      const toInput = createDtgInput({ name: 'period_to', label: 'Period to', value: defaultTo });
      const draftButton = createElement('button', 'primary-button', 'Generate draft');
      draftButton.type = 'button';
      draftButton.addEventListener('click', () => {
        try {
          const from = readDtgValue(fromInput);
          const to = readDtgValue(toInput);
          if (!from || !to) throw new Error('The INTSUM period needs a start and an end DTG.');
          loadDraft(from, to, section);
        } catch (error) {
          showError(section, error.message);
        }
      });
      form.append(fromInput, toInput, draftButton);
      section.append(form);
    }
    container.append(section);
    if (draftForm) renderIntsumEditor(container);

    const listSection = createElement('section', 'field-group');
    listSection.dataset.product = 'intsum-list';
    listSection.append(createElement('h3', null, 'Saved INTSUMs'));
    if (!data.intsums.length) {
      listSection.append(createElement('p', 'panel-note', 'None saved yet.'));
    } else {
      const table = document.createElement('table');
      table.className = 'data-table';
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      ['DTG', 'Period', 'Author', 'Cell', ''].forEach((label) =>
        headRow.append(createElement('th', null, label)),
      );
      head.append(headRow);
      const body = document.createElement('tbody');
      data.intsums.forEach((intsum) => {
        const row = document.createElement('tr');
        row.append(
          createElement('td', null, intsum.dtg),
          createElement(
            'td',
            null,
            `${formatDate(intsum.period_start)} \u2192 ${formatDate(intsum.period_end)}`,
          ),
          createElement('td', null, intsum.author || '—'),
        );
        const cellCell = document.createElement('td');
        cellCell.append(renderCellBadge(intsum.owner_cell));
        cellCell.append(
          renderReleaseControl({
            item: intsum,
            onRelease: (cells) => releaseIntsum(intsum, cells),
          }),
        );
        appendOwnerReassign(cellCell, intsum.owner_cell, (ownerCell) =>
          reassignIntsumOwner(intsum, ownerCell),
        );
        row.append(cellCell);
        const actions = document.createElement('td');
        const openButton = createElement('button', 'text-button', 'Open');
        openButton.type = 'button';
        openButton.addEventListener('click', () => openIntsum(intsum));
        actions.append(openButton);
        // C2b: release grants read only, so Delete needs canEditClient on
        // top of the analyst role; "Open" stays available to anyone who
        // can see the INTSUM at all — its editor already falls back to a
        // read-only view (see renderIntsumEditor) for non-editors.
        if (can('analyst') && canEditClient(intsum)) {
          const deleteButton = createElement('button', 'icon-button danger', 'Delete');
          deleteButton.type = 'button';
          deleteButton.addEventListener('click', () => deleteIntsum(intsum.id));
          actions.append(deleteButton);
        }
        row.append(actions);
        body.append(row);
      });
      table.append(head, body);
      listSection.append(table);
    }
    container.append(listSection);
  }

  // -- Graphic INTSUM -------------------------------------------------------

  function trackExtent() {
    const points = data.tracks.map((t) => [t.lon, t.lat]);
    if (!points.length) return null;
    const lons = points.map((p) => p[0]);
    const lats = points.map((p) => p[1]);
    return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  }

  function ensureMap(target) {
    if (mapController && mapTarget === target) return mapController;
    mapController?.destroy();
    mapController = createMap({
      target,
      basemapUrl: `${TERRAIN_API}/tiles/vector.pmtiles`,
      center: CZECHIA_CENTER,
      zoom: 7,
    });
    mapController.setMgrsGrid(true);
    mapTarget = target;
    return mapController;
  }

  let printMapFigure = null;

  /**
   * Snapshots the live map into the print-only figure on `beforeprint`, the
   * same pattern `modules/ipb/client/view.js`'s `preparePrintMap` uses:
   * `exportCanvas()` already composites the MGRS grid, so the printed map
   * carries its own scale reference.
   */
  function preparePrintMap() {
    if (!printMapFigure) return;
    printMapFigure.replaceChildren();
    const frame = mapController?.exportCanvas();
    if (!frame) return;
    const { canvas, attributions, metresPerPixel } = frame;
    const caption = createElement('figcaption');
    const scaleNote = metresPerPixel ? `~1 px \u2248 ${Math.round(metresPerPixel)} m` : null;
    caption.append(
      createElement('strong', null, `Graphic INTSUM — ${classification}`),
      createElement(
        'span',
        null,
        [`DTG ${formatDtg(scenarioNow())}`, scaleNote].filter(Boolean).join(' · '),
      ),
    );
    if (attributions.length) caption.append(createElement('small', null, attributions.join(' · ')));
    printMapFigure.append(canvas, caption);
  }

  function clearPrintMap() {
    printMapFigure?.replaceChildren();
  }

  function renderGraphicIntsum(container) {
    const section = createElement('section', 'field-group graphic-intsum-section');
    section.dataset.product = 'graphic';
    const header = createElement('div', 'panel-header-row');
    header.append(createElement('h3', null, 'Graphic INTSUM'));
    const printButton = createElement('button', 'chip-button', 'Print preview');
    printButton.type = 'button';
    printButton.addEventListener('click', () => printProduct('graphic'));
    header.append(printButton);
    section.append(header);

    const classificationField = document.createElement('input');
    classificationField.type = 'text';
    classificationField.className = 'classification-input';
    classificationField.value = classification;
    classificationField.setAttribute('aria-label', 'Classification marking');
    classificationField.addEventListener('input', () => {
      classification = classificationField.value || DEFAULT_CLASSIFICATION;
    });
    section.append(classificationField);

    const mapWrap = createElement('div', 'graphic-intsum-map');
    const target = createElement('div', 'graphic-intsum-target');
    mapWrap.append(target);
    section.append(mapWrap);
    printMapFigure = createElement('figure', 'print-map graphic-intsum-print-map');
    section.append(printMapFigure);
    container.append(section);

    // Deferred: the target must be attached to the DOM before OL measures it.
    requestAnimationFrame(() => {
      const map = ensureMap(target);
      map.setSituation({ tracks: data.tracks, reports: data.reports }, { onSelect: () => {} });
      map.setFeatures(
        data.nais.map((nai) => ({
          id: nai.id,
          layer: nai.kind,
          kind: 'polygon',
          label: nai.label,
          geometry: nai.geometry,
          properties: {},
        })),
      );
      const extent = trackExtent();
      if (extent) map.fitExtent(extent);
    });

    const legend = createElement('div', 'graphic-intsum-legend');
    legend.append(createElement('h4', null, 'Legend'));
    const trackList = createElement('ul', null);
    data.tracks.forEach((track) =>
      trackList.append(
        createElement(
          'li',
          null,
          `${track.designation || track.sidc} — ${track.status} — ${formatMgrs(track.lon, track.lat)}`,
        ),
      ),
    );
    legend.append(trackList);
    legend.append(createElement('h4', null, 'Report credibility key'));
    const credibilityList = createElement('ul', null, '');
    [
      '1–2 solid marker: confirmed',
      '3 half-filled: probably true',
      '4–6 hollow: unconfirmed',
    ].forEach((text) => credibilityList.append(createElement('li', null, text)));
    legend.append(credibilityList);
    section.append(legend);

    const { from, to } = defaultPeriod();
    section.append(
      createElement(
        'p',
        'panel-note graphic-intsum-caption',
        `DTG ${formatDtg(scenarioNow())} · Period ${formatDate(from)} \u2192 ${formatDate(to)} · ${classification}`,
      ),
    );
    container.append(section);
  }

  // -- SALUTE / SPOTREP print -------------------------------------------------

  const SALUTE_FIELDS = [
    ['size', 'Size'],
    ['activity', 'Activity'],
    ['location', 'Location'],
    ['unit', 'Unit'],
    ['time', 'Time'],
    ['equipment', 'Equipment'],
  ];
  const SPOTREP_FIELDS = [...SALUTE_FIELDS, ['remarks', 'Remarks']];

  function renderSalutePrint(container) {
    const section = createElement('section', 'field-group salute-section');
    section.dataset.product = 'salute';
    section.append(createElement('h3', null, 'SPOTREP / SALUTE print'));
    const structuredReports = data.reports.filter(
      (r) => r.report_type === 'salute' || r.report_type === 'spotrep',
    );
    if (!structuredReports.length) {
      section.append(createElement('p', 'panel-note', 'No SALUTE/SPOTREP reports yet.'));
      container.append(section);
      return;
    }
    const select = document.createElement('select');
    select.append(new Option('Choose a report…', ''));
    structuredReports.forEach((r) =>
      select.append(
        new Option(`#${r.id} ${r.report_type.toUpperCase()} — ${r.text.slice(0, 40)}`, r.id),
      ),
    );
    select.value = selectedReportId ?? '';
    select.addEventListener('change', () => {
      selectedReportId = select.value ? Number.parseInt(select.value, 10) : null;
      render();
    });
    const printButton = createElement('button', 'chip-button', 'Print preview');
    printButton.type = 'button';
    printButton.disabled = !selectedReportId;
    printButton.addEventListener('click', () => printProduct('salute'));
    const controls = createElement('div', 'inline-form');
    controls.append(select, printButton);
    section.append(controls);

    const report = structuredReports.find((r) => r.id === selectedReportId);
    if (report) {
      const sheet = createElement('div', 'salute-sheet');
      sheet.append(
        createElement('p', 'classification-banner', DEFAULT_CLASSIFICATION),
        createElement('h4', null, report.report_type.toUpperCase()),
        createElement(
          'p',
          'panel-note',
          `DTG ${formatDtg(new Date(report.occurred_at ?? report.created_at).getTime())} · MGRS ${formatMgrs(report.lon, report.lat)} · Admiralty ${report.reliability}${report.credibility}`,
        ),
      );
      const dl = document.createElement('dl');
      dl.className = 'salute-fields';
      const fieldSpec = report.report_type === 'spotrep' ? SPOTREP_FIELDS : SALUTE_FIELDS;
      fieldSpec.forEach(([key, label]) => {
        dl.append(
          createElement('dt', null, label),
          createElement('dd', null, report.fields?.[key] || '—'),
        );
      });
      sheet.append(dl);
      sheet.append(createElement('p', null, report.text));
      section.append(sheet);
    }
    container.append(section);
  }

  function render() {
    if (!panel) return;
    panel.replaceChildren();
    panel.append(createElement('h2', null, 'Products'));
    renderIntsumSection(panel);
    renderGraphicIntsum(panel);
    renderSalutePrint(panel);
  }

  async function enter(container) {
    panel = container;
    panel.replaceChildren(createElement('p', 'panel-note', 'Loading products\u2026'));
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
    window.addEventListener('beforeprint', preparePrintMap);
    window.addEventListener('afterprint', clearPrintMap);
  }

  function leave() {
    unsubscribe?.();
    unsubscribe = null;
    window.removeEventListener('beforeprint', preparePrintMap);
    window.removeEventListener('afterprint', clearPrintMap);
    mapController?.destroy();
    mapController = null;
    mapTarget = null;
    printMapFigure = null;
    panel = null;
  }

  return { enter, leave };
}
