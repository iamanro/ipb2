import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, test } from 'vitest';

import { showCard } from './db.js';
import { cardRanges, parseRanges } from './ranges.js';

const DATABASE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'unitgenerator.db',
);

function row(sectionPath, name, value, units = null) {
  return { sectionPath, name, value, units };
}

describe('parseRanges', () => {
  test('parses a comma-thousands range with a units column', () => {
    expect(parseRanges([row('Main Gun', 'Effective Range', '2,000-3,000', 'm')])).toEqual([
      { system: 'Main Gun', kind: 'effective', min_m: 2000, max_m: 3000, raw: '2,000-3,000 m' },
    ]);
  });

  test('parses a unit embedded directly after the number, no units column', () => {
    expect(parseRanges([row('Main Gun', 'Maximum Range', '200-1,800m')])).toEqual([
      { system: 'Main Gun', kind: 'maximum', min_m: 200, max_m: 1800, raw: '200-1,800m' },
    ]);
  });

  test('parses a single value with a space before the embedded unit', () => {
    expect(parseRanges([row('Fire Control', 'Range, Day Sight', '1,220 m')])).toEqual([
      { system: 'Fire Control', kind: 'sight', min_m: null, max_m: 1220, raw: '1,220 m' },
    ]);
  });

  test('converts km to metres', () => {
    expect(parseRanges([row('Missile System', 'Maximum Effective Range', '5', 'km')])).toEqual([
      { system: 'Missile System', kind: 'effective', min_m: null, max_m: 5000, raw: '5 km' },
    ]);
  });

  test('a "to"-separated range parses the same as a dash', () => {
    expect(parseRanges([row('System', 'Range', '1 to 50', 'km')])).toEqual([
      { system: 'System', kind: 'other', min_m: 1000, max_m: 50000, raw: '1 to 50 km' },
    ]);
  });

  test.each(['INA', 'N/A', 'NA', 'unk', '', '   ', 'TBD'])(
    'skips a non-distance value %p',
    (value) => {
      expect(parseRanges([row('System', 'Maximum Range', value, 'm')])).toEqual([]);
    },
  );

  test('skips a value with no resolvable unit', () => {
    expect(parseRanges([row('System', 'Maximum Range', '5000')])).toEqual([]);
  });

  test('skips units this module does not model, e.g. nautical miles', () => {
    expect(parseRanges([row('System', 'Maximum Range', '30', 'nm')])).toEqual([]);
  });

  test('a "Minimum Range" single value becomes min_m, not max_m', () => {
    expect(parseRanges([row('Ammunition', 'Minimum Range', '40 m')])).toEqual([
      { system: 'Ammunition', kind: 'minimum', min_m: 40, max_m: null, raw: '40 m' },
    ]);
  });

  test('"Minimum Effective Range" is classified effective, bounded as a minimum', () => {
    expect(parseRanges([row('System', 'Minimum Effective Range', '100', 'm')])).toEqual([
      { system: 'System', kind: 'effective', min_m: 100, max_m: null, raw: '100 m' },
    ]);
  });

  test('a name with no min/max/effective/sight qualifier is "other"', () => {
    expect(parseRanges([row('Protection', 'Self-Destruct Range', '4,000', 'm')])).toEqual([
      { system: 'Protection', kind: 'other', min_m: null, max_m: 4000, raw: '4,000 m' },
    ]);
  });

  test('non-range property names are ignored entirely', () => {
    expect(parseRanges([row('System', 'Crew', '3', 'ea')])).toEqual([]);
  });

  test.each([
    'Traverse Range',
    'Elevation Range (Super Elevation)',
    'Frequency Range',
    'Cruising Range',
    'Ferry Range',
    'Operational Range',
    'R-173 Range',
    'R-168-25VE Range',
    'Automotive Range',
    'Detection Range',
    'Radar Detection Range',
    'Jamming Range',
    'Communication Range',
    'Laser Rangefinder',
    'Accuracy Range',
    'Operating Temperature Range',
  ])('excludes a non-weapon range property by name: %p', (name) => {
    expect(parseRanges([row('System', name, '10-20', 'km')])).toEqual([]);
  });

  test('deduplicates identical entries', () => {
    const rows = [
      row('Main Gun', 'Maximum Range', '5,000', 'm'),
      row('Main Gun', 'Maximum Range', '5,000', 'm'),
    ];
    expect(parseRanges(rows)).toHaveLength(1);
  });

  test('distinguishes entries that differ only by system path', () => {
    const rows = [
      row('Main Gun › Ammunition (Option 1)', 'Maximum Range', '5,000', 'm'),
      row('Main Gun › Ammunition (Option 2)', 'Maximum Range', '5,000', 'm'),
    ];
    expect(parseRanges(rows)).toHaveLength(2);
  });

  test('ignores malformed rows instead of throwing', () => {
    expect(parseRanges([null, {}, row('System', 'Range', null, 'm')])).toEqual([]);
  });
});

describe('cardRanges (integration, real reference database)', () => {
  const available = existsSync(DATABASE);
  const maybeTest = available ? test : test.skip;

  maybeTest('T-72B3: main gun effective and maximum ranges, no automotive/radio range', () => {
    const database = new DatabaseSync(DATABASE, { readOnly: true });
    try {
      const cards = database
        .prepare("SELECT identifier FROM cards WHERE name LIKE '%T-72B3%'")
        .all();
      expect(cards).toHaveLength(1);
      const entries = cardRanges(showCard, database, cards[0].identifier);

      const effective = entries.find(
        (e) => e.kind === 'effective' && e.system.startsWith('Main Gun'),
      );
      expect(effective).toMatchObject({ min_m: 2000, max_m: 3000 });

      const maximum = entries.find(
        (e) => e.kind === 'maximum' && e.system.startsWith('Main Gun') && e.max_m === 5000,
      );
      expect(maximum).toBeTruthy();

      // The vehicle's road range ("Automotive" section) and its radio's
      // range ("R-173 Range") are not weapon ranges.
      expect(entries.some((e) => e.raw.includes('500') && e.raw.includes('km'))).toBe(false);
      expect(entries.some((e) => e.system.toLowerCase().includes('automotive'))).toBe(false);
      expect(entries.some((e) => e.system.toLowerCase().includes('communications'))).toBe(false);
    } finally {
      database.close();
    }
  });

  maybeTest('a man-portable ATGM (9K115 Metis) parses embedded-unit min/max', () => {
    const database = new DatabaseSync(DATABASE, { readOnly: true });
    try {
      const cards = database
        .prepare("SELECT identifier FROM cards WHERE name LIKE '9K115 Metis%'")
        .all();
      expect(cards.length).toBeGreaterThanOrEqual(1);
      const entries = cardRanges(showCard, database, cards[0].identifier);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'maximum', min_m: null, max_m: 1000 }),
          expect.objectContaining({ kind: 'minimum', min_m: 40, max_m: null }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  maybeTest('a howitzer (D-30) parses min/max and skips INA options', () => {
    const database = new DatabaseSync(DATABASE, { readOnly: true });
    try {
      const cards = database
        .prepare("SELECT identifier FROM cards WHERE name LIKE 'D-30 (M1963)%'")
        .all();
      expect(cards).toHaveLength(1);
      const entries = cardRanges(showCard, database, cards[0].identifier);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'minimum', min_m: 1000, max_m: null }),
          expect.objectContaining({ kind: 'maximum', min_m: null, max_m: 15300 }),
          expect.objectContaining({ kind: 'maximum', min_m: null, max_m: 21900 }),
        ]),
      );
      // Both "INA" min/max under Ammunition (Option 2) contribute nothing.
      expect(entries.some((e) => e.raw.toLowerCase().includes('ina'))).toBe(false);
    } finally {
      database.close();
    }
  });

  maybeTest('cardRanges returns null for an unknown identifier', () => {
    const database = new DatabaseSync(DATABASE, { readOnly: true });
    try {
      expect(cardRanges(showCard, database, 'does-not-exist')).toBeNull();
    } finally {
      database.close();
    }
  });
});
