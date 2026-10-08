import { describe, expect, test } from 'vitest';

import { reportTimeLabel, resolveObservedAt } from './reportTime.js';

const RECEIVED = '2026-09-28T17:45:00.000Z';

describe('reportTimeLabel', () => {
  test('shows the observation DTG when the report has one', () => {
    expect(reportTimeLabel({ occurred_at: '2026-09-28T10:00:00.000Z', created_at: RECEIVED })).toBe(
      '281000ZSEP26',
    );
  });

  test('never presents the receipt time as the observation time', () => {
    expect(reportTimeLabel({ occurred_at: null, created_at: RECEIVED })).toBe(
      'unknown (received 281745ZSEP26)',
    );
  });
});

describe('resolveObservedAt', () => {
  test("uses the report's own observation time", () => {
    const report = { occurred_at: '2026-09-28T10:00:00.000Z' };
    expect(resolveObservedAt(report, '')).toEqual({ observedAt: report.occurred_at });
  });

  test('an unknown observation time must be entered before plotting', () => {
    expect(resolveObservedAt({ occurred_at: null }, '  ')).toHaveProperty('error');
  });

  test('rejects text that is not a DTG', () => {
    expect(resolveObservedAt({ occurred_at: null }, 'yesterday')).toHaveProperty('error');
  });

  test('a short DTG takes month and year from the scenario clock, paused or accelerated', () => {
    // Scenario paused at 281000ZSEP26 while the wall clock is weeks later.
    expect(resolveObservedAt({ occurred_at: null }, '280930Z', '2026-09-28T10:00:00.000Z')).toEqual(
      { observedAt: '2026-09-28T09:30:00.000Z' },
    );
    // An accelerated scenario that has run into the next month.
    expect(resolveObservedAt({ occurred_at: null }, '010200Z', '2026-10-01T03:00:00.000Z')).toEqual(
      { observedAt: '2026-10-01T02:00:00.000Z' },
    );
  });

  test('a full DTG is taken as written', () => {
    expect(resolveObservedAt({ occurred_at: null }, '271200ZSEP26')).toEqual({
      observedAt: '2026-09-27T12:00:00.000Z',
    });
  });
});
