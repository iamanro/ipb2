import { describe, expect, test } from 'vitest';

import { layoutTimeline, scenarioNowMs, sortEventGroups, timelineDomain } from './timeline.js';

const H_HOUR = '2026-09-25T12:00:00.000Z';

function group(indicator, eventsByCoa) {
  return { indicator, naiFeatureId: null, events: new Map(Object.entries(eventsByCoa)) };
}

describe('scenarioNowMs', () => {
  test('advances by real elapsed time scaled by rate', () => {
    const clock = { base_scenario_ts: '2026-09-25T12:00:00.000Z', base_real_ts: '2026-09-25T00:00:00.000Z', rate: 2, paused: false };
    const realNow = new Date('2026-09-25T00:10:00.000Z').getTime();
    expect(scenarioNowMs(clock, realNow)).toBe(new Date('2026-09-25T12:20:00.000Z').getTime());
  });

  test('paused freezes at base_scenario_ts regardless of real time', () => {
    const clock = { base_scenario_ts: '2026-09-25T12:00:00.000Z', base_real_ts: '2026-09-25T00:00:00.000Z', rate: 5, paused: true };
    const realNow = new Date('2026-09-26T00:00:00.000Z').getTime();
    expect(scenarioNowMs(clock, realNow)).toBe(new Date('2026-09-25T12:00:00.000Z').getTime());
  });
});

describe('sortEventGroups', () => {
  test('orders rows by their earliest resolved event time', () => {
    const groups = [
      group('Late', { 1: { expected_offset: 120, expected_at: null } }),
      group('Early', { 1: { expected_offset: 10, expected_at: null } }),
      group('Mid', { 1: { expected_offset: 60, expected_at: null } }),
    ];
    expect(sortEventGroups(groups, H_HOUR).map((g) => g.indicator)).toEqual(['Early', 'Mid', 'Late']);
  });

  test('a group whose events all lack a time sorts last, order preserved among ties', () => {
    const groups = [
      group('NoTimeA', { 1: { expected_offset: null, expected_at: null } }),
      group('Timed', { 1: { expected_offset: 30, expected_at: null } }),
      group('NoTimeB', { 1: { expected_offset: null, expected_at: null } }),
    ];
    expect(sortEventGroups(groups, H_HOUR).map((g) => g.indicator)).toEqual(['Timed', 'NoTimeA', 'NoTimeB']);
  });

  test('the earliest event across several COAs in one row wins', () => {
    const groups = [
      group('Row', {
        1: { expected_offset: 200, expected_at: null },
        2: { expected_offset: 5, expected_at: null },
      }),
    ];
    expect(earliestOffsetOf(sortEventGroups(groups, H_HOUR)[0])).toBe(5);
  });
});

function earliestOffsetOf(group_) {
  return Math.min(...[...group_.events.values()].map((e) => e.expected_offset));
}

describe('timelineDomain', () => {
  test('spans every resolvable phase/event/DP time, padded', () => {
    const phases = [{ start_offset: 0, end_offset: 120 }];
    const events = [{ expected_offset: 60, expected_at: null }];
    const decisionPoints = [{ earliest_offset: 30, latest_offset: 90, earliest_at: null, latest_at: null }];
    const [min, max] = timelineDomain({ phases, events, decisionPoints, hHour: H_HOUR, nowMs: null });
    const hHourMs = new Date(H_HOUR).getTime();
    expect(min).toBeLessThan(hHourMs);
    expect(max).toBeGreaterThan(hHourMs + 120 * 60_000);
  });

  test('falls back to now ± 1h when nothing resolves and no scenario clock is known', () => {
    const before = Date.now();
    const [min, max] = timelineDomain({ phases: [], events: [], decisionPoints: [], hHour: null, nowMs: null });
    const after = Date.now();
    expect(max - min).toBe(7_200_000);
    expect(min).toBeGreaterThanOrEqual(before - 3_600_000);
    expect(min).toBeLessThanOrEqual(after - 3_600_000);
  });

  test('with no other resolvable times, centres on the scenario clock instead of real now', () => {
    const nowMs = 1_000_000_000;
    const [min, max] = timelineDomain({ phases: [], events: [], decisionPoints: [], hHour: null, nowMs });
    expect(min).toBe(nowMs - 900_000);
    expect(max).toBe(nowMs + 900_000);
  });
});

describe('layoutTimeline', () => {
  const domain = [0, 100_000];
  const coas = [{ id: 1, name: 'MLCOA' }, { id: 2, name: 'MDCOA' }];

  test('xScale maps the domain edges to 0 and width', () => {
    const layout = layoutTimeline({ domain, width: 500, coas: [], phases: [], events: [], decisionPoints: [], hHour: null });
    expect(layout.xScale(0)).toBe(0);
    expect(layout.xScale(100_000)).toBe(500);
    expect(layout.xScale(50_000)).toBe(250);
  });

  test('one row per COA, in order, each at a distinct y', () => {
    const layout = layoutTimeline({ domain, width: 500, coas, phases: [], events: [], decisionPoints: [], hHour: null });
    expect(layout.rows.map((r) => r.coaName)).toEqual(['MLCOA', 'MDCOA']);
    expect(layout.rows[1].y).toBeGreaterThan(layout.rows[0].y);
  });

  test('an event lands in its own COA row at the right x', () => {
    const events = [{ id: 9, coa_id: 2, indicator: 'X', expected_offset: null, expected_at: null, nai_feature_id: null }];
    // Use an absolute time within the ms domain via expected_at (domain is raw ms here, not H-hour-relative).
    events[0].expected_at = new Date(50_000).toISOString();
    const layout = layoutTimeline({ domain, width: 500, coas, phases: [], events, decisionPoints: [], hHour: null });
    expect(layout.rows[0].events).toEqual([]);
    expect(layout.rows[1].events).toHaveLength(1);
    expect(layout.rows[1].events[0].x).toBeCloseTo(250, 0);
  });

  test('a phase band spans its start to end offset in pixels', () => {
    const hHour = new Date(0).toISOString();
    const phases = [{ id: 1, name: 'Phase I', start_offset: 0, end_offset: 100_000 / 60_000 }];
    const layout = layoutTimeline({ domain, width: 500, coas: [], phases, events: [], decisionPoints: [], hHour });
    expect(layout.phaseBands).toHaveLength(1);
    expect(layout.phaseBands[0].x).toBeCloseTo(0, 0);
    expect(layout.phaseBands[0].width).toBeCloseTo(500, 0);
  });

  test('a decision point with both ends resolved gets a window bar', () => {
    const hHour = new Date(0).toISOString();
    const decisionPoints = [{ id: 1, name: 'DP1', earliest_offset: 100_000 / 60_000 / 4, latest_offset: (100_000 / 60_000) * 3 / 4, earliest_at: null, latest_at: null }];
    const layout = layoutTimeline({ domain, width: 500, coas: [], phases: [], events: [], decisionPoints, hHour });
    expect(layout.decisionPoints).toHaveLength(1);
    const dp = layout.decisionPoints[0];
    expect(dp.xStart).toBeCloseTo(125, 0);
    expect(dp.xEnd).toBeCloseTo(375, 0);
  });

  test('a decision point with no resolvable time is dropped', () => {
    const decisionPoints = [{ id: 1, name: 'DP1', earliest_offset: null, latest_offset: null, earliest_at: null, latest_at: null }];
    const layout = layoutTimeline({ domain, width: 500, coas: [], phases: [], events: [], decisionPoints, hHour: null });
    expect(layout.decisionPoints).toEqual([]);
  });
});
