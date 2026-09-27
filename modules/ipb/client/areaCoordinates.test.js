import { describe, expect, test } from 'vitest';

import { formatCorner, parseCornerLines } from './areaCoordinates.js';

const CORNERS = [
  [17.4000123, 49.6000456],
  [17.6, 49.6],
  [17.6, 49.8],
];

describe('parseCornerLines', () => {
  test.each(['mgrs', 'dd'])('untouched %s text keeps every corner exactly', (format) => {
    const text = CORNERS.map((corner) => formatCorner(corner, format)).join('\n');
    expect(parseCornerLines(text, { originals: CORNERS, format })).toEqual({
      corners: CORNERS,
      errors: [],
    });
  });

  test('new or edited lines are read in any notation, within a metre', () => {
    const text = [
      formatCorner(CORNERS[0], 'mgrs'),
      formatCorner([17.5, 49.7], 'mgrs').replaceAll(' ', ''),
      '49.75, 17.55',
      '49.800000 N 17.400000 E',
      '',
    ].join('\n');
    const { corners, errors } = parseCornerLines(text, { originals: CORNERS });
    expect(errors).toEqual([]);
    expect(corners[0]).toEqual(CORNERS[0]);
    expect(corners.slice(2)).toEqual([
      [17.55, 49.75],
      [17.4, 49.8],
    ]);
    // MGRS to the metre: within 1e-5° either way.
    expect(Math.abs(corners[1][0] - 17.5)).toBeLessThan(2e-5);
    expect(Math.abs(corners[1][1] - 49.7)).toBeLessThan(1e-5);
  });

  test('decimal degrees round-trip to 6 places', () => {
    const [[lon, lat]] = parseCornerLines(
      `${formatCorner([17.1234567, -49.7654321], 'dd')}\n0,1\n1,1`,
    ).corners;
    expect(lon).toBeCloseTo(17.123457, 6);
    expect(lat).toBeCloseTo(-49.765432, 6);
  });

  test('a closing line repeating the first is dropped', () => {
    const text = ['49.6, 17.4', '49.6, 17.6', '49.8, 17.6', '49.6, 17.4'].join('\n');
    expect(parseCornerLines(text).corners).toHaveLength(3);
  });

  test('reports unreadable lines by number, and too few corners', () => {
    expect(parseCornerLines('49.6, 17.4\nhill 402\n49.8, 17.6').errors).toEqual([
      { line: 2, text: 'hill 402' },
    ]);
    expect(parseCornerLines('49.6, 17.4\n49.6, 17.4\n49.8, 17.6').errors).toEqual([
      { line: null, text: 'An area needs at least 3 different corners.' },
    ]);
  });
});
