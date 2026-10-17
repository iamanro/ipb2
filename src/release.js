/**
 * Cell release (C5, docs/phase1-access.md): the badge every cell-owned
 * item's owner/release state renders as, and the release control a
 * module's list/detail view embeds next to one. Mirrors
 * `server/policy.ts`'s `canRelease`/`CELLS` in miniature — duplicated, not
 * imported, the same reason `src/session.js` duplicates `ROLES`: that file
 * pulls in `node:sqlite` and has no business in a browser bundle. The
 * server enforces regardless of what this predicate shows.
 */
import './release.css';

import { can, cellLabel, currentUser, sessionMode } from './session.js';

const CELLS = ['white', 'blue', 'red'];

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isWhiteUser(user) {
  return Boolean(user?.admin) || user?.cell === 'white';
}

function releasedCells(item) {
  return Array.isArray(item?.releasable_to) ? item.releasable_to : [];
}

/**
 * A small badge for `cell` (`'white' | 'blue' | 'red'`): a colour fill
 * *and* the cell's name as text, so it never reads as colour alone. `cell`
 * missing or unrecognised renders a neutral "—" badge rather than nothing,
 * so a caller's layout never silently collapses.
 */
export function renderCellBadge(cell) {
  const known = CELLS.includes(cell);
  return createElement(
    'span',
    `cell-badge cell-badge-${known ? cell : 'none'}`,
    known ? cellLabel(cell) : '—',
  );
}

/** Mirrors `server/policy.ts`'s `canRelease`: White (incl. admin), or an
 * analyst-or-above member of the item's owning cell. */
export function canReleaseClient(item) {
  if (sessionMode() === 'off') return true;
  const user = currentUser();
  if (!user) return false;
  if (isWhiteUser(user)) return true;
  if (!user.cell || user.cell !== item.owner_cell) return false;
  return can('analyst');
}

/** Mirrors `server/policy.ts`'s `canEdit`: release grants read access only,
 * so edit/delete controls on an item (and its children) show for White or
 * the owning cell. The role check (`can(...)`) still applies on top. */
export function canEditClient(item) {
  if (sessionMode() === 'off') return true;
  const user = currentUser();
  if (!user) return false;
  if (isWhiteUser(user)) return true;
  return Boolean(user.cell) && user.cell === item.owner_cell;
}

/** An accessible `<dialog>` with one checkbox per cell but the item's
 * owner, pre-checked for cells already released to. Resolves the checked
 * cells on submit ("Release"), or `null` on cancel/Escape/backdrop. */
function openReleaseDialog(item) {
  return new Promise((resolve) => {
    const dialog = createElement('dialog', 'release-dialog');
    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'release-form';
    form.append(createElement('h2', 'release-form-title', 'Release to'));
    form.append(
      createElement(
        'p',
        'release-form-hint',
        `Owned by ${cellLabel(item.owner_cell)}. Choose which other cells can see it.`,
      ),
    );

    const already = new Set(releasedCells(item));
    const list = createElement('div', 'release-checklist');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Release to cell');
    const boxes = new Map();
    for (const cell of CELLS) {
      if (cell === item.owner_cell) continue;
      const option = createElement('label', 'release-checklist-option');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = cell;
      box.checked = already.has(cell);
      option.append(box, renderCellBadge(cell));
      list.append(option);
      boxes.set(cell, box);
    }
    form.append(list);

    const actions = createElement('div', 'release-form-actions');
    const cancelButton = createElement('button', 'text-button', 'Cancel');
    cancelButton.type = 'button';
    const submitButton = createElement('button', 'release-form-submit', 'Release');
    submitButton.type = 'submit';
    actions.append(cancelButton, submitButton);
    form.append(actions);

    dialog.append(form);
    document.body.append(dialog);

    cancelButton.addEventListener('click', () => {
      dialog.returnValue = 'cancel';
      dialog.close();
    });
    form.addEventListener('submit', () => {
      dialog.returnValue = 'accept';
    });
    dialog.addEventListener(
      'close',
      () => {
        const result =
          dialog.returnValue === 'accept'
            ? [...boxes].filter(([, box]) => box.checked).map(([cell]) => cell)
            : null;
        dialog.remove();
        resolve(result);
      },
      { once: true },
    );

    dialog.showModal();
  });
}

/**
 * `{ item: { owner_cell, releasable_to }, onRelease(cells) }`: the owner
 * badge, a chip per cell it's released to, and — only when
 * `canReleaseClient(item)`, hidden rather than disabled otherwise, like
 * every other control this app hides for a role that can't use it — a
 * "Release…" button opening `openReleaseDialog`. `onRelease(cells)` is
 * awaited; it's the caller's job to PATCH the module's release endpoint
 * and refresh from the response, not this function's.
 */
export function renderReleaseControl({ item, onRelease }) {
  const wrap = createElement('div', 'release-control');
  wrap.append(
    createElement('span', 'release-control-label', 'Owner'),
    renderCellBadge(item.owner_cell),
  );

  const released = releasedCells(item);
  if (released.length) {
    wrap.append(createElement('span', 'release-control-label', 'Released to'));
    for (const cell of released) {
      const chip = renderCellBadge(cell);
      chip.classList.add('cell-badge-chip');
      wrap.append(chip);
    }
  }

  if (canReleaseClient(item)) {
    const button = createElement('button', 'release-button', 'Release…');
    button.type = 'button';
    button.addEventListener('click', async () => {
      const cells = await openReleaseDialog(item);
      if (cells === null) return;
      await onRelease(cells);
    });
    wrap.append(button);
  }

  return wrap;
}
