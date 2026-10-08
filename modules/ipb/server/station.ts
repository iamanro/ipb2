/**
 * Measured weather from the nearest reporting station: the latest METAR of
 * the airfield closest to a point, from aviationweather.gov (NOAA). The
 * service sends no CORS headers, so the browser asks this server, which is
 * the only part of it that goes online, and only when asked.
 */

const METAR_API = 'https://aviationweather.gov/api/data/metar';
/** Search boxes, half-size in degrees of latitude, widened until one reports. */
const SEARCH_RADII = [1, 2.5, 5];
const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
const EARTH_RADIUS_KM = 6371.0088;
const KNOT = 0.514444;
const STATUTE_MILE = 1609.344;
const CEILING_COVERS = new Set(['BKN', 'OVC', 'OVX', 'VV']);

const radians = (degrees) => (degrees * Math.PI) / 180;

/** Great-circle distance (km) and initial bearing (degrees) from `from` to `to`. */
export function distanceAndBearing(from, to) {
  const lat1 = radians(from.lat);
  const lat2 = radians(to.lat);
  const dLat = lat2 - lat1;
  const dLon = radians(to.lon - from.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const km = 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return { km, bearing };
}

/**
 * One aviationweather.gov METAR (JSON) in metric terms. Visibility "6+" (six
 * statute miles or more) and CAVOK both mean 10 km or more; the ceiling is
 * the lowest broken, overcast or obscured layer, in feet above the station
 * as reported, and in metres.
 */
export function summariseMetar(report) {
  const raw = String(report.rawOb ?? '');
  const cavok = /\bCAVOK\b/.test(raw);
  let visibility: any = null;
  if (cavok || report.visib === '6+') visibility = { metres: 10_000, atLeast: true };
  else if (Number.isFinite(Number.parseFloat(report.visib))) {
    visibility = {
      metres: Math.round(Number.parseFloat(report.visib) * STATUTE_MILE),
      atLeast: false,
    };
  }
  const clouds = (report.clouds ?? [])
    .filter((layer) => typeof layer?.cover === 'string')
    .map((layer) => ({ cover: layer.cover, baseFeet: layer.base ?? null }));
  const ceilingFeet =
    clouds
      .filter((layer) => CEILING_COVERS.has(layer.cover) && Number.isFinite(layer.baseFeet))
      .map((layer) => layer.baseFeet)
      .sort((a, b) => a - b)[0] ?? null;
  const knots = (value) => (Number.isFinite(value) ? value : null);
  const speedKnots = knots(report.wspd);
  const gustKnots = knots(report.wgst);
  return {
    station: {
      id: report.icaoId,
      name: report.name ?? report.icaoId,
      lon: report.lon,
      lat: report.lat,
      elevation: report.elev ?? null,
    },
    observed: Number.isFinite(report.obsTime)
      ? report.obsTime * 1000
      : Date.parse(report.reportTime),
    temperature: report.temp ?? null,
    dewPoint: report.dewp ?? null,
    wind: {
      // "VRB": variable direction, too light or shifting to name one.
      direction: Number.isFinite(report.wdir) ? report.wdir : null,
      variable: report.wdir === 'VRB',
      speed: speedKnots === null ? null : Math.round(speedKnots * KNOT * 10) / 10,
      gusts: gustKnots === null ? null : Math.round(gustKnots * KNOT * 10) / 10,
      knots: speedKnots,
      gustKnots,
    },
    visibility,
    cavok,
    clouds,
    ceilingFeet,
    ceilingMetres: ceilingFeet === null ? null : Math.round(ceilingFeet * 0.3048),
    qnh: report.altim ?? null,
    weather: report.wxString ?? null,
    flightCategory: report.fltCat ?? null,
    raw,
  };
}

/** The report whose station is closest to `at`, with its distance and bearing, or null. */
export function nearestReport(reports, at) {
  let best: any = null;
  for (const report of reports) {
    if (!Number.isFinite(report?.lat) || !Number.isFinite(report?.lon)) continue;
    const { km, bearing } = distanceAndBearing(at, report);
    if (!best || km < best.km) best = { report, km, bearing };
  }
  return best;
}

/**
 * Latest METAR of the station nearest `at` (`{ lon, lat }`): searches boxes
 * of growing size until one holds a report. Resolves to the summary plus
 * `distanceKm` and `bearing` from `at`, or null if none within the widest.
 */
export async function fetchNearestStation(at, { fetchImpl = fetch } = {}) {
  for (const radius of SEARCH_RADII) {
    const lonRadius = radius / Math.max(Math.cos(radians(at.lat)), 0.1);
    const bbox = [at.lat - radius, at.lon - lonRadius, at.lat + radius, at.lon + lonRadius]
      .map((value) => value.toFixed(3))
      .join(',');
    const response = await fetchImpl(`${METAR_API}?bbox=${bbox}&format=json`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    // 204: no reports in the box.
    if (response.status === 204) continue;
    if (!response.ok) throw new Error(`aviationweather.gov answered ${response.status}`);
    const reports = await response.json();
    const nearest = nearestReport(Array.isArray(reports) ? reports : [], at);
    if (nearest) {
      return {
        ...summariseMetar(nearest.report),
        distanceKm: Math.round(nearest.km * 10) / 10,
        bearing: Math.round(nearest.bearing),
      };
    }
  }
  return null;
}

const cache = new Map();

/** fetchNearestStation, remembered for a few minutes per ~1 km of position. */
export async function nearestStation(at, options?) {
  const key = `${at.lat.toFixed(2)},${at.lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fetchNearestStation(at, options);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}
