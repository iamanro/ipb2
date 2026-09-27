import { describe, expect, test } from 'vitest';

import { createChmiClient, latestValues, parseStations } from './chmi.js';

const LIBAVA = { lon: 17.52, lat: 49.68 };
const NOW = Date.parse('2026-09-27T12:30:00Z');

const table = (header, values) => ({ data: { data: { header, values } } });

// Trimmed ČHMÚ metadata, as published for this area.
const META1 = table('WSI,GH_ID,FULL_NAME,GEOGR1,GEOGR2,ELEVATION,BEGIN_DATE', [
  [
    '0-203-0-41102037001',
    'O1POTB01',
    'Potštát, Boškov',
    17.6445,
    49.6378,
    545,
    '2000-01-01T00:00:00Z',
  ],
  ['0-20000-0-11766', 'O1CERV01', 'Červená', 17.5424, 49.7774, 748.13, '1960-01-01T00:00:00Z'],
  // Placed 1 km from the point for the test: the nearest temperature station.
  ['0-203-0-41003127001', 'O1VUJE01', 'Velký Újezd', 17.53, 49.685, 381, '2000-01-01T00:00:00Z'],
  ['0-20000-0-04030', 'ZIS04030', 'Reykjavik', -21.9, 64.13, 51, '2015-01-01T00:00:00Z'],
]);
const META2 = table('OBS_TYPE,WSI,EG_EL_ABBREVIATION,NAME,UN_DESCRIPTION,HEIGHT,SCHEDULE', [
  // Boškov: a rain gauge only.
  ['10M', '0-203-0-41102037001', 'SRA10M', 'Srážka-10M', 'mm', 1, '10M'],
  // Červená: everything.
  ...['T', 'H', 'F', 'D', 'Fmax', 'SRA10M', 'P'].map((element) => [
    '10M',
    '0-20000-0-11766',
    element,
    element,
    '',
    2,
    '10M',
  ]),
  // Velký Újezd: temperature, but its data has stopped (see below).
  ['10M', '0-203-0-41003127001', 'T', 'Teplota', '°C', 2, '10M'],
  ['1H', '0-20000-0-04030', 'T', 'Teplota', '°C', 2, '1H'],
]);

const series = (station, element, values, lastAt = '2026-09-27T12:20:00Z', quality = 5) =>
  values.map((value, index) => [
    station,
    element,
    new Date(Date.parse(lastAt) - (values.length - 1 - index) * 10 * 60_000).toISOString(),
    value,
    '',
    quality,
  ]);

const HEADER = 'STATION,ELEMENT,DT,VAL,FLAG,QUALITY';
const DATA = {
  '0-203-0-41102037001': table(
    HEADER,
    series('0-203-0-41102037001', 'SRA10M', [0, 0.2, 0.4, 0.1, 0, 0.3, 0.5]),
  ),
  '0-20000-0-11766': table(HEADER, [
    ...series('0-20000-0-11766', 'T', [15.8, 16.1]),
    ...series('0-20000-0-11766', 'H', [45, 44]),
    ...series('0-20000-0-11766', 'F', [2.2, 3.1]),
    ...series('0-20000-0-11766', 'D', [73, 80]),
    ...series('0-20000-0-11766', 'Fmax', [4, 6.2]),
    ...series('0-20000-0-11766', 'SRA10M', [0, 0]),
    ...series('0-20000-0-11766', 'P', [939.3, 939.1]),
  ]),
  // Last value three hours ago: not "now".
  '0-203-0-41003127001': table(
    HEADER,
    series('0-203-0-41003127001', 'T', [14], '2026-09-27T09:30:00Z'),
  ),
};

function fakeFetch() {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const json = url.includes('/metadata/meta1-20260927')
      ? META1
      : url.includes('/metadata/meta2-20260927')
        ? META2
        : Object.entries(DATA).find(([id]) => url.endsWith(`10m-${id}-20260927.json`))?.[1];
    return json
      ? { ok: true, status: 200, json: async () => json }
      : { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, urls };
}

describe('parseStations', () => {
  test('keeps only stations publishing 10-minute data, with what each measures', () => {
    const stations = parseStations(META1, META2);
    expect(stations.map((station) => station.name)).toEqual([
      'Potštát, Boškov',
      'Červená',
      'Velký Újezd',
    ]);
    expect([...stations[0].elements]).toEqual(['SRA10M']);
    expect(stations[1].elements.has('F')).toBe(true);
  });
});

describe('latestValues', () => {
  test('the latest good value per element; precipitation also summed over its last hour', () => {
    const values = latestValues(DATA['0-203-0-41102037001'], ['SRA10M']);
    // The last six 10-minute sums: 0.2 + 0.4 + 0.1 + 0 + 0.3 + 0.5.
    expect(values.SRA10M).toEqual({
      value: 0.5,
      time: Date.parse('2026-09-27T12:20:00Z'),
      lastHour: 1.5,
    });
  });

  test('values flagged poor (2) or missing (4) are skipped', () => {
    const json = table(HEADER, [
      ...series('s', 'T', [12], '2026-09-27T12:00:00Z'),
      ...series('s', 'T', [99], '2026-09-27T12:10:00Z', 2),
      ...series('s', 'T', [-99], '2026-09-27T12:20:00Z', 4),
    ]);
    expect(latestValues(json, ['T']).T.value).toBe(12);
  });
});

describe('nearestMeasurements', () => {
  test('each quantity from the nearest station that measured it recently', async () => {
    const { fetchImpl } = fakeFetch();
    const client = createChmiClient({ fetchImpl, now: () => NOW });
    const { groups } = await client.nearestMeasurements(LIBAVA);
    // Rain from Boškov (~10 km), the nearest gauge.
    expect(groups.precipitation.station.name).toBe('Potštát, Boškov');
    expect(groups.precipitation.values.SRA10M.lastHour).toBe(1.5);
    // Velký Újezd (nearest) measures temperature but stopped three hours ago: Červená instead.
    expect(groups.temperature.station.name).toBe('Červená');
    expect(groups.temperature.values).toMatchObject({ T: { value: 16.1 }, H: { value: 44 } });
    expect(groups.wind.values).toMatchObject({
      F: { value: 3.1 },
      D: { value: 80 },
      Fmax: { value: 6.2 },
    });
    expect(groups.pressure.values.P.value).toBe(939.1);
  });

  test('outside the network (no station within reach): null', async () => {
    const { fetchImpl } = fakeFetch();
    const client = createChmiClient({ fetchImpl, now: () => NOW });
    expect(await client.nearestMeasurements({ lon: 2.35, lat: 48.86 })).toBeNull();
  });

  test('the station list is fetched once a day, a station file at most every few minutes', async () => {
    const { fetchImpl, urls } = fakeFetch();
    let now = NOW;
    const client = createChmiClient({ fetchImpl, now: () => now });
    await client.nearestMeasurements(LIBAVA);
    const first = urls.length;
    await client.nearestMeasurements(LIBAVA);
    expect(urls.length).toBe(first);
    now += 6 * 60_000;
    await client.nearestMeasurements(LIBAVA);
    expect(urls.filter((url) => url.includes('/metadata/'))).toHaveLength(2);
    expect(urls.length).toBeGreaterThan(first);
  });
});
