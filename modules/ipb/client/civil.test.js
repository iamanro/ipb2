import { describe, expect, test } from 'bun:test';

import {
  ASCOPE_ROWS,
  PMESII_COLUMNS,
  countFilledCells,
  groupFilledConsiderations,
  indexCivilConsiderations,
} from './civil.js';

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

describe('groupFilledConsiderations', () => {
  test('groups filled cells by ASCOPE, in ASCOPE display order, omitting empty groups', () => {
    const groups = groupFilledConsiderations(ROWS);
    expect(groups.map((group) => group.ascope)).toEqual(['areas', 'people']);
    expect(groups[0].label).toBe('Areas');
    expect(groups[0].entries).toEqual([ROWS[0]]);
    expect(groups[1].entries).toEqual([ROWS[2]]);
  });

  test('sorts entries within a group by PMESII-PT column order', () => {
    const rows = [
      { ascope: 'areas', pmesii: 'time', text: 'Dry season access only.' },
      { ascope: 'areas', pmesii: 'military', text: 'Key crossroads.' },
      { ascope: 'areas', pmesii: 'economic', text: 'Market square.' },
    ];
    const [group] = groupFilledConsiderations(rows);
    expect(group.entries.map((row) => row.pmesii)).toEqual(['military', 'economic', 'time']);
  });

  test('blank-text rows do not count as filled and empty input yields no groups', () => {
    expect(groupFilledConsiderations([{ ascope: 'areas', pmesii: 'time', text: '   ' }])).toEqual(
      [],
    );
    expect(groupFilledConsiderations(undefined)).toEqual([]);
  });
});
