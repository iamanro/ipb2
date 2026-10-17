// Exercise: the Activity (AAR) panel.

import { formatDtg } from '../../../src/dtg.js';
import { can, sessionMode } from '../../../src/session.js';

import { createElement, elements, formatDate, renderPanel, requestJson, state } from './view.js';

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

/** The game-master's cross-module audit trail (`GET /api/auth/audit`): only meaningful
 * in LAN/auth mode (`sessionMode() === 'on'`), where users and roles actually exist. */
async function loadAudit(offset = 0) {
  try {
    const result = await requestJson(`/api/auth/audit?limit=${state.audit.limit}&offset=${offset}`);
    state.audit = {
      ...state.audit,
      items: result.items,
      total: result.total,
      offset,
      loaded: true,
    };
    if (state.tab === 'activity') renderPanel();
  } catch (error) {
    if (error.name !== 'AbortError') {
      state.audit = { ...state.audit, loaded: true };
    }
  }
}

function renderAuditSection(container) {
  if (sessionMode() !== 'on' || !can('game-master')) return;
  const section = createElement('section', 'field-group audit-section');
  section.append(createElement('h3', null, 'Audit trail'));
  if (!state.audit.loaded) {
    section.append(createElement('p', 'panel-note', 'Loading audit trail\u2026'));
    container.append(section);
    loadAudit(state.audit.offset);
    return;
  }
  if (!state.audit.items.length) {
    section.append(createElement('p', 'panel-note', 'No audited requests yet.'));
    container.append(section);
    return;
  }
  const table = document.createElement('table');
  table.className = 'data-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['At', 'User', 'Method', 'Path', 'Status'].forEach((label) =>
    headRow.append(createElement('th', null, label)),
  );
  head.append(headRow);
  table.append(head);
  const body = document.createElement('tbody');
  state.audit.items.forEach((entry) => {
    const row = document.createElement('tr');
    row.append(
      createElement('td', null, formatDtg(new Date(entry.at).getTime())),
      createElement('td', null, entry.user || '—'),
      createElement('td', null, entry.method),
      createElement('td', null, entry.path),
      createElement('td', null, String(entry.status)),
    );
    body.append(row);
  });
  table.append(body);
  section.append(table);

  const pager = createElement('div', 'inline-form');
  const prevButton = createElement('button', 'chip-button', 'Newer');
  prevButton.type = 'button';
  prevButton.disabled = state.audit.offset <= 0;
  prevButton.addEventListener('click', () =>
    loadAudit(Math.max(0, state.audit.offset - state.audit.limit)),
  );
  const nextButton = createElement('button', 'chip-button', 'Older');
  nextButton.type = 'button';
  nextButton.disabled = state.audit.offset + state.audit.limit >= state.audit.total;
  nextButton.addEventListener('click', () => loadAudit(state.audit.offset + state.audit.limit));
  pager.append(
    prevButton,
    createElement(
      'span',
      'panel-note',
      `${state.audit.offset + 1}\u2013${Math.min(state.audit.offset + state.audit.limit, state.audit.total)} of ${state.audit.total}`,
    ),
    nextButton,
  );
  section.append(pager);
  container.append(section);
}

export function renderActivityPanel() {
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
  } else {
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
  renderAuditSection(container);
}
