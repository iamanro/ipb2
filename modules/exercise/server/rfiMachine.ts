/**
 * RFI state machine: a pure transition table, no database. `submitted` is
 * the only entry state reachable from `draft`; `answered` forks into
 * `closed` (satisfied) or `reopened` (needs more work), and `reopened`
 * returns to `assigned` rather than back to `submitted` — the assignee is
 * already known.
 */
const TRANSITIONS: Record<string, string[]> = {
  draft: ['submitted'],
  submitted: ['assigned', 'rejected'],
  assigned: ['in_collection', 'rejected'],
  in_collection: ['answered'],
  answered: ['closed', 'reopened'],
  reopened: ['assigned'],
  closed: [],
  rejected: [],
};

export const RFI_STATES = Object.keys(TRANSITIONS);

export function canTransition(from: string, to: string) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
