/**
 * Military time: date-time groups and H-hour offsets.
 *
 * A DTG here is always Zulu (UTC): `DDHHMMZMONYY`, e.g. `251430ZSEP26`.
 * Staff write it short (`251430Z`) when the month is obvious, so parsing
 * takes the missing month and year from a reference instant.
 *
 * An H-hour offset is minutes relative to a plan's H-hour: `H+4`, `H+4:30`,
 * `H-0:15`, `H-hour`. Events planned before H-hour is fixed are written this
 * way; `resolveTime` turns either form into an instant once H-hour is known.
 *
 * All instants are epoch milliseconds; storage uses ISO strings.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MINUTE = 60_000;

const pad = (value) => String(value).padStart(2, '0');

/** `251430ZSEP26` for an instant. */
export function formatDtg(ms) {
  const date = new Date(ms);
  return (
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    'Z' +
    MONTHS[date.getUTCMonth()] +
    pad(date.getUTCFullYear() % 100)
  );
}

const DTG = /^(\d{2})(\d{2})(\d{2})\s*Z(?:\s*([A-Z]{3})\s*(\d{2}|\d{4})?)?$/;

/**
 * An instant from a DTG (`251430ZSEP26`, `251430Z SEP 2026`, `251430Z`) or an
 * ISO 8601 string; null when `text` is neither or names an impossible time.
 * A short DTG takes its month and year from `reference` (default: now).
 */
export function parseDtg(text, reference = Date.now()) {
  if (typeof text !== 'string') return null;
  const value = text.trim().toUpperCase();
  if (!value) return null;
  const match = DTG.exec(value);
  if (match) {
    const [, dd, hh, mm, mon, yy] = match;
    const ref = new Date(reference);
    const month = mon === undefined ? ref.getUTCMonth() : MONTHS.indexOf(mon);
    if (month < 0) return null;
    let year = ref.getUTCFullYear();
    if (yy !== undefined) year = yy.length === 4 ? Number(yy) : 2000 + Number(yy);
    const [day, hour, minute] = [Number(dd), Number(hh), Number(mm)];
    if (hour > 23 || minute > 59 || day < 1) return null;
    const ms = Date.UTC(year, month, day, hour, minute);
    // Date.UTC rolls 31 SEP into 1 OCT; a DTG naming a day the month lacks is a typo.
    if (new Date(ms).getUTCDate() !== day) return null;
    return ms;
  }
  // ISO only: Date.parse would also accept free text like "Sep 25".
  if (!/^\d{4}-\d{2}-\d{2}(T|$)/.test(value)) return null;
  // Date.parse reads a date-time without a zone as local time; this app works
  // in Zulu, so a bare "2026-09-26T05:30" is 05:30Z, as its DTG would be.
  const zoned = /T[\d:.]+$/.test(value) ? `${value}Z` : value;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? ms : null;
}

/** `H+4:30`, `H-0:15`, `H-hour` for an offset in minutes. */
export function formatHOffset(minutes) {
  if (minutes === 0) return 'H-hour';
  const sign = minutes < 0 ? '-' : '+';
  const total = Math.abs(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return `H${sign}${hours}${rest ? `:${pad(rest)}` : ''}`;
}

/** Each written form of an offset, with how its captures become minutes. */
const H_OFFSET_FORMS = [
  [/^H\s*([+-])\s*(\d+):(\d{2})$/, (h, m) => (Number(m) > 59 ? null : h * 60 + Number(m))], // H+4:30
  [
    /^H\s*([+-])\s*(\d+)\s*H\s*(\d+)\s*M(?:IN)?$/,
    (h, m) => (Number(m) > 59 ? null : h * 60 + Number(m)),
  ], // H+2h30m
  [/^H\s*([+-])\s*(\d+)\s*M(?:IN)?$/, (m) => Number(m)], // H+90min
  [/^H\s*([+-])\s*(\d+)\s*(?:H|HRS?)?$/, (h) => h * 60], // H+4, H+4h
];

/**
 * Minutes from an H-hour offset: `H+4`, `H+4:30`, `H-0:15`, `H+90min`,
 * `H+2h30m`, `H-hour`/`H`. Null when `text` isn't one.
 */
export function parseHOffset(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim().toUpperCase();
  if (/^H(\s*-?\s*HOUR)?$/.test(value)) return 0;
  for (const [pattern, toMinutes] of H_OFFSET_FORMS) {
    const match = pattern.exec(value);
    if (!match) continue;
    const [, sign, ...parts] = match;
    const minutes = toMinutes(...parts.map(Number));
    if (minutes === null) return null;
    return sign === '-' ? -minutes : minutes;
  }
  return null;
}

/**
 * A planned time as entered: `{ at }` (absolute instant, ms) for a DTG/ISO,
 * `{ offset }` (minutes) for an H-hour offset, null when it is neither.
 */
export function parsePlannedTime(text, reference) {
  const offset = parseHOffset(text);
  if (offset !== null) return { offset };
  const at = parseDtg(text, reference);
  return at === null ? null : { at };
}

/**
 * The instant of a planned time: `at` (ISO string or ms) when absolute, or
 * H-hour plus `offset` minutes. Null when relative and H-hour isn't set.
 */
export function resolveTime({ at = null, offset = null }, hHour = null) {
  if (at !== null && at !== undefined) {
    const ms = typeof at === 'number' ? at : Date.parse(at);
    return Number.isFinite(ms) ? ms : null;
  }
  if (offset === null || offset === undefined) return null;
  const base = typeof hHour === 'number' ? hHour : hHour ? Date.parse(hHour) : NaN;
  return Number.isFinite(base) ? base + offset * MINUTE : null;
}

/**
 * How a planned time reads: `H+4 (251830ZSEP26)` when relative and H-hour is
 * known, `H+4` when it isn't, the DTG when absolute; '' when unset.
 */
export function formatPlannedTime(time, hHour = null) {
  if (!time) return '';
  const ms = resolveTime(time, hHour);
  if (time.offset !== null && time.offset !== undefined) {
    const relative = formatHOffset(time.offset);
    return ms === null ? relative : `${relative} (${formatDtg(ms)})`;
  }
  return ms === null ? '' : formatDtg(ms);
}
