import { describe, expect, test } from 'vitest';

import {
  DEFAULT_WEATHER_THRESHOLDS,
  WEATHER_SYSTEMS,
  classifyLight,
  evaluateWeatherCell,
  evaluateWeatherMatrix,
  forecastLightStates,
  resolveThresholds,
  resolveWeatherEffectsPoint,
} from './weatherEffects.js';

const LIGHT = {
  bmnt: 4 * 3600_000,
  bmct: 5 * 3600_000,
  sunrise: 6 * 3600_000,
  sunset: 20 * 3600_000,
  eect: 21 * 3600_000,
  eent: 22 * 3600_000,
};

describe('classifyLight', () => {
  test('day between sunrise and sunset', () => {
    expect(classifyLight(LIGHT, 12 * 3600_000)).toBe('day');
    expect(classifyLight(LIGHT, LIGHT.sunrise)).toBe('day');
    expect(classifyLight(LIGHT, LIGHT.sunset)).toBe('day');
  });

  test('civil twilight between BMCT/sunrise and sunset/EECT', () => {
    expect(classifyLight(LIGHT, 5.5 * 3600_000)).toBe('civil-twilight');
    expect(classifyLight(LIGHT, 20.5 * 3600_000)).toBe('civil-twilight');
  });

  test('nautical twilight between BMNT/BMCT and EECT/EENT', () => {
    expect(classifyLight(LIGHT, 4.5 * 3600_000)).toBe('nautical-twilight');
    expect(classifyLight(LIGHT, 21.5 * 3600_000)).toBe('nautical-twilight');
  });

  test('night before BMNT and after EENT', () => {
    expect(classifyLight(LIGHT, 1 * 3600_000)).toBe('night');
    expect(classifyLight(LIGHT, 23 * 3600_000)).toBe('night');
  });

  test('missing light data (polar day/night) defaults to day', () => {
    expect(classifyLight(null, 0)).toBe('day');
    expect(classifyLight({ bmnt: null, bmct: null, sunrise: null, sunset: null, eect: null, eent: null }, 0)).toBe(
      'day',
    );
  });
});

describe('resolveThresholds', () => {
  test('fills every factor from defaults when nothing is saved', () => {
    expect(resolveThresholds(null)).toEqual(DEFAULT_WEATHER_THRESHOLDS);
  });

  test('merges a saved factor over its defaults without losing sibling keys', () => {
    const resolved = resolveThresholds({ wind_ms: { marginal: 5 } });
    expect(resolved.wind_ms).toEqual({ marginal: 5, unfavourable: 15 });
    expect(resolved.gusts_ms).toEqual(DEFAULT_WEATHER_THRESHOLDS.gusts_ms);
  });
});

describe('evaluateWeatherCell', () => {
  const thresholds = DEFAULT_WEATHER_THRESHOLDS;

  test('favourable when every applicable factor is under its marginal threshold', () => {
    const system = WEATHER_SYSTEMS.find((entry) => entry.id === 'dismounted-movement');
    const hour = { precipitation: 0, visibility: 10000, temperature: 15 };
    const cell = evaluateWeatherCell(system, hour, thresholds, 'day');
    expect(cell.rating).toBe('favourable');
  });

  test('rates the worst of its applicable factors, not the average', () => {
    const system = WEATHER_SYSTEMS.find((entry) => entry.id === 'rotary-wing');
    // Wind favourable, gusts unfavourable: the cell must read unfavourable.
    const hour = { wind: 2, gusts: 25, visibility: 10000, cloudLow: 10 };
    const cell = evaluateWeatherCell(system, hour, thresholds, 'day');
    expect(cell.rating).toBe('unfavourable');
    expect(cell.reasons.find((reason) => reason.factor === 'gusts').rating).toBe('unfavourable');
    expect(cell.reasons.find((reason) => reason.factor === 'wind').rating).toBe('favourable');
  });

  test('a factor with no data is skipped, not counted favourable or unfavourable', () => {
    const system = WEATHER_SYSTEMS.find((entry) => entry.id === 'wheeled-movement');
    const cell = evaluateWeatherCell(system, { precipitation: 0, visibility: null }, thresholds, 'day');
    expect(cell.reasons.map((reason) => reason.factor)).toEqual(['precipitation']);
  });

  test('visibility is low-is-bad: low visibility rates worse, not better', () => {
    const system = WEATHER_SYSTEMS.find((entry) => entry.id === 'observation-isr-eo');
    const clear = evaluateWeatherCell(system, { visibility: 10000, cloudLow: 0 }, thresholds, 'day');
    const fog = evaluateWeatherCell(system, { visibility: 500, cloudLow: 0 }, thresholds, 'day');
    expect(clear.rating).toBe('favourable');
    expect(fog.rating).toBe('unfavourable');
  });

  test('night is unfavourable for a light-sensitive system, day is not', () => {
    const system = WEATHER_SYSTEMS.find((entry) => entry.id === 'observation-isr-eo');
    const hour = { visibility: 10000, cloudLow: 0 };
    expect(evaluateWeatherCell(system, hour, thresholds, 'night').rating).toBe('unfavourable');
    expect(evaluateWeatherCell(system, hour, thresholds, 'day').rating).toBe('favourable');
  });

  test('temperature outside the band in either direction is unfavourable', () => {
    const system = WEATHER_SYSTEMS.find((entry) => entry.id === 'dismounted-movement');
    const cold = evaluateWeatherCell(system, { precipitation: 0, visibility: 10000, temperature: -30 }, thresholds, 'day');
    const hot = evaluateWeatherCell(system, { precipitation: 0, visibility: 10000, temperature: 50 }, thresholds, 'day');
    expect(cold.rating).toBe('unfavourable');
    expect(hot.rating).toBe('unfavourable');
  });
});

describe('evaluateWeatherMatrix', () => {
  test('one row per system, one cell per hour', () => {
    const hours = [
      { time: Date.UTC(2026, 5, 1, 10), wind: 1, gusts: 1, precipitation: 0, visibility: 10000, cloudLow: 0, temperature: 18 },
      { time: Date.UTC(2026, 5, 1, 13), wind: 20, gusts: 25, precipitation: 5, visibility: 500, cloudLow: 90, temperature: 18 },
    ];
    const matrix = evaluateWeatherMatrix(hours, DEFAULT_WEATHER_THRESHOLDS, 49.7, 17.5);
    expect(matrix).toHaveLength(WEATHER_SYSTEMS.length);
    for (const { cells } of matrix) expect(cells).toHaveLength(2);
    const rotary = matrix.find((row) => row.system.id === 'rotary-wing');
    expect(rotary.cells[0].rating).toBe('favourable');
    expect(rotary.cells[1].rating).toBe('unfavourable');
  });
});

describe('forecastLightStates', () => {
  test('computes light at most once per calendar day spanned by the hours', () => {
    const dayOne = Date.UTC(2026, 5, 1, 10);
    const dayTwo = Date.UTC(2026, 5, 2, 10);
    const states = forecastLightStates([{ time: dayOne }, { time: dayOne + 3600_000 }, { time: dayTwo }], 49.7, 17.5);
    expect(states).toHaveLength(3);
    for (const state of states) {
      expect(['day', 'civil-twilight', 'nautical-twilight', 'night']).toContain(state);
    }
  });

  test('missing coordinates default every hour to day rather than throwing', () => {
    const states = forecastLightStates([{ time: Date.now() }], null, null);
    expect(states).toEqual(['day']);
  });
});

describe('resolveWeatherEffectsPoint', () => {
  test('prefers the study weather point when set', () => {
    expect(resolveWeatherEffectsPoint({ weather_point: { lon: 1, lat: 2 }, bounds: [0, 0, 10, 10] })).toEqual({
      lon: 1,
      lat: 2,
    });
  });

  test('falls back to the bounds centre', () => {
    expect(resolveWeatherEffectsPoint({ weather_point: null, bounds: [10, 40, 20, 50] })).toEqual({
      lon: 15,
      lat: 45,
    });
  });

  test('null when neither is available', () => {
    expect(resolveWeatherEffectsPoint({ weather_point: null, bounds: null })).toBeNull();
  });
});
