/**
 * A time input that stays in Zulu. `<input type="datetime-local">` reads and
 * writes the browser's zone, so the same instant showed two hours apart from
 * the DTGs in SORs and INTSUMs; staff type and read DTGs anyway.
 *
 * Accepts what `parseDtg` does: `261430Z`, `261430ZSEP26`, or ISO (a bare
 * ISO time is Zulu). A short DTG takes month and year from `reference()`,
 * normally scenario time.
 */
import { formatDtg, parseDtg } from './dtg.js';

/** A text input for a Zulu time; `value` (ISO, ms or null) prefills it as a DTG. */
export function createDtgInput({ name, label, value = null, reference = () => Date.now() }) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'dtg-input';
  input.name = name;
  input.placeholder = `${label} (DTG, e.g. 261430Z)`;
  input.setAttribute('aria-label', `${label}, Zulu date-time group`);
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dtgReference = reference;
  setDtgValue(input, value);
  input.addEventListener('input', () => input.setCustomValidity(''));
  input.addEventListener('blur', () => {
    // Normalize what was typed, so the analyst sees the instant it will save.
    const ms = parseDtg(input.value, reference());
    if (ms !== null) input.value = formatDtg(ms);
  });
  return input;
}

/** Show `value` (ISO string, ms or null) in `input` as a DTG. */
export function setDtgValue(input, value) {
  const ms = typeof value === 'number' ? value : value ? Date.parse(value) : NaN;
  input.value = Number.isFinite(ms) ? formatDtg(ms) : '';
}

/**
 * The input's instant as an ISO string, or null when it is empty. Throws an
 * Error naming the field when the text isn't a time, and marks the input
 * invalid so the browser shows it.
 */
export function readDtgValue(input) {
  const text = input.value.trim();
  if (!text) return null;
  const ms = parseDtg(text, input.dtgReference?.() ?? Date.now());
  if (ms === null) {
    const label = input.getAttribute('aria-label')?.split(',')[0] ?? input.name;
    const message = `${label}: enter a DTG such as 261430Z or 261430ZSEP26.`;
    input.setCustomValidity(message);
    input.reportValidity?.();
    throw new Error(message);
  }
  return new Date(ms).toISOString();
}
