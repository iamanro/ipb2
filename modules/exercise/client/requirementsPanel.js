// Exercise: the Requirements panel (PIRs/FFIRs, SIRs, indicators, evidence).

import { formatPlannedTime } from '../../../src/dtg.js';
import { createDtgInput, readDtgValue } from '../../../src/dtgField.js';
import { canEditClient, renderCellBadge, renderReleaseControl } from '../../../src/release.js';
import { can } from '../../../src/session.js';
import { appendOwnerReassign } from './ownerReassign.js';

import {
  API,
  askConfirm,
  createElement,
  elements,
  formatDate,
  hasCell,
  loadAll,
  renderPanel,
  requestJson,
  scenarioNow,
  showError,
  state,
} from './view.js';

const IPB_API = '/api/ipb';

// --- Requirements panel ----------------------------------------------------

function revisionBody(item, extra = {}) {
  return { ...extra, revision: item.revision };
}

function renderRequirementConflict(container, error, { reload, reapply }) {
  showError(container, error.message);
  const node = container.querySelector(':scope > .inline-error');
  if (!node || error.status !== 409 || error.code !== 'stale_revision') return;
  const actions = createElement('div', 'inline-form');
  const reloadButton = createElement('button', 'text-button', 'Reload latest');
  reloadButton.type = 'button';
  reloadButton.addEventListener('click', async () => {
    try {
      await reload();
    } catch (reloadError) {
      showError(container, reloadError.message);
    }
  });
  const reapplyButton = createElement('button', 'text-button', 'Reapply draft to latest');
  reapplyButton.type = 'button';
  reapplyButton.addEventListener('click', async () => {
    try {
      await reapply();
    } catch (reapplyError) {
      showError(container, reapplyError.message);
    }
  });
  actions.append(reloadButton, reapplyButton);
  node.append(actions);
}

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

async function addSir(requirement, text, container) {
  if (!text.trim()) return;
  try {
    await requestJson(`${API}/requirements/${requirement.id}/sirs`, {
      method: 'POST',
      body: revisionBody(requirement, { text: text.trim() }),
    });
    delete state.requirementDrafts.sirs[requirement.id];
    await loadAll();
    renderPanel();
  } catch (error) {
    renderRequirementConflict(container, error, {
      reload: async () => {
        await loadAll();
        renderPanel();
      },
      reapply: async () => {
        await loadAll();
        const latest = state.requirements.find((entry) => entry.id === requirement.id);
        // oxlint-disable-next-line eslint/preserve-caught-error -- a new condition, not a rethrow of the conflict
        if (!latest) throw new Error('Requirement is no longer available; draft kept.');
        renderPanel();
      },
    });
  }
}

async function deleteSir(requirement, sir, container) {
  if (!(await askConfirm('Delete this SIR and its indicators?'))) return;
  try {
    await requestJson(`${API}/requirements/${requirement.id}/sirs/${sir.id}`, {
      method: 'DELETE',
      body: revisionBody(requirement),
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    renderRequirementConflict(container, error, {
      reload: async () => {
        await loadAll();
        renderPanel();
      },
      reapply: async () => {
        await loadAll();
        renderPanel();
      },
    });
  }
}

async function addIndicator(requirement, sir, description, container) {
  if (!description.trim()) return;
  try {
    await requestJson(`${API}/requirements/${requirement.id}/indicators`, {
      method: 'POST',
      body: revisionBody(requirement, { sir_id: sir.id, description: description.trim() }),
    });
    delete state.requirementDrafts.indicators[sir.id];
    await loadAll();
    renderPanel();
  } catch (error) {
    renderRequirementConflict(container, error, {
      reload: async () => {
        await loadAll();
        renderPanel();
      },
      reapply: async () => {
        await loadAll();
        const latest = state.requirements.find((entry) => entry.id === requirement.id);
        const latestSir = latest?.sirs.find((entry) => entry.id === sir.id);
        if (!latest || !latestSir)
          // oxlint-disable-next-line eslint/preserve-caught-error -- a new condition, not a rethrow of the conflict
          throw new Error('Requirement or SIR is no longer available; draft kept.');
        renderPanel();
      },
    });
  }
}

async function toggleIndicator(requirement, indicator, container) {
  try {
    await requestJson(`${API}/requirements/${requirement.id}/indicators/${indicator.id}`, {
      method: 'PATCH',
      body: revisionBody(requirement, { observed: !indicator.observed }),
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    renderRequirementConflict(container, error, {
      reload: async () => {
        await loadAll();
        renderPanel();
      },
      reapply: async () => {
        await loadAll();
        renderPanel();
      },
    });
  }
}

async function deleteIndicator(requirement, indicator, container) {
  try {
    await requestJson(`${API}/requirements/${requirement.id}/indicators/${indicator.id}`, {
      method: 'DELETE',
      body: revisionBody(requirement),
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    renderRequirementConflict(container, error, {
      reload: async () => {
        await loadAll();
        renderPanel();
      },
      reapply: async () => {
        await loadAll();
        renderPanel();
      },
    });
  }
}

/** A relation badge plus the cited report (or "Report withdrawn" once the
 * report that supported it has been deleted — the link itself outlives the
 * report it cites, docs/adr/0002 + CONTEXT.md). Shown under the requirement
 * (blanket links) and each of its SIRs (`links` from the server shape). */
function renderEvidenceLinks(container, requirement, links) {
  if (!links.length) return;
  const list = createElement('ul', 'evidence-list');
  links.forEach((link) => {
    const item = createElement('li', 'evidence-item');
    item.append(createElement('span', `relation-badge relation-${link.relation}`, link.relation));
    if (link.withdrawn) {
      item.append(createElement('span', 'panel-note', 'Report withdrawn'));
    } else if (link.report) {
      item.append(
        createElement(
          'span',
          null,
          `${link.report.text} (Admiralty ${link.report.reliability}${link.report.credibility})`,
        ),
      );
    } else {
      item.append(createElement('span', 'panel-note', 'Report not visible'));
    }
    if (can('analyst') && canEditClient(requirement)) {
      const remove = createElement('button', 'icon-button danger', '×');
      remove.type = 'button';
      remove.title = 'Remove evidence link';
      remove.setAttribute('aria-label', 'Remove evidence link');
      remove.addEventListener('click', async () => {
        try {
          await requestJson(`${API}/requirements/${link.requirement_id}/evidence/${link.id}`, {
            method: 'DELETE',
            body: revisionBody(requirement),
          });
          await loadAll();
          renderPanel();
        } catch (error) {
          renderRequirementConflict(item, error, {
            reload: async () => {
              await loadAll();
              renderPanel();
            },
            reapply: async () => {
              await loadAll();
              renderPanel();
            },
          });
        }
      });
      item.append(remove);
    }
    list.append(item);
  });
  container.append(list);
}

function renderSirRow(sir, requirement) {
  // C2b: release grants read only, so SIR/indicator edit/delete/add
  // controls need canEditClient on the parent requirement, not just the
  // analyst role — a cell it was only released to still sees them, greyed.
  const editable = can('analyst') && canEditClient(requirement);
  const row = createElement('div', 'sir-row');
  const header = createElement('div', 'sir-row-header');
  header.append(createElement('strong', null, sir.text));
  if (editable) {
    const deleteButton = createElement('button', 'icon-button danger', 'Delete');
    deleteButton.type = 'button';
    deleteButton.addEventListener('click', () => deleteSir(requirement, sir, row));
    header.append(deleteButton);
  }
  row.append(header, fulfillmentBar(sir.fulfillment));

  const indicatorList = createElement('ul', 'indicator-list');
  sir.indicators.forEach((indicator) => {
    const item = createElement('li', 'indicator-item');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = indicator.observed;
    checkbox.disabled = !editable;
    checkbox.addEventListener('change', () => toggleIndicator(requirement, indicator, item));
    const label = createElement('span', null, indicator.description);
    item.append(checkbox, label);
    if (editable) {
      const remove = createElement('button', 'icon-button danger', '×');
      remove.type = 'button';
      remove.title = 'Delete indicator';
      remove.setAttribute('aria-label', `Delete indicator ${indicator.description}`);
      remove.addEventListener('click', () => deleteIndicator(requirement, indicator, item));
      item.append(remove);
    }
    indicatorList.append(item);
  });
  row.append(indicatorList);
  renderEvidenceLinks(row, requirement, sir.links);

  if (editable) {
    const indicatorForm = createElement('div', 'inline-form');
    const indicatorInput = document.createElement('input');
    indicatorInput.type = 'text';
    indicatorInput.placeholder = 'Observable indicator…';
    indicatorInput.value = state.requirementDrafts.indicators[sir.id] ?? '';
    indicatorInput.addEventListener('input', () => {
      state.requirementDrafts.indicators[sir.id] = indicatorInput.value;
    });
    const indicatorAdd = createElement('button', 'chip-button', 'Add indicator');
    indicatorAdd.type = 'button';
    indicatorAdd.addEventListener('click', () => {
      addIndicator(requirement, sir, indicatorInput.value, row);
    });
    indicatorForm.append(indicatorInput, indicatorAdd);
    row.append(indicatorForm);
  }

  return row;
}

async function deleteRequirement(requirement, container) {
  if (!(await askConfirm('Delete this requirement, its SIRs, and indicators?'))) return;
  try {
    await requestJson(`${API}/requirements/${requirement.id}`, {
      method: 'DELETE',
      body: revisionBody(requirement),
    });
    await loadAll();
    renderPanel();
  } catch (error) {
    renderRequirementConflict(container, error, {
      reload: async () => {
        await loadAll();
        renderPanel();
      },
      reapply: async () => {
        await loadAll();
        renderPanel();
      },
    });
  }
}

function renderRequirementCard(requirement) {
  const card = createElement('article', 'requirement-card');
  const header = createElement('div', 'requirement-header');
  header.append(
    createElement('span', `kind-badge kind-${requirement.kind}`, requirement.kind),
    createElement('span', 'requirement-priority', `Priority ${requirement.priority}`),
    renderCellBadge(requirement.owner_cell),
  );
  if (requirement.source?.startsWith('ipb:')) {
    const badge = createElement('span', 'source-badge', 'From IPB');
    badge.title =
      'Derived from an IPB event matrix; re-importing that study refreshes its wording.';
    header.append(badge);
  }
  if (can('analyst') && canEditClient(requirement)) {
    const deleteButton = createElement('button', 'icon-button danger', 'Delete');
    deleteButton.type = 'button';
    deleteButton.addEventListener('click', () => deleteRequirement(requirement, card));
    header.append(deleteButton);
  }
  card.append(header);
  card.append(
    renderReleaseControl({
      item: requirement,
      onRelease: (cells) => releaseRequirement(requirement, cells),
    }),
  );
  appendOwnerReassign(card, requirement.owner_cell, (cell) =>
    reassignRequirementOwner(requirement, cell),
  );
  card.append(createElement('h3', null, requirement.text));
  const meta = createElement('p', 'panel-note');
  meta.textContent = `Decision point: ${requirement.decision_point || '—'} · LTIOV: ${formatDate(requirement.ltiov)}`;
  card.append(meta);
  card.append(fulfillmentBar(requirement.fulfillment));
  renderEvidenceLinks(card, requirement, requirement.links);

  const sirList = createElement('div', 'sir-list');
  requirement.sirs.forEach((sir) => sirList.append(renderSirRow(sir, requirement)));
  card.append(sirList);

  if (can('analyst') && canEditClient(requirement)) {
    const sirForm = createElement('div', 'inline-form');
    const sirInput = document.createElement('input');
    sirInput.type = 'text';
    sirInput.placeholder = 'What, where, when to observe…';
    sirInput.value = state.requirementDrafts.sirs[requirement.id] ?? '';
    sirInput.addEventListener('input', () => {
      state.requirementDrafts.sirs[requirement.id] = sirInput.value;
    });
    const sirAdd = createElement('button', 'chip-button', 'Add SIR');
    sirAdd.type = 'button';
    sirAdd.addEventListener('click', () => {
      addSir(requirement, sirInput.value, card);
    });
    sirForm.append(sirInput, sirAdd);
    card.append(sirForm);
  }

  return card;
}

async function reassignRequirementOwner(requirement, ownerCell) {
  await requestJson(`${API}/requirements/${requirement.id}/owner`, {
    method: 'PATCH',
    body: revisionBody(requirement, { owner_cell: ownerCell }),
  });
  await loadAll();
  renderPanel();
}

async function releaseRequirement(requirement, cells) {
  await requestJson(`${API}/requirements/${requirement.id}/release`, {
    method: 'POST',
    body: revisionBody(requirement, { cells }),
  });
  await loadAll();
  renderPanel();
}

async function createRequirement(form, container) {
  const kind = form.querySelector('[name=kind]').value;
  const text = form.querySelector('[name=text]').value.trim();
  const priority = Number.parseInt(form.querySelector('[name=priority]').value, 10) || 0;
  const decisionPoint = form.querySelector('[name=decision_point]').value.trim();
  if (!text) return;
  try {
    const ltiov = readDtgValue(form.querySelector('[name=ltiov]'));
    await requestJson(`${API}/requirements`, {
      method: 'POST',
      body: {
        kind,
        text,
        priority,
        decision_point: decisionPoint || null,
        ltiov,
      },
    });
    state.requirementDrafts.create = {
      kind: 'PIR',
      text: '',
      priority: '0',
      decision_point: '',
      ltiov: '',
    };
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

/**
 * Sends only the event-matrix subset of the IPB study aggregate; the
 * exercise server (ipbImport.js) owns the mapping to PIR/SIR/indicator.
 * NAI *and* TAI layers go over as `nais[]` (with geometry, so `GET nais`
 * can point-in-polygon match reports and taskings can reference real
 * ground), and each event's `expected_time` is a formatted string — the
 * IPB server dropped that column, so it now lives in `expected_at` /
 * `expected_offset` plus the study's `h_hour`, resolved client-side with
 * `formatPlannedTime` because ipbImport.js still only reads text.
 */
async function importIpbStudy(studyId, container) {
  try {
    const { study, coas, events, features } = await requestJson(`${IPB_API}/studies/${studyId}`);
    const nais = features.filter((feature) => feature.layer === 'nai' || feature.layer === 'tai');
    const counts = await requestJson(`${API}/import/ipb`, {
      method: 'POST',
      body: {
        study: { id: study.id, name: study.name },
        coas: coas.map((coa) => ({ id: coa.id, name: coa.name, kind: coa.kind })),
        nais: nais.map((feature) => ({
          id: feature.id,
          label: feature.label,
          kind: feature.layer,
          geometry: feature.geometry ?? null,
        })),
        events: events.map((event) => ({
          id: event.id,
          coa_id: event.coa_id,
          nai_feature_id: event.nai_feature_id,
          indicator: event.indicator,
          expected_time: formatPlannedTime(
            { at: event.expected_at ?? null, offset: event.expected_offset ?? null },
            study.h_hour ?? null,
          ),
          observed_status: event.observed_status,
        })),
      },
    });
    state.importSummary = { study: study.name, counts, naiCount: nais.length };
    await loadAll();
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

function describeImport({ study, counts, naiCount }) {
  const part = (label, { created, updated, stale }) =>
    `${label} ${created} new, ${updated} updated${stale.length ? `, ${stale.length} no longer in IPB (kept)` : ''}`;
  const naiPart =
    naiCount === undefined ? '' : ` · ${naiCount} NAI/TAI feature${naiCount === 1 ? '' : 's'}`;
  return `Imported “${study}”: ${part('PIRs', counts.requirements)} · ${part('SIRs', counts.sirs)} · ${part('indicators', counts.indicators)}${naiPart}.`;
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
  if (!can('analyst')) {
    section.append(createElement('p', 'panel-note', 'Importing from IPB needs the analyst role.'));
    container.append(section);
    return;
  }
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

export function renderRequirementsPanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'Requirements — CCIR / PIR / FFIR / SIR'));
  renderIpbImport(container);

  if (!can('analyst') || !hasCell()) {
    container.append(
      createElement('p', 'panel-note', 'Adding requirements needs the analyst role.'),
    );
  } else {
    const formSection = createElement('section', 'field-group');
    formSection.append(createElement('h3', null, 'New requirement'));
    const form = createElement('div', 'requirement-form');
    const draft = state.requirementDrafts.create;
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
    kindSelect.value = draft.kind;
    kindSelect.addEventListener('change', () => (draft.kind = kindSelect.value));
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.name = 'text';
    textInput.placeholder = 'Will the enemy attack before D+2?';
    textInput.value = draft.text;
    textInput.addEventListener('input', () => (draft.text = textInput.value));
    const priorityInput = document.createElement('input');
    priorityInput.type = 'number';
    priorityInput.name = 'priority';
    priorityInput.placeholder = 'Priority';
    priorityInput.value = draft.priority;
    priorityInput.addEventListener('input', () => (draft.priority = priorityInput.value));
    const decisionInput = document.createElement('input');
    decisionInput.type = 'text';
    decisionInput.name = 'decision_point';
    decisionInput.placeholder = 'Decision point (optional)';
    decisionInput.value = draft.decision_point;
    decisionInput.addEventListener('input', () => (draft.decision_point = decisionInput.value));
    const ltiovInput = createDtgInput({
      name: 'ltiov',
      label: 'LTIOV',
      value: draft.ltiov,
      reference: scenarioNow,
    });
    ltiovInput.addEventListener('input', () => (draft.ltiov = ltiovInput.value));
    const addButton = createElement('button', 'primary-button', 'Add requirement');
    addButton.type = 'button';
    addButton.addEventListener('click', () => createRequirement(form, formSection));
    form.append(kindSelect, textInput, priorityInput, decisionInput, ltiovInput, addButton);
    formSection.append(form);
    container.append(formSection);
  }

  if (!state.requirements.length) {
    container.append(createElement('p', 'panel-note', 'No requirements yet.'));
    return;
  }
  const list = createElement('div', 'requirement-list');
  state.requirements.forEach((requirement) => list.append(renderRequirementCard(requirement)));
  container.append(list);
}
