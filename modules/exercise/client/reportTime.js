import { formatDtg, parseDtg } from '../../../src/dtg.js';

/**
 * A report's observation time for display: its DTG when `occurred_at` is set,
 * otherwise "unknown" with the receipt time beside it, so a reader never takes
 * the time a report was entered for the time something was seen.
 */
export function reportTimeLabel(report) {
  if (report.occurred_at) return formatDtg(Date.parse(report.occurred_at));
  return `unknown (received ${formatDtg(Date.parse(report.created_at))})`;
}

/**
 * The observation instant to plot a report at: the report's own `occurred_at`,
 * else the DTG the analyst typed. A short DTG (`281000Z`) takes its month and
 * year from the scenario clock (`clockNow`, ISO), not the wall clock.
 * Returns `{ observedAt }` (ISO) or `{ error }` when there is no usable time.
 */
export function resolveObservedAt(report, typed, clockNow = null) {
  if (report.occurred_at) return { observedAt: report.occurred_at };
  const text = (typed ?? '').trim();
  if (!text) {
    return { error: 'This report has no observation time. Enter when it was observed to plot it.' };
  }
  const reference = clockNow ? Date.parse(clockNow) : Date.now();
  const ms = parseDtg(text, Number.isFinite(reference) ? reference : Date.now());
  if (ms === null) return { error: 'Observed must be a DTG (281000ZSEP26) or ISO date.' };
  return { observedAt: new Date(ms).toISOString() };
}
