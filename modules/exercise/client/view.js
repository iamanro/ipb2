import './styles.css';
import template from './view.html?raw';

const API = '/api/exercise';
const IPB_API = '/api/ipb';
const TABS = ['requirements', 'reports', 'rfi', 'scenario', 'roster', 'activity'];

/** UI affordance only: the server (rfiMachine.js) is the actual guard. */
const RFI_NEXT = {
  draft: ['submitted'],
  submitted: ['assigned', 'rejected'],
  assigned: ['in_collection', 'rejected'],
  in_collection: ['answered'],
  answered: ['closed', 'reopened'],
  reopened: ['assigned'],
  closed: [],
  rejected: [],
};

let state;
let elements;
let dialogNode;

// --- State & elements --------------------------------------------------------

function createState() {
  return {
    session: new AbortController(),
    tab: 'requirements',
    requirements: [],
    reports: [],
    rfis: [],
    roster: [],
    clock: null,
    scenarioEvents: [],
    activity: [],
    importSummary: null,
    tickTimer: null,
  };
}

function queryElements(root) {
  return {
    tabNav: root.querySelector('#tab-nav'),
    panel: root.querySelector('#panel'),
  };
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

async function requestJson(path, { method = 'GET', body, signal = state.session.signal } = {}) {
  const options = { method, signal };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload;
}

function showError(container, message) {
  let node = container.querySelector(':scope > .inline-error');
  if (!node) {
    node = createElement('p', 'inline-error');
    container.prepend(node);
  }
  node.textContent = message;
}

// --- Confirm dialog ----------------------------------------------------------

function askConfirm(message) {
  dialogNode.querySelector('#confirm-message').textContent = message;
  return new Promise((resolve) => {
    const settle = () => {
      dialogNode.removeEventListener('close', settle);
      resolve(dialogNode.returnValue === 'accept');
    };
    dialogNode.addEventListener('close', settle);
    dialogNode.showModal();
  });
}

// --- URL state -----------------------------------------------------------

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  state.tab = TABS.includes(tab) ? tab : 'requirements';
}

function writeLocation() {
  const params = new URLSearchParams();
  params.set('tab', state.tab);
  window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
}

// --- Loading -----------------------------------------------------------------

async function loadAll() {
  const [requirements, reports, rfis, roster, clock, scenarioEvents, activity] = await Promise.all([
    requestJson(`${API}/requirements`),
    requestJson(`${API}/reports`),
    requestJson(`${API}/rfis`),
    requestJson(`${API}/roster`),
    requestJson(`${API}/clock`),
    requestJson(`${API}/scenario-events`),
    requestJson(`${API}/activity`),
  ]);
  state.requirements = requirements;
  state.reports = reports;
  state.rfis = rfis;
  state.roster = roster;
  state.clock = clock;
  state.scenarioEvents = scenarioEvents;
  state.activity = activity;
}

// --- Tab chrome ----------------------------------------------------------------

function renderTabNav() {
  elements.tabNav.querySelectorAll('.tab-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === state.tab);
  });
}

function switchTab(tab) {
  state.tab = tab;
  writeLocation();
  renderTabNav();
  renderPanel();
}

function renderPanel() {
  elements.panel.replaceChildren();
  const renderers = {
    requirements: renderRequirementsPanel,
    reports: renderReportsPanel,
    rfi: renderRfiPanel,
    scenario: renderScenarioPanel,
    roster: renderRosterPanel,
    activity: renderActivityPanel,
  };
  renderers[state.tab]();
}

// --- Requirements panel ----------------------------------------------------

function fulfillmentBar(fulfillment) {
  const wrap = createElement('div', `fulfillment-bar state-${fulfillment.state}`);
  const fill = createElement('div', 'fulfillment-fill');
  fill.style.width = `${fulfillment.percent}%`;
  const label = createElement(
    'span',
    'fulfillment-label',
    `${fulfillment.covered}/${fulfillment.total} SIRs · ${fulfillment.percent}% · ${fulfillment.state}`,
  );
  wrap.append(fill, label);
  return wrap;
}

async function addSir(requirementId, text, container) {
  if (!text.trim()) return;
  try {
    await requestJson(`${API}/requirements/${requirementId}/sirs`, {
      method: 'POST',
      body: { text: text.trim() },
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

async function deleteSir(id) {
  if (!(await askConfirm('Delete this SIR and its indicators?'))) return;
  await requestJson(`${API}/sirs/${id}`, { method: 'DELETE' });
  await loadAll();
  renderPanel();
}

async function addIndicator(sirId, description, container) {
  if (!description.trim()) return;
  try {
    await requestJson(`${API}/sirs/${sirId}/indicators`, {
      method: 'POST',
      body: { description: description.trim() },
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

async function toggleIndicator(indicator) {
  await requestJson(`${API}/indicators/${indicator.id}`, {
    method: 'PATCH',
    body: { observed: !indicator.observed },
  });
  await loadAll();
  renderPanel();
}

async function deleteIndicator(id) {
  await requestJson(`${API}/indicators/${id}`, { method: 'DELETE' });
  await loadAll();
  renderPanel();
}

function renderSirRow(sir) {
  const row = createElement('div', 'sir-row');
  const header = createElement('div', 'sir-row-header');
  header.append(createElement('strong', null, sir.text));
  const deleteButton = createElement('button', 'icon-button danger', 'Delete');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteSir(sir.id));
  header.append(deleteButton);
  row.append(header, fulfillmentBar(sir.fulfillment));

  const indicatorList = createElement('ul', 'indicator-list');
  sir.indicators.forEach((indicator) => {
    const item = createElement('li', 'indicator-item');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = indicator.observed;
    checkbox.addEventListener('change', () => toggleIndicator(indicator));
    const label = createElement('span', null, indicator.description);
    const remove = createElement('button', 'icon-button danger', '×');
    remove.type = 'button';
    remove.title = 'Delete indicator';
    remove.addEventListener('click', () => deleteIndicator(indicator.id));
    item.append(checkbox, label, remove);
    indicatorList.append(item);
  });
  row.append(indicatorList);

  const indicatorForm = createElement('div', 'inline-form');
  const indicatorInput = document.createElement('input');
  indicatorInput.type = 'text';
  indicatorInput.placeholder = 'Observable indicator…';
  const indicatorAdd = createElement('button', 'chip-button', 'Add indicator');
  indicatorAdd.type = 'button';
  indicatorAdd.addEventListener('click', () => {
    const value = indicatorInput.value;
    indicatorInput.value = '';
    addIndicator(sir.id, value, row);
  });
  indicatorForm.append(indicatorInput, indicatorAdd);
  row.append(indicatorForm);

  return row;
}

async function deleteRequirement(id) {
  if (!(await askConfirm('Delete this requirement, its SIRs, and indicators?'))) return;
  await requestJson(`${API}/requirements/${id}`, { method: 'DELETE' });
  await loadAll();
  renderPanel();
}

function renderRequirementCard(requirement) {
  const card = createElement('article', 'requirement-card');
  const header = createElement('div', 'requirement-header');
  header.append(
    createElement('span', `kind-badge kind-${requirement.kind}`, requirement.kind),
    createElement('span', 'requirement-priority', `Priority ${requirement.priority}`),
  );
  if (requirement.source?.startsWith('ipb:')) {
    const badge = createElement('span', 'source-badge', 'From IPB');
    badge.title =
      'Derived from an IPB event matrix; re-importing that study refreshes its wording.';
    header.append(badge);
  }
  const deleteButton = createElement('button', 'icon-button danger', 'Delete');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteRequirement(requirement.id));
  header.append(deleteButton);
  card.append(header);
  card.append(createElement('h3', null, requirement.text));
  const meta = createElement('p', 'panel-note');
  meta.textContent = `Decision point: ${requirement.decision_point || '—'} · LTIOV: ${formatDate(requirement.ltiov)}`;
  card.append(meta);
  card.append(fulfillmentBar(requirement.fulfillment));

  const sirList = createElement('div', 'sir-list');
  requirement.sirs.forEach((sir) => sirList.append(renderSirRow(sir)));
  card.append(sirList);

  const sirForm = createElement('div', 'inline-form');
  const sirInput = document.createElement('input');
  sirInput.type = 'text';
  sirInput.placeholder = 'What, where, when to observe…';
  const sirAdd = createElement('button', 'chip-button', 'Add SIR');
  sirAdd.type = 'button';
  sirAdd.addEventListener('click', () => {
    const value = sirInput.value;
    sirInput.value = '';
    addSir(requirement.id, value, card);
  });
  sirForm.append(sirInput, sirAdd);
  card.append(sirForm);

  return card;
}

async function createRequirement(form, container) {
  const kind = form.querySelector('[name=kind]').value;
  const text = form.querySelector('[name=text]').value.trim();
  const priority = Number.parseInt(form.querySelector('[name=priority]').value, 10) || 0;
  const decisionPoint = form.querySelector('[name=decision_point]').value.trim();
  const ltiov = form.querySelector('[name=ltiov]').value;
  if (!text) return;
  try {
    await requestJson(`${API}/requirements`, {
      method: 'POST',
      body: {
        kind,
        text,
        priority,
        decision_point: decisionPoint || null,
        ltiov: ltiov ? new Date(ltiov).toISOString() : null,
      },
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

/**
 * Sends only the event-matrix subset of the IPB study aggregate; the
 * exercise server (ipbImport.js) owns the mapping to PIR/SIR/indicator.
 */
async function importIpbStudy(studyId, container) {
  try {
    const { study, coas, events, features } = await requestJson(`${IPB_API}/studies/${studyId}`);
    const counts = await requestJson(`${API}/import/ipb`, {
      method: 'POST',
      body: {
        study: { id: study.id, name: study.name },
        coas: coas.map((coa) => ({ id: coa.id, name: coa.name, kind: coa.kind })),
        nais: features
          .filter((feature) => feature.layer === 'nai')
          .map((feature) => ({ id: feature.id, label: feature.label })),
        events: events.map((event) => ({
          id: event.id,
          coa_id: event.coa_id,
          nai_feature_id: event.nai_feature_id,
          indicator: event.indicator,
          expected_time: event.expected_time,
          observed_status: event.observed_status,
        })),
      },
    });
    state.importSummary = { study: study.name, counts };
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

function describeImport({ study, counts }) {
  const part = (label, { created, updated, stale }) =>
    `${label} ${created} new, ${updated} updated${stale.length ? `, ${stale.length} no longer in IPB (kept)` : ''}`;
  return `Imported “${study}”: ${part('PIRs', counts.requirements)} · ${part('SIRs', counts.sirs)} · ${part('indicators', counts.indicators)}.`;
}

function renderIpbImport(container) {
  const section = createElement('section', 'field-group');
  section.append(
    createElement('h3', null, 'Import from IPB'),
    createElement(
      'p',
      'panel-note',
      'Each threat COA becomes a PIR, each NAI it uses a SIR, each event-matrix row an indicator. Re-importing refreshes wording and adds new rows; it never deletes, and keeps observations and evidence.',
    ),
  );
  const form = createElement('div', 'requirement-form');
  const select = document.createElement('select');
  select.name = 'study';
  select.disabled = true;
  select.append(new Option('Loading IPB studies…', ''));
  const button = createElement('button', 'primary-button', 'Import event matrix');
  button.type = 'button';
  button.disabled = true;
  button.addEventListener('click', () => importIpbStudy(select.value, section));
  form.append(select, button);
  section.append(form);
  if (state.importSummary) {
    section.append(createElement('p', 'panel-note', describeImport(state.importSummary)));
    const { counts } = state.importSummary;
    const stale = [...counts.requirements.stale, ...counts.sirs.stale, ...counts.indicators.stale];
    if (stale.length) {
      const list = createElement('ul', 'panel-note stale-list');
      stale.forEach((text) => list.append(createElement('li', null, text)));
      section.append(
        createElement('p', 'panel-note', 'No longer in IPB — delete below if not needed:'),
        list,
      );
    }
  }
  container.append(section);

  requestJson(`${IPB_API}/studies`)
    .then(({ items }) => {
      select.replaceChildren(
        ...(items.length
          ? items.map((study) => new Option(`${study.name} (${study.coa_count} COAs)`, study.id))
          : [new Option('No IPB studies yet', '')]),
      );
      select.disabled = button.disabled = !items.length;
    })
    .catch((error) => {
      if (error.name !== 'AbortError') showError(section, error.message);
    });
}

function renderRequirementsPanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'Requirements — CCIR / PIR / FFIR / SIR'));
  renderIpbImport(container);

  const formSection = createElement('section', 'field-group');
  formSection.append(createElement('h3', null, 'New requirement'));
  const form = createElement('div', 'requirement-form');
  const kindSelect = document.createElement('select');
  kindSelect.name = 'kind';
  [
    ['PIR', 'PIR'],
    ['FFIR', 'FFIR'],
  ].forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    kindSelect.append(option);
  });
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.name = 'text';
  textInput.placeholder = 'Will the enemy attack before D+2?';
  const priorityInput = document.createElement('input');
  priorityInput.type = 'number';
  priorityInput.name = 'priority';
  priorityInput.placeholder = 'Priority';
  priorityInput.value = '0';
  const decisionInput = document.createElement('input');
  decisionInput.type = 'text';
  decisionInput.name = 'decision_point';
  decisionInput.placeholder = 'Decision point (optional)';
  const ltiovInput = document.createElement('input');
  ltiovInput.type = 'datetime-local';
  ltiovInput.name = 'ltiov';
  const addButton = createElement('button', 'primary-button', 'Add requirement');
  addButton.type = 'button';
  addButton.addEventListener('click', () => createRequirement(form, formSection));
  form.append(kindSelect, textInput, priorityInput, decisionInput, ltiovInput, addButton);
  formSection.append(form);
  container.append(formSection);

  if (!state.requirements.length) {
    container.append(createElement('p', 'panel-note', 'No requirements yet.'));
    return;
  }
  const list = createElement('div', 'requirement-list');
  state.requirements.forEach((requirement) => list.append(renderRequirementCard(requirement)));
  container.append(list);
}

// --- Reports panel -------------------------------------------------------------

function evidenceTargets() {
  const options = [];
  state.requirements.forEach((requirement) => {
    options.push({
      kind: 'requirement',
      id: requirement.id,
      label: `${requirement.kind} • ${requirement.text}`,
    });
    requirement.sirs.forEach((sir) => {
      options.push({ kind: 'sir', id: sir.id, label: `↳ SIR • ${sir.text}` });
    });
  });
  return options;
}

async function addEvidenceLink(reportId, form, container) {
  const [kind, id] = form.querySelector('[name=target]').value.split(':');
  const relation = form.querySelector('[name=relation]').value;
  const note = form.querySelector('[name=note]').value.trim();
  try {
    await requestJson(`${API}/reports/${reportId}/links`, {
      method: 'POST',
      body: { target_kind: kind, target_id: Number.parseInt(id, 10), relation, note: note || null },
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

async function deleteEvidenceLink(id) {
  await requestJson(`${API}/links/${id}`, { method: 'DELETE' });
  await loadAll();
  renderPanel();
}

async function deleteReport(id) {
  if (!(await askConfirm('Delete this report and its evidence links?'))) return;
  await requestJson(`${API}/reports/${id}`, { method: 'DELETE' });
  await loadAll();
  renderPanel();
}

function renderReportCard(report) {
  const card = createElement('article', 'report-card');
  const header = createElement('div', 'report-header');
  header.append(
    createElement('span', 'admiralty-badge', `${report.reliability}${report.credibility}`),
    createElement('span', 'panel-note', formatDate(report.occurred_at || report.created_at)),
  );
  const deleteButton = createElement('button', 'icon-button danger', 'Delete');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteReport(report.id));
  header.append(deleteButton);
  card.append(header);
  card.append(createElement('p', null, report.text));
  card.append(
    createElement(
      'p',
      'panel-note',
      `Source: ${report.source || '—'} · Author: ${report.author || '—'}`,
    ),
  );

  const linkList = createElement('ul', 'evidence-list');
  report.links.forEach((link) => {
    const item = createElement('li', 'evidence-item');
    const targetOption = evidenceTargets().find(
      (option) => option.kind === link.target_kind && option.id === link.target_id,
    );
    item.append(
      createElement('span', `relation-badge relation-${link.relation}`, link.relation),
      createElement(
        'span',
        null,
        targetOption ? targetOption.label : `${link.target_kind} #${link.target_id}`,
      ),
    );
    const remove = createElement('button', 'icon-button danger', '×');
    remove.type = 'button';
    remove.addEventListener('click', () => deleteEvidenceLink(link.id));
    item.append(remove);
    linkList.append(item);
  });
  card.append(linkList);

  const targets = evidenceTargets();
  if (targets.length) {
    const form = createElement('div', 'inline-form');
    const targetSelect = document.createElement('select');
    targetSelect.name = 'target';
    targets.forEach((option) => {
      const opt = document.createElement('option');
      opt.value = `${option.kind}:${option.id}`;
      opt.textContent = option.label;
      targetSelect.append(opt);
    });
    const relationSelect = document.createElement('select');
    relationSelect.name = 'relation';
    ['confirms', 'denies', 'partial', 'context'].forEach((relation) => {
      const opt = document.createElement('option');
      opt.value = relation;
      opt.textContent = relation;
      relationSelect.append(opt);
    });
    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.name = 'note';
    noteInput.placeholder = 'Note (optional)';
    const linkButton = createElement('button', 'chip-button', 'Link evidence');
    linkButton.type = 'button';
    linkButton.addEventListener('click', () => addEvidenceLink(report.id, form, card));
    form.append(targetSelect, relationSelect, noteInput, linkButton);
    card.append(form);
  } else {
    card.append(createElement('p', 'panel-note', 'Create a requirement or SIR to link evidence.'));
  }

  return card;
}

async function createReport(form, container) {
  const text = form.querySelector('[name=text]').value.trim();
  const reliability = form.querySelector('[name=reliability]').value;
  const credibility = Number.parseInt(form.querySelector('[name=credibility]').value, 10);
  const source = form.querySelector('[name=source]').value.trim();
  const author = form.querySelector('[name=author]').value.trim();
  if (!text) return;
  try {
    await requestJson(`${API}/reports`, {
      method: 'POST',
      body: { text, reliability, credibility, source: source || null, author: author || null },
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

function renderReportsPanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'Reports & evidence'));

  const formSection = createElement('section', 'field-group');
  formSection.append(createElement('h3', null, 'New report'));
  const form = createElement('div', 'requirement-form');
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.name = 'text';
  textInput.placeholder = 'What was observed…';
  const reliabilitySelect = document.createElement('select');
  reliabilitySelect.name = 'reliability';
  'ABCDEF'.split('').forEach((letter) => {
    const option = document.createElement('option');
    option.value = letter;
    option.textContent = `Reliability ${letter}`;
    reliabilitySelect.append(option);
  });
  const credibilitySelect = document.createElement('select');
  credibilitySelect.name = 'credibility';
  [1, 2, 3, 4, 5, 6].forEach((n) => {
    const option = document.createElement('option');
    option.value = String(n);
    option.textContent = `Credibility ${n}`;
    credibilitySelect.append(option);
  });
  const sourceInput = document.createElement('input');
  sourceInput.type = 'text';
  sourceInput.name = 'source';
  sourceInput.placeholder = 'Source (optional)';
  const authorInput = document.createElement('input');
  authorInput.type = 'text';
  authorInput.name = 'author';
  authorInput.placeholder = 'Author (optional)';
  const addButton = createElement('button', 'primary-button', 'Add report');
  addButton.type = 'button';
  addButton.addEventListener('click', () => createReport(form, formSection));
  form.append(textInput, reliabilitySelect, credibilitySelect, sourceInput, authorInput, addButton);
  formSection.append(form);
  container.append(formSection);

  if (!state.reports.length) {
    container.append(createElement('p', 'panel-note', 'No reports yet.'));
    return;
  }
  const list = createElement('div', 'report-list');
  state.reports.forEach((report) => list.append(renderReportCard(report)));
  container.append(list);
}

// --- RFI panel -----------------------------------------------------------------

async function createRfi(form, container) {
  const question = form.querySelector('[name=question]').value.trim();
  const priority = form.querySelector('[name=priority]').value;
  const nlt = form.querySelector('[name=nlt]').value;
  const target = form.querySelector('[name=target]').value;
  if (!question) return;
  const [kind, id] = target ? target.split(':') : [null, null];
  try {
    await requestJson(`${API}/rfis`, {
      method: 'POST',
      body: {
        question,
        priority,
        nlt: nlt ? new Date(nlt).toISOString() : null,
        requirement_id: kind === 'requirement' ? Number.parseInt(id, 10) : null,
        sir_id: kind === 'sir' ? Number.parseInt(id, 10) : null,
      },
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

async function transitionRfi(rfi, toState, extra, container) {
  try {
    await requestJson(`${API}/rfis/${rfi.id}/transition`, {
      method: 'POST',
      body: { state: toState, ...extra },
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

async function deleteRfi(id) {
  if (!(await askConfirm('Delete this RFI?'))) return;
  await requestJson(`${API}/rfis/${id}`, { method: 'DELETE' });
  await loadAll();
  renderPanel();
}

function renderRfiRow(rfi) {
  const row = createElement('div', `rfi-row state-${rfi.state}`);
  const header = createElement('div', 'rfi-header');
  header.append(
    createElement('span', `rfi-state rfi-state-${rfi.state}`, rfi.state.replace('_', ' ')),
    createElement('span', `rfi-priority rfi-priority-${rfi.priority}`, rfi.priority),
    createElement('span', 'panel-note', `NLT: ${formatDate(rfi.nlt)}`),
  );
  const deleteButton = createElement('button', 'icon-button danger', 'Delete');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteRfi(rfi.id));
  header.append(deleteButton);
  row.append(header);
  row.append(createElement('p', null, rfi.question));

  const actions = createElement('div', 'rfi-actions');
  const nextStates = RFI_NEXT[rfi.state] || [];
  nextStates.forEach((toState) => {
    if (toState === 'answered') {
      if (!state.reports.length) {
        actions.append(createElement('p', 'panel-note', 'Create a report to answer this RFI.'));
        return;
      }
      const select = document.createElement('select');
      state.reports.forEach((report) => {
        const option = document.createElement('option');
        option.value = String(report.id);
        option.textContent = report.text.slice(0, 40);
        select.append(option);
      });
      const answerButton = createElement('button', 'chip-button', 'Answer with report');
      answerButton.type = 'button';
      answerButton.addEventListener('click', () =>
        transitionRfi(
          rfi,
          'answered',
          { answer_report_id: Number.parseInt(select.value, 10) },
          row,
        ),
      );
      actions.append(select, answerButton);
      return;
    }
    const button = createElement('button', 'chip-button', toState.replace('_', ' '));
    button.type = 'button';
    button.addEventListener('click', () => transitionRfi(rfi, toState, {}, row));
    actions.append(button);
  });
  row.append(actions);
  return row;
}

function renderRfiPanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'RFI'));

  const formSection = createElement('section', 'field-group');
  formSection.append(createElement('h3', null, 'New RFI'));
  const form = createElement('div', 'requirement-form');
  const questionInput = document.createElement('input');
  questionInput.type = 'text';
  questionInput.name = 'question';
  questionInput.placeholder = 'Question…';
  const prioritySelect = document.createElement('select');
  prioritySelect.name = 'priority';
  ['routine', 'priority', 'immediate'].forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    prioritySelect.append(option);
  });
  const targetSelect = document.createElement('select');
  targetSelect.name = 'target';
  targetSelect.append(new Option('No linked requirement', ''));
  evidenceTargets().forEach((option) =>
    targetSelect.append(new Option(option.label, `${option.kind}:${option.id}`)),
  );
  const nltInput = document.createElement('input');
  nltInput.type = 'datetime-local';
  nltInput.name = 'nlt';
  const addButton = createElement('button', 'primary-button', 'Submit RFI');
  addButton.type = 'button';
  addButton.addEventListener('click', () => createRfi(form, formSection));
  form.append(questionInput, prioritySelect, targetSelect, nltInput, addButton);
  formSection.append(form);
  container.append(formSection);

  if (!state.rfis.length) {
    container.append(createElement('p', 'panel-note', 'No RFIs yet.'));
    return;
  }
  const list = createElement('div', 'rfi-list');
  state.rfis.forEach((rfi) => list.append(renderRfiRow(rfi)));
  container.append(list);
}

// --- Scenario panel --------------------------------------------------------

function updateMastheadStatus() {
  if (!elements.statusText || !state.clock) return;
  elements.statusText.textContent = state.clock.paused
    ? 'Clock paused'
    : `Clock running ×${state.clock.rate}`;
}

async function patchClock(body, container) {
  try {
    await requestJson(`${API}/clock`, { method: 'PATCH', body });
    await loadAll();
    renderPanel();
    updateMastheadStatus();
  } catch (error) {
    showError(container, error.message);
  }
}

async function createScenarioEvent(form, container) {
  const kind = form.querySelector('[name=kind]').value;
  const triggerAt = form.querySelector('[name=trigger_at]').value;
  const text = form.querySelector('[name=text]').value.trim();
  if (!triggerAt || !text) return;
  const payload =
    kind === 'message'
      ? { text }
      : {
          text,
          reliability: form.querySelector('[name=reliability]').value,
          credibility: Number.parseInt(form.querySelector('[name=credibility]').value, 10),
        };
  try {
    await requestJson(`${API}/scenario-events`, {
      method: 'POST',
      body: { trigger_at: new Date(triggerAt).toISOString(), kind, payload },
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

async function fireEventNow(id) {
  await requestJson(`${API}/scenario-events/${id}/fire`, { method: 'POST' });
  await loadAll();
  renderPanel();
}

async function cancelEvent(id) {
  await requestJson(`${API}/scenario-events/${id}/cancel`, { method: 'POST' });
  await loadAll();
  renderPanel();
}

function renderScenarioEventRow(event) {
  const row = createElement('div', `scenario-event-row state-${event.state}`);
  row.append(
    createElement('span', `scenario-event-kind kind-${event.kind}`, event.kind),
    createElement('span', null, formatDate(event.trigger_at)),
    createElement('span', null, event.payload.text || ''),
    createElement('span', `scenario-event-state`, event.state),
  );
  if (event.state === 'pending') {
    const fireButton = createElement('button', 'icon-button', 'Fire now');
    fireButton.type = 'button';
    fireButton.addEventListener('click', () => fireEventNow(event.id));
    const cancelButton = createElement('button', 'icon-button danger', 'Cancel');
    cancelButton.type = 'button';
    cancelButton.addEventListener('click', () => cancelEvent(event.id));
    row.append(fireButton, cancelButton);
  }
  return row;
}

function renderScenarioPanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'Scenario clock & injects'));

  const clockSection = createElement('section', 'field-group clock-panel');
  const clock = state.clock;
  clockSection.append(
    createElement('p', 'clock-now', `Scenario time: ${formatDate(clock.now)}`),
    createElement(
      'p',
      'panel-note',
      `Rate ${clock.rate}× · ${clock.paused ? 'Paused' : 'Running'}`,
    ),
  );
  const controls = createElement('div', 'inline-form');
  const toggleButton = createElement('button', 'primary-button', clock.paused ? 'Resume' : 'Pause');
  toggleButton.type = 'button';
  toggleButton.addEventListener('click', () => patchClock({ paused: !clock.paused }, clockSection));
  const rateInput = document.createElement('input');
  rateInput.type = 'number';
  rateInput.min = '0.1';
  rateInput.step = '0.1';
  rateInput.value = String(clock.rate);
  const rateButton = createElement('button', 'chip-button', 'Set rate');
  rateButton.type = 'button';
  rateButton.addEventListener('click', () =>
    patchClock({ rate: Number.parseFloat(rateInput.value) }, clockSection),
  );
  const jumpInput = document.createElement('input');
  jumpInput.type = 'datetime-local';
  const jumpButton = createElement('button', 'chip-button', 'Jump to');
  jumpButton.type = 'button';
  jumpButton.addEventListener('click', () => {
    if (!jumpInput.value) return;
    patchClock({ jump_to: new Date(jumpInput.value).toISOString() }, clockSection);
  });
  const tickButton = createElement('button', 'chip-button', 'Fire due events now');
  tickButton.type = 'button';
  tickButton.addEventListener('click', async () => {
    await requestJson(`${API}/scenario-tick`, { method: 'POST' });
    await loadAll();
    renderPanel();
  });
  controls.append(toggleButton, rateInput, rateButton, jumpInput, jumpButton, tickButton);
  clockSection.append(controls);
  container.append(clockSection);

  const formSection = createElement('section', 'field-group');
  formSection.append(createElement('h3', null, 'Schedule an inject'));
  const form = createElement('div', 'requirement-form');
  const kindSelect = document.createElement('select');
  kindSelect.name = 'kind';
  kindSelect.append(new Option('Message', 'message'), new Option('Report', 'report'));
  const triggerInput = document.createElement('input');
  triggerInput.type = 'datetime-local';
  triggerInput.name = 'trigger_at';
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.name = 'text';
  textInput.placeholder = 'Inject text…';
  const reliabilitySelect = document.createElement('select');
  reliabilitySelect.name = 'reliability';
  'ABCDEF'.split('').forEach((letter) => reliabilitySelect.append(new Option(letter, letter)));
  const credibilitySelect = document.createElement('select');
  credibilitySelect.name = 'credibility';
  [1, 2, 3, 4, 5, 6].forEach((n) => credibilitySelect.append(new Option(String(n), String(n))));
  const addButton = createElement('button', 'primary-button', 'Schedule');
  addButton.type = 'button';
  addButton.addEventListener('click', () => createScenarioEvent(form, formSection));
  form.append(kindSelect, triggerInput, textInput, reliabilitySelect, credibilitySelect, addButton);
  formSection.append(form);
  container.append(formSection);

  if (!state.scenarioEvents.length) {
    container.append(createElement('p', 'panel-note', 'No injects scheduled.'));
    return;
  }
  const list = createElement('div', 'scenario-event-list');
  state.scenarioEvents.forEach((event) => list.append(renderScenarioEventRow(event)));
  container.append(list);
}

// --- Roster panel --------------------------------------------------------------

async function addRosterMember(form, container) {
  const name = form.querySelector('[name=name]').value.trim();
  const role = form.querySelector('[name=role]').value;
  if (!name) return;
  try {
    await requestJson(`${API}/roster`, { method: 'POST', body: { name, role } });
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

async function removeRosterMember(id) {
  if (!(await askConfirm('Remove this roster member?'))) return;
  await requestJson(`${API}/roster/${id}`, { method: 'DELETE' });
  await loadAll();
  renderPanel();
}

function renderRosterPanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'Roster'));

  const formSection = createElement('section', 'field-group');
  const form = createElement('div', 'requirement-form');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.name = 'name';
  nameInput.placeholder = 'Name…';
  const roleSelect = document.createElement('select');
  roleSelect.name = 'role';
  ['analyst', 'collection-manager', 'game-master'].forEach((role) =>
    roleSelect.append(new Option(role, role)),
  );
  const addButton = createElement('button', 'primary-button', 'Add to roster');
  addButton.type = 'button';
  addButton.addEventListener('click', () => addRosterMember(form, formSection));
  form.append(nameInput, roleSelect, addButton);
  formSection.append(form);
  container.append(formSection);

  if (!state.roster.length) {
    container.append(createElement('p', 'panel-note', 'No one on the roster yet.'));
    return;
  }
  const table = document.createElement('table');
  table.className = 'data-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Name', 'Role', ''].forEach((label) => headRow.append(createElement('th', null, label)));
  head.append(headRow);
  table.append(head);
  const body = document.createElement('tbody');
  state.roster.forEach((member) => {
    const row = document.createElement('tr');
    row.append(createElement('td', null, member.name), createElement('td', null, member.role));
    const actionsCell = document.createElement('td');
    const removeButton = createElement('button', 'icon-button danger', 'Remove');
    removeButton.type = 'button';
    removeButton.addEventListener('click', () => removeRosterMember(member.id));
    actionsCell.append(removeButton);
    row.append(actionsCell);
    body.append(row);
  });
  table.append(body);
  container.append(table);
}

// --- Activity panel --------------------------------------------------------

function exportActivity() {
  const blob = new Blob([JSON.stringify(state.activity, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `activity-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function renderActivityPanel() {
  const container = elements.panel;
  const header = createElement('div', 'panel-header-row');
  header.append(createElement('h2', null, 'Activity (AAR)'));
  const exportButton = createElement('button', 'chip-button', 'Export JSON');
  exportButton.type = 'button';
  exportButton.addEventListener('click', exportActivity);
  header.append(exportButton);
  container.append(header);

  if (!state.activity.length) {
    container.append(createElement('p', 'panel-note', 'No activity recorded yet.'));
    return;
  }
  const table = document.createElement('table');
  table.className = 'data-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['At', 'Action', 'Target'].forEach((label) => headRow.append(createElement('th', null, label)));
  head.append(headRow);
  table.append(head);
  const body = document.createElement('tbody');
  state.activity.forEach((entry) => {
    const row = document.createElement('tr');
    row.append(
      createElement('td', null, formatDate(entry.at)),
      createElement('td', null, entry.action),
      createElement('td', null, entry.target),
    );
    body.append(row);
  });
  table.append(body);
  container.append(table);
}

// --- Mount -------------------------------------------------------------------

export function mount({ root, status }) {
  root.innerHTML = template;
  state = createState();
  elements = queryElements(root);
  dialogNode = root.querySelector('#confirm-dialog');
  const { session } = state;

  const statusLight = createElement('span', 'status-light');
  const statusText = createElement('span', null, 'Exercise workbench');
  status.replaceChildren(statusLight, statusText);
  elements.statusText = statusText;

  elements.tabNav.addEventListener('click', (event) => {
    const button = event.target.closest('.tab-button');
    if (!button) return;
    switchTab(button.dataset.tab);
  });

  readLocation();
  renderTabNav();

  loadAll()
    .then(() => {
      renderPanel();
      updateMastheadStatus();
    })
    .catch((error) => {
      if (error.name === 'AbortError') return;
      elements.panel.replaceChildren(createElement('p', 'inline-error', error.message));
    });

  // Auto-fire due injects while the scenario clock runs, without requiring
  // the analyst to press "Fire due events now". Idempotent: a tick with
  // nothing due is a no-op, so this can never double-fire an event.
  state.tickTimer = window.setInterval(async () => {
    if (!state.clock || state.clock.paused) return;
    try {
      const result = await requestJson(`${API}/scenario-tick`, { method: 'POST' });
      if (result.fired.length) {
        await loadAll();
        if (state.tab === 'scenario' || state.tab === 'reports') renderPanel();
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        // Non-critical background poll; surface nothing intrusive.
      }
    }
  }, 5000);

  return () => {
    window.clearInterval(state.tickTimer);
    session.abort();
    root.replaceChildren();
  };
}
