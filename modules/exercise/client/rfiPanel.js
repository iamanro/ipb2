// Exercise: the RFI panel.

import { createDtgInput, readDtgValue } from '../../../src/dtgField.js';
import { canEditClient, renderCellBadge, renderReleaseControl } from '../../../src/release.js';
import { can, isWhite } from '../../../src/session.js';
import { appendOwnerReassign } from './ownerReassign.js';

import {
  API,
  askConfirm,
  createElement,
  elements,
  evidenceTargets,
  formatDate,
  hasCell,
  loadAll,
  renderPanel,
  requestJson,
  scenarioNow,
  showError,
  state,
} from './view.js';

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

// --- RFI panel -----------------------------------------------------------------

async function createRfi(form, container) {
  const question = form.querySelector('[name=question]').value.trim();
  const priority = form.querySelector('[name=priority]').value;
  const target = form.querySelector('[name=target]').value;
  if (!question) return;
  const [kind, id] = target ? target.split(':') : [null, null];
  try {
    const nlt = readDtgValue(form.querySelector('[name=nlt]'));
    await requestJson(`${API}/rfis`, {
      method: 'POST',
      body: {
        question,
        priority,
        nlt,
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

async function releaseRfi(id, cells) {
  await requestJson(`${API}/rfis/${id}/release`, { method: 'POST', body: { cells } });
  await loadAll();
  renderPanel();
}

async function reassignRfiOwner(id, ownerCell) {
  await requestJson(`${API}/rfis/${id}/owner`, {
    method: 'PATCH',
    body: { owner_cell: ownerCell },
  });
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
    renderCellBadge(rfi.owner_cell),
  );
  if (can('analyst') && canEditClient(rfi)) {
    const deleteButton = createElement('button', 'icon-button danger', 'Delete');
    deleteButton.type = 'button';
    deleteButton.addEventListener('click', () => deleteRfi(rfi.id));
    header.append(deleteButton);
  }
  row.append(header);
  row.append(renderReleaseControl({ item: rfi, onRelease: (cells) => releaseRfi(rfi.id, cells) }));
  appendOwnerReassign(row, rfi.owner_cell, (cell) => reassignRfiOwner(rfi.id, cell));
  row.append(createElement('p', null, rfi.question));

  // C2b: release grants read only, so a cell this RFI was only released to
  // never gets transition controls; White answers, the owning cell submits/
  // assigns/rejects/closes its own.
  if (!can('analyst') || !canEditClient(rfi)) return row;
  const actions = createElement('div', 'rfi-actions');
  const nextStates = RFI_NEXT[rfi.state] || [];
  nextStates.forEach((toState) => {
    if (toState === 'answered') {
      if (!isWhite()) return;
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

export function renderRfiPanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'RFI'));

  if (can('analyst') && hasCell()) {
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
    const nltInput = createDtgInput({ name: 'nlt', label: 'NLT', reference: scenarioNow });
    const addButton = createElement('button', 'primary-button', 'Submit RFI');
    addButton.type = 'button';
    addButton.addEventListener('click', () => createRfi(form, formSection));
    form.append(questionInput, prioritySelect, targetSelect, nltInput, addButton);
    formSection.append(form);
    container.append(formSection);
  } else {
    container.append(createElement('p', 'panel-note', 'Submitting an RFI needs the analyst role.'));
  }

  if (!state.rfis.length) {
    container.append(createElement('p', 'panel-note', 'No RFIs yet.'));
    return;
  }
  const list = createElement('div', 'rfi-list');
  state.rfis.forEach((rfi) => list.append(renderRfiRow(rfi)));
  container.append(list);
}
