/**
 * Admin (C1/C6): users (a global `admin` flag, not a role), the current
 * exercise's membership roster (cell + role, per docs/phase1-access.md),
 * the exercise lifecycle (rename/archive/reset/restore), and the audit
 * trail (`GET /api/auth/audit`). Every write goes through `/api/auth/*`
 * (`server/api.js`); this module has no server route of its own (see
 * `module.js`).
 */
import { formatDtg } from '../../../src/dtg.js';
import { renderCellBadge } from '../../../src/release.js';
import { can, currentUser, handleUnauthorized, sessionMode } from '../../../src/session.js';

import './styles.css';
import template from './view.html?raw';

const CELLS = ['white', 'blue', 'red'];
const CELL_LABELS = { white: 'White', blue: 'Blue', red: 'Red' };
const MEMBERSHIP_ROLES = ['observer', 'analyst', 'collection-manager', 'game-master'];
const PASSWORD_MIN_LENGTH = 12;
const GENERATED_PASSWORD_LENGTH = 16;
const GENERATED_PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let state;
let elements;
let dialogNode;
let resetDialogNode;

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createState() {
  return {
    session: new AbortController(),
    tab: 'users',
    users: [],
    usersLoaded: false,
    members: [],
    membersLoaded: false,
    selectedMembers: new Set(),
    bulkCell: '',
    bulkRole: '',
    exercise: null,
    exerciseLoaded: false,
    archives: [],
    archivesLoaded: false,
    audit: { items: [], total: 0, offset: 0, limit: 50, loaded: false },
  };
}

async function requestJson(path, { method = 'GET', body, signal = state.session.signal } = {}) {
  const options = { method, signal, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) handleUnauthorized();
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
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

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

// --- Confirm dialog --------------------------------------------------------

function createDialogNode(root) {
  dialogNode = root.querySelector('#confirm-dialog');
}

function askConfirm(message, accept = 'Confirm') {
  dialogNode.querySelector('.dialog-message').textContent = message;
  const acceptButton = dialogNode.querySelector('.dialog-accept');
  acceptButton.textContent = accept;
  acceptButton.classList.toggle('danger', accept !== 'Confirm');
  return new Promise((resolve) => {
    const settle = () => {
      dialogNode.removeEventListener('close', settle);
      resolve(dialogNode.returnValue === 'accept');
    };
    dialogNode.addEventListener('close', settle);
    dialogNode.showModal();
  });
}

// --- Reset (typed confirmation) dialog --------------------------------------

function createResetDialogNode(root) {
  resetDialogNode = root.querySelector('#reset-dialog');
  const form = resetDialogNode.querySelector('form');
  const confirmInput = resetDialogNode.querySelector('#reset-confirm-input');
  const nameInput = resetDialogNode.querySelector('#reset-name-input');
  // A native `disabled` submit button redirects Enter's implicit
  // submission to the *other* (Cancel) submit button — surprising, given
  // this is exactly the moment a confirming admin is typing and might
  // press Enter. Gating in the `submit` handler instead (still able to
  // cancel it via `preventDefault`, `method="dialog"` closes otherwise)
  // avoids that entirely; the button's look still communicates readiness.
  form.addEventListener('submit', (event) => {
    if (event.submitter?.value !== 'accept') return;
    const ready =
      confirmInput.value === resetDialogNode.dataset.currentName && nameInput.value.trim();
    if (!ready) event.preventDefault();
  });
}

/** Resolves `{ name, confirm }` on a valid, confirmed submit; `null` on cancel. */
function askResetConfirmation(currentName) {
  resetDialogNode.dataset.currentName = currentName;
  const confirmInput = resetDialogNode.querySelector('#reset-confirm-input');
  const nameInput = resetDialogNode.querySelector('#reset-name-input');
  confirmInput.value = '';
  nameInput.value = '';
  return new Promise((resolve) => {
    const settle = () => {
      resetDialogNode.removeEventListener('close', settle);
      resolve(
        resetDialogNode.returnValue === 'accept'
          ? { confirm: confirmInput.value, name: nameInput.value.trim() }
          : null,
      );
    };
    resetDialogNode.addEventListener('close', settle);
    resetDialogNode.showModal();
    confirmInput.focus();
  });
}

// --- Password generator ------------------------------------------------------

function generatePassword() {
  const bytes = crypto.getRandomValues(new Uint32Array(GENERATED_PASSWORD_LENGTH));
  return Array.from(
    bytes,
    (n) => GENERATED_PASSWORD_ALPHABET[n % GENERATED_PASSWORD_ALPHABET.length],
  ).join('');
}

// --- Tab chrome --------------------------------------------------------------

function renderTabNav() {
  elements.tabNav.querySelectorAll('.tab-button').forEach((button) => {
    const active = button.dataset.tab === state.tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
}

function renderPanel() {
  elements.panel.replaceChildren();
  if (state.tab === 'users') renderUsersPanel();
  else if (state.tab === 'members') renderMembersPanel();
  else if (state.tab === 'exercise') renderExercisePanel();
  else renderAuditPanel();
}

function switchTab(tab) {
  state.tab = tab;
  renderTabNav();
  renderPanel();
}

/** A guard every admin-only panel opens with: `off` mode has nothing to
 * administer, and a non-admin gets a plain message — the server enforces
 * the real gate regardless (every `/api/auth/*` route this module calls). */
function renderAccessNote(container, subject) {
  if (sessionMode() !== 'on') {
    container.append(createElement('p', 'panel-note', `${subject} needs LAN mode (IPB_AUTH=on).`));
    return true;
  }
  if (!can('admin')) {
    container.append(createElement('p', 'panel-note', `${subject} needs the admin flag.`));
    return true;
  }
  return false;
}

// --- Users panel -------------------------------------------------------------

async function loadUsers() {
  const { items } = await requestJson('/api/auth/users');
  state.users = items;
  state.usersLoaded = true;
}

async function createUser(form, container) {
  const name = form.querySelector('[name=name]').value.trim();
  const admin = form.querySelector('[name=admin]').checked;
  const password = form.querySelector('[name=password]').value;
  if (!name || !password) return;
  try {
    await requestJson('/api/auth/users', { method: 'POST', body: { name, admin, password } });
    form.reset();
    await loadUsers();
    state.membersLoaded = false;
    renderPanel();
  } catch (error) {
    showError(container, error.message);
  }
}

/** Every action below reloads the table on both success and failure — a
 * guard rejection (last-admin, self-disable/delete) leaves the server-side
 * state unchanged, so re-fetching just reverts the control to what it
 * actually is instead of the optimistic edit the user made. Errors surface
 * as an alert: these buttons live inside table rows with no stable place of
 * their own for an inline message to survive the table re-render. */
async function reportAndReload(action) {
  try {
    await action();
  } catch (error) {
    window.alert(error.message);
  } finally {
    await loadUsers();
    // The Members tab's cache can go stale from here too (a new/deleted
    // user, or an admin flag the members table also shows) — invalidating
    // it rather than re-fetching unconditionally means an untouched
    // Members tab pays nothing, and a visited one refetches next time it's
    // opened instead of showing what's now a stale roster.
    state.membersLoaded = false;
    renderPanel();
  }
}

function setAdmin(name, admin) {
  return reportAndReload(() =>
    requestJson(`/api/auth/users/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: { admin },
    }),
  );
}

async function setDisabled(name, disabled) {
  if (
    disabled &&
    !(await askConfirm(`Disable ${name}? Their sessions end immediately.`, 'Disable'))
  ) {
    return;
  }
  return reportAndReload(() =>
    requestJson(`/api/auth/users/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: { disabled },
    }),
  );
}

async function resetPassword(name) {
  if (
    !(await askConfirm(
      `Reset ${name}'s password to a new random one? They will have to change it at next sign-in.`,
      'Reset',
    ))
  ) {
    return;
  }
  const password = generatePassword();
  try {
    await requestJson(`/api/auth/users/${encodeURIComponent(name)}/reset-password`, {
      method: 'POST',
      body: { password },
    });
    window.alert(`${name}'s new temporary password:\n\n${password}\n\nShown once — copy it now.`);
  } catch (error) {
    window.alert(error.message);
  }
}

function revokeSessions(name) {
  return reportAndReload(() =>
    requestJson(`/api/auth/users/${encodeURIComponent(name)}/revoke-sessions`, { method: 'POST' }),
  );
}

async function deleteUser(name) {
  if (!(await askConfirm(`Delete ${name}? This cannot be undone.`, 'Delete'))) return;
  return reportAndReload(() =>
    requestJson(`/api/auth/users/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  );
}

function renderCreateForm(container) {
  const section = createElement('section', 'field-group');
  section.append(createElement('h3', null, 'Add a user'));
  const form = document.createElement('form');
  form.className = 'requirement-form';
  form.noValidate = true;

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.name = 'name';
  nameInput.placeholder = 'Name…';
  nameInput.required = true;

  const adminLabel = createElement('label', 'inline-checkbox');
  const adminInput = document.createElement('input');
  adminInput.type = 'checkbox';
  adminInput.name = 'admin';
  adminLabel.append(adminInput, document.createTextNode(' Admin'));

  const passwordInput = document.createElement('input');
  passwordInput.type = 'text';
  passwordInput.name = 'password';
  passwordInput.placeholder = `Password (at least ${PASSWORD_MIN_LENGTH} characters)…`;
  passwordInput.required = true;
  passwordInput.minLength = PASSWORD_MIN_LENGTH;

  const generateButton = createElement('button', 'chip-button', 'Generate');
  generateButton.type = 'button';
  generateButton.addEventListener('click', () => {
    passwordInput.type = 'text';
    passwordInput.value = generatePassword();
  });

  const addButton = createElement('button', 'primary-button', 'Create user');
  addButton.type = 'submit';

  form.append(nameInput, adminLabel, passwordInput, generateButton, addButton);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    createUser(form, section);
  });
  section.append(form);
  container.append(section);
}

function renderUserRow(user) {
  const row = document.createElement('tr');
  row.classList.toggle('user-row-disabled', user.disabled);

  const isSelf = user.name === currentUser()?.name;

  const adminLabel = createElement('label', 'inline-checkbox');
  const adminInput = document.createElement('input');
  adminInput.type = 'checkbox';
  adminInput.checked = user.admin;
  adminInput.addEventListener('change', () => setAdmin(user.name, adminInput.checked));
  adminLabel.append(adminInput);

  const cellCell = document.createElement('td');
  cellCell.append(renderCellBadge(user.cell));
  const roleCell = document.createElement('td');
  roleCell.append(document.createTextNode(user.role ?? '—'));

  const actionsCell = document.createElement('td');
  const disableButton = createElement(
    'button',
    'icon-button',
    user.disabled ? 'Enable' : 'Disable',
  );
  disableButton.type = 'button';
  disableButton.disabled = isSelf && !user.disabled;
  disableButton.title = isSelf && !user.disabled ? "You can't disable your own account." : '';
  disableButton.addEventListener('click', () => setDisabled(user.name, !user.disabled));

  const resetButton = createElement('button', 'icon-button', 'Reset password');
  resetButton.type = 'button';
  resetButton.addEventListener('click', () => resetPassword(user.name));

  const revokeButton = createElement('button', 'icon-button', 'Revoke sessions');
  revokeButton.type = 'button';
  revokeButton.disabled = user.session_count === 0;
  revokeButton.addEventListener('click', () => revokeSessions(user.name));

  const deleteButton = createElement('button', 'icon-button danger', 'Delete');
  deleteButton.type = 'button';
  deleteButton.disabled = isSelf;
  deleteButton.title = isSelf ? "You can't delete your own account." : '';
  deleteButton.addEventListener('click', () => deleteUser(user.name));

  actionsCell.append(disableButton, resetButton, revokeButton, deleteButton);

  row.append(
    createElement('td', null, user.name),
    (() => {
      const cell = document.createElement('td');
      cell.append(adminLabel);
      return cell;
    })(),
    cellCell,
    roleCell,
    createElement(
      'td',
      null,
      user.created_at ? formatDtg(new Date(user.created_at).getTime()) : '—',
    ),
    createElement(
      'td',
      null,
      user.last_login_at ? formatDtg(new Date(user.last_login_at).getTime()) : 'Never',
    ),
    createElement('td', null, String(user.session_count)),
    createElement('td', null, user.disabled ? 'Disabled' : 'Active'),
    createElement('td', null, user.must_change_password ? 'Yes' : 'No'),
    actionsCell,
  );
  return row;
}

function renderUsersTable(container) {
  if (!state.users.length) {
    container.append(createElement('p', 'panel-note', 'No users yet.'));
    return;
  }
  const table = document.createElement('table');
  table.className = 'data-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  [
    'Name',
    'Admin',
    'Cell',
    'Role',
    'Created',
    'Last login',
    'Sessions',
    'Status',
    'Must change pw',
    '',
  ].forEach((label) => headRow.append(createElement('th', null, label)));
  head.append(headRow);
  table.append(head);
  const body = document.createElement('tbody');
  state.users.forEach((user) => body.append(renderUserRow(user)));
  table.append(body);
  container.append(table);
}

function renderUsersPanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'Users'));
  if (renderAccessNote(container, 'User management')) return;

  renderCreateForm(container);

  if (!state.usersLoaded) {
    container.append(createElement('p', 'panel-note', 'Loading users…'));
    loadUsers()
      .then(() => {
        if (state.tab === 'users') renderPanel();
      })
      .catch((error) => showError(container, error.message));
    return;
  }
  renderUsersTable(container);
}

// --- Members panel -----------------------------------------------------------

async function loadMembers() {
  const { items } = await requestJson('/api/auth/members');
  state.members = items;
  state.membersLoaded = true;
}

function cellOptionList(select, { includeUnassigned }) {
  select.replaceChildren();
  if (includeUnassigned) select.append(new Option('— unassigned —', ''));
  for (const cell of CELLS) select.append(new Option(CELL_LABELS[cell], cell));
}

function roleOptionList(select, { includePlaceholder }) {
  select.replaceChildren();
  if (includePlaceholder) select.append(new Option('— role —', ''));
  for (const role of MEMBERSHIP_ROLES) select.append(new Option(role, role));
}

async function setMembership(name, cell, role) {
  try {
    await requestJson(`/api/auth/members/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: { cell, role },
    });
  } catch (error) {
    window.alert(error.message);
  } finally {
    await loadMembers();
    // The Users tab shows each user's cell/role too.
    state.usersLoaded = false;
    renderPanel();
  }
}

async function removeMembership(name) {
  try {
    await requestJson(`/api/auth/members/${encodeURIComponent(name)}`, { method: 'DELETE' });
  } catch (error) {
    window.alert(error.message);
  } finally {
    await loadMembers();
    state.usersLoaded = false;
    renderPanel();
  }
}

function renderMemberRow(member) {
  const row = document.createElement('tr');

  const selectCell = document.createElement('td');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = state.selectedMembers.has(member.name);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) state.selectedMembers.add(member.name);
    else state.selectedMembers.delete(member.name);
    renderPanel();
  });
  selectCell.append(checkbox);

  const adminCell = document.createElement('td');
  adminCell.textContent = member.admin ? 'Admin' : '';

  const cellSelect = document.createElement('select');
  cellOptionList(cellSelect, { includeUnassigned: true });
  cellSelect.value = member.cell ?? '';
  const roleSelect = document.createElement('select');
  roleOptionList(roleSelect, { includePlaceholder: true });
  roleSelect.value = member.role ?? '';

  function applyIfComplete() {
    if (!cellSelect.value) {
      if (member.cell) removeMembership(member.name);
      return;
    }
    if (!roleSelect.value) return; // wait for a role before writing anything
    setMembership(member.name, cellSelect.value, roleSelect.value);
  }
  cellSelect.addEventListener('change', applyIfComplete);
  roleSelect.addEventListener('change', applyIfComplete);

  const cellCell = document.createElement('td');
  cellCell.append(cellSelect);
  const roleCell = document.createElement('td');
  roleCell.append(roleSelect);

  const actionsCell = document.createElement('td');
  const removeButton = createElement('button', 'icon-button', 'Remove');
  removeButton.type = 'button';
  removeButton.disabled = !member.cell;
  removeButton.addEventListener('click', () => removeMembership(member.name));
  actionsCell.append(removeButton);

  row.append(
    selectCell,
    createElement('td', null, member.name),
    adminCell,
    cellCell,
    roleCell,
    actionsCell,
  );
  return row;
}

function renderBulkBar(container) {
  const bar = createElement('div', 'bulk-bar');
  const selectAll = document.createElement('input');
  selectAll.type = 'checkbox';
  selectAll.setAttribute('aria-label', 'Select all members');
  const allSelected =
    state.members.length > 0 && state.members.every((m) => state.selectedMembers.has(m.name));
  selectAll.checked = allSelected;
  selectAll.addEventListener('change', () => {
    if (selectAll.checked) state.members.forEach((m) => state.selectedMembers.add(m.name));
    else state.selectedMembers.clear();
    renderPanel();
  });

  const cellSelect = document.createElement('select');
  cellOptionList(cellSelect, { includeUnassigned: false });
  cellSelect.value = state.bulkCell || CELLS[0];
  state.bulkCell = cellSelect.value;
  cellSelect.addEventListener('change', () => {
    state.bulkCell = cellSelect.value;
  });

  const roleSelect = document.createElement('select');
  roleOptionList(roleSelect, { includePlaceholder: false });
  roleSelect.value = state.bulkRole || MEMBERSHIP_ROLES[0];
  state.bulkRole = roleSelect.value;
  roleSelect.addEventListener('change', () => {
    state.bulkRole = roleSelect.value;
  });

  const assignButton = createElement('button', 'chip-button', 'Assign selected');
  assignButton.type = 'button';
  assignButton.disabled = state.selectedMembers.size === 0;
  assignButton.addEventListener('click', async () => {
    const names = [...state.selectedMembers];
    try {
      await Promise.all(
        names.map((name) =>
          requestJson(`/api/auth/members/${encodeURIComponent(name)}`, {
            method: 'PUT',
            body: { cell: cellSelect.value, role: roleSelect.value },
          }),
        ),
      );
    } catch (error) {
      window.alert(error.message);
    } finally {
      state.selectedMembers.clear();
      await loadMembers();
      state.usersLoaded = false;
      renderPanel();
    }
  });

  bar.append(
    selectAll,
    createElement(
      'span',
      'bulk-bar-count',
      state.selectedMembers.size
        ? `${state.selectedMembers.size} selected`
        : 'Select members to bulk-assign',
    ),
    cellSelect,
    roleSelect,
    assignButton,
  );
  container.append(bar);
}

function renderMembersPanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'Members'));
  if (renderAccessNote(container, 'Membership management')) return;

  if (!state.membersLoaded) {
    container.append(createElement('p', 'panel-note', 'Loading members…'));
    loadMembers()
      .then(() => {
        if (state.tab === 'members') renderPanel();
      })
      .catch((error) => showError(container, error.message));
    return;
  }
  if (!state.members.length) {
    container.append(createElement('p', 'panel-note', 'No users yet.'));
    return;
  }

  renderBulkBar(container);

  const table = document.createElement('table');
  table.className = 'data-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Select', 'Name', 'Admin', 'Cell', 'Role', 'Actions'].forEach((label) =>
    headRow.append(createElement('th', null, label)),
  );
  head.append(headRow);
  table.append(head);
  const body = document.createElement('tbody');
  state.members.forEach((member) => body.append(renderMemberRow(member)));
  table.append(body);
  container.append(table);
}

// --- Exercise panel ------------------------------------------------------

async function loadExercise() {
  state.exercise = await requestJson('/api/auth/exercise');
  state.exerciseLoaded = true;
}

async function loadArchives() {
  const { items } = await requestJson('/api/auth/exercise/archives');
  state.archives = items;
  state.archivesLoaded = true;
}

function renderExerciseNameForm(container) {
  const form = document.createElement('form');
  form.className = 'exercise-name-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = state.exercise.name;
  input.required = true;
  input.maxLength = 80;
  const saveButton = createElement('button', 'primary-button', 'Save');
  saveButton.type = 'submit';
  form.append(input, saveButton);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      state.exercise = await requestJson('/api/auth/exercise', {
        method: 'PATCH',
        body: { name: input.value.trim() },
      });
      renderPanel();
    } catch (error) {
      showError(container, error.message);
    }
  });
  container.append(form);
}

function renderArchiveNowForm(container) {
  const section = createElement('section', 'field-group');
  section.append(createElement('h3', null, 'Archive now'));
  const form = document.createElement('form');
  form.className = 'requirement-form';
  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.placeholder = 'Note (optional)…';
  noteInput.name = 'note';
  const archiveButton = createElement('button', 'primary-button', 'Archive now');
  archiveButton.type = 'submit';
  form.append(noteInput, archiveButton);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await requestJson('/api/auth/exercise/archive', {
        body: { note: noteInput.value.trim() || null },
      });
      form.reset();
      await loadArchives();
      renderPanel();
    } catch (error) {
      showError(section, error.message);
    }
  });
  section.append(form);
  container.append(section);
}

async function restoreArchive(archive) {
  if (
    !(await askConfirm(
      `Restore "${archive.name}" (archived ${formatDtg(new Date(archive.archived_at).getTime())})? ` +
        'The current exercise is archived first, then this one replaces it.',
      'Restore',
    ))
  ) {
    return;
  }
  try {
    await requestJson('/api/auth/exercise/restore', { body: { archive: archive.id } });
    // A reset/restore publishes a live event every tab (including this
    // one) reloads on — nothing further to render here.
  } catch (error) {
    window.alert(error.message);
    await loadArchives();
    renderPanel();
  }
}

function renderArchivesTable(container) {
  container.append(createElement('h3', null, 'Archives'));
  if (!state.archives.length) {
    container.append(createElement('p', 'panel-note', 'No archives yet.'));
    return;
  }
  const table = document.createElement('table');
  table.className = 'data-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Name', 'Archived', 'Note', 'ipb', 'exercise', 'orbat', ''].forEach((label) =>
    headRow.append(createElement('th', null, label)),
  );
  head.append(headRow);
  table.append(head);
  const body = document.createElement('tbody');
  state.archives.forEach((archive) => {
    const row = document.createElement('tr');
    const restoreButton = createElement('button', 'icon-button', 'Restore');
    restoreButton.type = 'button';
    restoreButton.addEventListener('click', () => restoreArchive(archive));
    const actionsCell = document.createElement('td');
    actionsCell.append(restoreButton);
    row.append(
      createElement('td', null, archive.name),
      createElement('td', null, formatDtg(new Date(archive.archived_at).getTime())),
      createElement('td', null, archive.note || '—'),
      createElement('td', null, formatSize(archive.sizes?.ipb)),
      createElement('td', null, formatSize(archive.sizes?.exercise)),
      createElement('td', null, formatSize(archive.sizes?.orbat)),
      actionsCell,
    );
    body.append(row);
  });
  table.append(body);
  container.append(table);
}

async function resetExercise() {
  const result = await askResetConfirmation(state.exercise.name);
  if (!result) return;
  try {
    await requestJson('/api/auth/exercise/reset', {
      body: { name: result.name, confirm: result.confirm },
    });
    // The reset's live event reloads every tab, this one included.
  } catch (error) {
    window.alert(error.message);
  }
}

function renderDangerZone(container) {
  const zone = createElement('div', 'exercise-danger-zone');
  zone.append(
    createElement('h3', null, 'Reset exercise'),
    createElement(
      'p',
      null,
      'Archives the current exercise, then empties every study, ORBAT and exercise record, ' +
        'and clears every membership. This cannot be undone (but the archive can be restored).',
    ),
  );
  const resetButton = createElement('button', 'icon-button danger', 'Reset exercise…');
  resetButton.type = 'button';
  resetButton.addEventListener('click', () => resetExercise());
  zone.append(resetButton);
  container.append(zone);
}

function renderExercisePanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'Exercise'));
  if (renderAccessNote(container, 'Exercise administration')) return;

  if (!state.exerciseLoaded) {
    container.append(createElement('p', 'panel-note', 'Loading…'));
    loadExercise()
      .then(() => {
        if (state.tab === 'exercise') renderPanel();
      })
      .catch((error) => showError(container, error.message));
    return;
  }

  renderExerciseNameForm(container);
  renderArchiveNowForm(container);

  if (!state.archivesLoaded) {
    container.append(createElement('p', 'panel-note', 'Loading archives…'));
    loadArchives()
      .then(() => {
        if (state.tab === 'exercise') renderPanel();
      })
      .catch((error) => showError(container, error.message));
    return;
  }
  renderArchivesTable(container);
  renderDangerZone(container);
}

// --- Audit panel ---------------------------------------------------------

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
    if (state.tab === 'audit') renderPanel();
  } catch (error) {
    if (error.name !== 'AbortError') state.audit = { ...state.audit, loaded: true };
  }
}

function renderAuditPanel() {
  const container = elements.panel;
  container.append(createElement('h2', null, 'Audit trail'));
  if (renderAccessNote(container, 'The audit trail')) return;
  if (!state.audit.loaded) {
    container.append(createElement('p', 'panel-note', 'Loading audit trail…'));
    loadAudit(state.audit.offset);
    return;
  }
  if (!state.audit.items.length) {
    container.append(createElement('p', 'panel-note', 'No audited requests yet.'));
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
  container.append(table);

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
  container.append(pager);
}

// --- Mount -----------------------------------------------------------------

export function mount({ root, status }) {
  root.innerHTML = template;
  state = createState();
  elements = {
    tabNav: root.querySelector('.tab-nav'),
    panel: root.querySelector('.panel'),
  };
  createDialogNode(root);
  createResetDialogNode(root);

  const statusLight = createElement('span', 'status-light');
  const statusText = createElement('span', null, 'User administration');
  status.replaceChildren(statusLight, statusText);

  elements.tabNav.addEventListener('click', (event) => {
    const button = event.target.closest('.tab-button');
    if (!button) return;
    switchTab(button.dataset.tab);
  });

  renderTabNav();
  renderPanel();

  return () => {
    state.session.abort();
    root.replaceChildren();
  };
}
