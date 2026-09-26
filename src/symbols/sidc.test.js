import { describe, expect, test } from 'vitest';

import {
  DEFAULT_SIDC,
  affiliationOf,
  defaultThreatSidc,
  describeSidc,
  formatSidc,
  parseSidc,
  withAffiliation,
  withEchelon,
  withFields,
  withStatus,
} from './sidc.js';

describe('parseSidc / formatSidc', () => {
  test('splits a land unit code into its fields and joins it back unchanged', () => {
    const sidc = '10031002161211045101';
    const parts = parseSidc(sidc);
    expect(parts).toEqual({
      version: '10',
      context: '0',
      identity: '3',
      symbolSet: '10',
      status: '0',
      hqtfd: '2',
      amplifier: '16',
      entity: '121104',
      modifier1: '51',
      modifier2: '01',
    });
    expect(formatSidc(parts)).toBe(sidc);
  });

  test('reads a code copied in spaced or dashed groups', () => {
    expect(parseSidc('10 0 3 10 0 0 16 121100 00 00')?.amplifier).toBe('16');
    expect(parseSidc('1003-1000-1612-1100-0000')?.entity).toBe('121100');
  });

  test('rejects anything that is not exactly 20 digits', () => {
    for (const text of [
      '',
      '1003100016121100000',
      '100310001612110000000',
      'SFGPUCI----D---',
      null,
    ]) {
      expect(parseSidc(text)).toBeNull();
    }
  });

  test('refuses a field of the wrong width instead of shifting the code', () => {
    const parts = parseSidc('10031000161211000000');
    expect(() => formatSidc({ ...parts, amplifier: '6' })).toThrow(/amplifier/);
  });

  test('withFields changes only the named fields', () => {
    expect(withFields('10031000161211000000', { identity: '6', amplifier: '18' })).toBe(
      '10061000181211000000',
    );
  });
});

describe('describeSidc', () => {
  test('names every field of a catalogued land unit', () => {
    const fields = Object.fromEntries(
      describeSidc('10031002161211045101').map((field) => [field.key, field.meaning]),
    );
    expect(fields).toMatchObject({
      identity: 'Friend',
      symbolSet: 'Land unit',
      hqtfd: 'Headquarters',
      amplifier: 'Battalion / squadron',
      entity: 'Infantry – motorized',
      modifier1: 'RFID interrogator / sensor',
      modifier2: 'Airborne',
    });
  });

  test('does not read an equipment mobility code as an echelon', () => {
    const amplifier = describeSidc('10031500311201000000').find(
      (field) => field.key === 'amplifier',
    );
    expect(amplifier.meaning).toBe('Mobility (equipment)');
  });

  test('leaves entities of uncatalogued symbol sets unnamed rather than misnaming them', () => {
    const entity = describeSidc('10030100001101000000').find((field) => field.key === 'entity');
    expect(entity.code).toBe('110100');
    expect(entity.meaning).toBeUndefined();
  });
});

describe('withAffiliation / affiliationOf', () => {
  test('round-trips every affiliation through a SIDC', () => {
    for (const affiliation of ['friendly', 'hostile', 'neutral', 'unknown']) {
      expect(affiliationOf(withAffiliation(DEFAULT_SIDC, affiliation))).toBe(affiliation);
    }
  });

  test('folds the exercise joker/faker and pending/assumed identities into their category', () => {
    expect(affiliationOf(withFields(DEFAULT_SIDC, { identity: '0' }))).toBe('unknown'); // pending
    expect(affiliationOf(withFields(DEFAULT_SIDC, { identity: '2' }))).toBe('friendly'); // assumed friend
    expect(affiliationOf(withFields(DEFAULT_SIDC, { identity: '5' }))).toBe('hostile'); // suspect/joker
  });

  test('rejects an unknown affiliation name', () => {
    expect(() => withAffiliation(DEFAULT_SIDC, 'enemy')).toThrow(/affiliation/);
  });

  test('affiliationOf returns null for text that is not a SIDC', () => {
    expect(affiliationOf('not a sidc')).toBeNull();
  });
});

describe('withStatus', () => {
  test('present is the solid frame, planned the dashed one', () => {
    expect(parseSidc(withStatus(DEFAULT_SIDC, 'present')).status).toBe('0');
    expect(parseSidc(withStatus(DEFAULT_SIDC, 'planned')).status).toBe('1');
  });

  test('rejects an unknown status', () => {
    expect(() => withStatus(DEFAULT_SIDC, 'observed')).toThrow(/status/);
  });
});

describe('withEchelon', () => {
  test('maps every IPB echelon name to its APP-6(D) amplifier code', () => {
    const expected = {
      team: '11',
      squad: '12',
      section: '13',
      platoon: '14',
      company: '15',
      battalion: '16',
      regiment: '17',
      brigade: '18',
      division: '21',
      corps: '22',
      army: '23',
    };
    for (const [name, code] of Object.entries(expected)) {
      expect(parseSidc(withEchelon(DEFAULT_SIDC, name)).amplifier).toBe(code);
    }
  });

  test('rejects an unknown echelon name', () => {
    expect(() => withEchelon(DEFAULT_SIDC, 'flotilla')).toThrow(/echelon/);
  });
});

describe('defaultThreatSidc', () => {
  test('is a hostile land unit, infantry, at the given echelon', () => {
    const sidc = defaultThreatSidc('battalion');
    expect(affiliationOf(sidc)).toBe('hostile');
    const parts = parseSidc(sidc);
    expect(parts.symbolSet).toBe('10');
    expect(parts.entity).toBe('121100');
    expect(parts.amplifier).toBe('16');
  });
});
