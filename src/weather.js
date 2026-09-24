/**
 * Real-time weather sources. All three services are online-only, keyless and
 * allow browser requests (CORS `*`); nothing here is cached for offline use.
 *
 *   RainViewer   precipitation radar mosaic, past 2 h in 10-min frames
 *   EUMETSAT     Meteosat cloud mask and Lightning Imager via WMS
 *   Open-Meteo   model wind for map arrows and the step-1 forecast table
 */

export const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
/** The free tier serves radar only up to zoom 7; OpenLayers upscales beyond. */
export const RAINVIEWER_MAX_ZOOM = 7;
export const RAINVIEWER_ATTRIBUTION =
  'Radar: <a href="https://www.rainviewer.com/" target="_blank" rel="noreferrer">RainViewer</a>';

export const EUMETSAT_WMS = 'https://view.eumetsat.int/geoserver/ows';
export const EUMETSAT_ATTRIBUTION = 'Satellite: © EUMETSAT';
/** Meteosat Second Generation cloud mask: white cloud, green clear land, blue clear water. */
export const CLOUD_LAYER = 'msg_fes:clm';
/** Meteosat Third Generation Lightning Imager, accumulated flash area. */
export const LIGHTNING_LAYER = 'mtg_fd:li_afa';

export const OPEN_METEO_API = 'https://api.open-meteo.com/v1/forecast';
export const OPEN_METEO_ATTRIBUTION =
  'Wind: <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> (CC BY 4.0)';

/**
 * Radar frames from RainViewer's weather-maps.json, oldest first:
 * `[{ time (ms), url (XYZ template, 512 px images) }]`.
 */
export function radarFrames(json) {
  const host = json?.host;
  const frames = [...(json?.radar?.past ?? []), ...(json?.radar?.nowcast ?? [])];
  if (!host) return [];
  return frames
    .filter((frame) => Number.isFinite(frame?.time) && typeof frame.path === 'string')
    .map((frame) => ({
      time: frame.time * 1000,
      // Colour scheme 2 (Universal Blue, the only one on the free tier),
      // smoothed, snow shown in its own colours.
      url: `${host}${frame.path}/512/{z}/{x}/{y}/2/1_1.png`,
    }));
}

/**
 * The newest image time a WMS layer offers, from its (per-layer)
 * GetCapabilities XML: the default of the `time` dimension, as ms, or null.
 */
export function latestWmsTime(xml) {
  const dimension = /<Dimension\b[^>]*\bname="time"[^>]*>/i.exec(xml)?.[0];
  const value = dimension && /\bdefault="([^"]+)"/.exec(dimension)?.[1];
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

/** Per-layer GetCapabilities, a few KB instead of the whole server's. */
export function wmsCapabilitiesUrl(layer) {
  const [workspace, name] = layer.split(':');
  return `${EUMETSAT_WMS.replace(/\/ows$/, '')}/${workspace}/${name}/ows?service=WMS&version=1.3.0&request=GetCapabilities`;
}

/** GetMap for one Web Mercator tile extent, transparent PNG. */
export function wmsTileUrl(layer, extent, size, time) {
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: layer,
    styles: '',
    crs: 'EPSG:3857',
    bbox: extent.join(','),
    width: String(size),
    height: String(size),
    format: 'image/png',
    transparent: 'true',
  });
  if (time !== null && time !== undefined) params.set('time', new Date(time).toISOString());
  return `${EUMETSAT_WMS}?${params}`;
}

/**
 * Recolour the cloud-mask image in place: cloud (white) becomes `rgb` at
 * `alpha` (0..1); clear land and water (saturated green/blue) become
 * transparent. The whiteness is the smallest channel, so resampled edge
 * pixels between the classes fade instead of fringing.
 */
export function recolourCloudMask(data, [red, green, blue], alpha) {
  for (let index = 0; index < data.length; index += 4) {
    const cloud = Math.min(data[index], data[index + 1], data[index + 2]) / 255;
    data[index] = red;
    data[index + 1] = green;
    data[index + 2] = blue;
    data[index + 3] = Math.round(data[index + 3] * cloud * alpha);
  }
  return data;
}

/** Lattice steps in degrees; 0.02° (~2 km) matches the finest model grid. */
const WIND_STEPS = [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5];

/**
 * Points for wind arrows over a view: a lattice on whole multiples of a step
 * (so panning reuses the points already fetched), coarse enough that arrows
 * are at least `minSpacing` px apart and at most `maxPoints` fit the view.
 * `bounds` is `[west, south, east, north]`, `size` the view in px.
 * Returns `{ step, points: [{ lon, lat, key }] }`.
 */
export function windLattice(bounds, [width, height], { minSpacing = 90, maxPoints = 60 } = {}) {
  const [west, south, east, north] = bounds;
  const pxPerLon = width / (east - west);
  const pxPerLat = height / (north - south);
  let step = null;
  let columns = [];
  let rows = [];
  for (const candidate of WIND_STEPS) {
    if (candidate * Math.min(pxPerLon, pxPerLat) < minSpacing) continue;
    columns = multiplesWithin(west, east, candidate);
    rows = multiplesWithin(south, north, candidate);
    step = candidate;
    if (columns.length * rows.length <= maxPoints) break;
  }
  if (step === null || columns.length * rows.length > maxPoints) return { step, points: [] };
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const points = [];
  for (const lat of rows) {
    for (const lon of columns) {
      points.push({ lon, lat, key: `${lat.toFixed(decimals)},${lon.toFixed(decimals)}` });
    }
  }
  return { step, points };
}

/** Whole multiples of `step` strictly inside (low, high), without float drift. */
function multiplesWithin(low, high, step) {
  const values = [];
  // Compare the rounded value: 17.2 / 0.1 is 171.99…, which would put a
  // point exactly on the edge.
  for (let index = Math.floor(low / step); index * step <= high + step; index += 1) {
    const value = Number((index * step).toFixed(6));
    if (value > low && value < high) values.push(value);
  }
  return values;
}

const COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

/** 16-point compass name for a direction in degrees (0/360 = N). */
export function compassPoint(degrees) {
  return COMPASS[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * Map rotation (radians, clockwise from north) of an arrow drawn pointing
 * north for a wind *from* `direction` degrees: it points where the air goes.
 */
export function downwindRotation(direction) {
  return (((direction + 180) % 360) * Math.PI) / 180;
}

/** WMO weather interpretation codes as Open-Meteo reports them. */
const WMO_CODES = {
  0: 'Clear',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Dense drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Heavy freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers',
  81: 'Showers',
  82: 'Violent showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm, hail',
  99: 'Thunderstorm, heavy hail',
};

export function weatherText(code) {
  return WMO_CODES[code] ?? '—';
}

const FORECAST_FIELDS = [
  'temperature_2m',
  'weather_code',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'precipitation',
  'precipitation_probability',
  'cloud_cover',
  'cloud_cover_low',
  'visibility',
];

const FORECAST_HOURS = 48;

/**
 * Current conditions plus 48 h hourly forecast for `points` (`[{ lon, lat,
 * elevation? }]`), wind in m/s, unix times. One hour more than shown: hourly
 * sums cover the *preceding* hour, so the last window needs the value at its
 * end. With every point's ground height known, it is sent: Open-Meteo then
 * corrects temperature from its model cell's height to the real ground (on
 * a ridge or in a valley that is often 0.5-1 °C); otherwise it uses its own
 * 90 m terrain model.
 */
export function forecastUrl(points) {
  const params = new URLSearchParams({
    latitude: points.map((point) => point.lat.toFixed(4)).join(','),
    longitude: points.map((point) => point.lon.toFixed(4)).join(','),
    current: FORECAST_FIELDS.filter((field) => field !== 'precipitation_probability').join(','),
    hourly: FORECAST_FIELDS.join(','),
    forecast_hours: String(FORECAST_HOURS + 1),
    wind_speed_unit: 'ms',
    timeformat: 'unixtime',
    timezone: 'GMT',
  });
  if (points.every((point) => Number.isFinite(point.elevation))) {
    params.set('elevation', points.map((point) => Math.round(point.elevation)).join(','));
  }
  return `${OPEN_METEO_API}?${params}`;
}

/**
 * A multi-point forecast response (one object for a single point) as one
 * parseForecast result per point, in request order, each with `cell`: the
 * model grid cell Open-Meteo used and the height it corrected to.
 */
export function parseForecasts(json, everyHours = 3) {
  return (Array.isArray(json) ? json : [json]).map((entry) => ({
    cell: { lon: entry?.longitude, lat: entry?.latitude, elevation: entry?.elevation ?? null },
    ...parseForecast(entry, everyHours),
  }));
}

/**
 * Open-Meteo forecast JSON as `{ current, hours }`, each entry
 * `{ time (ms), temperature, code, wind, direction, gusts, precipitation,
 * probability, cloud, cloudLow, visibility }`.
 *
 * `hours` has one row per `everyHours` window starting at the row's time.
 * Temperature, wind, cloud and visibility are the values at that time;
 * precipitation is the window's total, probability, gusts and weather code
 * its highest (WMO codes rise roughly with significance: fog < drizzle <
 * rain < snow < showers < thunderstorm). Open-Meteo reports sums for the
 * *preceding* hour, so the window from hour i is read from hours i+1..i+n.
 */
export function parseForecast(json, everyHours = 3) {
  const pick = (source, index) => {
    const value = (field) => (index === null ? source[field] : source[field]?.[index]) ?? null;
    return {
      time: value('time') * 1000,
      temperature: value('temperature_2m'),
      code: value('weather_code'),
      wind: value('wind_speed_10m'),
      direction: value('wind_direction_10m'),
      gusts: value('wind_gusts_10m'),
      precipitation: value('precipitation'),
      probability: value('precipitation_probability'),
      cloud: value('cloud_cover'),
      cloudLow: value('cloud_cover_low'),
      visibility: value('visibility'),
    };
  };
  const hourly = json?.hourly;
  const hours = [];
  const count = Array.isArray(hourly?.time) ? hourly.time.length : 0;
  for (let start = 0; start + everyHours < count; start += everyHours) {
    const window = [];
    for (let index = start + 1; index <= start + everyHours; index += 1) {
      window.push(pick(hourly, index));
    }
    const finite = (field) => window.map((hour) => hour[field]).filter(Number.isFinite);
    const highest = (field) => (finite(field).length ? Math.max(...finite(field)) : null);
    const precipitation = finite('precipitation');
    hours.push({
      ...pick(hourly, start),
      precipitation: precipitation.length
        ? Math.round(precipitation.reduce((sum, value) => sum + value, 0) * 10) / 10
        : null,
      probability: highest('probability'),
      gusts: highest('gusts'),
      code: highest('code'),
    });
  }
  return { current: json?.current ? pick(json.current, null) : null, hours };
}

/** Open-Meteo `current` wind for many points in one request. */
export function windUrl(points) {
  const params = new URLSearchParams({
    latitude: points.map((point) => point.lat).join(','),
    longitude: points.map((point) => point.lon).join(','),
    current: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    wind_speed_unit: 'ms',
    timeformat: 'unixtime',
  });
  return `${OPEN_METEO_API}?${params}`;
}

/** One wind reading per requested point, in request order (a single point is not wrapped). */
export function parseWind(json, points) {
  const entries = Array.isArray(json) ? json : [json];
  return points.map((point, index) => {
    const current = entries[index]?.current ?? {};
    return {
      ...point,
      speed: current.wind_speed_10m ?? null,
      direction: current.wind_direction_10m ?? null,
      gusts: current.wind_gusts_10m ?? null,
      time: Number.isFinite(current.time) ? current.time * 1000 : null,
    };
  });
}
