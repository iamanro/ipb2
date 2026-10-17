// The IPB guide (tools panel) beside the map.

import { parseCoordinate } from '../../../src/geo.js';
import { can } from '../../../src/session.js';
import { renderExchangeTools } from './exchange.js';
import { renderAreaTool } from './areas.js';
import { refreshGuide, renderGuide } from './guide.js';
import { firstOpenTask, stepProgress, taskAfter, taskStatuses } from './guideTasks.js';
import { renderSitempTools } from './sitemp.js';
import { importThreatsFromOrbat } from './threatSymbols.js';

import {
  API,
  canEditStudy,
  canSwitchStudies,
  createElement,
  createStudy,
  editable,
  elements,
  jumpToCoordinate,
  renderDrawButtons,
  requestJson,
  showError,
  state,
  switchStep,
  syncMapFeatures,
  toggleSheet,
} from './view.js';
import { renderWeatherPointGroup } from './step1.js';
import {
  MAX_VIEWSHED_POSTS,
  armLosTool,
  armViewshedTool,
  clearViewshedPosts,
  heightInput,
  paintMobility,
  renderAvenueTools,
  renderKeyTerrainTools,
  renderStep2Worksheet,
  runMobility,
} from './step2.js';
import {
  addManualThreat,
  renderBookmarkedEquipment,
  renderEquipmentResults,
  renderStep3Worksheet,
  searchEquipment,
} from './step3.js';
import { createCoa, renderStep4Worksheet } from './step4.js';

const MOBILITY_CELL_SIZES = [50, 100, 200];

// --- The guide (tools panel) --------------------------------------------------

function canEditHere() {
  return can('analyst') && canEditStudy();
}

/** Shows the worksheet (opening its sheet if put away) scrolled to `selector` in this step. */
function showInWorksheet(selector) {
  if (!state.sheets.worksheet) toggleSheet('worksheet');
  const target = elements[`worksheet${state.step}`].querySelector(selector);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.classList.remove('worksheet-flash');
  void target.offsetWidth; // restart the flash
  target.classList.add('worksheet-flash');
}

function worksheetLink(label, selector) {
  const button = createElement('button', 'chip-button', `${label} →`);
  button.type = 'button';
  button.addEventListener('click', () => showInWorksheet(selector));
  return button;
}

function drawRow(layer) {
  const row = createElement('div', 'oakoc-tool-row');
  row.append(createElement('span', 'oakoc-tool-label', 'Draw'), renderDrawButtons(layer));
  return row;
}

function toolGroup(...children) {
  const group = createElement('div', 'field-group');
  group.append(...children);
  return group;
}

function renderJumpGroup() {
  const jumpGroup = createElement('div', 'field-group');
  jumpGroup.append(createElement('h3', null, 'Jump to coordinate'));
  const jumpRow = createElement('div', 'inline-form');
  const jumpInput = document.createElement('input');
  jumpInput.type = 'text';
  jumpInput.placeholder = 'MGRS, UTM, or DD…';
  jumpInput.setAttribute('aria-label', 'Coordinate to jump to');
  const jumpButton = createElement('button', 'chip-button', 'Go');
  jumpButton.type = 'button';
  const jumpError = createElement('p', 'inline-error');
  jumpError.hidden = true;
  const jump = () => {
    const parsed = parseCoordinate(jumpInput.value.trim());
    if (!parsed) {
      jumpError.hidden = false;
      jumpError.textContent = 'Could not parse that coordinate.';
      return;
    }
    jumpError.hidden = true;
    jumpToCoordinate(parsed.lon, parsed.lat);
  };
  jumpButton.addEventListener('click', jump);
  jumpInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') jump();
  });
  jumpRow.append(jumpInput, jumpButton);
  jumpGroup.append(jumpRow, jumpError);
  return jumpGroup;
}

/** "More tools": the ones a staff reaches for now and then, in every step. */
function renderMoreTools() {
  return [
    renderJumpGroup(),
    renderExchangeTools({
      createElement,
      requestJson,
      showError,
      can: canEditHere(),
      getStudyId: () => state.studyId,
      onImported: (items) => {
        state.study.features.push(...items);
        syncMapFeatures();
        renderStep2Worksheet();
        renderStep4Worksheet();
      },
    }),
    // The same node every render: renderCustomLayers fills it in place.
    elements.customLayers,
  ];
}

function renderMcooGroup(bounds) {
  const group = createElement('div', 'field-group');
  if (!bounds) {
    group.append(createElement('p', 'tool-hint', 'Set the AOI in step 1 first.'));
    return group;
  }
  const cellSizeLabel = createElement('label', 'inline-field');
  cellSizeLabel.append(createElement('span', null, 'Cell size'));
  const cellSelect = document.createElement('select');
  MOBILITY_CELL_SIZES.forEach((size) => {
    const option = document.createElement('option');
    option.value = String(size);
    option.textContent = `${size} m`;
    if (size === state.mobility.cell) option.selected = true;
    cellSelect.append(option);
  });
  cellSelect.addEventListener('change', () => {
    state.mobility.cell = Number(cellSelect.value);
  });
  cellSizeLabel.append(cellSelect);
  const runButton = editable(
    createElement('button', 'primary-button', state.mobility.running ? 'Running…' : 'Run MCOO'),
  );
  runButton.type = 'button';
  runButton.disabled = state.mobility.running;
  runButton.addEventListener('click', runMobility);
  const opacityLabel = createElement('label', 'inline-field');
  opacityLabel.append(createElement('span', null, 'Overlay opacity'));
  const opacityInput = document.createElement('input');
  opacityInput.type = 'range';
  opacityInput.min = '0';
  opacityInput.max = '100';
  opacityInput.value = String(Math.round(state.mobility.opacity * 100));
  opacityInput.addEventListener('input', () => {
    state.mobility.opacity = Number(opacityInput.value) / 100;
    paintMobility();
  });
  opacityLabel.append(opacityInput);
  group.append(cellSizeLabel, runButton, opacityLabel);
  return group;
}

function renderViewshedGroup() {
  const group = createElement('div', 'field-group');
  group.append(createElement('h3', null, 'Viewshed'));
  const radiusLabel = createElement('label', 'inline-field');
  radiusLabel.append(createElement('span', null, 'Radius (m)'));
  const radiusInput = document.createElement('input');
  radiusInput.type = 'number';
  radiusInput.min = '200';
  radiusInput.max = '25000';
  radiusInput.step = 'any';
  radiusInput.value = String(state.viewshedForm.radius);
  radiusInput.addEventListener('change', () => {
    const parsed = Number(radiusInput.value);
    if (Number.isFinite(parsed)) state.viewshedForm.radius = Math.min(Math.max(parsed, 200), 25000);
  });
  radiusLabel.append(radiusInput);
  group.append(
    radiusLabel,
    heightInput('Observer height (m)', state.viewshedForm.observer, (value) => {
      state.viewshedForm.observer = value;
    }),
    heightInput('Target height (m)', state.viewshedForm.target, (value) => {
      state.viewshedForm.target = value;
    }),
  );
  const actions = createElement('div', 'button-row');
  const viewshedButton = editable(
    createElement(
      'button',
      'chip-button',
      state.tool?.type === 'viewshed-pick' ? 'Picking…' : 'Add observation post',
    ),
  );
  viewshedButton.type = 'button';
  viewshedButton.disabled = state.viewshedPosts.length >= MAX_VIEWSHED_POSTS;
  viewshedButton.addEventListener('click', armViewshedTool);
  actions.append(viewshedButton);
  if (state.viewshedPosts.length) {
    const clearButton = createElement('button', 'text-button', 'Clear posts');
    clearButton.type = 'button';
    clearButton.addEventListener('click', clearViewshedPosts);
    actions.append(clearButton);
  }
  group.append(actions);
  if (state.viewshedPosts.length) {
    group.append(
      createElement(
        'p',
        'tool-hint',
        `${state.viewshedPosts.length} post${state.viewshedPosts.length > 1 ? 's' : ''}: dark = dead ground, deeper orange = seen by two or more.`,
      ),
    );
  }
  return group;
}

function renderLosGroup() {
  const group = createElement('div', 'field-group');
  group.append(createElement('h3', null, 'Line of sight'));
  group.append(
    heightInput('Observer height (m)', state.losForm.observer, (value) => {
      state.losForm.observer = value;
    }),
    heightInput('Target height (m)', state.losForm.target, (value) => {
      state.losForm.target = value;
    }),
  );
  const losButton = editable(
    createElement(
      'button',
      'chip-button',
      state.tool?.type === 'los-pick' ? 'Picking…' : 'Pick two points',
    ),
  );
  losButton.type = 'button';
  losButton.addEventListener('click', armLosTool);
  group.append(losButton);
  return group;
}

function renderAddThreatGroup() {
  const group = createElement('div', 'field-group');
  const addRow = createElement('div', 'inline-form');
  const nameInput = editable(document.createElement('input'), { hide: true });
  nameInput.type = 'text';
  nameInput.placeholder = 'Unit or system name…';
  nameInput.setAttribute('aria-label', 'New threat name');
  const addButton = editable(createElement('button', 'chip-button', 'Add'));
  addButton.type = 'button';
  const submitAdd = () => {
    const name = nameInput.value.trim();
    if (!name) return;
    nameInput.value = '';
    addManualThreat(name);
  };
  addButton.addEventListener('click', submitAdd);
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitAdd();
  });
  addRow.append(nameInput, addButton);
  group.append(addRow);
  if (canEditHere()) {
    const importButton = createElement('button', 'chip-button', 'Import from ORBAT…');
    importButton.type = 'button';
    importButton.addEventListener('click', async () => {
      const created = await importThreatsFromOrbat({
        requestJson,
        studyId: state.studyId,
        api: API,
        onError: (error) => showError(elements.worksheet3, error.message),
      });
      if (created?.length) {
        state.study.threats.push(...created);
        renderStep3Worksheet();
      }
    });
    group.append(importButton);
  }
  return group;
}

function renderEquipmentGroups() {
  const lookupGroup = createElement('div', 'field-group');
  lookupGroup.append(createElement('h3', null, 'Equipment lookup'));
  const searchField = createElement('label', 'search-field');
  searchField.setAttribute('for', 'equipment-lookup');
  searchField.append(createElement('span', null, 'Search the sibling equipment catalogue'));
  const searchControl = createElement('div', 'search-control');
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.autocomplete = 'off';
  searchInput.placeholder = 'Tank, radar, designation…';
  searchInput.id = 'equipment-lookup';
  const searchIcon = createElement('span', null, '⌕');
  searchIcon.setAttribute('aria-hidden', 'true');
  searchControl.append(searchIcon, searchInput);
  searchField.append(searchControl);
  const results = createElement('div', 'equipment-results');
  let timer;
  searchInput.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      state.equipmentQuery = searchInput.value.trim();
      if (!state.equipmentQuery) {
        state.equipmentResults = [];
        renderEquipmentResults(results);
        return;
      }
      searchEquipment(state.equipmentQuery, results);
    }, 180);
  });
  lookupGroup.append(searchField, results);
  renderEquipmentResults(results);

  const bookmarksGroup = createElement('div', 'field-group');
  bookmarksGroup.append(createElement('h3', null, 'Your bookmarks'));
  const bookmarksList = createElement('div', 'equipment-results');
  renderBookmarkedEquipment(bookmarksList);
  bookmarksGroup.append(bookmarksList);
  return [lookupGroup, bookmarksGroup];
}

function renderCoaButtons() {
  const likelyButton = editable(createElement('button', 'chip-button', '+ Most likely COA'));
  likelyButton.type = 'button';
  likelyButton.addEventListener('click', () => createCoa('most-likely'));
  const dangerousButton = editable(createElement('button', 'chip-button', '+ Most dangerous COA'));
  dangerousButton.type = 'button';
  dangerousButton.addEventListener('click', () => createCoa('most-dangerous'));
  const row = createElement('div', 'draw-buttons');
  row.append(likelyButton, dangerousButton);
  return toolGroup(row, worksheetLink('Name and describe them in the worksheet', '.coa-list'));
}

function renderSitempTaskBody() {
  const sketch = createElement('div', 'field-group');
  sketch.append(createElement('h3', null, 'COA sketch'));
  if (!state.selectedCoaId) {
    sketch.append(
      createElement('p', 'tool-hint', 'Select a COA in the worksheet to sketch onto it.'),
    );
  }
  sketch.append(renderDrawButtons('coa'));
  const container = createElement('div', 'field-group');
  container.append(
    renderSitempTools({ threats: state.study.threats, canEdit: canEditHere() }),
    sketch,
  );
  return container;
}

/** Each guide task's controls, keyed by task id (`guideTasks.js`). */
const TASK_BODIES = {
  ao: () => renderAreaTool('ao'),
  aoi: () => renderAreaTool('aoi'),
  weather: () =>
    toolGroup(
      worksheetLink('Light data', '.light-data'),
      worksheetLink('Weather forecast', '.weather-forecast'),
      renderWeatherPointGroup(),
    ),
  marking: () =>
    toolGroup(
      worksheetLink('Classification marking', '.classification-field'),
      worksheetLink('Environment notes', '.environment-notes'),
    ),
  mcoo: () => renderMcooGroup(state.study.study.bounds),
  obstacles: () => drawRow('obstacle'),
  'key-terrain': () =>
    toolGroup(renderKeyTerrainTools(state.study.study.bounds), drawRow('key-terrain')),
  avenues: () => toolGroup(renderAvenueTools(state.study.study.bounds), drawRow('avenue')),
  observation: () => toolGroup(renderViewshedGroup(), renderLosGroup()),
  civil: () => worksheetLink('Open the ASCOPE × PMESII-PT matrix', '.civil-matrix-block'),
  threats: () =>
    toolGroup(renderAddThreatGroup(), worksheetLink('The threat table', '.threat-table-block')),
  targets: () => worksheetLink('Symbols, HVT and HPT in the threat table', '.threat-table-block'),
  weapons: () =>
    toolGroup(
      createElement(
        'p',
        'tool-hint',
        'Find the threat’s weapon system, then use Rings in the map toolbar: “Weapon ranges” draws its ranges round a point.',
      ),
      ...renderEquipmentGroups(),
    ),
  coas: renderCoaButtons,
  sitemp: renderSitempTaskBody,
  nais: () => {
    const naiRow = createElement('div', 'oakoc-tool-row');
    naiRow.append(createElement('span', 'oakoc-tool-label', 'NAI'), renderDrawButtons('nai'));
    const taiRow = createElement('div', 'oakoc-tool-row');
    taiRow.append(createElement('span', 'oakoc-tool-label', 'TAI'), renderDrawButtons('tai'));
    return toolGroup(naiRow, taiRow);
  },
  events: () =>
    toolGroup(
      worksheetLink('H-hour', '.h-hour-field'),
      worksheetLink('Event matrix', '.event-matrix-block'),
      worksheetLink('Phases', '.phases-block'),
    ),
  decisions: () => worksheetLink('Decision points', '.decision-points-block'),
  handoff: () => {
    const link = createElement('a', 'chip-button', 'Open Exercise → Requirements →');
    link.href = '/exercise/?tab=requirements';
    return toolGroup(link);
  },
};

/**
 * The task shown open in the current step: the one picked, else the first
 * still to do — then pinned, so finishing it leaves it open (ticked, with
 * Next highlighted) instead of jumping away mid-work.
 */
function openGuideTask() {
  if (!Object.hasOwn(state.guide.open, state.step)) {
    state.guide.open[state.step] = firstOpenTask(state.step, taskStatuses(state.study));
  }
  return state.guide.open[state.step];
}

async function setTaskChecked(taskId, checked) {
  if (!canEditHere()) return;
  const current = new Set(state.study.study.checked ?? []);
  if (checked) current.add(taskId);
  else current.delete(taskId);
  try {
    const updated = await requestJson(`${API}/studies/${state.studyId}`, {
      method: 'PATCH',
      body: { checked: [...current] },
    });
    state.study.study = { ...state.study.study, checked: updated.checked };
    refreshGuideStatus();
  } catch (error) {
    showError(elements.toolPanel, error.message);
  }
}

function goToNextTask(taskId) {
  const next = taskAfter(taskId);
  if (!next) return;
  state.guide.open[next.step] = next.id;
  if (next.step === state.step) renderToolPanel();
  else switchStep(next.step);
  elements.toolPanel
    .querySelector(`[data-task="${next.id}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

export function renderToolPanel() {
  elements.toolPanel.replaceChildren();
  if (!state.study) {
    const empty = createElement('div', 'guide-empty');
    empty.append(
      createElement('h2', 'guide-step-title', 'Start your IPB'),
      createElement(
        'p',
        'panel-note',
        canSwitchStudies()
          ? state.studies.length
            ? 'Open a study from the Study menu at the top, or create one.'
            : 'Create a study for this exercise. The panel then takes you through the four IPB steps, one task at a time.'
          : 'Your cell study opens automatically for this exercise. The panel then takes you through the four IPB steps, one task at a time.',
      ),
    );
    if (can('analyst') && canSwitchStudies()) {
      const create = createElement('button', 'primary-button', '+ Create study');
      create.type = 'button';
      create.addEventListener('click', createStudy);
      empty.append(create);
    }
    elements.toolPanel.append(empty);
    return;
  }
  elements.toolPanel.append(
    renderGuide({
      payload: state.study,
      step: state.step,
      openTaskId: openGuideTask(),
      bodies: TASK_BODIES,
      more: renderMoreTools,
      moreOpen: state.guide.more,
      canEdit: canEditHere(),
      onOpen: (taskId) => {
        state.guide.open[state.step] = taskId;
        renderToolPanel();
      },
      onNext: goToNextTask,
      onCheck: setTaskChecked,
      onMoreToggle: (open) => {
        state.guide.more = open;
      },
    }),
  );
  renderStepProgress();
}

/** "2/4" under each step tab. */
function renderStepProgress() {
  const statuses = state.study ? taskStatuses(state.study) : null;
  elements.stepNav.querySelectorAll('.step-tab').forEach((button) => {
    let counter = button.querySelector('.step-progress');
    if (!statuses) {
      counter?.remove();
      button.classList.remove('step-complete');
      return;
    }
    if (!counter) {
      counter = createElement('small', 'step-progress');
      button.append(counter);
    }
    const { done, total } = stepProgress(Number(button.dataset.step), statuses);
    counter.textContent = `${done}/${total}`;
    counter.setAttribute('aria-label', `${done} of ${total} tasks done`);
    button.classList.toggle('step-complete', done === total);
  });
}

/** Ticks and counters after any change to the study, without rebuilding the open task. */
export function refreshGuideStatus() {
  if (!state.study) return;
  const guide = elements.toolPanel.querySelector(':scope > .guide');
  if (guide) refreshGuide(guide, state.study, { canEdit: canEditHere() });
  renderStepProgress();
}
