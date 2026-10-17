/**
 * Measured weather close to a point from the Czech Hydrometeorological
 * Institute's open data (opendata.chmi.cz, CC BY 4.0): about 300 automatic
 * and professional stations publishing 10-minute values, so the nearest one
 * is usually within 10-20 km — far closer than an airfield METAR.
 *
 * Not every station measures everything: many are rain gauges only, and wind
 * is measured at fewer. So each quantity comes from the nearest station
 * that measured it recently: temperature and humidity, wind, precipitation,
 * pressure, each with its own station, distance and time.
 *
 * Only this server goes online, only when asked; the station list is loaded
 * once a day, a station's data file at most every few minutes.
 */
import { isJsonObject, type Json, type JsonObject } from '../../../server/http.ts';
import { distanceAndBearing, type LonLat } from './station.ts';

export type Station = {
  id: string;
  name: string | null;
  lon: number;
  lat: number;
  elevation: number | null;
  /** The 10-minute elements this station publishes. */
  elements: Set<string>;
};
export type Measurement = { value: number; time: number; lastHour?: number };
type StationGroup = {
  station: { id: string; name: string | null; elevation: number | null };
  distanceKm: number;
  bearing: number;
  values: Record<string, Measurement>;
};

function finite(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function textField(value: Json | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

const BASE = 'https://opendata.chmi.cz/meteorology/climate/now';
const TIMEOUT_MS = 15_000;
const DATA_CACHE_MS = 5 * 60_000;
/** Beyond this, a station says little about the weather at the point. */
export const MAX_DISTANCE_KM = 60;
/** A value older than this is not "now": the station is skipped. */
export const MAX_AGE_MS = 2 * 60 * 60_000;
/** ČHMÚ quality codes (metadata meta4) never shown: 2 poor, 4 missing. */
const UNUSABLE = new Set([2, 4]);
/** Stations tried per quantity before giving up on it. */
const CANDIDATES = 4;

/** The quantities reported, each from the nearest station measuring `element`. */
export const GROUPS = [
  { id: 'temperature', element: 'T', elements: ['T', 'H'] },
  { id: 'wind', element: 'F', elements: ['F', 'D', 'Fmax'] },
  { id: 'precipitation', element: 'SRA10M', elements: ['SRA10M'] },
  { id: 'pressure', element: 'P', elements: ['P'] },
];

/** `{ header: "A,B", values: [[…]] }` (ČHMÚ's table shape) as objects. */
function rows(json: Json): JsonObject[] {
  const outer = isJsonObject(json) ? json.data : undefined;
  const table = isJsonObject(outer) ? outer.data : undefined;
  if (!isJsonObject(table) || typeof table.header !== 'string' || !Array.isArray(table.values))
    throw new Error('unexpected ČHMÚ format');
  const keys = table.header.split(',');
  return table.values.map((values): JsonObject =>
    Object.fromEntries(keys.map((key, i) => [key, Array.isArray(values) ? values[i] : undefined])),
  );
}

/**
 * Stations (meta1) joined with the 10-minute elements each measures (meta2):
 * `[{ id, name, lon, lat, elevation, elements: Set }]`, only stations that
 * publish 10-minute data at all.
 */
export function parseStations(meta1: Json, meta2: Json): Station[] {
  const elements = new Map<string, Set<string>>();
  for (const row of rows(meta2)) {
    const id = textField(row.WSI);
    const element = textField(row.EG_EL_ABBREVIATION);
    if (row.OBS_TYPE !== '10M' || id === null || element === null) continue;
    const set = elements.get(id) ?? new Set<string>();
    set.add(element);
    elements.set(id, set);
  }
  return rows(meta1).flatMap((row): Station[] => {
    const id = textField(row.WSI);
    const measured = id === null ? undefined : elements.get(id);
    const lon = finite(row.GEOGR1);
    const lat = finite(row.GEOGR2);
    if (id === null || !measured || lon === null || lat === null) return [];
    return [
      {
        id,
        name: textField(row.FULL_NAME),
        lon,
        lat,
        elevation: finite(row.ELEVATION),
        elements: measured,
      },
    ];
  });
}

/**
 * The latest good value of each of `elements` in a station's day file:
 * `{ element: { value, time } }`; for SRA10M also `lastHour`, the sum over
 * the hour ending at its latest value. Values ČHMÚ flags "poor, do not
 * use" (quality 2) or missing (4), and non-numbers, are ignored.
 */
export function latestValues(json: Json, elements: string[]): Record<string, Measurement> {
  const wanted = new Set(elements);
  const series = new Map<string, { value: number; time: number }[]>();
  for (const row of rows(json)) {
    const element = textField(row.ELEMENT);
    const value = finite(row.VAL);
    const quality = finite(row.QUALITY);
    if (element === null || !wanted.has(element) || value === null) continue;
    if (quality !== null && UNUSABLE.has(quality)) continue;
    const time = Date.parse(textField(row.DT) ?? '');
    if (!Number.isFinite(time)) continue;
    const points = series.get(element) ?? [];
    points.push({ value, time });
    series.set(element, points);
  }
  const latest: Record<string, Measurement> = {};
  for (const [element, points] of series) {
    points.sort((a, b) => a.time - b.time);
    const last = points.at(-1);
    if (!last) continue;
    latest[element] = { value: last.value, time: last.time };
    if (element === 'SRA10M') {
      const since = last.time - 60 * 60_000;
      const sum = points
        .filter((point) => point.time > since)
        .reduce((total, point) => total + point.value, 0);
      latest[element].lastHour = Math.round(sum * 10) / 10;
    }
  }
  return latest;
}

function dayStamp(time: number) {
  return new Date(time).toISOString().slice(0, 10).replaceAll('-', '');
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<Json> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`opendata.chmi.cz answered ${response.status}`);
  const json: Json = await response.json();
  return json;
}

/**
 * A ČHMÚ client with its own caches. `fetchImpl` and `now` are injectable
 * for tests.
 */
export function createChmiClient({
  fetchImpl = fetch,
  now = () => Date.now(),
}: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
  let stations: { day: string; list: Station[] } | null = null;
  const dataCache = new Map<string, { at: number; value: Json }>();

  async function loadStations() {
    const day = dayStamp(now());
    if (stations?.day === day) return stations.list;
    const [meta1, meta2] = await Promise.all([
      fetchJson(`${BASE}/metadata/meta1-${day}.json`, fetchImpl),
      fetchJson(`${BASE}/metadata/meta2-${day}.json`, fetchImpl),
    ]);
    // Just after midnight UTC today's list may not be out yet: keep yesterday's.
    if (!meta1 || !meta2) {
      if (stations) return stations.list;
      throw new Error('ČHMÚ station list not published yet');
    }
    stations = { day, list: parseStations(meta1, meta2) };
    return stations.list;
  }

  /** A station's values today (or, just after midnight UTC, yesterday). */
  async function stationData(stationId: string): Promise<Json> {
    const hit = dataCache.get(stationId);
    if (hit && now() - hit.at < DATA_CACHE_MS) return hit.value;
    let json: Json = null;
    for (const time of [now(), now() - 24 * 60 * 60_000]) {
      json = await fetchJson(`${BASE}/data/10m-${stationId}-${dayStamp(time)}.json`, fetchImpl);
      if (json) break;
    }
    dataCache.set(stationId, { at: now(), value: json });
    const oldest = dataCache.keys().next().value;
    if (dataCache.size > 200 && oldest !== undefined) dataCache.delete(oldest);
    return json;
  }

  /**
   * For `at` (`{ lon, lat }`): `{ groups: { temperature?, wind?, precipitation?,
   * pressure? } }`, each `{ station: { id, name, elevation }, distanceKm, bearing,
   * values: { element: { value, time, lastHour? } } }` from the nearest station
   * with a recent value; a quantity with none within MAX_DISTANCE_KM is absent.
   * Null when no quantity is found at all (e.g. outside Czechia).
   */
  async function nearestStationValues(
    at: LonLat,
  ): Promise<{ groups: Record<string, StationGroup> } | null> {
    const list = await loadStations();
    const byDistance = list
      .map((station) => ({ station, ...distanceAndBearing(at, station) }))
      .filter((entry) => entry.km <= MAX_DISTANCE_KM)
      .sort((a, b) => a.km - b.km);
    const groups: Record<string, StationGroup> = {};
    await Promise.all(
      GROUPS.map(async (group) => {
        const candidates = byDistance
          .filter((entry) => entry.station.elements.has(group.element))
          .slice(0, CANDIDATES);
        for (const candidate of candidates) {
          const json = await stationData(candidate.station.id);
          if (!json) continue;
          const values = latestValues(json, group.elements);
          const main = values[group.element];
          if (!main || now() - main.time > MAX_AGE_MS) continue;
          const { id, name, elevation } = candidate.station;
          groups[group.id] = {
            station: { id, name, elevation },
            distanceKm: Math.round(candidate.km * 10) / 10,
            bearing: Math.round(candidate.bearing),
            values,
          };
          return;
        }
      }),
    );
    return Object.keys(groups).length ? { groups } : null;
  }

  return { nearestMeasurements: nearestStationValues };
}

const client = createChmiClient();

export function nearestMeasurements(at: LonLat) {
  return client.nearestMeasurements(at);
}
