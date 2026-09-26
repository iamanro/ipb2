/**
 * White-only owner-cell reassignment control (docs/phase1-access.md C3): a
 * `<select>` a module's card/row renders next to its cell badge and release
 * control. One shared helper for every cell-owned resource (requirements,
 * reports, tracks, RFIs, INTSUMs, collectors) instead of five copies of the
 * same three-option `<select>`.
 */
import { isWhite } from '../../../src/session.js';

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `onReassign(cell)` PATCHes the module's own update endpoint with `{ owner_cell }`. */
export function renderOwnerReassign(currentOwner, onReassign) {
  const label = createElement('label', 'owner-reassign', 'Owner: ');
  const select = document.createElement('select');
  ['white', 'blue', 'red'].forEach((cell) => {
    select.append(
      new Option(
        cell[0].toUpperCase() + cell.slice(1),
        cell,
        cell === currentOwner,
        cell === currentOwner,
      ),
    );
  });
  select.addEventListener('change', () => onReassign(select.value));
  label.append(select);
  return label;
}

/** Appends the owner-reassign control to `container` for White only; a no-op for everyone else. */
export function appendOwnerReassign(container, currentOwner, onReassign) {
  if (!isWhite()) return;
  container.append(renderOwnerReassign(currentOwner, onReassign));
}
