import { describe, expect, test } from 'vitest';

import { dueEvents, reanchor, scenarioNowMs } from './scenarioClock.ts';

const BASE_REAL = new Date('2026-01-01T00:00:00.000Z').getTime();
const BASE_SCENARIO = new Date('2026-06-01T06:00:00.000Z').getTime();

function clock({ rate = 1, paused = false } = {}) {
  return {
    base_real_ts: new Date(BASE_REAL).toISOString(),
    base_scenario_ts: new Date(BASE_SCENARIO).toISOString(),
    rate,
    paused,
  };
}

describe('scenarioNowMs', () => {
  test('at the anchor instant, scenario time equals the scenario base', () => {
    expect(scenarioNowMs(clock(), BASE_REAL)).toBe(BASE_SCENARIO);
  });

  test('advances at 1x with real time when running', () => {
    expect(scenarioNowMs(clock({ rate: 1 }), BASE_REAL + 60_000)).toBe(BASE_SCENARIO + 60_000);
  });

  test('advances proportionally to rate', () => {
    expect(scenarioNowMs(clock({ rate: 4 }), BASE_REAL + 60_000)).toBe(BASE_SCENARIO + 240_000);
  });

  test('is frozen at the scenario base while paused, regardless of elapsed real time', () => {
    expect(scenarioNowMs(clock({ paused: true }), BASE_REAL + 3_600_000)).toBe(BASE_SCENARIO);
  });
});

describe('reanchor', () => {
  test('preserves the current scenario instant across a rate change', () => {
    const running = clock({ rate: 1 });
    const realNow = BASE_REAL + 60_000; // scenario now = BASE_SCENARIO + 60s
    const before = scenarioNowMs(running, realNow);
    const rebased = reanchor(running, { rate: 4 }, realNow);
    const after = scenarioNowMs(rebased, realNow);
    expect(after).toBe(before);
    expect(rebased.rate).toBe(4);
  });

  test('pausing freezes exactly at the instant it was paused, not the original base', () => {
    const running = clock({ rate: 2 });
    const realNow = BASE_REAL + 30_000; // scenario now = BASE_SCENARIO + 60s (2x)
    const pausedAt = scenarioNowMs(running, realNow);
    const paused = reanchor(running, { paused: true }, realNow);
    expect(scenarioNowMs(paused, realNow + 999_999)).toBe(pausedAt);
  });

  test('a jump sets scenario time directly, independent of elapsed real time', () => {
    const running = clock();
    const jumpTarget = BASE_SCENARIO + 86_400_000; // one scenario day forward
    const jumped = reanchor(running, { jumpToMs: jumpTarget }, BASE_REAL);
    expect(scenarioNowMs(jumped, BASE_REAL)).toBe(jumpTarget);
  });

  test('resuming from pause continues from the paused instant, not a jump back', () => {
    const running = clock({ rate: 1 });
    const pauseRealTs = BASE_REAL + 60_000;
    const paused = reanchor(running, { paused: true }, pauseRealTs);
    // Time passes with the clock paused...
    const resumeRealTs = pauseRealTs + 3_600_000;
    const resumed = reanchor(paused, { paused: false }, resumeRealTs);
    // Scenario time must still read where it was paused, not have jumped
    // forward by the real hour that passed while paused.
    expect(scenarioNowMs(resumed, resumeRealTs)).toBe(BASE_SCENARIO + 60_000);
  });
});

describe('dueEvents', () => {
  const events = [
    { id: 1, trigger_at: new Date(BASE_SCENARIO + 1000).toISOString(), state: 'pending' },
    { id: 2, trigger_at: new Date(BASE_SCENARIO - 1000).toISOString(), state: 'pending' },
    { id: 3, trigger_at: new Date(BASE_SCENARIO - 2000).toISOString(), state: 'fired' },
    { id: 4, trigger_at: new Date(BASE_SCENARIO + 2000).toISOString(), state: 'pending' },
  ];

  test('returns only pending events at or before now, earliest first', () => {
    const due = dueEvents(events, BASE_SCENARIO);
    expect(due.map((event) => event.id)).toEqual([2]);
  });

  test('a later "now" picks up more events, still in trigger order', () => {
    const due = dueEvents(events, BASE_SCENARIO + 2000);
    expect(due.map((event) => event.id)).toEqual([2, 1, 4]);
  });

  test('an already-fired event is never re-fired, even if its time has passed', () => {
    const due = dueEvents(events, BASE_SCENARIO + 10_000);
    expect(due.some((event) => event.id === 3)).toBe(false);
  });
});
