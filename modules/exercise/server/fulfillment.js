/**
 * PIR fulfillment: a pure function over already-joined data, no database.
 *
 * A SIR counts as covered when at least one evidence link against it (or
 * against its parent requirement) confirms or partially confirms it, from a
 * report credible enough to trust (Admiralty credibility 1-3, i.e. "probably
 * true" or better). A PIR's fulfillment is the share of its SIRs covered.
 *
 * `links` is `{ sirId, relation, credibility }[]`; a link recorded against
 * the requirement itself (no specific SIR) covers every SIR under it.
 */
const CREDITABLE_RELATIONS = new Set(['confirms', 'partial']);
const CREDIBILITY_THRESHOLD = 3;

function isCreditable(link) {
  return CREDITABLE_RELATIONS.has(link.relation) && link.credibility <= CREDIBILITY_THRESHOLD;
}

export function computePirFulfillment(sirIds, links, { productIssued = false } = {}) {
  const creditable = links.filter(isCreditable);
  const blanket = creditable.some((link) => link.sirId === null);
  const covered = blanket
    ? sirIds.length
    : sirIds.filter((id) => creditable.some((link) => link.sirId === id)).length;
  const total = sirIds.length;
  const percent = total === 0 ? 0 : Math.round((covered / total) * 100);
  let state = 'open';
  if (total > 0 && covered === total) state = productIssued ? 'answered' : 'fulfilled';
  else if (covered > 0) state = 'partial';
  return { covered, total, percent, state };
}
