import { formatDtg } from '../../../src/dtg.js';
import { clientId, subscribe } from '../../../src/live.js';
import { renderCellBadge } from '../../../src/release.js';
import { currentUser, handleUnauthorized, isWhite, sessionMode } from '../../../src/session.js';
import { createCollectionController } from './collection.js';
import { createProductsController } from './products.js';
import { createReportsController } from './reportForm.js';
import { createInstructorController } from './instructor.js';
import { renderExerciseGuide } from './guide.js';
import {
  GUIDE_LISTS,
  defaultList,
  extraLoads,
  firstOpenTask,
  listTasks,
  taskStatuses,
} from './guideTasks.js';
import { createSituationController } from './situation.js';
import './styles.css';
import template from './view.html?raw';
import { renderActivityPanel } from './activityPanel.js';
import { destroyGeoMap, onGeoKeydown, renderGeographyPanel } from './geographyPanel.js';
import { renderRequirementsPanel } from './requirementsPanel.js';
import { renderRfiPanel } from './rfiPanel.js';

export const API = '/api/exercise';

const TABS = new Set([
  'instructor',
  'requirements',
  'geography',
  'reports',
  'situation',
  'rfi',
  'collection',
  'products',
  'scenario',
  'activity',
]);

export let state;

export let elements;

let dialogNode;

/** Collection/Products tab controllers (collection.js/products.js): built once in mount()
 * with the shared `ctx`, entered/left like geoMap — see CONTROLLER_TABS/switchTab. */
let collectionController;

let productsController;

let reportsController;

let situationController;

let instructorController;

/** True when the user may create a cell-owned item at all: off mode's
 * fixed operator and White always can; a member of any cell can; an admin
 * with no membership acts as White (C1) and still can. Only a signed-in
 * non-admin with no exercise membership can't — and that case is already
 * turned away before this module ever mounts (403 upstream), so this is
 * belt-and-braces for hiding create controls, not the real gate. */
export function hasCell() {
  if (sessionMode() !== 'on') return true;
  const user = currentUser();
  return Boolean(user?.admin) || Boolean(user?.cell);
}

// --- State & elements --------------------------------------------------------

function createState() {
  return {
    session: new AbortController(),
    tab: 'requirements',
    requirements: [],
    reports: [],
    rfis: [],
    messages: [],
    clock: null,
    activity: [],
    importSummary: null,
    requirementDrafts: {
      create: { kind: 'PIR', text: '', priority: '0', decision_point: '', ltiov: '' },
      sirs: {},
      indicators: {},
    },
    guide: { list: 'analyst', open: null, progress: null, refresh: null },
    unsubscribeTick: null,
    // The game-master's audit view (Activity tab, LAN/auth mode only) — loaded lazily,
    // separate from `activity` (the exercise module's own per-object log).
    audit: { items: [], total: 0, offset: 0, limit: 50, loaded: false },
    geo: {
      scenarios: [],
      scenario: null,
      regions: null,
      regionsError: null,
      regionLevel: 'kraj',
      // null | 'pick-regions' | 'edit-border' | 'draw-area'; place renaming has no mode,
      // it is just the map's default click behaviour while nothing else is armed.
      mode: null,
      activeCountryId: null,
      basemap: 'roads',
      terrainMeta: null,
      loading: false,
      error: null,
    },
  };
}

function queryElements(root) {
  return {
    tabNav: root.querySelector('#tab-nav'),
    guide: root.querySelector('#exercise-guide'),
    panel: root.querySelector('#panel'),
  };
}

export function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Every exercise time reads as a Zulu DTG, like the SORs and INTSUMs built from it. */
export function formatDate(value) {
  if (!value) return '—';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? formatDtg(ms) : value;
}

/** Scenario "now" (ms): the reference for short DTGs typed into time fields. */
export function scenarioNow() {
  const now = state.clock ? Date.parse(state.clock.now) : NaN;
  return Number.isFinite(now) ? now : Date.now();
}

export async function requestJson(
  path,
  { method = 'GET', body, signal = state.session.signal } = {},
) {
  const options = { method, signal, headers: { 'X-Client-Id': clientId } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) handleUnauthorized();
    const error = new Error(payload.error || `Request failed: ${response.status}`);
    error.status = response.status;
    if (payload.code) error.code = payload.code;
    if (payload.current_revision !== undefined) error.currentRevision = payload.current_revision;
    throw error;
  }
  if (method !== 'GET' && !signal.aborted) state.guide.refresh?.();
  return payload;
}

export function showError(container, message) {
  let node = container.querySelector(':scope > .inline-error');
  if (!node) {
    node = createElement('p', 'inline-error');
    container.prepend(node);
  }
  node.textContent = message;
}

// --- Prompts -----------------------------------------------------------------

/** One reusable <dialog>, built in JS (not view.html) so it survives every tab's
 * template swap: focus trap, Escape and backdrop come for free. */
function createDialogNode(root) {
  dialogNode = createElement('dialog', 'workspace-dialog');
  const form = createElement('form');
  form.method = 'dialog';
  const message = createElement('p', 'dialog-message');
  const input = createElement('input', 'dialog-input');
  input.type = 'text';
  input.autocomplete = 'off';
  const actions = createElement('div', 'dialog-actions');
  // Enter in the text input submits the form with its *first* submit button,
  // so Cancel must not be one, or Enter would discard what was typed. As the
  // first focusable control it still takes Enter in inputless confirms,
  // which keeps "Delete?" defaulting to the safe answer.
  const cancel = createElement('button', 'text-button', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => dialogNode.close('cancel'));
  const accept = createElement('button', 'dialog-accept');
  accept.type = 'submit';
  accept.value = 'accept';
  actions.append(cancel, accept);
  form.append(message, input, actions);
  dialogNode.append(form);
  root.append(dialogNode);
}

function openDialog({ message, initial, accept, withInput, destructive = false }) {
  dialogNode.querySelector('.dialog-message').textContent = message;
  const input = dialogNode.querySelector(':scope form > .dialog-input');
  input.hidden = !withInput;
  input.value = initial ?? '';
  const acceptButton = dialogNode.querySelector('.dialog-accept');
  acceptButton.textContent = accept;
  acceptButton.classList.toggle('danger', destructive);
  return new Promise((resolve) => {
    const settle = () => {
      dialogNode.removeEventListener('close', settle);
      const accepted = dialogNode.returnValue === 'accept';
      if (!withInput) return resolve(accepted);
      return resolve(accepted ? input.value.trim() : null);
    };
    dialogNode.addEventListener('close', settle);
    dialogNode.showModal();
    if (withInput) {
      input.focus();
      input.select();
    }
  });
}

/** Resolves to the trimmed text, or null when the analyst cancels. */
export function askText(message, initial = '', accept = 'Save') {
  return openDialog({ message, initial, accept, withInput: true });
}

/** Every confirmation here guards a delete, so its accept reads as one. */
export function askConfirm(message, accept = 'Delete') {
  return openDialog({ message, accept, withInput: false, destructive: true });
}

// --- URL state -----------------------------------------------------------

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  const allowed = TABS.has(tab) && (tab !== 'instructor' || isWhite());
  state.tab = allowed ? tab : isWhite() ? 'instructor' : 'requirements';
}

function writeLocation() {
  const params = new URLSearchParams();
  params.set('tab', state.tab);
  window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
}

// --- Loading -----------------------------------------------------------------

export async function loadAll() {
  const [requirements, reports, rfis, messages, clock, activity] = await Promise.all([
    requestJson(`${API}/requirements`),
    requestJson(`${API}/reports`),
    requestJson(`${API}/rfis`),
    requestJson(`${API}/messages`),
    requestJson(`${API}/clock`),
    requestJson(`${API}/activity`),
  ]);
  state.requirements = requirements;
  state.reports = reports;
  state.rfis = rfis;
  state.messages = messages;
  state.clock = clock;
  state.activity = activity;
}

// --- Tab chrome ----------------------------------------------------------------

function renderTabNav() {
  elements.tabNav.querySelectorAll('.tab-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === state.tab);
    if (button.dataset.tab === 'instructor') button.hidden = !isWhite();
  });
}

// --- The guide (sidebar) ----------------------------------------------------------

const GUIDE_LIST_KEY = 'exercise.guideList';

/** The member's own list; White, admins and the local operator may look at the others. */
function guideLists() {
  const user =
    sessionMode() === 'on' ? currentUser() : { cell: 'white', role: 'game-master', admin: true };
  const own = defaultList({
    cell: user?.cell ?? null,
    role: user?.role ?? null,
    admin: Boolean(user?.admin),
  });
  const lists = isWhite() ? Object.keys(GUIDE_LISTS) : [own];
  let chosen = own;
  try {
    const saved = window.localStorage.getItem(GUIDE_LIST_KEY);
    if (saved && lists.includes(saved)) chosen = saved;
  } catch {
    // Storage blocked: the member's own list.
  }
  return { lists, chosen };
}

/**
 * What the guide's tasks read: the view's own lists, plus the few (tracks,
 * INTSUMs, collectors…) only some lists need, fetched here and refreshed on
 * every exercise change.
 */
async function loadGuideProgress() {
  const owner = state;
  const list = owner.guide.list;
  const needs = extraLoads(list);
  const fetchOr = (need, path, fallback, pick = (value) => value) =>
    needs.has(need) ? requestJson(path).then(pick) : Promise.resolve(fallback);
  const [tracks, intsums, collectors, taskings, conflicts, activeScenario] = await Promise.all([
    fetchOr('tracks', `${API}/tracks`, []),
    fetchOr('intsums', `${API}/intsums`, []),
    fetchOr('collectors', `${API}/collectors`, []),
    fetchOr('taskings', `${API}/taskings`, []),
    fetchOr('conflicts', `${API}/collection/conflicts`, []),
    fetchOr('activeScenario', `${API}/scenario/active`, null, (value) => value.scenario),
  ]);
  if (owner.session.signal.aborted || owner !== state || list !== owner.guide.list) return;
  state.guide.progress = {
    requirements: state.requirements,
    reports: state.reports,
    rfis: state.rfis,
    tracks,
    intsums,
    collectors,
    taskings,
    conflicts,
    activeScenario,
  };
}

function renderGuide() {
  const { progress, list } = state.guide;
  const statuses = progress ? taskStatuses(list, progress) : null;
  if (state.guide.open === null && statuses) {
    state.guide.open =
      listTasks(list).find((task) => task.tab === state.tab)?.id ?? firstOpenTask(list, statuses);
  }
  const focused = elements.guide.contains(document.activeElement);
  const focusedTask = document.activeElement?.closest('[data-task]')?.dataset.task;
  const focusedList = document.activeElement?.classList.contains('guide-list-select');
  const { lists } = guideLists();
  elements.guide.replaceChildren(
    renderExerciseGuide({
      listId: list,
      lists,
      progress,
      openTaskId: state.guide.open,
      onOpen: (taskId) => {
        state.guide.open = taskId;
        const task = listTasks(list).find((entry) => entry.id === taskId);
        if (task.tab !== state.tab) switchTab(task.tab);
        else renderGuide();
      },
      onList: (listId) => {
        state.guide.list = listId;
        state.guide.open = null;
        state.guide.progress = null;
        try {
          window.localStorage.setItem(GUIDE_LIST_KEY, listId);
        } catch {
          // Storage blocked: the choice lasts this visit.
        }
        renderGuide();
        refreshGuide();
      },
    }),
  );
  if (focused) {
    const selector = focusedList
      ? '.guide-list-select'
      : `[data-task="${state.guide.open ?? focusedTask}"] .guide-task-head`;
    elements.guide.querySelector(selector)?.focus({ preventScroll: true });
  }
}

/** Reloads what the guide reads and redraws it; a failure only leaves the ticks stale. */
async function refreshGuide() {
  const owner = state;
  try {
    await loadGuideProgress();
    if (!owner.session.signal.aborted && owner === state) renderGuide();
  } catch (error) {
    if (error.name !== 'AbortError' && owner === state && !owner.session.signal.aborted) {
      showError(
        elements.guide,
        `Task progress unavailable: ${error.message}. Use All sections below.`,
      );
    }
  }
}

/** Tabs whose panel is owned by a `{ enter(container), leave() }` controller
 * (collection.js, products.js) instead of the plain renderers map below —
 * same "lives across renders, torn down on leaving the tab" shape as the
 * Geography tab's map controller. */
const CONTROLLER_TABS = {
  collection: () => collectionController,
  products: () => productsController,
  reports: () => reportsController,
  situation: () => situationController,
  instructor: () => instructorController,
};

function switchTab(tab) {
  if (tab === 'instructor' && !isWhite()) return;
  // The map controller lives across renders of the Geography tab (see
  // renderGeographyPanel); every other tab is a plain wipe-and-redraw, so it
  // only needs tearing down when actually leaving the tab that owns it.
  if (state.tab === 'geography' && tab !== 'geography') destroyGeoMap();
  const leavingController = CONTROLLER_TABS[state.tab];
  if (leavingController && state.tab !== tab) leavingController().leave();
  state.tab = tab;
  writeLocation();
  renderTabNav();
  renderGuide();
  renderPanel();
}

export function renderPanel() {
  elements.panel.replaceChildren();
  elements.panel.classList.toggle('panel-geo', state.tab === 'geography');
  elements.panel.classList.toggle('panel-situation', state.tab === 'situation');
  const enterController = CONTROLLER_TABS[state.tab];
  if (enterController) {
    enterController().enter(elements.panel);
    return;
  }
  const renderers = {
    requirements: renderRequirementsPanel,
    geography: renderGeographyPanel,
    rfi: renderRfiPanel,
    scenario: renderScenarioPanel,
    activity: renderActivityPanel,
  };
  renderers[state.tab]();
}

// --- Reports tab (reportForm.js's createReportsController owns the panel; this
// stays here because it needs state.requirements/sirs, passed through ctx.evidenceTargets) ---

export function evidenceTargets() {
  const options = [];
  state.requirements.forEach((requirement) => {
    options.push({
      kind: 'requirement',
      id: requirement.id,
      // Evidence links are parts of the requirement they support
      // (CONTEXT.md): this is the `:item` reportForm.js posts/deletes
      // under, for both a blanket link and one against a SIR.
      requirement_id: requirement.id,
      label: `${requirement.kind} • ${requirement.text}`,
      // C2b: a SIR has no owner_cell of its own — it inherits the parent
      // requirement's, for reportForm.js's canEditClient gating (linking
      // evidence changes the target, not the report).
      owner_cell: requirement.owner_cell,
      revision: requirement.revision,
    });
    requirement.sirs.forEach((sir) => {
      options.push({
        kind: 'sir',
        id: sir.id,
        requirement_id: requirement.id,
        label: `↳ SIR • ${sir.text}`,
        owner_cell: requirement.owner_cell,
        revision: requirement.revision,
      });
    });
  });
  return options;
}

// --- Scenario panel --------------------------------------------------------

function updateMastheadStatus() {
  if (!elements.statusText || !state.clock) return;
  elements.statusText.textContent = state.clock.paused
    ? 'Clock paused'
    : `Clock running ×${state.clock.rate}`;
}

function renderScenarioPanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'Briefing & scenario clock'));
  const clock = state.clock;
  container.append(
    createElement('p', 'clock-now', `Scenario time: ${formatDate(clock.now)}`),
    createElement(
      'p',
      'panel-note',
      `Rate ${clock.rate}× · ${clock.paused ? 'Paused' : 'Running'}`,
    ),
  );
  if (isWhite()) {
    const desk = createElement('button', 'chip-button', 'Open Instructor desk');
    desk.type = 'button';
    desk.addEventListener('click', () => switchTab('instructor'));
    container.append(desk);
  }
  renderMessagesSection(container);
}

// --- Messages panel (fired MESSAGE injects, filtered to the user's cell) ---

/** Fired MESSAGE injects the current cell can see (C1/C4): the Scenario
 * tab's own notice board, alongside the clock and the inject schedule. */
function renderMessagesSection(container) {
  const section = createElement('section', 'field-group messages-section');
  section.append(createElement('h3', null, 'Messages'));
  if (!state.messages.length) {
    section.append(createElement('p', 'panel-note', 'No messages for your cell.'));
    container.append(section);
    return;
  }
  const list = createElement('div', 'message-list');
  // Newest first (already the API's own order — listMessages sorts
  // fired_at DESC — kept explicit here so a live-pushed update can't
  // silently reorder the list out from under a re-render).
  [...state.messages]
    .sort((a, b) => (a.fired_at < b.fired_at ? 1 : a.fired_at > b.fired_at ? -1 : 0))
    .forEach((message) => {
      const row = createElement('div', 'message-row');
      row.append(createElement('span', 'message-dtg', formatDate(message.fired_at)));
      row.append(renderCellBadge(message.owner_cell));
      row.append(createElement('span', 'message-text', message.text));
      list.append(row);
    });
  section.append(list);
  container.append(section);
}

// --- Mount -------------------------------------------------------------------

export function mount({ root, status }) {
  root.innerHTML = template;
  state = createState();
  elements = queryElements(root);
  createDialogNode(root);
  const { session } = state;

  // Shared plumbing every tab controller (collection.js, products.js) gets, built
  // once so they all use the exact same dialog/request/error affordances view.js
  // already has instead of re-implementing them. reportsController also needs
  // evidenceTargets() (view.js-local: reads state.requirements/sirs); situationController
  // needs switchTab to jump to the Reports tab from a linked report.
  const ctx = {
    requestJson,
    createElement,
    askText,
    askConfirm,
    showError,
    formatDate,
    api: API,
    evidenceTargets,
    switchTab,
  };
  collectionController = createCollectionController(ctx);
  productsController = createProductsController(ctx);
  reportsController = createReportsController(ctx);
  situationController = createSituationController(ctx);
  instructorController = createInstructorController(ctx);

  const statusLight = createElement('span', 'status-light');
  const statusText = createElement('span', null, 'Exercise workbench');
  status.replaceChildren(statusLight, statusText);
  elements.statusText = statusText;

  elements.tabNav.addEventListener('click', (event) => {
    const button = event.target.closest('.tab-button');
    if (!button) return;
    state.guide.open =
      listTasks(state.guide.list).find((task) => task.tab === button.dataset.tab)?.id ?? null;
    switchTab(button.dataset.tab);
  });
  document.addEventListener('keydown', onGeoKeydown);

  readLocation();
  renderTabNav();
  const { chosen } = guideLists();
  state.guide.list = state.tab === 'instructor' ? 'excon' : chosen;
  renderGuide();

  loadAll()
    .then(() => {
      renderPanel();
      updateMastheadStatus();
      refreshGuide().then(() => {
        if (
          !session.signal.aborted &&
          !isWhite() &&
          !new URLSearchParams(window.location.search).has('tab')
        ) {
          const task = listTasks(state.guide.list).find((entry) => entry.id === state.guide.open);
          if (task && task.tab !== state.tab) switchTab(task.tab);
        }
      });
    })
    .catch((error) => {
      if (error.name === 'AbortError') return;
      elements.panel.replaceChildren(createElement('p', 'inline-error', error.message));
    });

  // The server fires due injects on scenario time (see routes.js `connect`);
  // refresh the inject list and masthead when it announces that it did —
  // one live event per fired inject now (docs/adr/0002-item-scoped-requests.md:
  // each is announced only to its own cells), not one flat tick.
  state.unsubscribeTick = subscribe(
    (event) => event.module === 'exercise' && /^scenario-events\/\d+\/fire$/.test(event.route),
    async () => {
      try {
        await loadAll();
        updateMastheadStatus();
        if (state.tab === 'scenario') renderPanel();
      } catch (error) {
        if (error.name !== 'AbortError') throw error;
      }
    },
  );

  let guideTimer = null;
  const scheduleGuideRefresh = () => {
    window.clearTimeout(guideTimer);
    guideTimer = window.setTimeout(async () => {
      try {
        await loadAll();
        await refreshGuide();
      } catch (error) {
        if (error.name !== 'AbortError') console.warn('[exercise] guide refresh:', error.message);
      }
    }, 800);
  };
  const unsubscribeGuide = subscribe((event) => event.module === 'exercise', scheduleGuideRefresh);
  state.guide.refresh = scheduleGuideRefresh;

  return () => {
    window.clearTimeout(guideTimer);
    unsubscribeGuide();
    state.unsubscribeTick();
    document.removeEventListener('keydown', onGeoKeydown);
    destroyGeoMap();
    collectionController.leave();
    productsController.leave();
    reportsController.leave();
    situationController.leave();
    instructorController.leave();
    session.abort();
    root.replaceChildren();
  };
}
