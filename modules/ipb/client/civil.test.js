import { describe, expect, test } from 'vitest';

import { ASCOPE_ROWS, PMESII_COLUMNS, countFilledCells, countFilledInRow, indexCivilConsiderations } from './civil.js';

const ROWS = [
  { id: 1, ascope: 'areas', pmesii: 'military', text: 'Key crossroads at Hill 214.' },
  { id: 2, ascope: 'areas', pmesii: 'time', text: '' },
  { id: 3, ascope: 'people', pmesii: 'social', text: 'Mixed ethnic population.' },
];

describe('ASCOPE_ROWS / PMESII_COLUMNS', () => {
  test('six ASCOPE rows and eight PMESII-PT columns, matching the server enums', () => {
    expect(ASCOPE_ROWS.map((row) => row.id)).toEqual([
      'areas',
      'structures',
      'capabilities',
      'organizations',
      'people',
      'events',
    ]);
    expect(PMESII_COLUMNS.map((column) => column.id)).toEqual([
      'political',
      'military',
      'economic',
      'social',
      'information',
      'infrastructure',
      'physical-environment',
      'time',
    ]);
  });
});

describe('indexCivilConsiderations', () => {
  test('indexes rows by "ascope|pmesii" for O(1) lookup', () => {
    const index = indexCivilConsiderations(ROWS);
    expect(index.get('areas|military')).toBe(ROWS[0]);
    expect(index.get('people|social')).toBe(ROWS[2]);
    expect(index.get('events|time')).toBeUndefined();
  });

  test('empty for undefined or empty rows', () => {
    expect(indexCivilConsiderations(undefined).size).toBe(0);
    expect(indexCivilConsiderations([]).size).toBe(0);
  });
});

describe('countFilledCells', () => {
  test('counts only cells with non-blank text', () => {
    expect(countFilledCells(ROWS)).toBe(2);
  });

  test('whitespace-only text does not count as filled', () => {
    expect(countFilledCells([{ ascope: 'areas', pmesii: 'time', text: '   ' }])).toBe(0);
  });

  test('zero for undefined rows', () => {
    expect(countFilledCells(undefined)).toBe(0);
  });
});

describe('countFilledInRow', () => {
  test('counts only the given ASCOPE row', () => {
    expect(countFilledInRow(ROWS, 'areas')).toBe(1);
    expect(countFilledInRow(ROWS, 'people')).toBe(1);
    expect(countFilledInRow(ROWS, 'structures')).toBe(0);
  });
});
