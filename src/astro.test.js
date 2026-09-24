import { describe, expect, test } from 'vitest';

import { lightData } from './astro.js';

// US Naval Observatory, "Sun and Moon Data for One Day"
// (aa.usno.navy.mil/api/rstt/oneday, coords=49.7,17.5, tz=0), fetched
// 2026-09-24. Times are UTC and rounded to the minute; illumination is the
// fraction at 12:00 of the date. Libavá, across seasons and moon phases.
const USNO = {
  '2026-03-20': {
    bmct: '04:21',
    sunrise: '04:53',
    sunset: '17:03',
    eect: '17:35',
    moonrise: '05:08',
    moonset: '19:16',
    illumination: 3,
  },
  '2026-06-21': {
    bmct: '01:58',
    sunrise: '02:42',
    sunset: '19:01',
    eect: '19:46',
    moonrise: '10:26',
    moonset: '22:36',
    illumination: 46,
  },
  '2026-09-24': {
    bmct: '04:07',
    sunrise: '04:39',
    sunset: '16:44',
    eect: '17:16',
    moonrise: '15:50',
    moonset: '01:46',
    illumination: 95,
  },
  '2026-12-21': {
    bmct: '06:06',
    sunrise: '06:44',
    sunset: '14:52',
    eect: '15:30',
    moonrise: '12:06',
    moonset: '03:43',
    illumination: 90,
  },
  '2027-01-15': {
    bmct: '06:05',
    sunrise: '06:42',
    sunset: '15:17',
    eect: '15:54',
    moonrise: '09:20',
    moonset: '23:56',
    illumination: 46,
  },
};

const minutesAfterMidnight = (ms, day) => (ms - Date.parse(`${day}T00:00:00Z`)) / 60000;
const clock = (text) => {
  const [hours, minutes] = text.split(':').map(Number);
  return hours * 60 + minutes;
};

describe('lightData', () => {
  test.each(Object.entries(USNO))('matches the USNO tables on %s', (day, reference) => {
    const light = lightData(49.7, 17.5, Date.parse(`${day}T00:00:00Z`));
    // USNO rounds to the minute; the sun is good to one minute, the moon to two.
    for (const event of ['bmct', 'sunrise', 'sunset', 'eect']) {
      expect(
        Math.abs(minutesAfterMidnight(light[event], day) - clock(reference[event])),
      ).toBeLessThan(1);
    }
    for (const event of ['moonrise', 'moonset']) {
      expect(
        Math.abs(minutesAfterMidnight(light[event], day) - clock(reference[event])),
      ).toBeLessThan(2);
    }
    expect(Math.abs(light.illumination * 100 - reference.illumination)).toBeLessThan(1.5);
  });

  test('orders the morning and evening twilights around sunrise and sunset', () => {
    const light = lightData(49.7, 17.5, Date.parse('2026-09-24T00:00:00Z'));
    expect(light.bmnt < light.bmct && light.bmct < light.sunrise).toBe(true);
    expect(light.sunset < light.eect && light.eect < light.eent).toBe(true);
  });

  test('reports no sun events on a polar day instead of inventing times', () => {
    const light = lightData(78.2, 15.6, Date.parse('2026-06-21T00:00:00Z')); // Svalbard
    expect([light.bmnt, light.sunrise, light.sunset, light.eent]).toEqual([null, null, null, null]);
  });
});
