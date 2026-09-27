import { describe, expect, test } from 'vitest';

import { filterByCoa } from './sitemp.js';

const featureOf = (coaId) => ({ id: coaId, properties: { coa_id: coaId } });
const FEATURES = [featureOf(1), featureOf(2), featureOf(1)];

describe('filterByCoa', () => {
  test('no COA selected: every feature shows', () => {
    expect(filterByCoa(FEATURES, null, false)).toEqual(FEATURES);
  });

  test('a COA selected and "show all" off: only that COA', () => {
    expect(filterByCoa(FEATURES, 1, false)).toEqual([FEATURES[0], FEATURES[2]]);
  });

  test('a feature with no COA shows on whichever COA is selected', () => {
    const everyCoa = { id: 9, properties: { coa_id: null } };
    const noProperties = { id: 10, properties: {} };
    expect(filterByCoa([...FEATURES, everyCoa, noProperties], 2, false)).toEqual([
      FEATURES[1],
      everyCoa,
      noProperties,
    ]);
  });

  test('a COA selected but "show all" on: every feature still shows', () => {
    expect(filterByCoa(FEATURES, 1, true)).toEqual(FEATURES);
  });
});
