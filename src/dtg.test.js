import { describe, expect, test } from 'vitest';

import {
  formatDtg,
  formatHOffset,
  formatPlannedTime,
  parseDtg,
  parseHOffset,
  parsePlannedTime,
  resolveTime,
} from './dtg.js';

const AT = Date.UTC(2026, 8, 25, 14, 30); // 25 SEP 2026 14:30Z

describe('DTG', () => {
  test('formats Zulu, independent of the local zone', () => {
    expect(formatDtg(AT)).toBe('251430ZSEP26');
    expect(formatDtg(Date.UTC(2027, 0, 1, 0, 5))).toBe('010005ZJAN27');
  });

  test.each([
    ['full', '251430ZSEP26'],
    ['spaced, four-digit year', '251430Z SEP 2026'],
    ['lower case', '251430zsep26'],
    ['ISO', '2026-09-25T14:30:00Z'],
  ])('parses %s', (_label, text) => {
    expect(parseDtg(text)).toBe(AT);
  });

  test('an ISO time without a zone is Zulu, not the local zone', () => {
    expect(parseDtg('2026-09-25T14:30')).toBe(AT);
    expect(parseDtg('2026-09-25T16:30+02:00')).toBe(AT);
  });

  test('a short DTG takes month and year from the reference', () => {
    expect(parseDtg('251430Z', Date.UTC(2026, 8, 1))).toBe(AT);
  });

  test('round-trips', () => {
    expect(parseDtg(formatDtg(AT))).toBe(AT);
  });

  test.each([
    '311200ZSEP26',
    '252460ZSEP26',
    '001200ZSEP26',
    '251430ZXYZ26',
    'Sep 25',
    'H+4',
    '',
    '2514',
  ])('rejects %j', (text) => {
    expect(parseDtg(text)).toBeNull();
  });
});

describe('H-hour offsets', () => {
  test.each([
    ['H-hour', 0],
    ['H', 0],
    ['H+4', 240],
    ['h+4', 240],
    ['H+4:30', 270],
    ['H-0:15', -15],
    ['H+90min', 90],
    ['H+2h30m', 150],
    ['H - 2', -120],
  ])('parses %j as %d minutes', (text, minutes) => {
    expect(parseHOffset(text)).toBe(minutes);
  });

  test.each(['H+4:75', '4', 'H+', '251430Z', 'H+x'])('rejects %j', (text) => {
    expect(parseHOffset(text)).toBeNull();
  });

  test('formats and round-trips', () => {
    expect(formatHOffset(0)).toBe('H-hour');
    expect(formatHOffset(270)).toBe('H+4:30');
    expect(formatHOffset(-15)).toBe('H-0:15');
    for (const minutes of [-600, -15, 0, 45, 240, 1470]) {
      expect(parseHOffset(formatHOffset(minutes))).toBe(minutes);
    }
  });
});

describe('planned times', () => {
  const hHour = Date.UTC(2026, 8, 25, 10, 0);

  test('an entry is relative or absolute, never both', () => {
    expect(parsePlannedTime('H+4:30')).toEqual({ offset: 270 });
    expect(parsePlannedTime('251430ZSEP26')).toEqual({ at: AT });
    expect(parsePlannedTime('dawn')).toBeNull();
  });

  test('relative times resolve only once H-hour is set', () => {
    expect(resolveTime({ offset: 270 }, hHour)).toBe(AT);
    expect(resolveTime({ offset: 270 }, new Date(hHour).toISOString())).toBe(AT);
    expect(resolveTime({ offset: 270 }, null)).toBeNull();
    expect(resolveTime({ at: new Date(AT).toISOString() }, null)).toBe(AT);
  });

  test('reads as the staff write it', () => {
    expect(formatPlannedTime({ offset: 270 }, hHour)).toBe('H+4:30 (251430ZSEP26)');
    expect(formatPlannedTime({ offset: 270 }, null)).toBe('H+4:30');
    expect(formatPlannedTime({ at: AT }, null)).toBe('251430ZSEP26');
    expect(formatPlannedTime(null)).toBe('');
  });
});
