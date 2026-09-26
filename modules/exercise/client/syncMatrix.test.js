import { describe, expect, test } from 'vitest';

import {
  buildMatrixRows,
  computeTimeWindow,
  conflictTaskingIds,
  findUncoveredSirs,
  timeScale,
  zoomWindow,
} from './syncMatrix.js';

const H = 3_600_000;
const NOW = Date.UTC(2026, 8, 25, 12, 0);

describe('computeTimeWindow', () => {
  test('fits every tasking span plus LTIOVs, padded an hour', () => {
    const taskings = [
      { start_at: new Date(NOW).toISOString(), end_at: new Date(NOW + 2 * H).toISOString() },
      { start_at: new Date(NOW + 5 * H).toISOString(), end_at: new Date(NOW + 6 * H).toISOString() },
    ];
    const window = computeTimeWindow(taskings, [NOW + 8 * H], NOW);
    expect(window.start).toBe(NOW - H);
    expect(window.end).toBe(NOW + 9 * H);
  });

  test('falls back to now ± 3h with nothing to fit', () => {
    expect(computeTimeWindow([], [], NOW)).toEqual({ start: NOW - 3 * H, end: NOW + 3 * H });
  });
});

test('zoomWindow centres a fixed span', () => {
  expect(zoomWindow(NOW, 24)).toEqual({ start: NOW - 12 * H, end: NOW + 12 * H });
});

describe('timeScale', () => {
  test('maps the window linearly onto [0, width]', () => {
    const scale = timeScale(NOW, NOW + 10 * H, 1000);
    expect(scale(NOW)).toBe(0);
    expect(scale(NOW + 5 * H)).toBe(500);
    expect(scale(NOW + 10 * H)).toBe(1000);
  });
});

describe('buildMatrixRows', () => {
  const nais = [{ id: 1, label: 'NAI 1' }];
  const requirements = [
    {
      id: 10,
      text: 'PIR: enemy attacks?',
      ltiov: new Date(NOW + 20 * H).toISOString(),
      sirs: [
        { id: 100, text: 'Watch the pass', nai_id: 1 },
        { id: 101, text: 'No NAI SIR', nai_id: null },
      ],
    },
    { id: 11, text: 'PIR with no SIRs', ltiov: null, sirs: [] },
  ];

  test('drops requirements with no SIRs and orders PIR then its SIRs', () => {
    const rows = buildMatrixRows(requirements, [], nais);
    expect(rows.map((r) => [r.kind, r.id])).toEqual([
      ['pir', 10],
      ['sir', 100],
      ['sir', 101],
    ]);
  });

  test('a SIR row labels its NAI and sorts taskings by start', () => {
    const taskings = [
      { id: 1, sir_id: 100, start_at: new Date(NOW + 3 * H).toISOString(), end_at: new Date(NOW + 4 * H).toISOString() },
      { id: 2, sir_id: 100, start_at: new Date(NOW).toISOString(), end_at: new Date(NOW + H).toISOString() },
    ];
    const rows = buildMatrixRows(requirements, taskings, nais);
    const sirRow = rows.find((r) => r.id === 100);
    expect(sirRow.label).toBe('Watch the pass — NAI NAI 1');
    expect(sirRow.taskings.map((t) => t.id)).toEqual([2, 1]);
  });
});

describe('findUncoveredSirs', () => {
  test('a SIR with no tasking at all is uncovered', () => {
    const rows = [{ kind: 'sir', id: 1, ltiov: null, taskings: [] }];
    expect(findUncoveredSirs(rows)).toEqual(rows);
  });

  test('a SIR whose only tasking ends after LTIOV is uncovered', () => {
    const rows = [
      {
        kind: 'sir',
        id: 1,
        ltiov: NOW,
        taskings: [{ end_at: new Date(NOW + H).toISOString() }],
      },
    ];
    expect(findUncoveredSirs(rows)).toHaveLength(1);
  });

  test('a SIR with a tasking ending on or before LTIOV is covered', () => {
    const rows = [
      {
        kind: 'sir',
        id: 1,
        ltiov: NOW + H,
        taskings: [{ end_at: new Date(NOW).toISOString() }],
      },
    ];
    expect(findUncoveredSirs(rows)).toEqual([]);
  });

  test('PIR rows are never flagged', () => {
    expect(findUncoveredSirs([{ kind: 'pir', id: 1 }])).toEqual([]);
  });
});

describe('conflictTaskingIds', () => {
  test('collects ids from both overlap and outside-availability conflicts', () => {
    const ids = conflictTaskingIds({
      overlaps: [{ tasking_ids: [1, 2] }],
      outside: [{ tasking_id: 3 }],
    });
    expect([...ids].sort()).toEqual([1, 2, 3]);
  });

  test('handles an empty/missing conflicts object', () => {
    expect(conflictTaskingIds(undefined)).toEqual(new Set());
    expect(conflictTaskingIds({ overlaps: [], outside: [] })).toEqual(new Set());
  });
});
