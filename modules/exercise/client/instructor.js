/**
 * The Instructor desk: White's control-of-exercise tab. Story (Blue-facing
 * briefing plus White-private objectives/notes), an ordered list of
 * situations White develops through the exercise (private ground truth +
 * expected response, current/complete status), the scenario clock, and the
 * single inject composer (message or report, optionally linked to a
 * situation) that used to live on the Scenario tab — moved here so every
 * authoring control lives in one place; the Scenario tab is now a
 * read-only "Briefing & clock" view (view.js).
 *
 * `createInstructorController(ctx)` returns `{ enter(container), leave() }`,
 * the same shape `collection.js`/`products.js`/`reportForm.js`'s Reports
 * controller/`situation.js` use — see `view.js`'s shared `ctx`.
 *
 * All of `GET/PATCH/POST/DELETE /api/exercise/instructor*` is White-only on
 * the server (routes.js): nothing here is a real gate, only UI affordance,
 * same convention as every other controller's `can()`/`isWhite()` checks.
 *
 * Preserving unsaved input across a live-triggered reload (`ctx` has no
 * autosave): every editable value is read from a local draft object, not
 * from the freshly loaded server data, and a draft is only (re)seeded from
 * the server the first time its target is opened — a live refresh mid-edit
 * re-renders the same draft values back into fresh input elements instead
 * of clobbering them with what just came from the network. The linked
 * report fieldset (reportForm.js) is the same idea one level down: its
 * current value is read back into the composer's draft immediately before
 * every rebuild, then handed back in as `initial` when the fieldset is
 * recreated.
 */
import { createDtgInput, readDtgValue } from '../../../src/dtgField.js';
import { subscribe } from '../../../src/live.js';
import { can, isWhite } from '../../../src/session.js';

import { symbolElement } from '../../../src/symbols/symbol.js';

import {
  appendCredibilityOptions,
  appendReliabilityOptions,
  createReportFieldset,
  credibilityOptionLabel,
  formatReportLocationMgrs,
  REPORT_TYPE_LABEL,
  reliabilityOptionLabel,
} from './reportForm.js';
import './instructor.css';

const SITUATION_STATUSES = ['planned', 'active', 'complete'];
const SITUATION_STATUS_LABEL = { planned: 'Planned', active: 'Current', complete: 'Complete' };
const EVENT_STATE_LABEL = { pending: 'Pending', fired: 'Delivered', cancelled: 'Cancelled' };

/** Blank story/situation/composer drafts, seeded from server data once and
 * never overwritten by a later load() while the analyst may still be typing
 * into them (see module doc). */
function blankStoryDraft() {
  return { title: '', briefing: '', objectives: '', instructor_notes: '' };
}

function blankSituationDraft() {
  return { title: '', ground_truth: '', expected_response: '' };
}

function blankComposerDraft() {
  return {
    situationId: null,
    kind: 'message',
    text: '',
    reportInitial: null,
    reliability: 'F',
    credibility: 6,
    releaseBlue: true,
    releaseRed: false,
    triggerText: '',
    editingEventId: null,
    pendingCreateId: null,
  };
}

export function createInstructorController(ctx) {
  const {
    requestJson: rawRequest,
    createElement: el,
    askText,
    askConfirm,
    showError,
    formatDate,
    api,
  } = ctx;

  const data = { story: null, situations: [], events: [], clock: null };
  let panel = null;
  let unsubscribe = null;
  let loadToken = 0;

  let storyDraft = null;
  let storyLoaded = false;
  let storyOpen = null;
  let requestController = null;
  let submitting = false;
  const situationDrafts = new Map(); // id -> draft, seeded once per situation
  let openSituationId = null;

  let composer = blankComposerDraft();
  let composerFieldset = null; // the live createReportFieldset() instance, while report-kind is shown
  let composerOpen = false;

  function request(path, options = {}) {
    if (!requestController || requestController.signal.aborted) {
      return Promise.reject(new DOMException('Desk closed', 'AbortError'));
    }
    return rawRequest(path, { ...options, signal: requestController.signal });
  }

  /** Scenario "now" (ms): same reference every other tab's DTG fields use. */
  function scenarioNow() {
    const now = data.clock ? Date.parse(data.clock.now) : NaN;
    return Number.isFinite(now) ? now : Date.now();
  }

  async function load() {
    const token = ++loadToken;
    const [instructor, clock] = await Promise.all([
      request(`${api}/instructor`),
      request(`${api}/clock`),
    ]);
    if (token !== loadToken) return; // a newer load() started meanwhile — discard this one
    data.story = instructor.story;
    data.situations = instructor.situations;
    data.events = instructor.events;
    data.clock = clock;
    if (!storyLoaded) {
      storyDraft = { ...blankStoryDraft(), ...data.story };
      storyLoaded = true;
    }
    for (const situation of data.situations) {
      if (!situationDrafts.has(situation.id)) {
        situationDrafts.set(situation.id, {
          ...blankSituationDraft(),
          title: situation.title,
          ground_truth: situation.ground_truth,
          expected_response: situation.expected_response,
        });
      }
    }
    // Drop drafts for situations that no longer exist (deleted elsewhere).
    const liveIds = new Set(data.situations.map((s) => s.id));
    for (const id of situationDrafts.keys()) if (!liveIds.has(id)) situationDrafts.delete(id);
    if (openSituationId != null && !liveIds.has(openSituationId)) openSituationId = null;
  }

  function canEdit() {
    return isWhite() && can('game-master');
  }

  // -- clock --------------------------------------------------------------

  async function patchClock(body, container) {
    try {
      await request(`${api}/clock`, { method: 'PATCH', body });
      await load();
      render();
    } catch (error) {
      showError(container, error.message);
    }
  }

  function renderClockSection() {
    const section = el('section', 'field-group instructor-clock');
    const clock = data.clock;
    section.append(
      el('p', 'clock-now', `Scenario time: ${formatDate(clock.now)}`),
      el(
        'p',
        'panel-note',
        `Rate ${clock.rate}\u00d7 \u00b7 ${clock.paused ? 'Paused' : 'Running'}`,
      ),
    );
    if (canEdit()) {
      const controls = el('div', 'inline-form');
      const toggleButton = el('button', 'primary-button', clock.paused ? 'Resume' : 'Pause');
      toggleButton.type = 'button';
      toggleButton.addEventListener('click', () => patchClock({ paused: !clock.paused }, section));

      const rateInput = document.createElement('input');
      rateInput.type = 'number';
      rateInput.setAttribute('aria-label', 'Scenario clock rate');
      rateInput.min = '0.1';
      rateInput.step = '0.1';
      rateInput.value = String(clock.rate);
      const rateButton = el('button', 'chip-button', 'Set rate');
      rateButton.type = 'button';
      rateButton.addEventListener('click', () =>
        patchClock({ rate: Number.parseFloat(rateInput.value) }, section),
      );

      const jumpInput = createDtgInput({
        name: 'jump_to',
        label: 'Jump to',
        reference: scenarioNow,
      });
      const jumpButton = el('button', 'chip-button', 'Jump to');
      jumpButton.type = 'button';
      jumpButton.addEventListener('click', () => {
        try {
          const jumpTo = readDtgValue(jumpInput);
          if (jumpTo) patchClock({ jump_to: jumpTo }, section);
        } catch (error) {
          showError(section, error.message);
        }
      });

      const tickButton = el('button', 'chip-button', 'Fire due events now');
      tickButton.type = 'button';
      tickButton.addEventListener('click', async () => {
        // No bulk tick route (docs/adr/0002-item-scoped-requests.md): each
        // due, non-draft event is announced only to its own cells, so it's
        // fired one request at a time.
        const nowMs = scenarioNow();
        const due = data.events.filter(
          (event) =>
            event.state === 'pending' &&
            event.delivery_mode === 'scheduled' &&
            new Date(event.trigger_at).getTime() <= nowMs,
        );
        tickButton.disabled = true;
        try {
          for (const event of due) {
            await request(`${api}/scenario-events/${event.id}/fire`, { method: 'POST' });
          }
          await load();
          render();
        } catch (error) {
          if (error.name !== 'AbortError') showError(section, error.message);
        } finally {
          tickButton.disabled = false;
        }
      });

      controls.append(toggleButton, rateInput, rateButton, jumpInput, jumpButton, tickButton);
      section.append(controls);
    }
    return section;
  }

  // -- story ----------------------------------------------------------------

  async function saveStory(container) {
    try {
      await request(`${api}/instructor/story`, {
        method: 'PATCH',
        body: { ...storyDraft },
      });
      storyOpen = false;
      await load();
      render();
    } catch (error) {
      showError(container, error.message);
    }
  }

  function renderStorySection() {
    const section = el('details', 'field-group instructor-story');
    section.open = storyOpen ?? !data.story.title;
    section.addEventListener('toggle', () => {
      storyOpen = section.open;
    });
    section.append(
      el(
        'summary',
        'instructor-story-summary',
        `1. Story${data.story.title ? ` — ${data.story.title}` : ' — set the background and mission'}`,
      ),
    );
    section.append(
      el(
        'p',
        'panel-note',
        'Everything here is private until you preview and send the Blue briefing. Saving does not send it.',
      ),
    );

    const titleLabel = el('label', 'field-label', 'Title');
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = storyDraft.title;
    titleInput.disabled = !canEdit();
    titleInput.addEventListener('input', () => (storyDraft.title = titleInput.value));
    titleLabel.append(titleInput);

    const briefingLabel = el(
      'label',
      'field-label',
      'Blue briefing (background + mission — send explicitly)',
    );
    const briefingArea = document.createElement('textarea');
    briefingArea.rows = 4;
    briefingArea.className = 'instructor-story-textarea blue-facing';
    briefingArea.value = storyDraft.briefing;
    briefingArea.disabled = !canEdit();
    briefingArea.addEventListener('input', () => (storyDraft.briefing = briefingArea.value));
    briefingLabel.append(briefingArea);

    const objectivesLabel = el('label', 'field-label', 'Objectives (White only)');
    const objectivesArea = document.createElement('textarea');
    objectivesArea.rows = 3;
    objectivesArea.className = 'instructor-story-textarea private';
    objectivesArea.value = storyDraft.objectives;
    objectivesArea.disabled = !canEdit();
    objectivesArea.addEventListener('input', () => (storyDraft.objectives = objectivesArea.value));
    objectivesLabel.append(objectivesArea);

    const notesLabel = el('label', 'field-label', 'Instructor notes (White only)');
    const notesArea = document.createElement('textarea');
    notesArea.rows = 3;
    notesArea.className = 'instructor-story-textarea private';
    notesArea.value = storyDraft.instructor_notes;
    notesArea.disabled = !canEdit();
    notesArea.addEventListener('input', () => (storyDraft.instructor_notes = notesArea.value));
    notesLabel.append(notesArea);

    section.append(titleLabel, briefingLabel, objectivesLabel, notesLabel);

    if (canEdit()) {
      const saveButton = el('button', 'primary-button', 'Save story');
      saveButton.type = 'button';
      saveButton.addEventListener('click', () => saveStory(section));
      const preview = el('button', 'chip-button', 'Preview Blue briefing');
      preview.type = 'button';
      preview.addEventListener('click', async () => {
        if (!storyDraft.briefing.trim()) {
          showError(section, 'Write the Blue briefing first.');
          return;
        }
        if (
          composerOpen &&
          buildPayload() &&
          !(await askConfirm(
            'Replace the unsaved composer with the Blue briefing?',
            'Replace draft',
          ))
        )
          return;
        resetComposer();
        composer.text = storyDraft.briefing;
        composerOpen = true;
        storyOpen = false;
        render();
        panel?.querySelector('.instructor-composer')?.scrollIntoView({ block: 'start' });
      });
      section.append(saveButton, preview);
    }
    return section;
  }

  // -- situations -------------------------------------------------------------

  function nextSortOrder() {
    return data.situations.reduce((max, s) => Math.max(max, s.sort_order), -1) + 1;
  }

  async function createSituation(container) {
    const title = await askText('Name this situation', '', 'Create situation');
    if (!title) return;
    try {
      const created = await request(`${api}/instructor/situations`, {
        method: 'POST',
        body: { ...blankSituationDraft(), title, sort_order: nextSortOrder() },
      });
      openSituationId = created.id;
      await load();
      render();
      panel?.querySelector('.instructor-situation-card.open')?.scrollIntoView({ block: 'nearest' });
    } catch (error) {
      showError(container, error.message);
    }
  }

  async function saveSituation(situation, container) {
    const draft = situationDrafts.get(situation.id);
    try {
      await request(`${api}/instructor/situations/${situation.id}`, {
        method: 'PATCH',
        body: {
          title: draft.title,
          ground_truth: draft.ground_truth,
          expected_response: draft.expected_response,
        },
      });
      await load();
      render();
    } catch (error) {
      showError(container, error.message);
    }
  }

  async function setSituationStatus(situation, status, container) {
    try {
      await request(`${api}/instructor/situations/${situation.id}`, {
        method: 'PATCH',
        body: { status },
      });
      await load();
      render();
    } catch (error) {
      showError(container, error.message);
    }
  }

  async function moveSituation(situation, direction, container) {
    const ordered = [...data.situations].sort((a, b) => a.sort_order - b.sort_order);
    const index = ordered.findIndex((s) => s.id === situation.id);
    const swapIndex = index + direction;
    if (swapIndex < 0 || swapIndex >= ordered.length) return;
    const other = ordered[swapIndex];
    try {
      await Promise.all([
        request(`${api}/instructor/situations/${situation.id}`, {
          method: 'PATCH',
          body: { sort_order: other.sort_order },
        }),
        request(`${api}/instructor/situations/${other.id}`, {
          method: 'PATCH',
          body: { sort_order: situation.sort_order },
        }),
      ]);
      await load();
      render();
    } catch (error) {
      showError(container, error.message);
    }
  }

  async function deleteSituation(situation, container) {
    const confirmed = await askConfirm(
      `Delete situation "${situation.title || 'Untitled'}"? This is blocked while any inject is linked to it.`,
    );
    if (!confirmed) return;
    try {
      await request(`${api}/instructor/situations/${situation.id}`, { method: 'DELETE' });
      situationDrafts.delete(situation.id);
      if (openSituationId === situation.id) openSituationId = null;
      await load();
      render();
    } catch (error) {
      showError(container, error.message);
    }
  }

  function renderSituationCard(situation, index, count) {
    const isOpen = openSituationId === situation.id;
    const card = el(
      'article',
      `instructor-situation-card status-${situation.status}${isOpen ? ' open' : ''}`,
    );

    const header = el('div', 'instructor-situation-header');
    const headerButton = el(
      'button',
      'instructor-situation-toggle',
      situation.title || 'Untitled situation',
    );
    headerButton.type = 'button';
    headerButton.setAttribute('aria-expanded', String(isOpen));
    headerButton.addEventListener('click', () => {
      openSituationId = isOpen ? null : situation.id;
      render();
    });
    header.append(
      headerButton,
      el(
        'span',
        `situation-status-badge status-${situation.status}`,
        SITUATION_STATUS_LABEL[situation.status],
      ),
    );
    card.append(header);

    if (!isOpen) return card;

    if (canEdit()) {
      const statusRow = el('div', 'inline-form');
      const statusSelect = document.createElement('select');
      statusSelect.setAttribute('aria-label', 'Situation status');
      SITUATION_STATUSES.forEach((status) =>
        statusSelect.append(new Option(SITUATION_STATUS_LABEL[status], status)),
      );
      statusSelect.value = situation.status;
      statusSelect.addEventListener('change', () =>
        setSituationStatus(situation, statusSelect.value, card),
      );
      statusRow.append(el('span', 'field-label-inline', 'Status'), statusSelect);

      const moveUp = el('button', 'icon-button', '\u2191');
      moveUp.type = 'button';
      moveUp.title = 'Move earlier';
      moveUp.disabled = index === 0;
      moveUp.addEventListener('click', () => moveSituation(situation, -1, card));
      const moveDown = el('button', 'icon-button', '\u2193');
      moveDown.type = 'button';
      moveDown.title = 'Move later';
      moveDown.disabled = index === count - 1;
      moveDown.addEventListener('click', () => moveSituation(situation, 1, card));
      statusRow.append(moveUp, moveDown);

      const deleteButton = el('button', 'icon-button danger', 'Delete');
      deleteButton.type = 'button';
      deleteButton.addEventListener('click', () => deleteSituation(situation, card));
      statusRow.append(deleteButton);
      card.append(statusRow);
    }

    const draft = situationDrafts.get(situation.id);

    const titleLabel = el('label', 'field-label', 'Title');
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = draft.title;
    titleInput.disabled = !canEdit();
    titleInput.addEventListener('input', () => (draft.title = titleInput.value));
    titleLabel.append(titleInput);

    const truthLabel = el('label', 'field-label', 'Ground truth (White only)');
    const truthArea = document.createElement('textarea');
    truthArea.rows = 3;
    truthArea.className = 'instructor-story-textarea private';
    truthArea.value = draft.ground_truth;
    truthArea.disabled = !canEdit();
    truthArea.addEventListener('input', () => (draft.ground_truth = truthArea.value));
    truthLabel.append(truthArea);

    const expectedLabel = el('label', 'field-label', 'Expected response (White only)');
    const expectedArea = document.createElement('textarea');
    expectedArea.rows = 3;
    expectedArea.className = 'instructor-story-textarea private';
    expectedArea.value = draft.expected_response;
    expectedArea.disabled = !canEdit();
    expectedArea.addEventListener('input', () => (draft.expected_response = expectedArea.value));
    expectedLabel.append(expectedArea);

    card.append(titleLabel, truthLabel, expectedLabel);

    if (canEdit()) {
      const saveButton = el('button', 'primary-button', 'Save situation');
      saveButton.type = 'button';
      saveButton.addEventListener('click', () => saveSituation(situation, card));
      const composeButton = el('button', 'chip-button', 'Compose inject for this situation\u2026');
      composeButton.type = 'button';
      composeButton.addEventListener('click', () => openComposerFor(situation.id));
      card.append(saveButton, composeButton);
    }

    card.append(renderSituationEvents(situation.id));
    return card;
  }

  function renderSituationsSection() {
    const section = el('section', 'field-group instructor-situations');
    const header = el('div', 'instructor-situations-header');
    // "Story situations", not "Situations" — the Situation tab (situation.js)
    // is the unrelated track/report map; this list is White's authored
    // story beats, so the heading needs to read distinctly from that tab.
    header.append(el('h2', null, 'Story situations'));
    if (canEdit()) {
      const addButton = el('button', 'primary-button', 'New situation');
      addButton.type = 'button';
      addButton.addEventListener('click', () => createSituation(section));
      header.append(addButton);
    }
    section.append(header);

    const active = data.situations.find((s) => s.status === 'active');
    const next = [...data.situations]
      .filter((s) => s.status === 'planned')
      .sort((a, b) => a.sort_order - b.sort_order)[0];
    section.append(
      el(
        'p',
        'panel-note',
        `Current: ${active ? active.title || 'Untitled' : '\u2014'} \u00b7 Next: ${next ? next.title || 'Untitled' : '\u2014'}`,
      ),
    );

    if (!data.situations.length) {
      section.append(el('p', 'panel-note', 'No situations yet.'));
      return section;
    }
    const ordered = [...data.situations].sort((a, b) => a.sort_order - b.sort_order);
    const list = el('div', 'instructor-situation-list');
    ordered.forEach((situation, index) =>
      list.append(renderSituationCard(situation, index, ordered.length)),
    );
    section.append(list);
    return section;
  }

  // -- composer (message/report inject, optionally linked to a situation) ---

  async function openComposerFor(situationId) {
    if (
      composerOpen &&
      buildPayload() &&
      !(await askConfirm('Replace the unsaved composer with a new development?', 'Replace draft'))
    )
      return;
    resetComposer();
    composer.situationId = situationId;
    composerOpen = true;
    render();
    panel?.querySelector('.instructor-composer')?.scrollIntoView({ block: 'start' });
    panel?.querySelector('.instructor-composer textarea')?.focus({ preventScroll: true });
  }

  function resetComposer() {
    composerFieldset?.destroy();
    composerFieldset = null;
    composer = blankComposerDraft();
    composerOpen = false;
  }

  async function editEvent(event) {
    if (
      composerOpen &&
      buildPayload() &&
      !(await askConfirm('Replace the unsaved composer with this saved inject?', 'Replace draft'))
    )
      return;
    composer = {
      situationId: event.situation_id,
      kind: event.kind,
      text: event.kind === 'message' ? (event.payload.text ?? '') : '',
      reportInitial: event.kind === 'report' ? event.payload : null,
      reliability: event.kind === 'report' ? (event.payload.reliability ?? 'F') : 'F',
      credibility: event.kind === 'report' ? (event.payload.credibility ?? 6) : 6,
      releaseBlue: (event.payload.release_to || ['blue']).includes('blue'),
      releaseRed: (event.payload.release_to || []).includes('red'),
      triggerText:
        event.delivery_mode === 'scheduled' ? formatDate(event.trigger_at).replace(' ', '') : '',
      editingEventId: event.id,
      pendingCreateId: event.id,
    };
    composerFieldset?.destroy();
    composerFieldset = null;
    composerOpen = true;
    render();
  }

  function buildPayload() {
    const releaseTo = [
      ...(composer.releaseBlue ? ['blue'] : []),
      ...(composer.releaseRed ? ['red'] : []),
    ];
    if (composer.kind === 'message') {
      if (!composer.text.trim()) return null;
      return { text: composer.text.trim(), release_to: releaseTo };
    }
    const values = composerFieldset ? composerFieldset.getValue() : composer.reportInitial;
    if (!values || !values.text) return null;
    return {
      text: values.text,
      report_type: values.report_type,
      fields: values.fields,
      sidc: values.sidc,
      lon: values.lon,
      lat: values.lat,
      reliability: composer.reliability,
      credibility: composer.credibility,
      release_to: releaseTo,
    };
  }

  function confirmDelivery(payload) {
    const dialog = el('dialog', 'workspace-dialog instructor-send-dialog');
    dialog.setAttribute('aria-label', 'Confirm delivery');
    const form = document.createElement('form');
    form.method = 'dialog';
    form.append(el('h2', null, 'Send this now?'));
    renderPreview(form, payload);
    const actions = el('div', 'dialog-actions');
    const cancel = el('button', 'chip-button', 'Cancel');
    cancel.value = 'cancel';
    const send = el('button', 'primary-button', 'Confirm send');
    send.value = 'send';
    actions.append(cancel, send);
    form.append(actions);
    dialog.append(form);
    panel.append(dialog);
    return new Promise((resolve) => {
      const signal = requestController.signal;
      const abort = () => dialog.close('cancel');
      dialog.addEventListener(
        'close',
        () => {
          const accepted = dialog.returnValue === 'send';
          signal.removeEventListener('abort', abort);
          dialog.remove();
          resolve(accepted);
        },
        { once: true },
      );
      signal.addEventListener('abort', abort, { once: true });
      dialog.showModal();
      cancel.focus();
    });
  }

  async function submitComposer({ deliveryMode, fireImmediately }, triggerInput, container) {
    if (submitting) return;
    const payload = buildPayload();
    if (!payload) {
      showError(
        container,
        composer.kind === 'message' ? 'Message text is required.' : 'Narrative text is required.',
      );
      return;
    }
    let triggerAt;
    if (deliveryMode === 'scheduled' && !fireImmediately) {
      try {
        triggerAt = readDtgValue(triggerInput);
      } catch (error) {
        showError(container, error.message);
        return;
      }
      if (!triggerAt) {
        showError(container, 'A trigger time is required to schedule.');
        return;
      }
    } else if (triggerInput.value.trim()) {
      // "Send now"/draft with a trigger typed anyway — keep it, it just won't
      // be waited on for a "Send now".
      try {
        triggerAt = readDtgValue(triggerInput);
      } catch {
        triggerAt = new Date(scenarioNow()).toISOString();
      }
    } else {
      triggerAt = new Date(scenarioNow()).toISOString();
    }
    const body = {
      trigger_at: triggerAt,
      kind: composer.kind,
      payload,
      situation_id: composer.situationId,
      delivery_mode: fireImmediately ? 'draft' : deliveryMode,
    };
    submitting = true;
    try {
      if (fireImmediately && !(await confirmDelivery(payload))) return;
      let eventId = composer.pendingCreateId;
      if (eventId) {
        await request(`${api}/scenario-events/${eventId}`, { method: 'PATCH', body });
      } else {
        const created = await request(`${api}/scenario-events`, { method: 'POST', body });
        eventId = created.id;
        // Remember the id immediately: if the follow-up fire below fails and
        // the analyst retries, the retry PATCHes+fires this id instead of
        // creating a second event.
        composer.pendingCreateId = eventId;
      }
      if (fireImmediately) {
        await request(`${api}/scenario-events/${eventId}/fire`, { method: 'POST' });
      }
      resetComposer();
      await load();
      render();
    } catch (error) {
      if (error.name !== 'AbortError') showError(container, error.message);
    } finally {
      submitting = false;
    }
  }

  async function cancelEvent(id) {
    try {
      await request(`${api}/scenario-events/${id}/cancel`, { method: 'POST' });
      await load();
      render();
    } catch (error) {
      if (error.name !== 'AbortError' && panel) showError(panel, error.message);
    }
  }

  async function fireEventNow(id) {
    if (submitting) return;
    const event = data.events.find((entry) => entry.id === id);
    if (!event) return;
    submitting = true;
    try {
      if (!(await confirmDelivery(event.payload))) return;
      await request(`${api}/scenario-events/${id}/fire`, { method: 'POST' });
      await load();
      render();
    } catch (error) {
      if (error.name !== 'AbortError' && panel) showError(panel, error.message);
    } finally {
      submitting = false;
    }
  }

  function renderPreview(container, payload = buildPayload()) {
    container.querySelector('.instructor-composer-preview')?.remove();
    const preview = el('div', 'instructor-composer-preview');
    preview.append(el('h4', null, 'What recipients will receive'));
    if (!payload) {
      preview.append(el('p', 'panel-note', 'Nothing to preview yet.'));
      container.insertBefore(preview, container.querySelector('.instructor-composer-actions'));
      return;
    }
    preview.append(el('p', null, payload.text));
    if (payload.report_type) {
      preview.append(el('p', 'panel-note', REPORT_TYPE_LABEL[payload.report_type]));
      const entries = Object.entries(payload.fields || {}).filter(([, value]) => value);
      if (entries.length) {
        const dl = el('dl', 'report-fields-summary');
        entries.forEach(([key, value]) => {
          dl.append(el('dt', null, key), el('dd', null, value));
        });
        preview.append(dl);
      }
      if (payload.sidc) {
        const sidcRow = el('div', 'report-sidc-row');
        sidcRow.append(symbolElement(payload.sidc, { size: 26 }, 'Reported unit symbol'));
        preview.append(sidcRow);
      }
      preview.append(
        el('p', 'panel-note', reliabilityOptionLabel(payload.reliability)),
        el('p', 'panel-note', credibilityOptionLabel(payload.credibility)),
      );
    }
    const mgrs = formatReportLocationMgrs(payload);
    if (mgrs) preview.append(el('p', 'panel-note', mgrs));
    preview.append(
      el(
        'p',
        'panel-note',
        `To: ${payload.release_to.length ? payload.release_to.map((c) => c[0].toUpperCase() + c.slice(1)).join(', ') : '\u2014'}`,
      ),
    );
    container.insertBefore(preview, container.querySelector('.instructor-composer-actions'));
  }

  function renderComposer() {
    const section = el('section', 'field-group instructor-composer');
    if (!canEdit()) return section;
    section.addEventListener('input', () => renderPreview(section));
    section.addEventListener('change', () => renderPreview(section));
    const header = el('div', 'instructor-composer-header');
    header.append(
      el(
        'h2',
        null,
        composer.editingEventId ? `Edit inject #${composer.editingEventId}` : 'Compose inject',
      ),
    );
    if (!composerOpen) {
      const openButton = el('button', 'chip-button', 'New inject\u2026');
      openButton.type = 'button';
      openButton.addEventListener('click', () => {
        composerOpen = true;
        render();
      });
      header.append(openButton);
      section.append(header);
      return section;
    }
    const closeButton = el('button', 'icon-button', 'Close');
    closeButton.type = 'button';
    closeButton.addEventListener('click', async () => {
      if (buildPayload() && !(await askConfirm('Discard unsaved composer changes?', 'Discard')))
        return;
      resetComposer();
      render();
    });
    header.append(closeButton);
    section.append(header);

    const situationLabel = el('label', 'field-label', 'Linked situation');
    const situationSelect = document.createElement('select');
    situationSelect.append(new Option('General (no situation)', ''));
    [...data.situations]
      .sort((a, b) => a.sort_order - b.sort_order)
      .forEach((situation) =>
        situationSelect.append(new Option(situation.title || 'Untitled', String(situation.id))),
      );
    situationSelect.value = composer.situationId != null ? String(composer.situationId) : '';
    situationSelect.addEventListener('change', () => {
      composer.situationId = situationSelect.value
        ? Number.parseInt(situationSelect.value, 10)
        : null;
    });
    situationLabel.append(situationSelect);
    section.append(situationLabel);

    const kindLabel = el('label', 'field-label', 'Kind');
    const kindSelect = document.createElement('select');
    kindSelect.append(new Option('Message', 'message'), new Option('Report', 'report'));
    kindSelect.value = composer.kind;
    kindSelect.addEventListener('change', () => {
      if (composerFieldset) composer.reportInitial = composerFieldset.getValue();
      composerFieldset?.destroy();
      composerFieldset = null;
      composer.kind = kindSelect.value;
      render();
    });
    kindLabel.append(kindSelect);
    section.append(kindLabel);

    if (composer.kind === 'message') {
      const textLabel = el('label', 'field-label', 'Message text');
      const textArea = document.createElement('textarea');
      textArea.rows = 3;
      textArea.value = composer.text;
      textArea.addEventListener('input', () => (composer.text = textArea.value));
      textLabel.append(textArea);
      section.append(textLabel);
    } else {
      composerFieldset = createReportFieldset({
        initial: composer.reportInitial,
        ariaLabel: 'Inject location',
      });
      section.append(composerFieldset.element);
      const reliabilityLabel = el('label', 'field-label', 'Reliability');
      const reliabilitySelect = document.createElement('select');
      appendReliabilityOptions(reliabilitySelect);
      reliabilitySelect.value = composer.reliability;
      reliabilitySelect.addEventListener(
        'change',
        () => (composer.reliability = reliabilitySelect.value),
      );
      reliabilityLabel.append(reliabilitySelect);
      const credibilityLabel = el('label', 'field-label', 'Credibility');
      const credibilitySelect = document.createElement('select');
      appendCredibilityOptions(credibilitySelect);
      credibilitySelect.value = String(composer.credibility);
      credibilitySelect.addEventListener(
        'change',
        () => (composer.credibility = Number.parseInt(credibilitySelect.value, 10)),
      );
      credibilityLabel.append(credibilitySelect);
      section.append(reliabilityLabel, credibilityLabel);
    }

    // Who a fired inject reaches (C3): Blue by default, the usual training
    // audience; White is never offered — a White-released inject to White
    // is a no-op the owner already sees.
    const releaseFieldset = document.createElement('fieldset');
    releaseFieldset.className = 'inject-release';
    releaseFieldset.append(el('legend', null, 'Release to'));
    const blueLabel = document.createElement('label');
    const blueCheckbox = document.createElement('input');
    blueCheckbox.type = 'checkbox';
    blueCheckbox.checked = composer.releaseBlue;
    blueCheckbox.addEventListener('change', () => (composer.releaseBlue = blueCheckbox.checked));
    blueLabel.append(blueCheckbox, ' Blue');
    const redLabel = document.createElement('label');
    const redCheckbox = document.createElement('input');
    redCheckbox.type = 'checkbox';
    redCheckbox.checked = composer.releaseRed;
    redCheckbox.addEventListener('change', () => (composer.releaseRed = redCheckbox.checked));
    redLabel.append(redCheckbox, ' Red');
    releaseFieldset.append(blueLabel, redLabel);
    section.append(releaseFieldset);

    const triggerInput = createDtgInput({
      name: 'trigger_at',
      label: 'Schedule for (blank = send/draft now)',
      reference: scenarioNow,
    });
    triggerInput.value = composer.triggerText;
    triggerInput.addEventListener('input', () => (composer.triggerText = triggerInput.value));
    section.append(triggerInput);

    renderPreview(section);

    const actions = el('div', 'inline-form instructor-composer-actions');
    const draftButton = el('button', 'chip-button', 'Save draft');
    draftButton.type = 'button';
    draftButton.addEventListener('click', () =>
      submitComposer({ deliveryMode: 'draft', fireImmediately: false }, triggerInput, section),
    );
    const scheduleButton = el('button', 'chip-button', 'Schedule');
    scheduleButton.type = 'button';
    scheduleButton.addEventListener('click', () =>
      submitComposer({ deliveryMode: 'scheduled', fireImmediately: false }, triggerInput, section),
    );
    const sendButton = el('button', 'primary-button', 'Send now');
    sendButton.type = 'button';
    sendButton.addEventListener('click', () =>
      submitComposer(
        { deliveryMode: triggerInput.value.trim() ? 'scheduled' : 'draft', fireImmediately: true },
        triggerInput,
        section,
      ),
    );
    actions.append(draftButton, scheduleButton, sendButton);
    section.append(actions);
    return section;
  }

  // -- events / development history ------------------------------------------

  function situationTitle(id) {
    if (id == null) return 'General';
    return data.situations.find((s) => s.id === id)?.title || 'Untitled situation';
  }

  function renderEventRow(event) {
    const row = el(
      'div',
      `scenario-event-row state-${event.state} delivery-${event.delivery_mode}`,
    );
    const mgrs = formatReportLocationMgrs(event.payload);
    const targets = event.payload.release_to || [];
    row.append(
      el('span', 'panel-note', situationTitle(event.situation_id)),
      el('span', `scenario-event-kind kind-${event.kind}`, event.kind),
      el(
        'span',
        `instructor-delivery-badge delivery-${event.delivery_mode}`,
        event.state === 'pending'
          ? event.delivery_mode === 'draft'
            ? 'Draft — not sent'
            : 'Scheduled'
          : EVENT_STATE_LABEL[event.state],
      ),
      el(
        'span',
        null,
        event.state === 'pending' && event.delivery_mode === 'draft'
          ? 'Manual delivery'
          : formatDate(event.fired_at || event.trigger_at),
      ),
      el('span', 'instructor-event-text', event.payload.text || ''),
      el('span', 'panel-note', mgrs || ''),
      el(
        'span',
        'panel-note',
        `To: ${targets.length ? targets.map((c) => c[0].toUpperCase() + c.slice(1)).join(', ') : '\u2014'}`,
      ),
    );
    if (event.state === 'pending' && canEdit()) {
      const editButton = el('button', 'icon-button', 'Edit');
      editButton.type = 'button';
      editButton.addEventListener('click', () => editEvent(event));
      const fireButton = el('button', 'icon-button', 'Send now');
      fireButton.type = 'button';
      fireButton.addEventListener('click', () => fireEventNow(event.id));
      const cancelButton = el('button', 'icon-button danger', 'Cancel');
      cancelButton.type = 'button';
      cancelButton.addEventListener('click', () => cancelEvent(event.id));
      row.append(editButton, fireButton, cancelButton);
    }
    return row;
  }

  function renderSituationEvents(situationId) {
    const events = data.events.filter((event) => event.situation_id === situationId);
    const wrap = el('div', 'instructor-situation-events');
    wrap.append(el('h4', null, 'Development history'));
    if (!events.length) {
      wrap.append(el('p', 'panel-note', 'No injects linked yet.'));
      return wrap;
    }
    events
      .sort((a, b) => new Date(a.trigger_at) - new Date(b.trigger_at))
      .forEach((event) => wrap.append(renderEventRow(event)));
    return wrap;
  }

  function renderHistorySection() {
    const section = el('section', 'field-group instructor-history');
    section.append(el('h2', null, 'All injects'));
    if (!data.events.length) {
      section.append(el('p', 'panel-note', 'No injects yet.'));
      return section;
    }
    const list = el('div', 'scenario-event-list');
    [...data.events]
      .sort((a, b) => new Date(a.trigger_at) - new Date(b.trigger_at))
      .forEach((event) => list.append(renderEventRow(event)));
    section.append(list);
    return section;
  }

  // -- mount ------------------------------------------------------------------

  function render() {
    if (!panel) return;
    // Snapshot the report fieldset's current (possibly unsaved, possibly
    // mid-keystroke) value into the composer draft before tearing it down —
    // it's about to be recreated with that draft as `initial`, so a
    // live-triggered rebuild never loses what the instructor was typing.
    if (composerFieldset) composer.reportInitial = composerFieldset.getValue();
    composerFieldset?.destroy();
    composerFieldset = null;
    panel.replaceChildren();
    if (!isWhite()) {
      panel.append(el('p', 'inline-error', 'The Instructor desk is White-only.'));
      return;
    }
    panel.append(el('h1', 'instructor-title', 'Instructor desk'));
    panel.append(renderClockSection());
    panel.append(renderStorySection());
    panel.append(renderSituationsSection());
    panel.append(renderComposer());
    panel.append(renderHistorySection());
  }

  async function enter(container) {
    leave();
    panel = container;
    requestController = new AbortController();
    const owner = requestController;
    panel.replaceChildren(el('p', 'panel-note', 'Loading instructor desk\u2026'));
    try {
      await load();
    } catch (error) {
      if (error.name === 'AbortError' || owner.signal.aborted) return;
      panel?.replaceChildren(el('p', 'inline-error', error.message));
      return;
    }
    if (owner.signal.aborted) return;
    render();
    unsubscribe = subscribe(
      (event) => event.module === 'exercise',
      () => {
        load()
          .then(() => {
            if (owner.signal.aborted) return;
            // Do not destroy the field or map-pick dialog someone is using.
            if (
              panel?.contains(document.activeElement) &&
              document.activeElement.matches('input, textarea, select')
            )
              return;
            if (document.querySelector('dialog[open]')) return;
            render();
          })
          .catch((error) => {
            if (error.name !== 'AbortError' && panel) showError(panel, error.message);
          });
      },
    );
  }

  function leave() {
    ++loadToken;
    requestController?.abort();
    requestController = null;
    if (composerFieldset) composer.reportInitial = composerFieldset.getValue();
    unsubscribe?.();
    unsubscribe = null;
    composerFieldset?.destroy();
    composerFieldset = null;
    panel = null;
  }

  return { enter, leave };
}
