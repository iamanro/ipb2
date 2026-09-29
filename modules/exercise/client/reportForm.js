/**
 * Reports: the type/fields/location/sidc composable (`createReportFieldset`,
 * reused by the Scenario tab's 'report' inject form) and the Reports tab
 * controller (`createReportsController`, the `{ enter(container), leave() }`
 * shape `collection.js`/`products.js` use — see `view.js`'s `ctx`).
 *
 * Report type structured fields mirror the server (`modules/exercise/server/store.js`
 * `SALUTE_FIELDS`/`SPOTREP_FIELDS`): SALUTE is size/activity/location/unit/time/
 * equipment, SPOTREP adds remarks, free has none. The SALUTE/SPOTREP "location"
 * field is free text (part of the narrative), separate from the report's own
 * lon/lat below it — it auto-fills from the point as MGRS until hand-edited.
 */
import { formatDtg, parseDtg } from '../../../src/dtg.js';
import { formatMgrs } from '../../../src/geo.js';
import { subscribe } from '../../../src/live.js';
import { canEditClient, renderCellBadge, renderReleaseControl } from '../../../src/release.js';
import { can, currentUser, sessionMode } from '../../../src/session.js';
import { openSymbolPicker } from '../../../src/symbols/picker.js';
import { DEFAULT_SIDC, withAffiliation } from '../../../src/symbols/sidc.js';
import { symbolElement } from '../../../src/symbols/symbol.js';

import { createLocationField } from './locationField.js';
import { appendOwnerReassign } from './ownerReassign.js';

export const REPORT_TYPES = ['free', 'spotrep', 'salute'];
export const REPORT_TYPE_LABEL = { free: 'Free text', spotrep: 'SPOTREP', salute: 'SALUTE' };
const SALUTE_FIELDS = ['size', 'activity', 'location', 'unit', 'time', 'equipment'];
const SPOTREP_FIELDS = [...SALUTE_FIELDS, 'remarks'];
const FIELDS_BY_TYPE = { free: [], spotrep: SPOTREP_FIELDS, salute: SALUTE_FIELDS };
const FIELD_LABEL = {
  size: 'Size',
  activity: 'Activity',
  location: 'Location',
  unit: 'Unit',
  time: 'Time',
  equipment: 'Equipment',
  remarks: 'Remarks',
};

/** NATO Admiralty System meanings, shown as option text next to the letter/number. */
export const RELIABILITY_MEANING = {
  A: 'Completely reliable',
  B: 'Usually reliable',
  C: 'Fairly reliable',
  D: 'Not usually reliable',
  E: 'Unreliable',
  F: 'Reliability cannot be judged',
};
export const CREDIBILITY_MEANING = {
  1: 'Confirmed by other sources',
  2: 'Probably true',
  3: 'Possibly true',
  4: 'Doubtful',
  5: 'Improbable',
  6: 'Truth cannot be judged',
};
const EVIDENCE_RELATIONS = ['confirms', 'denies', 'partial', 'context'];

/** True when the user may create a cell-owned item (see view.js's own
 * copy of this same check for why "no cell" is defensive, not the real gate). */
function hasCell() {
  if (sessionMode() !== 'on') return true;
  const user = currentUser();
  return Boolean(user?.admin) || Boolean(user?.cell);
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Great-circle distance in km (haversine) — sorts tracks nearest-first when plotting a report. */
export function distanceKm(lon1, lat1, lon2, lat2) {
  const earthRadiusKm = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** `tracks` sorted nearest-first to `point` ({lon,lat}), each wrapped with its distance in km. */
export function sortTracksByDistance(point, tracks) {
  return tracks
    .map((track) => ({ track, km: distanceKm(point.lon, point.lat, track.lon, track.lat) }))
    .sort((a, b) => a.km - b.km);
}

/** `payload.lon`/`lat` (a report or a located inject's payload) as MGRS, or null when unlocated. */
export function formatReportLocationMgrs(payload) {
  return payload && payload.lon != null ? formatMgrs(payload.lon, payload.lat) : null;
}

export function reliabilityOptionLabel(letter) {
  return `${letter} \u2014 ${RELIABILITY_MEANING[letter]}`;
}

export function credibilityOptionLabel(n) {
  return `${n} \u2014 ${CREDIBILITY_MEANING[n]}`;
}

/** Appends `<option>`s with Admiralty meanings to a reliability/credibility `<select>`. */
export function appendReliabilityOptions(select) {
  'ABCDEF'
    .split('')
    .forEach((letter) => select.append(new Option(reliabilityOptionLabel(letter), letter)));
}

export function appendCredibilityOptions(select) {
  [1, 2, 3, 4, 5, 6].forEach((n) =>
    select.append(new Option(credibilityOptionLabel(n), String(n))),
  );
}

/**
 * The type/fields/location/sidc composable. `initial` seeds it from an
 * existing report (or inject payload): `{ report_type, text, fields, sidc,
 * lon, lat }`. Returns `{ element, getValue(), setDisabled(bool), destroy() }`;
 * `getValue()` always returns a draft object, validity is the caller's job
 * (an empty `text` or a location the analyst hasn't finished typing).
 */
export function createReportFieldset({ initial = null, ariaLabel = 'Report location' } = {}) {
  const draft = {
    report_type: initial?.report_type ?? 'free',
    text: initial?.text ?? '',
    fields: { ...initial?.fields },
    sidc: initial?.sidc ?? null,
  };
  // Once the analyst hand-edits the SALUTE/SPOTREP "location" text, stop
  // overwriting it every time the point moves.
  let locationLocked = Boolean(draft.fields.location);

  const root = createElement('div', 'report-fieldset');

  const typeLabel = createElement('label', 'field-label', 'Report type');
  const typeSelect = document.createElement('select');
  typeSelect.className = 'report-type-select';
  REPORT_TYPES.forEach((type) => typeSelect.append(new Option(REPORT_TYPE_LABEL[type], type)));
  typeSelect.value = draft.report_type;
  typeLabel.append(typeSelect);
  root.append(typeLabel);

  const textLabel = createElement('label', 'field-label', 'Narrative');
  const textArea = document.createElement('textarea');
  textArea.className = 'report-text-input';
  textArea.rows = 3;
  textArea.value = draft.text;
  textArea.placeholder = 'What was observed\u2026';
  textArea.addEventListener('input', () => {
    draft.text = textArea.value;
  });
  textLabel.append(textArea);
  root.append(textLabel);

  const fieldsSection = createElement('div', 'report-type-fields');
  root.append(fieldsSection);

  const locationLabel = createElement('div', 'field-label', 'Location');
  const location = createLocationField({
    initial: initial && initial.lon != null ? { lon: initial.lon, lat: initial.lat } : null,
    ariaLabel,
    onChange: (value) => {
      if (draft.report_type !== 'free' && value && !locationLocked) {
        draft.fields.location = formatMgrs(value.lon, value.lat);
        renderFields();
      }
    },
  });
  locationLabel.append(location.element);
  root.append(locationLabel);

  const sidcSection = createElement('div', 'field-label', 'Reported SIDC (optional)');
  const sidcRow = createElement('div', 'report-sidc-row');
  const sidcPreview = createElement('span', 'report-sidc-preview');
  const sidcButton = createElement('button', 'chip-button', 'Choose symbol\u2026');
  sidcButton.type = 'button';
  const sidcClear = createElement('button', 'icon-button', 'Clear');
  sidcClear.type = 'button';
  sidcButton.addEventListener('click', async () => {
    const picked = await openSymbolPicker({
      initial: draft.sidc,
      affiliation: 'hostile',
      title: 'Reported unit symbol',
    });
    if (picked) {
      draft.sidc = picked;
      renderSidc();
    }
  });
  sidcClear.addEventListener('click', () => {
    draft.sidc = null;
    renderSidc();
  });
  sidcRow.append(sidcPreview, sidcButton, sidcClear);
  sidcSection.append(sidcRow);
  root.append(sidcSection);

  function renderSidc() {
    sidcPreview.replaceChildren();
    if (draft.sidc) {
      sidcPreview.append(symbolElement(draft.sidc, { size: 28 }, 'Reported unit symbol'));
    } else {
      sidcPreview.append(createElement('span', 'panel-note', 'No symbol selected.'));
    }
    sidcClear.disabled = !draft.sidc;
  }

  function renderFields() {
    fieldsSection.replaceChildren();
    FIELDS_BY_TYPE[draft.report_type].forEach((key) => {
      const label = createElement('label', 'field-label', FIELD_LABEL[key]);
      const field = document.createElement(key === 'remarks' ? 'textarea' : 'input');
      if (key === 'remarks') field.rows = 2;
      else field.type = 'text';
      field.className = 'report-field-input';
      field.value = draft.fields[key] ?? '';
      field.addEventListener('input', () => {
        draft.fields[key] = field.value;
        if (key === 'location') locationLocked = true;
      });
      label.append(field);
      fieldsSection.append(label);
    });
  }

  typeSelect.addEventListener('change', () => {
    draft.report_type = typeSelect.value;
    draft.fields = Object.fromEntries(
      Object.entries(draft.fields).filter(([key]) =>
        FIELDS_BY_TYPE[draft.report_type].includes(key),
      ),
    );
    fieldsSection.hidden = draft.report_type === 'free';
    renderFields();
  });

  fieldsSection.hidden = draft.report_type === 'free';
  renderFields();
  renderSidc();

  function getValue() {
    const point = location.getValue();
    return {
      report_type: draft.report_type,
      text: textArea.value.trim(),
      fields: draft.report_type === 'free' ? {} : { ...draft.fields },
      sidc: draft.sidc,
      lon: point ? point.lon : null,
      lat: point ? point.lat : null,
    };
  }

  function setDisabled(disabled) {
    typeSelect.disabled = disabled;
    textArea.disabled = disabled;
    sidcButton.disabled = disabled;
    sidcClear.disabled = disabled || !draft.sidc;
    fieldsSection.querySelectorAll('input, textarea').forEach((field) => {
      field.disabled = disabled;
    });
    location.setDisabled(disabled);
  }

  function destroy() {
    location.destroy();
  }

  return { element: root, getValue, setDisabled, destroy };
}

// -- Reports tab controller ---------------------------------------------------

/**
 * `ctx`: `{ requestJson, createElement, askText, askConfirm, showError,
 * formatDate, api, evidenceTargets() }` — the shared plumbing `view.js`
 * builds once in `mount()` (see `collection.js`'s identical contract), plus
 * `evidenceTargets()` (view.js-local: needs `state.requirements`/`sirs`).
 */
export function createReportsController(ctx) {
  const { requestJson, createElement: el, askConfirm, showError, api, evidenceTargets } = ctx;

  const data = { reports: [], nais: [], tracks: [] };
  const filters = { type: 'all', nai: 'all' };
  let panel = null;
  let unsubscribe = null;
  let editingId = null;
  let expandedId = null;
  let trackPanelId = null;
  let fieldset = null;
  let formDraft = null;
  let editingRevision = null;
  let skipNextCapture = false;
  let conflict = null;
  let formMeta = { source: '', author: '', occurred_at: '', reliability: 'F', credibility: 6 };
  let formNote = null;

  async function load() {
    const [reports, nais, tracks] = await Promise.all([
      requestJson(`${api}/reports`),
      requestJson(`${api}/nais`),
      requestJson(`${api}/tracks`),
    ]);
    data.reports = reports;
    data.nais = nais;
    data.tracks = tracks;
  }

  function naiLabel(naiId) {
    if (naiId == null) return null;
    return data.nais.find((nai) => nai.id === naiId)?.label ?? `NAI #${naiId}`;
  }

  function captureFormDraft() {
    if (fieldset) formDraft = fieldset.getValue();
  }

  function clearForm({ keepNote = false } = {}) {
    fieldset?.destroy();
    fieldset = null;
    formDraft = null;
    editingRevision = null;
    skipNextCapture = false;
    conflict = null;
    editingId = null;
    formMeta = { source: '', author: '', occurred_at: '', reliability: 'F', credibility: 6 };
    if (!keepNote) formNote = null;
  }

  function startEdit(report) {
    editingId = report.id;
    editingRevision = report.revision;
    formDraft = { ...report, fields: { ...report.fields } };
    skipNextCapture = true;
    conflict = null;
    formMeta = {
      source: report.source ?? '',
      author: report.author ?? '',
      occurred_at: report.occurred_at ? formatDtg(new Date(report.occurred_at).getTime()) : '',
      reliability: report.reliability,
      credibility: report.credibility,
    };
    formNote = null;
    render();
  }

  // -- create/edit form -----------------------------------------------------

  function renderForm(container) {
    if (skipNextCapture) skipNextCapture = false;
    else captureFormDraft();
    fieldset?.destroy();
    fieldset = null;
    const editingReport =
      editingId != null ? data.reports.find((report) => report.id === editingId) : null;
    const section = el('section', 'field-group');
    section.append(
      el(
        'h3',
        null,
        editingReport
          ? `Edit report #${editingReport.id}`
          : editingId != null
            ? `Report #${editingId} unavailable`
            : 'New report',
      ),
    );
    if (!can('analyst') || !hasCell()) {
      section.append(el('p', 'panel-note', 'Analyst role required to add or edit reports.'));
      container.append(section);
      return;
    }

    if (editingId != null && !editingReport) {
      fieldset = createReportFieldset({ initial: formDraft, ariaLabel: 'Report location' });
      fieldset.setDisabled(true);
      section.append(
        el(
          'p',
          'inline-error',
          'This report is no longer available to edit. Your draft is kept below; reload if access returns, or cancel edit.',
        ),
        fieldset.element,
      );
      const unavailableActions = el('div', 'inline-form');
      const reloadButton = el('button', 'text-button', 'Reload latest');
      reloadButton.type = 'button';
      reloadButton.addEventListener('click', async () => {
        try {
          await load();
          const latest = data.reports.find((report) => report.id === editingId);
          if (latest) startEdit(latest);
          else render();
        } catch (error) {
          formNote = error.message;
          render();
        }
      });
      const cancelButton = el('button', 'text-button', 'Cancel edit');
      cancelButton.type = 'button';
      cancelButton.addEventListener('click', () => {
        clearForm();
        render();
      });
      unavailableActions.append(reloadButton, cancelButton);
      section.append(unavailableActions);
      if (formNote) section.append(el('p', 'panel-note', formNote));
      container.append(section);
      return;
    }

    fieldset = createReportFieldset({
      initial: formDraft ?? editingReport,
      ariaLabel: 'Report location',
    });
    section.append(fieldset.element);

    const metaRow = el('div', 'requirement-form');
    const sourceInput = document.createElement('input');
    sourceInput.type = 'text';
    sourceInput.placeholder = 'Source (optional)';
    sourceInput.setAttribute('aria-label', 'Source');
    sourceInput.value = formMeta.source;
    sourceInput.addEventListener('input', () => (formMeta.source = sourceInput.value));
    const authorInput = document.createElement('input');
    authorInput.type = 'text';
    authorInput.placeholder = 'Author (optional)';
    authorInput.setAttribute('aria-label', 'Author');
    authorInput.value = formMeta.author;
    authorInput.addEventListener('input', () => (formMeta.author = authorInput.value));
    const occurredLabel = el('label', 'field-label-inline', 'Occurred (DTG or ISO)');
    const occurredInput = document.createElement('input');
    occurredInput.type = 'text';
    occurredInput.placeholder = '251430ZSEP26';
    occurredInput.value = formMeta.occurred_at;
    occurredInput.addEventListener('input', () => (formMeta.occurred_at = occurredInput.value));
    occurredLabel.append(occurredInput);
    const occurredError = el('p', 'field-error', 'Not a recognized DTG or ISO date.');
    occurredError.setAttribute('role', 'alert');
    occurredError.hidden = true;
    occurredInput.addEventListener('input', () => {
      const text = occurredInput.value.trim();
      occurredError.hidden = !text || parseDtg(text) !== null;
    });
    const reliabilitySelect = document.createElement('select');
    reliabilitySelect.setAttribute('aria-label', 'Reliability');
    appendReliabilityOptions(reliabilitySelect);
    reliabilitySelect.value = formMeta.reliability;
    reliabilitySelect.addEventListener(
      'change',
      () => (formMeta.reliability = reliabilitySelect.value),
    );
    const credibilitySelect = document.createElement('select');
    credibilitySelect.setAttribute('aria-label', 'Credibility');
    appendCredibilityOptions(credibilitySelect);
    credibilitySelect.value = String(formMeta.credibility);
    credibilitySelect.addEventListener('change', () => {
      formMeta.credibility = Number.parseInt(credibilitySelect.value, 10);
    });
    metaRow.append(
      sourceInput,
      authorInput,
      occurredLabel,
      occurredError,
      reliabilitySelect,
      credibilitySelect,
    );
    section.append(metaRow);

    const actions = el('div', 'inline-form');
    const saveButton = el(
      'button',
      'primary-button',
      editingReport ? 'Save changes' : 'Add report',
    );
    saveButton.type = 'button';
    saveButton.addEventListener('click', () =>
      submitForm(section, {
        sourceInput,
        authorInput,
        occurredInput,
        reliabilitySelect,
        credibilitySelect,
      }),
    );
    actions.append(saveButton);
    if (editingReport) {
      const cancelButton = el('button', 'text-button', 'Cancel edit');
      cancelButton.type = 'button';
      cancelButton.addEventListener('click', () => {
        clearForm();
        render();
      });
      actions.append(cancelButton);
    }
    section.append(actions);
    if (conflict) {
      const conflictBox = el('div', 'inline-error', conflict.message);
      const latestButton = el('button', 'text-button', 'Reload latest');
      latestButton.type = 'button';
      latestButton.addEventListener('click', async () => {
        try {
          await load();
          const latest = data.reports.find((report) => report.id === editingId);
          if (latest) startEdit(latest);
          else {
            formNote = 'The report is no longer available.';
            render();
          }
        } catch (error) {
          formNote = error.message;
          render();
        }
      });
      const reapplyButton = el('button', 'text-button', 'Reapply draft to latest');
      reapplyButton.type = 'button';
      reapplyButton.addEventListener('click', async () => {
        captureFormDraft();
        try {
          await load();
          const latest = data.reports.find((report) => report.id === editingId);
          if (!latest) {
            conflict = null;
            formNote = 'The report is no longer available; draft kept but cannot be reapplied.';
            render();
            return;
          }
          editingRevision = latest.revision;
          conflict = null;
          formNote = 'Draft kept against the latest report. Review it, then save again.';
          render();
        } catch (error) {
          formNote = error.message;
          render();
        }
      });
      conflictBox.append(latestButton, reapplyButton);
      section.append(conflictBox);
    }
    if (formNote) section.append(el('p', 'panel-note', formNote));
    container.append(section);
  }

  async function submitForm(container, refs) {
    const values = fieldset.getValue();
    if (!values.text) {
      showError(container, 'Narrative text is required.');
      return;
    }
    const occurredText = refs.occurredInput.value.trim();
    let occurredAtIso = null;
    if (occurredText) {
      const ms = parseDtg(occurredText);
      if (ms === null) {
        showError(container, 'Occurred-at must be a DTG (251430ZSEP26) or ISO date.');
        return;
      }
      occurredAtIso = new Date(ms).toISOString();
    }
    const body = {
      ...(editingId != null ? { revision: editingRevision } : {}),
      text: values.text,
      report_type: values.report_type,
      fields: values.fields,
      sidc: values.sidc,
      lon: values.lon,
      lat: values.lat,
      source: refs.sourceInput.value.trim() || null,
      author: refs.authorInput.value.trim() || null,
      occurred_at: occurredAtIso,
      reliability: refs.reliabilitySelect.value,
      credibility: Number.parseInt(refs.credibilitySelect.value, 10),
    };
    try {
      const saved =
        editingId != null
          ? await requestJson(`${api}/reports/${editingId}`, { method: 'PATCH', body })
          : await requestJson(`${api}/reports`, { method: 'POST', body });
      await load();
      formNote = `Saved. NAI: ${naiLabel(saved.nai_id) ?? 'none matched'}.`;
      clearForm({ keepNote: true });
      render();
    } catch (error) {
      if (error.status === 409 && error.code === 'stale_revision') {
        captureFormDraft();
        conflict = { message: error.message, currentRevision: error.currentRevision };
        render();
        return;
      }
      showError(container, error.message);
    }
  }

  // -- track plotting ---------------------------------------------------------

  function renderTrackPanel(container, report) {
    const panelEl = el('div', 'plot-track-panel');
    panelEl.append(el('h4', null, 'Plot / update track'));
    const select = document.createElement('select');
    select.className = 'plot-track-select';
    select.setAttribute('aria-label', 'Track to plot this report on');
    // C2b: adding a position mutates the existing track, so only offer
    // tracks this cell can edit — "New track…" below stays available
    // regardless, since creating one doesn't need canEdit on anything.
    const editableTracks = data.tracks.filter((track) => canEditClient(track));
    sortTracksByDistance({ lon: report.lon, lat: report.lat }, editableTracks).forEach(
      ({ track, km }) => {
        const label = `${track.designation || track.sidc} \u2014 ${km.toFixed(1)} km \u2014 ${track.status}`;
        const option = new Option(
          label,
          String(track.id),
          track.id === report.track_id,
          track.id === report.track_id,
        );
        select.append(option);
      },
    );
    select.append(new Option('New track\u2026', '__new__', !report.track_id, !report.track_id));

    const newTrackRow = el('div', 'inline-form plot-track-new-row');
    const designationInput = document.createElement('input');
    designationInput.type = 'text';
    designationInput.placeholder = 'Designation (optional)';
    designationInput.setAttribute('aria-label', 'New track designation');
    designationInput.value = report.fields?.unit || '';
    const sidcPreview = el('span', 'report-sidc-preview');
    let newTrackSidc = report.sidc || withAffiliation(DEFAULT_SIDC, 'hostile');
    const renderNewSidc = () => {
      sidcPreview.replaceChildren(symbolElement(newTrackSidc, { size: 24 }, 'New track symbol'));
    };
    const sidcButton = el('button', 'chip-button', 'Symbol\u2026');
    sidcButton.type = 'button';
    sidcButton.addEventListener('click', async () => {
      const picked = await openSymbolPicker({
        initial: newTrackSidc,
        affiliation: 'hostile',
        title: 'New track symbol',
      });
      if (picked) {
        newTrackSidc = picked;
        renderNewSidc();
      }
    });
    renderNewSidc();
    newTrackRow.append(sidcPreview, sidcButton, designationInput);
    newTrackRow.hidden = select.value !== '__new__';
    select.addEventListener('change', () => {
      newTrackRow.hidden = select.value !== '__new__';
    });

    const plotButton = el('button', 'primary-button', 'Plot');
    plotButton.type = 'button';
    plotButton.addEventListener('click', () =>
      plotTrack(
        report,
        select.value,
        { designation: designationInput.value.trim(), sidc: newTrackSidc },
        panelEl,
      ),
    );
    const closeButton = el('button', 'text-button', 'Close');
    closeButton.type = 'button';
    closeButton.addEventListener('click', () => {
      trackPanelId = null;
      render();
    });

    panelEl.append(select, newTrackRow, plotButton, closeButton);
    container.append(panelEl);
  }

  async function plotTrack(report, selectValue, newTrack, container) {
    try {
      if (selectValue === '__new__') {
        const created = await requestJson(`${api}/tracks`, {
          method: 'POST',
          body: {
            sidc: newTrack.sidc,
            designation: newTrack.designation || null,
            status: 'confirmed',
            lon: report.lon,
            lat: report.lat,
            observed_at: report.occurred_at,
          },
        });
        await requestJson(`${api}/tracks/${created.id}/positions`, {
          method: 'POST',
          body: {
            lon: report.lon,
            lat: report.lat,
            observed_at: report.occurred_at,
            report_id: report.id,
          },
        });
      } else {
        const trackId = Number.parseInt(selectValue, 10);
        await requestJson(`${api}/tracks/${trackId}/positions`, {
          method: 'POST',
          body: {
            lon: report.lon,
            lat: report.lat,
            observed_at: report.occurred_at,
            report_id: report.id,
          },
        });
      }
      trackPanelId = null;
      await load();
      render();
    } catch (error) {
      showError(container, error.message);
    }
  }

  // -- evidence linking ---------------------------------------------------------

  function renderEvidenceSection(container, report) {
    const section = el('div', 'evidence-section');
    const targets = evidenceTargets();
    const linkList = el('ul', 'evidence-list');
    report.links.forEach((link) => {
      const targetOption = targets.find(
        (option) => option.kind === link.target_kind && option.id === link.target_id,
      );
      const item = el('li', 'evidence-item');
      item.append(
        el('span', `relation-badge relation-${link.relation}`, link.relation),
        el(
          'span',
          null,
          targetOption ? targetOption.label : `${link.target_kind} #${link.target_id}`,
        ),
      );
      // C2b: deleting a link needs canEdit on its target, not the report —
      // an invisible target (not in `targets`) is never editable either.
      const canEditTarget =
        Boolean(targetOption) && canEditClient({ owner_cell: targetOption.owner_cell });
      if (can('analyst') && canEditTarget) {
        const remove = el('button', 'icon-button danger', '\u00d7');
        remove.type = 'button';
        remove.title = 'Remove evidence link';
        remove.setAttribute('aria-label', 'Remove evidence link');
        remove.addEventListener('click', async () => {
          // Evidence links are parts of the requirement they support
          // (CONTEXT.md), addressed flat under it.
          await requestJson(`${api}/requirements/${link.requirement_id}/evidence/${link.id}`, {
            method: 'DELETE',
            body: { revision: targetOption.revision },
          });
          await load();
          render();
        });
        item.append(remove);
      }
      linkList.append(item);
    });
    section.append(linkList);

    // C2b: creating a link changes its target, so the picker only offers
    // targets this cell can edit (canSee(report) alone isn't enough) — a
    // requirement/SIR merely released for reading never appears here.
    const editableTargets = targets.filter((option) =>
      canEditClient({ owner_cell: option.owner_cell }),
    );
    if (can('analyst') && editableTargets.length) {
      const form = el('div', 'inline-form');
      const targetSelect = document.createElement('select');
      targetSelect.setAttribute('aria-label', 'Evidence target');
      editableTargets.forEach((option) =>
        targetSelect.append(new Option(option.label, `${option.kind}:${option.id}`)),
      );
      const relationSelect = document.createElement('select');
      relationSelect.setAttribute('aria-label', 'Relation');
      EVIDENCE_RELATIONS.forEach((relation) =>
        relationSelect.append(new Option(relation, relation)),
      );
      const noteInput = document.createElement('input');
      noteInput.type = 'text';
      noteInput.placeholder = 'Note (optional)';
      noteInput.setAttribute('aria-label', 'Evidence link note');
      const linkButton = el('button', 'chip-button', 'Link evidence');
      linkButton.type = 'button';
      linkButton.addEventListener('click', async () => {
        const [kind, id] = targetSelect.value.split(':');
        const targetOption = editableTargets.find(
          (option) => option.kind === kind && String(option.id) === id,
        );
        try {
          // Evidence links are parts of the requirement they support
          // (CONTEXT.md): `:item` is that requirement, whether the link is
          // blanket (`target_kind: 'requirement'`) or against one of its SIRs.
          await requestJson(`${api}/requirements/${targetOption.requirement_id}/evidence`, {
            method: 'POST',
            body: {
              report_id: report.id,
              target_kind: kind,
              target_id: Number.parseInt(id, 10),
              relation: relationSelect.value,
              note: noteInput.value.trim() || null,
              revision: targetOption.revision,
            },
          });
          await load();
          render();
        } catch (error) {
          showError(form, error.message);
        }
      });
      form.append(targetSelect, relationSelect, noteInput, linkButton);
      section.append(form);
    } else if (can('analyst') && !targets.length) {
      section.append(el('p', 'panel-note', 'Create a requirement or SIR to link evidence.'));
    } else if (can('analyst')) {
      section.append(
        el('p', 'panel-note', 'No requirement or SIR your cell can edit to link evidence to.'),
      );
    }
    container.append(section);
  }

  // -- list: filters + table -----------------------------------------------------

  function filteredReports() {
    return data.reports.filter((report) => {
      if (filters.type !== 'all' && report.report_type !== filters.type) return false;
      if (filters.nai === '__none__') return report.nai_id == null;
      if (filters.nai !== 'all') return report.nai_id === Number.parseInt(filters.nai, 10);
      return true;
    });
  }

  function renderFilters(container) {
    const bar = el('div', 'report-filters');
    const typeLabel = el('label', 'field-label-inline', 'Type');
    const typeSelect = document.createElement('select');
    typeSelect.append(new Option('All types', 'all'));
    REPORT_TYPES.forEach((type) => typeSelect.append(new Option(REPORT_TYPE_LABEL[type], type)));
    typeSelect.value = filters.type;
    typeSelect.addEventListener('change', () => {
      filters.type = typeSelect.value;
      render();
    });
    typeLabel.append(typeSelect);

    const naiLabelEl = el('label', 'field-label-inline', 'NAI');
    const naiSelect = document.createElement('select');
    naiSelect.append(new Option('All NAIs', 'all'), new Option('No NAI', '__none__'));
    data.nais.forEach((nai) => naiSelect.append(new Option(nai.label, String(nai.id))));
    naiSelect.value = filters.nai;
    naiSelect.addEventListener('change', () => {
      filters.nai = naiSelect.value;
      render();
    });
    naiLabelEl.append(naiSelect);

    bar.append(typeLabel, naiLabelEl);
    container.append(bar);
  }

  function renderReportRow(report) {
    const row = document.createElement('tr');
    row.className = 'report-row';
    const toggleCell = document.createElement('td');
    const expanded = expandedId === report.id;
    const toggleButton = el(
      'button',
      'text-button report-row-toggle',
      expanded ? '\u25be' : '\u25b8',
    );
    toggleButton.type = 'button';
    toggleButton.setAttribute('aria-expanded', String(expanded));
    toggleButton.setAttribute(
      'aria-label',
      expanded ? 'Collapse report details' : 'Expand report details',
    );
    toggleButton.addEventListener('click', () => {
      expandedId = expanded ? null : report.id;
      if (expandedId !== report.id) trackPanelId = null;
      render();
    });
    toggleCell.append(toggleButton);
    row.append(toggleCell);
    row.append(el('td', null, REPORT_TYPE_LABEL[report.report_type]));
    row.append(
      el('td', null, formatDtg(new Date(report.occurred_at || report.created_at).getTime())),
    );
    row.append(el('td', null, report.lon != null ? formatMgrs(report.lon, report.lat) : '\u2014'));
    row.append(el('td', null, naiLabel(report.nai_id) ?? '\u2014'));
    const cellCell = document.createElement('td');
    cellCell.append(renderCellBadge(report.owner_cell));
    row.append(cellCell);
    const admiraltyCell = document.createElement('td');
    admiraltyCell.append(
      el('span', 'admiralty-badge', `${report.reliability}${report.credibility}`),
    );
    row.append(admiraltyCell);
    const actionsCell = document.createElement('td');
    const actions = el('div', 'row-actions');
    // C2b: release grants read only, so Edit/Track/Delete need canEditClient
    // on top of the analyst role — a cell this report was only released to
    // still sees it in the list, but never these controls.
    if (can('analyst') && canEditClient(report)) {
      const editButton = el('button', 'icon-button', 'Edit');
      editButton.type = 'button';
      editButton.addEventListener('click', () => startEdit(report));
      actions.append(editButton);
      if (report.lon != null) {
        const trackButton = el('button', 'icon-button', 'Track');
        trackButton.type = 'button';
        trackButton.addEventListener('click', () => {
          expandedId = report.id;
          trackPanelId = trackPanelId === report.id ? null : report.id;
          render();
        });
        actions.append(trackButton);
      }
      const deleteButton = el('button', 'icon-button danger', 'Delete');
      deleteButton.type = 'button';
      deleteButton.addEventListener('click', () => deleteReport(report));
      actions.append(deleteButton);
    }
    actionsCell.append(actions);
    row.append(actionsCell);
    return row;
  }

  async function releaseReport(report, cells) {
    await requestJson(`${api}/reports/${report.id}/release`, {
      method: 'POST',
      body: { cells, revision: report.revision },
    });
    await load();
    render();
  }

  async function reassignReportOwner(report, ownerCell) {
    await requestJson(`${api}/reports/${report.id}/owner`, {
      method: 'PATCH',
      body: { owner_cell: ownerCell, revision: report.revision },
    });
    await load();
    render();
  }

  function renderDetailRow(report) {
    const row = document.createElement('tr');
    row.className = 'report-detail-row';
    const cell = document.createElement('td');
    cell.colSpan = 8;
    cell.append(
      renderReleaseControl({ item: report, onRelease: (cells) => releaseReport(report, cells) }),
    );
    appendOwnerReassign(cell, report.owner_cell, (ownerCell) =>
      reassignReportOwner(report, ownerCell),
    );
    cell.append(el('p', null, report.text));
    const fieldKeys = FIELDS_BY_TYPE[report.report_type];
    if (fieldKeys.length) {
      const dl = el('dl', 'report-fields-summary');
      fieldKeys.forEach((key) => {
        if (!report.fields[key]) return;
        dl.append(el('dt', null, FIELD_LABEL[key]), el('dd', null, report.fields[key]));
      });
      if (dl.children.length) cell.append(dl);
    }
    if (report.sidc) {
      const sidcRow = el('div', 'report-sidc-row');
      sidcRow.append(symbolElement(report.sidc, { size: 24 }, 'Reported unit symbol'));
      cell.append(sidcRow);
    }
    cell.append(
      el(
        'p',
        'panel-note',
        `Source: ${report.source || '\u2014'} \u00b7 Author: ${report.author || '\u2014'}`,
      ),
    );
    if (report.track_id != null) {
      const track = data.tracks.find((entry) => entry.id === report.track_id);
      cell.append(
        el(
          'p',
          'panel-note',
          `Linked track: ${track ? track.designation || track.sidc : `#${report.track_id}`}`,
        ),
      );
    }
    renderEvidenceSection(cell, report);
    if (trackPanelId === report.id) renderTrackPanel(cell, report);
    row.append(cell);
    return row;
  }

  async function deleteReport(report) {
    if (!(await askConfirm('Delete this report and its evidence links?'))) return;
    if (editingId === report.id) clearForm();
    await requestJson(`${api}/reports/${report.id}`, {
      method: 'DELETE',
      body: { revision: report.revision },
    });
    await load();
    render();
  }

  function renderTable(reports) {
    const table = document.createElement('table');
    table.className = 'data-table report-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['', 'Type', 'DTG', 'MGRS', 'NAI', 'Cell', 'Admiralty', 'Actions'].forEach((label) =>
      headRow.append(el('th', null, label)),
    );
    thead.append(headRow);
    table.append(thead);
    const tbody = document.createElement('tbody');
    reports.forEach((report) => {
      tbody.append(renderReportRow(report));
      if (expandedId === report.id) tbody.append(renderDetailRow(report));
    });
    table.append(tbody);
    return table;
  }

  function render() {
    if (!panel) return;
    panel.replaceChildren();
    panel.append(el('h2', null, 'Reports & evidence'));
    renderForm(panel);
    renderFilters(panel);
    const filtered = filteredReports();
    if (!filtered.length) {
      panel.append(
        el(
          'p',
          'panel-note',
          data.reports.length ? 'No reports match the filters.' : 'No reports yet.',
        ),
      );
      return;
    }
    panel.append(renderTable(filtered));
  }

  async function enter(container) {
    panel = container;
    panel.replaceChildren(el('p', 'panel-note', 'Loading reports\u2026'));
    try {
      await load();
    } catch (error) {
      if (error.name === 'AbortError') return;
      panel.replaceChildren(el('p', 'inline-error', error.message));
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
    fieldset?.destroy();
    fieldset = null;
    panel = null;
  }

  return { enter, leave };
}
