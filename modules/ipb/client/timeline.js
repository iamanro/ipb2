/**
 * Time (item 6, IPB side): the study's H-hour, phases, decision points, each
 * event's planned time (DTG or H±offset, replacing the dropped free-text
 * `expected_time` column), and a timeline strip with a "now" marker from the
 * scenario clock.
 *
 * Pure layout/sort helpers (`sortEventGroups`, `timelineDomain`,
 * `layoutTimeline`, `scenarioNowMs`) take plain data and are unit tested.
 * Everything else is DOM glue reaching into `./view.js`'s shared internals —
 * see the comment above its export block.
 */
import { formatDtg, formatHOffset, parseDtg, parseHOffset, parsePlannedTime, resolveTime } from '../../../src/dtg.js';
import { subscribe } from '../../../src/live.js';
import { can } from '../../../src/session.js';
import {
  API,
  EXERCISE_API,
  askConfirm,
  askText,
  bindDebouncedCommit,
  canEditStudy,
  createElement,
  editable,
  elements,
  renderReorderButtons,
  renderStep4Worksheet,
  requestJson,
  showError,
  state,
} from './view.js';

// -- pure: the scenario clock -------------------------------------------------

/**
 * Mirrors `modules/exercise/server/scenarioClock.js`'s `scenarioNowMs`
 * exactly (duplicated, not imported: that file lives in another module's
 * server tree, and this pure formula is small enough to keep a client copy
 * in sync by inspection). Scenario time is `base_scenario_ts` plus elapsed
 * real time since `base_real_ts`, scaled by `rate`; frozen when paused.
 */
export function scenarioNowMs(clock, realNow = Date.now()) {
  const baseScenario = new Date(clock.base_scenario_ts).getTime();
  if (clock.paused) return baseScenario;
  const baseReal = new Date(clock.base_real_ts).getTime();
  return baseScenario + (realNow - baseReal) * clock.rate;
}

// -- pure: sorting and layout -------------------------------------------------

/** The earliest resolved time among a matrix row's per-COA events, or
 * `Infinity` when none resolve (sorts last). */
function earliestGroupMs(group, hHour) {
  let min = Infinity;
  for (const event of group.events.values()) {
    const ms = resolveTime({ at: event.expected_at, offset: event.expected_offset }, hHour);
    if (Number.isFinite(ms)) min = Math.min(min, ms);
  }
  return min;
}

/** The event matrix's rows, earliest resolved time first; unresolved rows
 * last, in their original relative order (stable). */
export function sortEventGroups(groups, hHour) {
  return groups
    .map((group, index) => ({ group, index, ms: earliestGroupMs(group, hHour) }))
    .sort((a, b) => a.ms - b.ms || a.index - b.index)
    .map((entry) => entry.group);
}

/** Every phase/event/DP/now time that resolves, padded 8% (floor 15 min)
 * each side; falls back to now ± 1 h when nothing resolves at all. */
export function timelineDomain({ phases, events, decisionPoints, hHour, nowMs }) {
  const times = [];
  const push = (ms) => {
    if (Number.isFinite(ms)) times.push(ms);
  };
  for (const phase of phases) {
    push(resolveTime({ offset: phase.start_offset }, hHour));
    if (phase.end_offset != null) push(resolveTime({ offset: phase.end_offset }, hHour));
  }
  for (const event of events) {
    push(resolveTime({ at: event.expected_at, offset: event.expected_offset }, hHour));
  }
  for (const dp of decisionPoints) {
    push(resolveTime({ at: dp.earliest_at, offset: dp.earliest_offset }, hHour));
    push(resolveTime({ at: dp.latest_at, offset: dp.latest_offset }, hHour));
  }
  if (Number.isFinite(nowMs)) push(nowMs);
  if (!times.length) {
    const base = Number.isFinite(nowMs) ? nowMs : Date.now();
    return [base - 3_600_000, base + 3_600_000];
  }
  const min = Math.min(...times);
  const max = Math.max(...times);
  const span = Math.max(max - min, 60_000);
  const pad = Math.max(span * 0.08, 15 * 60_000);
  return [min - pad, max + pad];
}

/**
 * A pure pixel layout for the timeline SVG: phase bands, one row per COA
 * with its events as points, and decision points as a diamond (+ an
 * earliest–latest window bar when both ends resolve) in their own lane.
 * `xScale` is exposed so the caller can place a "now" line the same way.
 */
export function layoutTimeline({
  domain,
  width,
  coas,
  phases,
  events,
  decisionPoints,
  hHour,
  rowHeight = 28,
  phaseBandHeight = 20,
  dpLaneHeight = 24,
}) {
  const [minMs, maxMs] = domain;
  const span = Math.max(1, maxMs - minMs);
  const xScale = (ms) => ((ms - minMs) / span) * width;
  const clampX = (x) => Math.min(width, Math.max(0, x));

  const phaseBands = phases
    .map((phase) => {
      const startMs = resolveTime({ offset: phase.start_offset }, hHour);
      if (startMs == null) return null;
      const endMs = phase.end_offset != null ? resolveTime({ offset: phase.end_offset }, hHour) : maxMs;
      const x = clampX(xScale(startMs));
      const endX = clampX(xScale(endMs ?? maxMs));
      return { id: phase.id, name: phase.name, x, width: Math.max(1, endX - x) };
    })
    .filter(Boolean);

  const dpLaneY = phaseBandHeight;
  const dpLaneUsed = decisionPoints.length > 0;
  const dps = decisionPoints
    .map((dp) => {
      const earliestMs = resolveTime({ at: dp.earliest_at, offset: dp.earliest_offset }, hHour);
      const latestMs = resolveTime({ at: dp.latest_at, offset: dp.latest_offset }, hHour);
      const anchorMs = earliestMs ?? latestMs;
      if (anchorMs == null) return null;
      return {
        id: dp.id,
        name: dp.name,
        x: clampX(xScale(anchorMs)),
        xStart: earliestMs != null ? clampX(xScale(earliestMs)) : null,
        xEnd: latestMs != null ? clampX(xScale(latestMs)) : null,
        y: dpLaneY + dpLaneHeight / 2,
      };
    })
    .filter(Boolean);

  const rowsTop = dpLaneY + (dpLaneUsed ? dpLaneHeight : 0);
  const rows = coas.map((coa, index) => {
    const y = rowsTop + index * rowHeight + rowHeight / 2;
    const rowEvents = events
      .filter((event) => String(event.coa_id) === String(coa.id))
      .map((event) => {
        const ms = resolveTime({ at: event.expected_at, offset: event.expected_offset }, hHour);
        if (ms == null) return null;
        return { id: event.id, indicator: event.indicator, naiFeatureId: event.nai_feature_id, x: clampX(xScale(ms)) };
      })
      .filter(Boolean);
    return { coaId: coa.id, coaName: coa.name, y, events: rowEvents };
  });

  const height = rowsTop + Math.max(1, coas.length) * rowHeight + 8;
  return { width, height, xScale, phaseBands, decisionPoints: dps, rows, rowsTop };
}

// -- H-hour ------------------------------------------------------------------

async function commitHHour(study, text) {
  if (!(can('analyst') && canEditStudy())) return true;
  if (!text) {
    const updated = await requestJson(`${API}/studies/${study.id}`, {
      method: 'PATCH',
      body: { h_hour: null },
    });
    study.h_hour = updated.h_hour;
    return true;
  }
  const at = parseDtg(text);
  if (at === null) return false;
  const updated = await requestJson(`${API}/studies/${study.id}`, {
    method: 'PATCH',
    body: { h_hour: new Date(at).toISOString() },
  });
  study.h_hour = updated.h_hour;
  return true;
}

export function renderHHourField(study, { canEdit }) {
  const group = createElement('div', 'field-group');
  group.append(createElement('h3', null, 'H-hour'));
  const row = createElement('div', 'inline-form');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'DTG or ISO, e.g. 251430ZSEP26';
  input.value = study.h_hour ? formatDtg(new Date(study.h_hour).getTime()) : '';
  if (!canEdit) editable(input);
  const error = createElement('p', 'inline-error');
  error.hidden = true;
  const commit = async () => {
    const text = input.value.trim();
    try {
      const ok = await commitHHour(study, text);
      if (!ok) {
        error.hidden = false;
        error.textContent = `Could not read "${text}" as a DTG or ISO time.`;
        return;
      }
      error.hidden = true;
      input.value = study.h_hour ? formatDtg(new Date(study.h_hour).getTime()) : '';
      renderStep4Worksheet();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message;
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commit();
  });
  input.addEventListener('blur', commit);
  row.append(input);
  group.append(row, error);
  return group;
}

// -- H±offset input (phases) --------------------------------------------------

/** A text input reading/writing an H±offset in minutes; `allowEmpty` lets it
 * clear back to null (phases' optional `end_offset`). */
function offsetField(value, onCommit, { allowEmpty = false, placeholder } = {}) {
  const wrap = document.createElement('span');
  wrap.className = 'offset-field';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder || 'H+0:00';
  input.value = value != null ? formatHOffset(value) : '';
  const error = createElement('p', 'inline-error');
  error.hidden = true;
  const commit = async () => {
    const text = input.value.trim();
    if (!text) {
      if (!allowEmpty) {
        error.hidden = false;
        error.textContent = 'An offset is required.';
        return;
      }
      error.hidden = true;
      await onCommit(null);
      return;
    }
    const minutes = parseHOffset(text);
    if (minutes === null) {
      error.hidden = false;
      error.textContent = `Could not read "${text}" as an H±offset.`;
      return;
    }
    error.hidden = true;
    await onCommit(minutes);
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commit();
  });
  input.addEventListener('blur', commit);
  wrap.append(input, error);
  return wrap;
}

// -- phases --------------------------------------------------------------------

async function patchPhase(phase, body) {
  if (!(can('analyst') && canEditStudy())) return;
  try {
    Object.assign(phase, await requestJson(`${API}/phases/${phase.id}`, { method: 'PATCH', body }));
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

async function deletePhase(phase) {
  if (!(can('analyst') && canEditStudy())) return;
  if (!(await askConfirm(`Delete phase "${phase.name}"?`))) return;
  try {
    await requestJson(`${API}/phases/${phase.id}`, { method: 'DELETE' });
    state.study.phases = state.study.phases.filter((entry) => entry.id !== phase.id);
    renderStep4Worksheet();
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

async function addPhase() {
  if (!(can('analyst') && canEditStudy())) return;
  const name = await askText('Phase name', '', 'Add');
  if (!name) return;
  try {
    const phase = await requestJson(`${API}/studies/${state.studyId}/phases`, {
      method: 'POST',
      body: { name, start_offset: 0 },
    });
    state.study.phases.push(phase);
    renderStep4Worksheet();
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

function renderPhaseRow(phase, index, total, canEdit) {
  const row = document.createElement('tr');
  const nameCell = document.createElement('td');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = phase.name;
  if (!canEdit) editable(nameInput);
  bindDebouncedCommit(nameInput, `phase:${phase.id}:name`, (value) => {
    if (value.trim()) patchPhase(phase, { name: value.trim() });
  });
  nameCell.append(nameInput);
  row.append(nameCell);

  const startCell = document.createElement('td');
  const startField = offsetField(phase.start_offset, (minutes) => patchPhase(phase, { start_offset: minutes }));
  if (!canEdit) editable(startField.querySelector('input'));
  startCell.append(startField);
  row.append(startCell);

  const endCell = document.createElement('td');
  const endField = offsetField(
    phase.end_offset,
    (minutes) => patchPhase(phase, { end_offset: minutes }),
    { allowEmpty: true, placeholder: 'open' },
  );
  if (!canEdit) editable(endField.querySelector('input'));
  endCell.append(endField);
  row.append(endCell);

  const actionsCell = document.createElement('td');
  if (canEdit) {
    actionsCell.append(renderReorderButtons('phases', phase, index, total, elements.worksheet4, renderStep4Worksheet));
    const del = createElement('button', 'icon-button danger', 'Delete');
    del.type = 'button';
    del.addEventListener('click', () => deletePhase(phase));
    actionsCell.append(del);
  }
  row.append(actionsCell);
  return row;
}

export function renderPhasesSection(canEdit) {
  const section = createElement('section', 'worksheet-block');
  const heading = createElement('div', 'custom-layers-header');
  heading.append(createElement('h4', null, 'Phases'));
  if (canEdit) {
    const add = createElement('button', 'text-button', '+ Add phase');
    add.type = 'button';
    add.addEventListener('click', addPhase);
    heading.append(add);
  }
  section.append(heading);
  const phases = state.study.phases ?? [];
  if (!phases.length) {
    section.append(createElement('p', 'panel-note', 'No phases yet.'));
    return section;
  }
  const table = document.createElement('table');
  table.className = 'data-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Name', 'Start (H±)', 'End (H±)', ''].forEach((label) => headRow.append(createElement('th', null, label)));
  head.append(headRow);
  const body = document.createElement('tbody');
  phases.forEach((phase, index) => body.append(renderPhaseRow(phase, index, phases.length, canEdit)));
  table.append(head, body);
  section.append(table);
  return section;
}

// -- decision points ------------------------------------------------------------

async function patchDecisionPoint(dp, body) {
  if (!(can('analyst') && canEditStudy())) return;
  try {
    Object.assign(dp, await requestJson(`${API}/decision-points/${dp.id}`, { method: 'PATCH', body }));
    renderStep4Worksheet();
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

async function deleteDecisionPoint(dp) {
  if (!(can('analyst') && canEditStudy())) return;
  if (!(await askConfirm(`Delete decision point "${dp.name}"?`))) return;
  try {
    await requestJson(`${API}/decision-points/${dp.id}`, { method: 'DELETE' });
    state.study.decision_points = state.study.decision_points.filter((entry) => entry.id !== dp.id);
    renderStep4Worksheet();
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

async function addDecisionPoint() {
  if (!(can('analyst') && canEditStudy())) return;
  const name = await askText('Decision point name', '', 'Add');
  if (!name) return;
  try {
    const dp = await requestJson(`${API}/studies/${state.studyId}/decision-points`, {
      method: 'POST',
      body: { name },
    });
    state.study.decision_points.push(dp);
    renderStep4Worksheet();
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

function selectField(label, value, options, onChange, disabled) {
  const wrap = createElement('label', 'field-label');
  wrap.append(document.createTextNode(label));
  const select = document.createElement('select');
  select.disabled = disabled;
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '—';
  select.append(blank);
  options.forEach(([optValue, text]) => {
    const option = document.createElement('option');
    option.value = String(optValue);
    option.textContent = text;
    if (String(value ?? '') === String(optValue)) option.selected = true;
    select.append(option);
  });
  select.addEventListener('change', () => onChange(select.value || null));
  wrap.append(select);
  return wrap;
}

/** A DTG-or-H±offset text field bound to an `{at, offset}` pair; empty clears both. */
function plannedTimeField(label, at, offset, onChange, disabled) {
  const wrap = createElement('label', 'field-label');
  wrap.append(document.createTextNode(label));
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'DTG or H±offset';
  input.disabled = disabled;
  input.value = at ? formatDtg(new Date(at).getTime()) : offset != null ? formatHOffset(offset) : '';
  const error = createElement('p', 'inline-error');
  error.hidden = true;
  const commit = async () => {
    const text = input.value.trim();
    if (!text) {
      error.hidden = true;
      await onChange({ at: null, offset: null });
      return;
    }
    const planned = parsePlannedTime(text);
    if (!planned) {
      error.hidden = false;
      error.textContent = `Could not read "${text}" as a DTG or H±offset.`;
      return;
    }
    error.hidden = true;
    await onChange(
      'at' in planned
        ? { at: new Date(planned.at).toISOString(), offset: null }
        : { at: null, offset: planned.offset },
    );
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commit();
  });
  input.addEventListener('blur', commit);
  wrap.append(input, error);
  return wrap;
}

function renderDecisionPointCard(dp, index, total, canEdit) {
  const card = createElement('article', 'coa-card dp-card');
  const header = createElement('div', 'coa-card-header');
  header.append(createElement('span', 'coa-kind', `Decision point ${index + 1}`));
  if (canEdit) {
    header.append(renderReorderButtons('decision-points', dp, index, total, elements.worksheet4, renderStep4Worksheet));
    const del = createElement('button', 'icon-button danger', 'Delete');
    del.type = 'button';
    del.addEventListener('click', () => deleteDecisionPoint(dp));
    header.append(del);
  }
  card.append(header);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'coa-name-input';
  nameInput.value = dp.name;
  nameInput.disabled = !canEdit;
  bindDebouncedCommit(nameInput, `dp:${dp.id}:name`, (value) => {
    if (value.trim()) patchDecisionPoint(dp, { name: value.trim() });
  });
  card.append(nameInput);

  const grid = createElement('div', 'dp-field-grid');
  grid.append(
    selectField(
      'COA',
      dp.coa_id,
      state.study.coas.map((coa) => [coa.id, coa.name]),
      (value) => patchDecisionPoint(dp, { coa_id: value ? Number(value) : null }),
      !canEdit,
    ),
    selectField(
      'NAI',
      dp.nai_feature_id,
      state.study.features.filter((f) => f.layer === 'nai').map((f) => [f.id, f.label]),
      (value) => patchDecisionPoint(dp, { nai_feature_id: value ? Number(value) : null }),
      !canEdit,
    ),
    selectField(
      'TAI',
      dp.tai_feature_id,
      state.study.features.filter((f) => f.layer === 'tai').map((f) => [f.id, f.label]),
      (value) => patchDecisionPoint(dp, { tai_feature_id: value ? Number(value) : null }),
      !canEdit,
    ),
    plannedTimeField(
      'Earliest',
      dp.earliest_at,
      dp.earliest_offset,
      (value) => patchDecisionPoint(dp, { earliest_at: value.at, earliest_offset: value.offset }),
      !canEdit,
    ),
    plannedTimeField(
      'Latest',
      dp.latest_at,
      dp.latest_offset,
      (value) => patchDecisionPoint(dp, { latest_at: value.at, latest_offset: value.offset }),
      !canEdit,
    ),
  );
  card.append(grid);

  card.append(createElement('label', 'field-label', 'Description'));
  const description = document.createElement('textarea');
  description.rows = 2;
  description.value = dp.description || '';
  description.disabled = !canEdit;
  bindDebouncedCommit(description, `dp:${dp.id}:description`, (value) => patchDecisionPoint(dp, { description: value || null }));
  card.append(description);

  card.append(createElement('label', 'field-label', 'Decision'));
  const decision = document.createElement('textarea');
  decision.rows = 2;
  decision.value = dp.decision || '';
  decision.disabled = !canEdit;
  bindDebouncedCommit(decision, `dp:${dp.id}:decision`, (value) => patchDecisionPoint(dp, { decision: value || null }));
  card.append(decision);

  return card;
}

export function renderDecisionPointsSection(canEdit) {
  const section = createElement('section', 'worksheet-block');
  const heading = createElement('div', 'custom-layers-header');
  heading.append(createElement('h4', null, 'Decision points'));
  if (canEdit) {
    const add = createElement('button', 'text-button', '+ Add decision point');
    add.type = 'button';
    add.addEventListener('click', addDecisionPoint);
    heading.append(add);
  }
  section.append(heading);
  const dps = state.study.decision_points ?? [];
  if (!dps.length) {
    section.append(createElement('p', 'panel-note', 'No decision points yet.'));
    return section;
  }
  const cards = createElement('div', 'coa-cards');
  dps.forEach((dp, index) => cards.append(renderDecisionPointCard(dp, index, dps.length, canEdit)));
  section.append(cards);
  return section;
}

// -- per-event planned time (matrix cells) ---------------------------------------

/** A self-contained `<dialog>` (own class names, no shared dialog-node
 * coupling needed since it only adds a `<select>`, which the shared
 * `askFields` doesn't support): time, TAI, decision point, note. */
function openEventEditor({ event, tais, decisionPoints, hHour }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'workspace-dialog event-editor-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    const message = createElement('p', 'dialog-message', `${event.indicator}`);
    form.append(message);

    const fields = createElement('div', 'dialog-fields');
    const timeLabel = createElement('label', 'dialog-field');
    timeLabel.append(createElement('span', null, 'Time (DTG or H±offset)'));
    const timeInput = document.createElement('input');
    timeInput.className = 'dialog-input';
    timeInput.type = 'text';
    timeInput.value = event.expected_at
      ? formatDtg(new Date(event.expected_at).getTime())
      : event.expected_offset != null
        ? formatHOffset(event.expected_offset)
        : '';
    timeLabel.append(timeInput);
    const timeError = createElement('p', 'inline-error');
    timeError.hidden = true;
    fields.append(timeLabel, timeError);

    const taiLabel = createElement('label', 'dialog-field');
    taiLabel.append(createElement('span', null, 'TAI'));
    const taiSelect = document.createElement('select');
    taiSelect.className = 'dialog-input';
    const taiNone = document.createElement('option');
    taiNone.value = '';
    taiNone.textContent = '— none —';
    taiSelect.append(taiNone);
    tais.forEach((tai) => {
      const option = document.createElement('option');
      option.value = String(tai.id);
      option.textContent = tai.label;
      if (String(event.tai_feature_id) === String(tai.id)) option.selected = true;
      taiSelect.append(option);
    });
    taiLabel.append(taiSelect);
    fields.append(taiLabel);

    const dpLabel = createElement('label', 'dialog-field');
    dpLabel.append(createElement('span', null, 'Decision point'));
    const dpSelect = document.createElement('select');
    dpSelect.className = 'dialog-input';
    const dpNone = document.createElement('option');
    dpNone.value = '';
    dpNone.textContent = '— none —';
    dpSelect.append(dpNone);
    decisionPoints.forEach((dp) => {
      const option = document.createElement('option');
      option.value = String(dp.id);
      option.textContent = dp.name;
      if (String(event.decision_point_id) === String(dp.id)) option.selected = true;
      dpSelect.append(option);
    });
    dpLabel.append(dpSelect);
    fields.append(dpLabel);

    const noteLabel = createElement('label', 'dialog-field');
    noteLabel.append(createElement('span', null, 'Note'));
    const noteInput = document.createElement('textarea');
    noteInput.className = 'dialog-input';
    noteInput.rows = 2;
    noteInput.value = event.note || '';
    noteLabel.append(noteInput);
    fields.append(noteLabel);

    form.append(fields);

    const actions = createElement('div', 'dialog-actions');
    const cancel = createElement('button', 'text-button', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      dialog.returnValue = 'cancel';
      dialog.close();
    });
    const accept = createElement('button', 'dialog-accept', 'Save');
    accept.type = 'submit';
    actions.append(cancel, accept);
    form.append(actions);

    dialog.append(form);
    document.body.append(dialog);

    let pending = null;
    form.addEventListener('submit', (submitEvent) => {
      const text = timeInput.value.trim();
      let time = { at: null, offset: null };
      if (text) {
        const planned = parsePlannedTime(text);
        if (!planned) {
          submitEvent.preventDefault();
          timeError.hidden = false;
          timeError.textContent = `Could not read "${text}" as a DTG or H±offset.`;
          return;
        }
        time = 'at' in planned ? { at: new Date(planned.at).toISOString(), offset: null } : { at: null, offset: planned.offset };
      }
      pending = {
        expected_at: time.at,
        expected_offset: time.offset,
        tai_feature_id: taiSelect.value ? Number(taiSelect.value) : null,
        decision_point_id: dpSelect.value ? Number(dpSelect.value) : null,
        note: noteInput.value || null,
      };
      dialog.returnValue = 'accept';
    });

    dialog.addEventListener(
      'close',
      () => {
        const result = dialog.returnValue === 'accept' ? pending : null;
        dialog.remove();
        resolve(result);
      },
      { once: true },
    );

    dialog.showModal();
    timeInput.focus();
    void hHour; // reserved: a future revision may show "resolves to <DTG>" live
  });
}

async function openEventEditorFor(event) {
  if (!(can('analyst') && canEditStudy())) return;
  const tais = state.study.features.filter((feature) => feature.layer === 'tai');
  const decisionPoints = state.study.decision_points ?? [];
  const result = await openEventEditor({ event, tais, decisionPoints, hHour: state.study.study.h_hour });
  if (!result) return;
  try {
    Object.assign(event, await requestJson(`${API}/events/${event.id}`, { method: 'PATCH', body: result }));
    renderStep4Worksheet();
  } catch (error) {
    showError(elements.worksheet4, error.message);
  }
}

/** The matrix cell's planned-time chip: shows the resolved time, opens the
 * full editor (time + TAI + decision point + note) on click. */
export function renderEventTimeChip(event) {
  const hHour = state.study.study.h_hour;
  const at = resolveTime({ at: event.expected_at, offset: event.expected_offset }, hHour);
  const label = event.expected_at
    ? formatDtg(new Date(event.expected_at).getTime())
    : event.expected_offset != null
      ? formatHOffset(event.expected_offset)
      : null;
  const button = editable(
    createElement('button', 'text-button planned-time-chip', label || 'Set time…'),
    // An unset "Set time…" prompt is purely an add action (hide it); a
    // resolved time is information the read-only role should still see.
    { hide: !label },
  );
  button.type = 'button';
  if (label && at != null && event.expected_offset != null) {
    button.title = `Resolves to ${formatDtg(at)}`;
  }
  button.addEventListener('click', (domEvent) => {
    domEvent.stopPropagation();
    openEventEditorFor(event);
  });
  return button;
}

// -- the timeline strip ------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function renderTimelineSvg(layout, { nowX, onSelectEvent, onSelectDp } = {}) {
  const svg = svgEl('svg', {
    class: 'timeline-svg',
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    role: 'img',
    'aria-label': 'Event timeline',
  });

  layout.phaseBands.forEach((band, index) => {
    svg.append(
      svgEl('rect', {
        x: band.x,
        y: 0,
        width: band.width,
        height: layout.height,
        class: `timeline-phase-band timeline-phase-${index % 4}`,
      }),
    );
    const label = svgEl('text', { x: band.x + 4, y: 12, class: 'timeline-phase-label' });
    label.textContent = band.name;
    svg.append(label);
  });

  layout.rows.forEach((row) => {
    svg.append(
      svgEl('line', { x1: 0, y1: row.y + 14, x2: layout.width, y2: row.y + 14, class: 'timeline-row-line' }),
    );
    const label = svgEl('text', { x: 4, y: row.y - 8, class: 'timeline-row-label' });
    label.textContent = row.coaName;
    svg.append(label);
    row.events.forEach((event) => {
      const marker = svgEl('circle', {
        cx: event.x,
        cy: row.y,
        r: 5,
        class: 'timeline-event-marker',
        tabindex: '0',
        role: 'button',
      });
      const title = svgEl('title');
      title.textContent = event.indicator;
      marker.append(title);
      marker.addEventListener('click', () => onSelectEvent?.(event.id));
      marker.addEventListener('keydown', (domEvent) => {
        if (domEvent.key === 'Enter' || domEvent.key === ' ') {
          domEvent.preventDefault();
          onSelectEvent?.(event.id);
        }
      });
      svg.append(marker);
    });
  });

  layout.decisionPoints.forEach((dp) => {
    if (dp.xStart != null && dp.xEnd != null) {
      svg.append(
        svgEl('line', { x1: dp.xStart, y1: dp.y, x2: dp.xEnd, y2: dp.y, class: 'timeline-dp-window' }),
      );
    }
    const diamond = svgEl('polygon', {
      points: `${dp.x},${dp.y - 6} ${dp.x + 6},${dp.y} ${dp.x},${dp.y + 6} ${dp.x - 6},${dp.y}`,
      class: 'timeline-dp-marker',
      tabindex: '0',
      role: 'button',
    });
    const title = svgEl('title');
    title.textContent = dp.name;
    diamond.append(title);
    diamond.addEventListener('click', () => onSelectDp?.(dp.id));
    diamond.addEventListener('keydown', (domEvent) => {
      if (domEvent.key === 'Enter' || domEvent.key === ' ') {
        domEvent.preventDefault();
        onSelectDp?.(dp.id);
      }
    });
    svg.append(diamond);
  });

  if (Number.isFinite(nowX)) {
    svg.append(svgEl('line', { x1: nowX, y1: 0, x2: nowX, y2: layout.height, class: 'timeline-now-line' }));
    const label = svgEl('text', { x: nowX + 3, y: 12, class: 'timeline-now-label' });
    label.textContent = 'NOW';
    svg.append(label);
  }

  return svg;
}

// -- scenario clock polling (module-local; see destroyTimeline) --------------

let clock = null;
let clockTimer = null;
let tickTimer = null;
let unsubscribeClock = null;
let mountedContainer = null;

async function refreshClock() {
  try {
    clock = await requestJson(`${EXERCISE_API}/clock`);
  } catch {
    // Not fatal: the timeline still renders, just without a "now" line
    // (e.g. no exercise module state yet, or the request was aborted).
    clock = null;
  }
}

function rerenderIfMounted() {
  if (mountedContainer) renderTimelineSection(mountedContainer);
}

function scheduleClockRefresh() {
  window.clearTimeout(clockTimer);
  clockTimer = window.setTimeout(async () => {
    await refreshClock();
    rerenderIfMounted();
    scheduleClockRefresh();
  }, 30_000);
}

/** Idempotent: starts the 30 s poll, the live-event refresh, and a 1 s
 * redraw tick so the "now" line advances smoothly between polls. */
function ensureClockRunning() {
  if (unsubscribeClock) return;
  refreshClock().then(rerenderIfMounted);
  scheduleClockRefresh();
  unsubscribeClock = subscribe(
    (event) => event.module === 'exercise',
    () => refreshClock().then(rerenderIfMounted),
  );
  tickTimer = window.setInterval(rerenderIfMounted, 1000);
}

/** Called from view.js's unmount: stops every timer/subscription this
 * module started, so leaving the study (or the app) leaves nothing running. */
export function destroyTimeline() {
  window.clearTimeout(clockTimer);
  window.clearInterval(tickTimer);
  clockTimer = null;
  tickTimer = null;
  unsubscribeClock?.();
  unsubscribeClock = null;
  mountedContainer = null;
}

/** The timeline SVG, redrawn into `container` on every call (cheap: a
 * handful of small elements). Starts clock polling on first use. */
export function renderTimelineSection(container) {
  mountedContainer = container;
  ensureClockRunning();
  const study = state.study.study;
  const phases = state.study.phases ?? [];
  const decisionPoints = state.study.decision_points ?? [];
  const coas = state.study.coas;
  const events = state.study.events;
  const hHour = study.h_hour;
  const nowMs = clock ? scenarioNowMs(clock) : null;
  const domain = timelineDomain({ phases, events, decisionPoints, hHour, nowMs });
  const width = Math.max(560, (elements.worksheet4?.clientWidth || 640) - 32);
  const layout = layoutTimeline({ domain, width, coas, phases, events, decisionPoints, hHour });
  const nowX = nowMs != null ? layout.xScale(nowMs) : null;
  if (!coas.length && !phases.length) {
    container.replaceChildren(
      createElement('p', 'panel-note', 'Add a COA or a phase to see the timeline.'),
    );
    return;
  }
  const svg = renderTimelineSvg(layout, {
    nowX,
    onSelectEvent: (id) => {
      const event = events.find((entry) => entry.id === id);
      if (event) openEventEditorFor(event);
    },
    onSelectDp: () => {
      // Decision points are already editable as cards just above the strip;
      // selecting one on the timeline scrolls the worksheet to them.
      elements.worksheet4.querySelector('.dp-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
  });
  container.replaceChildren(svg);
}

export function renderTimelineStripSection() {
  const section = createElement('section', 'worksheet-block timeline-section');
  section.append(createElement('h4', null, 'Timeline'));
  const container = createElement('div', 'timeline-strip');
  section.append(container);
  renderTimelineSection(container);
  return section;
}
