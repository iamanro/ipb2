import { describe, expect, test } from 'vitest';

import { computePirFulfillment } from './fulfillment.ts';

describe('computePirFulfillment', () => {
  test('no SIRs: open, 0%, not a divide-by-zero NaN', () => {
    expect(computePirFulfillment([], [])).toEqual({
      covered: 0,
      total: 0,
      percent: 0,
      state: 'open',
    });
  });

  test('no evidence at all: open, 0%', () => {
    const result = computePirFulfillment([1, 2], []);
    expect(result).toMatchObject({ covered: 0, total: 2, percent: 0, state: 'open' });
  });

  test('a confirming link at credibility 1 covers its SIR', () => {
    const result = computePirFulfillment(
      [1, 2],
      [{ sirId: 1, relation: 'confirms', credibility: 1 }],
    );
    expect(result).toMatchObject({ covered: 1, total: 2, percent: 50, state: 'partial' });
  });

  test('a partial link also counts as coverage', () => {
    const result = computePirFulfillment([1], [{ sirId: 1, relation: 'partial', credibility: 2 }]);
    expect(result).toMatchObject({ covered: 1, total: 1, percent: 100, state: 'fulfilled' });
  });

  test('a denies or context link does not count as coverage', () => {
    const links = [
      { sirId: 1, relation: 'denies', credibility: 1 },
      { sirId: 1, relation: 'context', credibility: 1 },
    ];
    expect(computePirFulfillment([1], links)).toMatchObject({
      covered: 0,
      percent: 0,
      state: 'open',
    });
  });

  test('credibility below the threshold (numerically higher) does not count', () => {
    // Admiralty credibility: 1 is best, 6 is worst; the threshold is <= 3.
    const result = computePirFulfillment([1], [{ sirId: 1, relation: 'confirms', credibility: 4 }]);
    expect(result).toMatchObject({ covered: 0, state: 'open' });
  });

  test('credibility exactly at the threshold (3) does count', () => {
    const result = computePirFulfillment([1], [{ sirId: 1, relation: 'confirms', credibility: 3 }]);
    expect(result).toMatchObject({ covered: 1, state: 'fulfilled' });
  });

  test('a link against the requirement itself (sirId null) covers every SIR', () => {
    const result = computePirFulfillment(
      [1, 2, 3],
      [{ sirId: null, relation: 'confirms', credibility: 1 }],
    );
    expect(result).toMatchObject({ covered: 3, total: 3, percent: 100, state: 'fulfilled' });
  });

  test('fully covered is "fulfilled", not "answered", until a product is issued', () => {
    const links = [{ sirId: 1, relation: 'confirms', credibility: 1 }];
    expect(computePirFulfillment([1], links)).toMatchObject({ state: 'fulfilled' });
    expect(computePirFulfillment([1], links, { productIssued: true })).toMatchObject({
      state: 'answered',
    });
  });

  test('multiple qualifying links on one SIR still count it once, never over 100%', () => {
    const links = [
      { sirId: 1, relation: 'confirms', credibility: 1 },
      { sirId: 1, relation: 'partial', credibility: 2 },
      { sirId: 1, relation: 'confirms', credibility: 3 },
    ];
    expect(computePirFulfillment([1], links)).toMatchObject({ covered: 1, total: 1, percent: 100 });
  });
});
