import { describe, expect, test } from 'vitest';

import {
  compassPoint,
  downwindRotation,
  latestWmsTime,
  parseForecast,
  parseWind,
  recolourCloudMask,
  windLattice,
} from './weather.js';

describe('windLattice', () => {
  const size = [1200, 800];
  const view = [17.2, 49.5, 17.8, 49.9];

  test('arrows stay at least minSpacing px apart and within the point cap', () => {
    const { step, points } = windLattice(view, size, { minSpacing: 90, maxPoints: 60 });
    expect(step * (size[0] / 0.6)).toBeGreaterThanOrEqual(90);
    expect(step * (size[1] / 0.4)).toBeGreaterThanOrEqual(90);
    expect(points.length).toBeLessThanOrEqual(60);
    for (const { lon, lat } of points) {
      expect(lon).toBeGreaterThan(view[0]);
      expect(lon).toBeLessThan(view[2]);
      expect(lat).toBeGreaterThan(view[1]);
      expect(lat).toBeLessThan(view[3]);
    }
  });

  test('panning keeps the points already fetched (same keys)', () => {
    const before = windLattice(view, size);
    const after = windLattice([17.23, 49.52, 17.83, 49.92], size);
    expect(after.step).toBe(before.step);
    const keys = new Set(before.points.map((point) => point.key));
    const shared = after.points.filter((point) => keys.has(point.key));
    expect(shared.length).toBeGreaterThan(after.points.length / 2);
  });

  test('never finer than the model grid, however far zoomed in', () => {
    const { step, points } = windLattice([17.5, 49.7, 17.51, 49.705], size);
    expect(step).toBe(0.02);
    expect(points).toEqual([]);
  });
});

describe('recolourCloudMask', () => {
  test('cloud keeps the tint, clear land and water vanish, no-data stays transparent', () => {
    // RGBA: cloud, clear land, clear water, outside the image.
    const pixels = new Uint8ClampedArray([
      255, 255, 255, 255, 0, 192, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0,
    ]);
    recolourCloudMask(pixels, [10, 20, 30], 0.5);
    expect([...pixels.subarray(0, 4)]).toEqual([10, 20, 30, 128]);
    expect([pixels[7], pixels[11], pixels[15]]).toEqual([0, 0, 0]);
  });
});

describe('latestWmsTime', () => {
  test('reads the time dimension default, not another dimension', () => {
    const xml = `<Layer><Dimension name="elevation" default="0">0</Dimension>
      <Dimension name="time" default="2026-09-24T19:45:00Z" units="ISO8601">2020…/PT15M</Dimension></Layer>`;
    expect(latestWmsTime(xml)).toBe(Date.UTC(2026, 8, 24, 19, 45));
    expect(latestWmsTime('<ServiceException>no layer</ServiceException>')).toBeNull();
  });
});

describe('wind direction', () => {
  test('arrows point downwind: a westerly (from 270°) points east', () => {
    expect(downwindRotation(270)).toBeCloseTo(Math.PI / 2);
    expect(downwindRotation(0)).toBeCloseTo(Math.PI);
  });

  test('compass sectors are centred on their direction, wrapping at north', () => {
    expect(compassPoint(349)).toBe('N');
    expect(compassPoint(11.2)).toBe('N');
    expect(compassPoint(11.3)).toBe('NNE');
    expect(compassPoint(279)).toBe('W');
  });
});

describe('parseForecast', () => {
  test('a row covers its whole window: a shower between sampled hours is not lost', () => {
    const hour = 3600;
    const hourly = {
      time: [0, 1, 2, 3, 4, 5, 6].map((index) => 1790280000 + index * hour),
      temperature_2m: [8, 7, 7, 6, 6, 5, 5],
      // Values at hour i are for the hour *before* i: the shower is 01:00-02:00.
      precipitation: [0, 0, 1.2, 0.3, 0, 0, 0],
      precipitation_probability: [10, 20, 70, 40, 0, 0, 0],
      weather_code: [3, 3, 80, 61, 3, 3, 3],
      wind_gusts_10m: [4, 5, 11, 6, 4, 4, 4],
    };
    const { hours } = parseForecast({ hourly });
    expect(hours).toHaveLength(2);
    expect(hours[0]).toMatchObject({
      time: 1790280000000,
      temperature: 8,
      precipitation: 1.5,
      probability: 70,
      code: 80,
      gusts: 11,
    });
    expect(hours[1]).toMatchObject({ temperature: 6, precipitation: 0, code: 3 });
  });
});

describe('parseWind', () => {
  test('a one-point response is an object, not a one-element array', () => {
    const points = [{ lon: 17.5, lat: 49.7, key: 'a' }];
    const json = { current: { time: 1790280000, wind_speed_10m: 4.2, wind_direction_10m: 279 } };
    expect(parseWind(json, points)).toEqual([
      { ...points[0], speed: 4.2, direction: 279, gusts: null, time: 1790280000000 },
    ]);
  });
});
