import { describe, expect, test } from 'vitest';

import { RFI_STATES, canTransition } from './rfiMachine.ts';

describe('canTransition', () => {
  test.each([
    ['draft', 'submitted'],
    ['submitted', 'assigned'],
    ['submitted', 'rejected'],
    ['assigned', 'in_collection'],
    ['assigned', 'rejected'],
    ['in_collection', 'answered'],
    ['answered', 'closed'],
    ['answered', 'reopened'],
    ['reopened', 'assigned'],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  test.each([
    ['draft', 'answered'],
    ['submitted', 'in_collection'],
    ['assigned', 'answered'],
    ['closed', 'reopened'],
    ['rejected', 'submitted'],
    ['reopened', 'submitted'],
    ['answered', 'assigned'],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  test('closed and rejected are terminal: nothing transitions out of them', () => {
    for (const to of RFI_STATES) {
      expect(canTransition('closed', to)).toBe(false);
      expect(canTransition('rejected', to)).toBe(false);
    }
  });

  test('rejects an unknown state instead of throwing', () => {
    expect(canTransition('nonexistent', 'draft')).toBe(false);
    expect(canTransition('draft', 'nonexistent')).toBe(false);
  });
});
