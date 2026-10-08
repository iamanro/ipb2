import { describe, expect, test } from 'vitest';

import { LEGEND } from './mobility.ts';
import { renderHillshade, renderSlopeClasses } from './rasterTiles.ts';
import { tileRange } from './tiles.ts';

// A zoom-12 tile inside the Libavá test area; the elevation functions below
// ignore where they are, only how they slope.
const Z = 12;
const { minX: X, minY: Y } = tileRange([17.5, 49.7, 17.51, 49.71], Z);
const SIZE = 16;

const alphas = (rgba) => rgba.filter((_, index) => index % 4 === 3);

describe('renderHillshade', () => {
  test('leaves flat ground fully transparent, so the basemap shows through unchanged', () => {
    expect(alphas(renderHillshade(() => 300, Z, X, Y, SIZE)).every((a) => a === 0)).toBe(true);
  });

  test('darkens slopes facing away from the north-west sun and lightens those facing it', () => {
    // Ground rising towards the north-west faces south-east: away from the sun.
    const risingNorthWest = (lon, lat) => (lat - lon) * 20000;
    const shadow = renderHillshade(risingNorthWest, Z, X, Y, SIZE);
    const lit = renderHillshade((lon, lat) => -risingNorthWest(lon, lat), Z, X, Y, SIZE);
    // Shadow pixels are black, lit pixels white; both visibly opaque.
    expect([shadow[0], shadow[1], shadow[2]]).toEqual([0, 0, 0]);
    expect([lit[0], lit[1], lit[2]]).toEqual([255, 255, 255]);
    expect(shadow[3]).toBeGreaterThan(40);
    expect(lit[3]).toBeGreaterThan(20);
  });

  test('leaves pixels without elevation data transparent', () => {
    const halfMissing = (lon) => (lon < 17.505 ? Number.NaN : 300 + lon * 1e4);
    const rgba = renderHillshade(halfMissing, Z, X, Y, SIZE);
    // First column is west of the cut-off: no data, so no shading at all.
    for (let row = 0; row < SIZE; row += 1) expect(rgba[row * SIZE * 4 + 3]).toBe(0);
  });
});

describe('renderSlopeClasses', () => {
  // A plane rising northwards at `degrees`, in metres per degree of latitude.
  const plane = (degrees) => (lon, lat) => Math.tan((degrees * Math.PI) / 180) * lat * 111132.95;
  const colourOf = (code) => {
    const hex = LEGEND.find((entry) => entry.code === code).color;
    return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  };

  test('tints slopes with the MCOO band colours and leaves GO ground clear', () => {
    const gentle = renderSlopeClasses(plane(5), Z, X, Y, SIZE);
    const restricted = renderSlopeClasses(plane(20), Z, X, Y, SIZE);
    const severe = renderSlopeClasses(plane(40), Z, X, Y, SIZE);
    expect(alphas(gentle).every((a) => a === 0)).toBe(true);
    expect(Array.from(restricted.subarray(0, 3))).toEqual(colourOf('SLOW-GO'));
    expect(Array.from(severe.subarray(0, 3))).toEqual(colourOf('NO-GO'));
    expect(restricted[3]).toBeGreaterThan(0);
    expect(severe[3]).toBeGreaterThan(0);
  });
});
