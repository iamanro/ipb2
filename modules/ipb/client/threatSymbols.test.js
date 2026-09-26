import { describe, expect, test } from 'vitest';

import { withEchelon } from '../../../src/symbols/sidc.js';
import { ipbEchelonFromSidc } from './threatSymbols.js';

const BASE = '10031000001211000000';

describe('ipbEchelonFromSidc', () => {
  test('reads every IPB echelon name back from its amplifier code', () => {
    for (const echelon of [
      'team',
      'squad',
      'section',
      'platoon',
      'company',
      'battalion',
      'regiment',
      'brigade',
      'division',
      'corps',
      'army',
    ]) {
      expect(ipbEchelonFromSidc(withEchelon(BASE, echelon))).toBe(echelon);
    }
  });

  test('an unspecified amplifier (00) names no echelon', () => {
    expect(ipbEchelonFromSidc(BASE)).toBeNull();
  });

  test('an unreadable SIDC names no echelon', () => {
    expect(ipbEchelonFromSidc('not-a-sidc')).toBeNull();
  });
});
