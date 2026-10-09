/**
 * Scenario clock: derived time, no database, no real-clock dependency (the
 * caller supplies `realNow` so this is fully deterministic under test).
 *
 * Scenario time is `base_scenario_ts` plus elapsed real time since
 * `base_real_ts`, scaled by `rate` — unless paused, in which case it is
 * frozen at `base_scenario_ts`. `reanchor` re-bases the clock so the current
 * scenario instant is preserved across a rate change, pause, or jump.
 */
/** The clock as stored: `paused` is SQLite's 0/1 or, from a caller, a boolean. */
export type Clock = {
  base_real_ts: string;
  base_scenario_ts: string;
  rate: number;
  paused: boolean | number;
};

export function scenarioNowMs(clock: Clock, realNow = Date.now()) {
  const baseScenario = new Date(clock.base_scenario_ts).getTime();
  if (clock.paused) return baseScenario;
  const baseReal = new Date(clock.base_real_ts).getTime();
  return baseScenario + (realNow - baseReal) * clock.rate;
}

export function reanchor(
  clock: Clock,
  { rate, paused, jumpToMs }: { rate?: number; paused?: boolean; jumpToMs?: number } = {},
  realNow = Date.now(),
) {
  const currentMs = jumpToMs ?? scenarioNowMs(clock, realNow);
  return {
    base_real_ts: new Date(realNow).toISOString(),
    base_scenario_ts: new Date(currentMs).toISOString(),
    rate: rate ?? clock.rate,
    paused: paused ?? clock.paused,
  };
}

/** Pending events whose trigger time has arrived, in trigger order. */
export function dueEvents<E extends { state: string; trigger_at: string }>(
  events: E[],
  nowMs: number,
): E[] {
  return events
    .filter((event) => event.state === 'pending' && new Date(event.trigger_at).getTime() <= nowMs)
    .sort((a, b) => Date.parse(a.trigger_at) - Date.parse(b.trigger_at));
}
