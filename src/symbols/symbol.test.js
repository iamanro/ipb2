import { describe, expect, test } from 'vitest';

import { createSymbol, symbolSvg } from './symbol.js';

const HOSTILE_INFANTRY_BATTALION = '10061000161211000000';

describe('text amplifiers', () => {
  // milsymbol throws laying out text if any amplifier key is present but
  // unset; a unit with a designation but no DTG used to blank the whole map.
  test.each([
    ['designation, no DTG', { uniqueDesignation: 'A/1-5', dtg: undefined }],
    ['DTG, no designation', { uniqueDesignation: undefined, dtg: '251430ZSEP26' }],
    ['designation, null formation', { uniqueDesignation: 'A', higherFormation: null }],
  ])('draws with %s', (_label, options) => {
    expect(() => createSymbol(HOSTILE_INFANTRY_BATTALION, options).asSVG()).not.toThrow();
  });

  test('a designation is drawn beside the frame', () => {
    const bare = symbolSvg(HOSTILE_INFANTRY_BATTALION);
    const labelled = symbolSvg(HOSTILE_INFANTRY_BATTALION, { designation: 'A/1-5' });
    expect(labelled).toContain('A/1-5');
    expect(bare).not.toContain('A/1-5');
  });
});
