import { describe, expect, test } from 'vitest';

import { distanceAndBearing, fetchNearestStation, summariseMetar } from './station.js';

const LIBAVA = { lon: 17.52, lat: 49.68 };
// Trimmed aviationweather.gov JSON, as fetched for this area.
const OSTRAVA = {
  icaoId: 'LKMT',
  obsTime: 1790281800,
  temp: 11,
  dewp: 10,
  wdir: 230,
  wspd: 5,
  visib: '6+',
  altim: 1020,
  fltCat: 'MVFR',
  lat: 49.696,
  lon: 18.111,
  elev: 251,
  name: 'Ostrava/Janáček Arpt, MO, CZ',
  clouds: [
    { cover: 'SCT', base: 1700 },
    { cover: 'BKN', base: 2100 },
    { cover: 'OVC', base: 2800 },
  ],
  rawOb: 'METAR LKMT 242030Z 23005KT 9999 SCT017 BKN021 OVC028 11/10 Q1020 NOSIG',
};
const BRNO = {
  icaoId: 'LKTB',
  lat: 49.151,
  lon: 16.694,
  wdir: 'VRB',
  wspd: 2,
  visib: 2.5,
  clouds: [{ cover: 'FEW', base: 900 }],
  rawOb: 'METAR LKTB 242030Z VRB02KT 4000 BR FEW009 10/08 Q1021',
};

describe('summariseMetar', () => {
  test('ceiling is the lowest broken or overcast layer, not a lower scattered one', () => {
    const summary = summariseMetar(OSTRAVA);
    expect(summary.ceilingFeet).toBe(2100);
    expect(summary.ceilingMetres).toBe(640);
    expect(summary.visibility).toEqual({ metres: 10_000, atLeast: true });
    expect(summary.wind).toMatchObject({ direction: 230, speed: 2.6, knots: 5 });
  });

  test('variable wind has no direction; visibility in miles becomes metres; FEW is no ceiling', () => {
    const summary = summariseMetar(BRNO);
    expect(summary.wind).toMatchObject({ direction: null, variable: true });
    expect(summary.visibility).toEqual({ metres: 4023, atLeast: false });
    expect(summary.ceilingFeet).toBeNull();
  });

  test('CAVOK means 10 km or more and no ceiling', () => {
    const summary = summariseMetar({ ...BRNO, visib: 'P6', clouds: [], rawOb: 'LKTB CAVOK' });
    expect(summary).toMatchObject({ cavok: true, ceilingFeet: null });
    expect(summary.visibility).toEqual({ metres: 10_000, atLeast: true });
  });
});

describe('fetchNearestStation', () => {
  test('widens the search until a station reports, then takes the closest', async () => {
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(url);
      if (asked.length === 1) return new Response(null, { status: 204 });
      return Response.json([BRNO, OSTRAVA]);
    };
    const station = await fetchNearestStation(LIBAVA, { fetchImpl });
    expect(asked).toHaveLength(2);
    expect(station.station.id).toBe('LKMT');
    expect(station.distanceKm).toBeCloseTo(42.6, 0);
    // Ostrava lies east of Libavá.
    expect(station.bearing).toBeGreaterThan(80);
    expect(station.bearing).toBeLessThan(95);
  });
});

describe('distanceAndBearing', () => {
  test('due north and due west', () => {
    expect(distanceAndBearing({ lon: 17, lat: 49 }, { lon: 17, lat: 50 })).toMatchObject({
      bearing: 0,
    });
    expect(distanceAndBearing({ lon: 17, lat: 49 }, { lon: 17, lat: 50 }).km).toBeCloseTo(111.2, 0);
    expect(distanceAndBearing({ lon: 17, lat: 0 }, { lon: 16, lat: 0 }).bearing).toBeCloseTo(270);
  });
});
