// IPB step 1, define the environment: AOI, light data and the weather forecast.

import { lightData } from '../../../src/astro.js';
import { formatMgrs, parseCoordinate } from '../../../src/geo.js';
import { can } from '../../../src/session.js';
import { compassPoint, forecastUrl, parseForecasts, weatherText } from '../../../src/weather.js';
import { applyClassificationBanner, renderClassificationField } from './exchange.js';
import { renderAreaWorksheet } from './areas.js';
import { renderWeatherEffectsBlock, resolveWeatherEffectsPoint } from './weatherEffects.js';

import {
  API,
  CLOCK,
  TERRAIN_API,
  WEATHER_UNAVAILABLE,
  aoiCentre,
  canEditStudy,
  cancelActiveTool,
  createElement,
  editable,
  elements,
  mapController,
  renderMapHint,
  requestJson,
  showError,
  state,
  syncMapFeatures,
} from './view.js';
import { refreshGuideStatus, renderToolPanel } from './toolPanel.js';
import { minutesAgo } from './weatherLayers.js';

// --- Step 1: define the environment --------------------------------------

export function renderStep1Worksheet() {
  const container = elements.worksheet1;
  container.replaceChildren();
  if (!state.study) return;
  refreshGuideStatus();
  const study = state.study.study;
  container.append(createElement('h3', null, '1 · Define the operational environment'));

  container.append(
    renderClassificationField({
      createElement,
      requestJson,
      showError,
      can: can('analyst') && canEditStudy(),
      study,
      studyId: state.studyId,
      getStudyId: () => state.studyId,
      onSaved: (text) =>
        applyClassificationBanner(
          elements.classificationTop,
          elements.classificationBottom,
          text,
          state.study?.study?.owner_cell,
        ),
    }),
  );

  container.append(renderAreaWorksheet());
  container.append(renderLightData(study));
  container.append(renderForecast(study));

  // Reuses the forecast the block above already fetched — never refetches.
  const { forecast } = state.weather;
  const forecastHours =
    forecast.dataKey === forecast.key && forecast.dataKey !== null
      ? (forecast.data?.[0]?.hours ?? [])
      : [];
  const weatherEffectsPoint = state.weather.site.value?.point ?? resolveWeatherEffectsPoint(study);
  container.append(
    renderWeatherEffectsBlock({
      createElement,
      requestJson,
      showError,
      can: can('analyst') && canEditStudy(),
      study,
      hours: forecastHours,
      point: weatherEffectsPoint,
    }),
  );

  const noteLabel = createElement('label', 'field-label environment-notes', 'Environment notes');
  noteLabel.setAttribute('for', 'step1-note');
  const textarea = document.createElement('textarea');
  textarea.id = 'step1-note';
  textarea.className = 'note-field';
  textarea.rows = 10;
  textarea.placeholder = 'Terrain, weather, civil considerations…';
  textarea.value = study.notes?.step1 || '';
  editable(textarea);
  const printCopy = createElement('div', 'print-copy', textarea.value || '—');
  textarea.addEventListener('input', () => {
    printCopy.textContent = textarea.value || '—';
    const studyId = state.studyId;
    window.clearTimeout(state.timers.get('step1-note'));
    state.timers.set(
      'step1-note',
      window.setTimeout(() => {
        if (!state.study || state.studyId !== studyId) return;
        const notes = { ...state.study.study.notes, step1: textarea.value };
        requestJson(`${API}/studies/${studyId}`, { method: 'PATCH', body: { notes } })
          .then((updated) => {
            if (!state.study || state.studyId !== studyId) return;
            state.study.study = { ...state.study.study, ...updated, notes };
            refreshGuideStatus();
          })
          .catch((error) => {
            if (error.name !== 'AbortError') showError(container, error.message);
          });
      }, 180),
    );
  });
  container.append(noteLabel, textarea, printCopy);
}

// --- Step 1: light data --------------------------------------------------------

const LIGHT_COLUMNS = [
  ['bmnt', 'BMNT'],
  ['bmct', 'BMCT'],
  ['sunrise', 'Sunrise'],
  ['sunset', 'Sunset'],
  ['eect', 'EECT'],
  ['eent', 'EENT'],
  ['moonrise', 'Moonrise'],
  ['moonset', 'Moonset'],
];

const LIGHT_DAY_OPTIONS = [1, 3, 7, 14];

export function localDateInputValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "Europe/Prague (UTC+2)" for the browser's zone on a given date. */
function timeZoneLabel(date) {
  const offset = -date.getTimezoneOffset() / 60;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${zone} (UTC${offset >= 0 ? '+' : '−'}${Math.abs(offset)})`;
}

/**
 * Sun and moon light table for the AOI centre (or the map centre until an AOI
 * is drawn), in local time, one row per local calendar day.
 */
function renderLightData(study) {
  const block = createElement('section', 'worksheet-block light-data');
  block.append(createElement('h4', null, 'Light data'));

  const location = aoiLocation(study);
  const { lon, lat } = location;
  const [year, month, day] = state.lightForm.start.split('-').map(Number);
  const firstDay = new Date(year, month - 1, day);

  const controls = createElement('div', 'light-controls');
  const startInput = document.createElement('input');
  startInput.type = 'date';
  startInput.value = state.lightForm.start;
  startInput.addEventListener('change', () => {
    if (!startInput.value) return;
    state.lightForm.start = startInput.value;
    renderStep1Worksheet();
  });
  const daysSelect = document.createElement('select');
  LIGHT_DAY_OPTIONS.forEach((count) => {
    daysSelect.append(new Option(`${count} day${count > 1 ? 's' : ''}`, String(count)));
  });
  daysSelect.value = String(state.lightForm.days);
  daysSelect.addEventListener('change', () => {
    state.lightForm.days = Number(daysSelect.value);
    renderStep1Worksheet();
  });
  controls.append(startInput, daysSelect);
  block.append(controls);

  block.append(
    createElement(
      'p',
      'panel-note',
      `${describeLocation(location)} · times in ${timeZoneLabel(firstDay)}`,
    ),
  );

  const time = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const table = document.createElement('table');
  table.className = 'data-table light-table';
  const headRow = document.createElement('tr');
  ['Date', ...LIGHT_COLUMNS.map(([, label]) => label), 'Moon (noon)'].forEach((label) => {
    headRow.append(createElement('th', null, label));
  });
  const head = document.createElement('thead');
  head.append(headRow);
  const body = document.createElement('tbody');
  for (let offset = 0; offset < state.lightForm.days; offset += 1) {
    // Local midnight each day, so rows follow the local calendar across DST.
    const dayStart = new Date(
      firstDay.getFullYear(),
      firstDay.getMonth(),
      firstDay.getDate() + offset,
    );
    const light = lightData(lat, lon, dayStart.getTime());
    const row = document.createElement('tr');
    row.append(createElement('td', null, date.format(dayStart)));
    LIGHT_COLUMNS.forEach(([key]) => {
      // Light tables round to the nearest minute; Intl would truncate seconds.
      const text = light[key] === null ? '—' : time.format(Math.round(light[key] / 60000) * 60000);
      row.append(createElement('td', null, text));
    });
    row.append(
      createElement(
        'td',
        null,
        `${Math.round(light.illumination * 100)}% ${light.waxing ? 'waxing' : 'waning'}`,
      ),
    );
    body.append(row);
  }
  table.append(head, body);
  block.append(table);
  block.append(
    createElement(
      'p',
      'panel-note',
      'BMNT/EENT: begin morning / end evening nautical twilight (sun 12° below the horizon); BMCT/EECT: civil twilight (6°). — : no such event that day.',
    ),
  );
  return block;
}

/** The AOI centre, else the AO centre, or the map centre until either is set. */
function aoiLocation(study) {
  for (const source of ['aoi', 'ao']) {
    if (!study[source]) continue;
    const [lon, lat] = aoiCentre(study[source]);
    return { lon, lat, source };
  }
  const [lon, lat] = mapController.getCenter();
  return { lon, lat, source: 'map' };
}

/** Where the study takes its weather: the point set for it, else derived from the AOI. */
export function weatherPoint(study) {
  if (study.weather_point) return { ...study.weather_point, source: 'set' };
  return aoiLocation(study);
}

const LOCATION_SOURCES = {
  set: 'Weather point',
  aoi: 'AOI centre',
  ao: 'AO centre',
  map: 'Map centre (set an AOI or a weather point to fix it)',
};

/** "AOI centre 33UXR80270827". */
function describeLocation({ lon, lat, source }) {
  return `${LOCATION_SOURCES[source]} ${formatMgrs(lon, lat, 4)}`;
}

/**
 * Save the study's weather point (`{ lon, lat }`, or null to derive it from
 * the AOI again). A forecast already fetched in this session follows it.
 */
export async function setWeatherPoint(point) {
  const studyId = state.studyId;
  try {
    const updated = await requestJson(`${API}/studies/${studyId}`, {
      method: 'PATCH',
      body: { weather_point: point },
    });
    if (!state.study || state.studyId !== studyId) return;
    state.study.study = { ...state.study.study, ...updated };
    const hadWeather = Boolean(state.weather.forecast.data);
    syncMapFeatures();
    renderStep1Worksheet();
    if (state.step === 1) renderToolPanel();
    if (hadWeather) loadWeatherReport();
  } catch (error) {
    if (error.name !== 'AbortError') showError(elements.toolPanel, error.message);
  }
}

function armWeatherPick() {
  if (!(can('analyst') && canEditStudy())) return;
  cancelActiveTool();
  state.tool = { type: 'weather-pick' };
  renderMapHint('Click the map to set the weather point. Press Escape to cancel.');
}

export function renderWeatherPointGroup() {
  const group = createElement('div', 'field-group');
  group.append(createElement('h3', null, 'Weather point'));
  const study = state.study.study;
  const point = weatherPoint(study);
  group.append(
    createElement(
      'p',
      'tool-hint',
      study.weather_point
        ? `Set to ${formatMgrs(point.lon, point.lat, 4)}.`
        : `Automatic: ${point.source === 'map' ? 'the map centre until an AOI is set' : `the ${point.source.toUpperCase()} centre`}, ${formatMgrs(point.lon, point.lat, 4)}. Set a point for a specific place, e.g. a ridge, a valley or a landing zone.`,
    ),
  );
  const row = createElement('div', 'inline-form');
  const input = editable(document.createElement('input'));
  input.type = 'text';
  input.placeholder = 'MGRS, UTM, or DD…';
  const set = editable(createElement('button', 'chip-button', 'Set'));
  set.type = 'button';
  const error = createElement('p', 'inline-error');
  error.hidden = true;
  const apply = () => {
    const parsed = parseCoordinate(input.value.trim());
    error.hidden = Boolean(parsed);
    if (!parsed) {
      error.textContent = 'Could not parse that coordinate.';
      return;
    }
    setWeatherPoint({ lon: parsed.lon, lat: parsed.lat });
  };
  set.addEventListener('click', apply);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') apply();
  });
  row.append(input, set);
  const actions = createElement('div', 'inline-form');
  const pick = editable(createElement('button', 'chip-button', 'Pick on map'));
  pick.type = 'button';
  pick.addEventListener('click', armWeatherPick);
  const reset = editable(createElement('button', 'chip-button', 'Use AOI centre'));
  reset.type = 'button';
  reset.disabled = !study.weather_point;
  reset.addEventListener('click', () => setWeatherPoint(null));
  actions.append(pick, reset);
  group.append(row, error, actions);
  return group;
}

// --- Step 1: weather forecast (online) -----------------------------------------

const FORECAST_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatNumber(value, digits = 0) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/** "W 4 (9)": direction the wind comes from, speed, gusts when notably higher. */
function formatWind({ direction, wind, gusts }) {
  if (!Number.isFinite(wind)) return '—';
  const from = Number.isFinite(direction) && wind >= 0.5 ? `${compassPoint(direction)} ` : '';
  const gust = Number.isFinite(gusts) && gusts >= wind + 3 ? ` (${Math.round(gusts)})` : '';
  return `${from}${Math.round(wind)}${gust}`;
}

function formatVisibility(metres) {
  return Number.isFinite(metres) ? (metres / 1000).toFixed(metres < 10_000 ? 1 : 0) : '—';
}

/**
 * Which study, weather point and AOI the site, forecast and station belong
 * to; rounded to ~100 m so a map-centre point survives small pans.
 */
export function siteKey(study) {
  const point = weatherPoint(study);
  return JSON.stringify([study.id, point.lon.toFixed(3), point.lat.toFixed(3), study.aoi]);
}

/**
 * Resolve the study's weather site offline from terrain.db: the weather
 * point's ground height and the AOI's highest and lowest ground. Memoised on
 * siteKey; the map markers and the forecast block update when it lands.
 * Without elevation data the site still resolves, without heights.
 */
function resolveSite(study) {
  const site = state.weather.site;
  const key = siteKey(study);
  if (site.key === key && site.promise) return site.promise;
  const point = weatherPoint(study);
  Object.assign(site, { key, value: null, loading: true, error: null });
  site.promise = (async () => {
    let value;
    try {
      const params = new URLSearchParams({ at: `${point.lon},${point.lat}` });
      const [ground, extremes] = await Promise.all([
        requestJson(`${TERRAIN_API}/elevation?${params}`),
        study.aoi
          ? requestJson(`${TERRAIN_API}/extremes`, { method: 'POST', body: { area: study.aoi } })
          : null,
      ]);
      value = {
        point: { ...point, elevation: Number.isFinite(ground.elevation) ? ground.elevation : null },
        high: extremes?.highest ?? null,
        low: extremes?.lowest ?? null,
      };
    } catch (error) {
      if (error.name === 'AbortError') return null;
      value = { point: { ...point, elevation: null }, high: null, low: null };
      if (site.key === key) site.error = error.message;
    }
    if (site.key !== key) return null;
    Object.assign(site, { value, loading: false });
    if (!state.session.signal.aborted) {
      syncMapFeatures();
      replaceForecastBlock();
    }
    return value;
  })();
  return site.promise;
}

/** The points the forecast is read at: the weather point, then the AOI's extremes. */
function sitePoints(site) {
  return [
    { role: 'point', label: 'Weather point', ...site.point },
    site.high && { role: 'high', label: 'Highest ground', ...site.high },
    site.low && { role: 'low', label: 'Lowest ground', ...site.low },
  ].filter(Boolean);
}

export function replaceForecastBlock() {
  const block = elements.worksheet1?.querySelector('.weather-forecast');
  if (block && state.study) block.replaceWith(renderForecast(state.study.study));
}

/**
 * Forecast for every site point (one Open-Meteo request) and the nearest
 * station's latest report (through this server), side by side; each part
 * fails on its own.
 */
async function loadWeatherReport() {
  const study = state.study.study;
  const key = siteKey(study);
  const { forecast, station, measured } = state.weather;
  Object.assign(forecast, { key, loading: true, error: null });
  Object.assign(station, { key, loading: true, error: null });
  Object.assign(measured, { key, loading: true, error: null });
  replaceForecastBlock();
  const site = await resolveSite(study);
  if (!site || forecast.key !== key) return;
  const points = sitePoints(site);
  const current = (entry) => entry.key === key;
  await Promise.all([
    requestJson(forecastUrl(points))
      .then((json) => {
        if (!current(forecast)) return;
        const results = parseForecasts(json);
        Object.assign(forecast, {
          data: points.map((point, index) => ({ ...point, ...results[index] })),
          dataKey: key,
          fetchedAt: Date.now(),
        });
      })
      .catch((error) => {
        if (error.name !== 'AbortError' && current(forecast)) forecast.error = WEATHER_UNAVAILABLE;
      })
      .finally(() => {
        if (current(forecast)) forecast.loading = false;
      }),
    requestJson(`${API}/weather/station?at=${site.point.lon},${site.point.lat}`)
      .then((data) => {
        if (current(station)) Object.assign(station, { data, dataKey: key });
      })
      .catch((error) => {
        if (error.name !== 'AbortError' && current(station)) station.error = error.message;
      })
      .finally(() => {
        if (current(station)) station.loading = false;
      }),
    requestJson(`${API}/weather/measured?at=${site.point.lon},${site.point.lat}`)
      .then((data) => {
        if (current(measured)) Object.assign(measured, { data, dataKey: key });
      })
      .catch((error) => {
        if (error.name !== 'AbortError' && current(measured)) measured.error = error.message;
      })
      .finally(() => {
        if (current(measured)) measured.loading = false;
      }),
  ]);
  if (!state.session.signal.aborted) replaceForecastBlock();
}

function heightText(elevation) {
  return Number.isFinite(elevation) ? `${Math.round(elevation)} m` : 'height unknown';
}

/**
 * 48-hour model forecast at the study's weather point, how it compares
 * across the AOI, and the nearest station's measurement. Fetched only on
 * request: the requests tell open-meteo.com and aviationweather.gov where
 * the AOI is.
 */
function renderForecast(study) {
  const key = siteKey(study);
  const { site, forecast } = state.weather;
  if (site.key !== key) resolveSite(study);
  const resolved = site.key === key ? site.value : null;
  const point = resolved?.point ?? weatherPoint(study);
  const loading = forecast.key === key && forecast.loading;
  const points = forecast.dataKey === key ? forecast.data : null;

  const block = createElement('section', 'worksheet-block weather-forecast');
  const heading = createElement('h4', null, 'Weather ');
  heading.append(createElement('span', 'basemap-note', 'online'));
  block.append(heading);

  const facts = createElement('dl', 'fact-list weather-site');
  const fact = (term, text) =>
    facts.append(createElement('dt', null, term), createElement('dd', null, text));
  fact(
    'Weather point',
    `${describeLocation(point)}${resolved ? ` · ground ${heightText(point.elevation)}` : ''}`,
  );
  if (resolved?.high) {
    fact(
      'Highest ground',
      `${formatMgrs(resolved.high.lon, resolved.high.lat, 4)} · ${heightText(resolved.high.elevation)}`,
    );
    fact(
      'Lowest ground',
      `${formatMgrs(resolved.low.lon, resolved.low.lat, 4)} · ${heightText(resolved.low.elevation)}`,
    );
  }
  block.append(facts);

  const controls = createElement('div', 'light-controls');
  const button = createElement(
    'button',
    'text-button',
    loading ? 'Loading…' : points ? 'Refresh weather' : 'Get weather',
  );
  button.type = 'button';
  button.disabled = loading;
  button.addEventListener('click', loadWeatherReport);
  controls.append(button);
  block.append(controls);
  if (forecast.key === key && forecast.error) {
    block.append(createElement('p', 'inline-error', forecast.error));
  }

  if (!points) {
    block.append(
      createElement(
        'p',
        'panel-note',
        'A 48-hour model forecast (open-meteo.com) at the weather point and the AOI’s highest and lowest ground; the latest measurements of the ČHMÚ stations nearest the weather point (opendata.chmi.cz, through this server); and the nearest airfield report (aviationweather.gov). Getting it sends those locations to the services. Set the weather point in the tool panel or by right-clicking the map.',
      ),
    );
    block.append(renderMeasured(key), renderStation(key));
    return block;
  }

  const [main] = points;
  const now = main.current;
  if (now) {
    block.append(
      createElement(
        'p',
        'weather-now',
        `Now (${CLOCK.format(now.time)}): ${weatherText(now.code)}, ${formatNumber(now.temperature)} °C, wind ${formatWind(now)} m/s, cloud ${formatNumber(now.cloud)} % (low ${formatNumber(now.cloudLow)} %), visibility ${formatVisibility(now.visibility)} km, precipitation ${formatNumber(now.precipitation, 1)} mm`,
      ),
    );
  }
  block.append(forecastTable(main.hours));
  const cellKm = Number.isFinite(main.cell.lat) ? metresApart(main, main.cell) / 1000 : Number.NaN;
  block.append(
    createElement(
      'p',
      'panel-note',
      [
        `At the weather point; times in ${timeZoneLabel(new Date())}`,
        "weather, precipitation (total, chance) and gusts: the worst of the 3 h from the row's time; the rest at that time; wind from the named direction",
        Number.isFinite(cellKm)
          ? `model grid point ${cellKm.toFixed(1)} km away${Number.isFinite(main.elevation) ? `, temperature corrected to the ground height ${Math.round(main.elevation)} m` : ''}`
          : null,
        `model forecast by Open-Meteo.com (CC BY 4.0), fetched ${CLOCK.format(forecast.fetchedAt)}`,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
  );
  if (points.length > 1) block.append(renderSpread(points));
  block.append(renderMeasured(key), renderStation(key));
  return block;
}

function metresApart(a, b) {
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((a.lon - b.lon) * kmPerDegLon, (a.lat - b.lat) * kmPerDegLat) * 1000;
}

function forecastTable(hours) {
  const table = document.createElement('table');
  table.className = 'data-table light-table weather-table';
  const headRow = document.createElement('tr');
  [
    'Time',
    'Weather',
    '°C',
    'Wind m/s (gusts)',
    'Precip. mm (prob.)',
    'Cloud % (low)',
    'Visibility km',
  ].forEach((label) => headRow.append(createElement('th', null, label)));
  const head = document.createElement('thead');
  head.append(headRow);
  const body = document.createElement('tbody');
  for (const hour of hours) {
    const row = document.createElement('tr');
    const probability = Number.isFinite(hour.probability) ? ` (${hour.probability} %)` : '';
    [
      FORECAST_TIME.format(hour.time),
      weatherText(hour.code),
      formatNumber(hour.temperature),
      formatWind(hour),
      `${formatNumber(hour.precipitation, 1)}${probability}`,
      `${formatNumber(hour.cloud)} (${formatNumber(hour.cloudLow)})`,
      formatVisibility(hour.visibility),
    ].forEach((text) => row.append(createElement('td', null, text)));
    body.append(row);
  }
  table.append(head, body);
  return table;
}

/**
 * The elements that differ across the AOI, per row "point / high / low":
 * temperature (height), wind (exposure), low cloud (hill fog on the tops)
 * and visibility (valley fog).
 */
function renderSpread(points) {
  const wrap = createElement('div', 'weather-spread');
  wrap.append(createElement('h5', null, 'Across the AOI'));
  wrap.append(
    createElement(
      'p',
      'panel-note',
      `Each cell: ${points.map((point) => `${point.label.toLowerCase()} (${heightText(point.elevation)})`).join(' / ')}`,
    ),
  );
  const table = document.createElement('table');
  table.className = 'data-table light-table weather-table';
  const headRow = document.createElement('tr');
  ['Time', '°C', 'Wind m/s (gusts)', 'Low cloud %', 'Visibility km'].forEach((label) =>
    headRow.append(createElement('th', null, label)),
  );
  const head = document.createElement('thead');
  head.append(headRow);
  const body = document.createElement('tbody');
  const rows = [
    { label: 'Now', pick: (point) => point.current },
    ...points[0].hours.map((hour, index) => ({
      label: FORECAST_TIME.format(hour.time),
      pick: (point) => point.hours[index],
    })),
  ];
  for (const { label, pick } of rows) {
    const row = document.createElement('tr');
    const cells = (format) =>
      points.map((point) => (pick(point) ? format(pick(point)) : '—')).join(' / ');
    [
      label,
      cells((entry) => formatNumber(entry.temperature)),
      cells(formatWind),
      cells((entry) => formatNumber(entry.cloudLow)),
      cells((entry) => formatVisibility(entry.visibility)),
    ].forEach((text) => row.append(createElement('td', null, text)));
    body.append(row);
  }
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

const MEASURED_ROWS = [
  {
    group: 'temperature',
    label: 'Temperature',
    text: ({ T, H }) =>
      [`${formatNumber(T?.value, 1)} °C`, H ? `humidity ${formatNumber(H.value)} %` : null]
        .filter(Boolean)
        .join(', '),
  },
  {
    group: 'wind',
    label: 'Wind',
    text: ({ F, D, Fmax }) =>
      [
        `${Number.isFinite(D?.value) && F?.value > 0 ? `${compassPoint(D.value)} ` : ''}${formatNumber(F?.value, 1)} m/s`,
        Fmax ? `gusts ${formatNumber(Fmax.value, 1)} m/s` : null,
      ]
        .filter(Boolean)
        .join(', '),
  },
  {
    group: 'precipitation',
    label: 'Precipitation',
    text: ({ SRA10M }) => `${formatNumber(SRA10M?.lastHour, 1)} mm in the last hour`,
  },
  {
    group: 'pressure',
    label: 'Station pressure',
    text: ({ P }) => `${formatNumber(P?.value, 1)} hPa (at the station's height, not QNH)`,
  },
];

/**
 * Measured now, as near the weather point as the ČHMÚ network allows: each
 * quantity from the nearest station that measures it, with that station's
 * distance and the time of its value.
 */
function renderMeasured(key) {
  const measured = state.weather.measured;
  const wrap = createElement('div', 'weather-measured');
  if (measured.key !== key && measured.dataKey !== key) return wrap;
  wrap.append(createElement('h5', null, 'Measured nearest the weather point'));
  if (measured.key === key && measured.loading) {
    wrap.append(createElement('p', 'panel-note', 'Asking the nearest ČHMÚ stations…'));
    return wrap;
  }
  if (measured.key === key && measured.error) {
    wrap.append(createElement('p', 'panel-note', measured.error));
    return wrap;
  }
  const groups = measured.dataKey === key ? measured.data?.groups : null;
  if (!groups) return wrap;
  const table = createElement('table', 'data-table weather-measured-table');
  const head = createElement('thead');
  const headRow = createElement('tr');
  ['', 'Now', 'Where and when'].forEach((label) =>
    headRow.append(createElement('th', null, label)),
  );
  head.append(headRow);
  const body = createElement('tbody');
  for (const row of MEASURED_ROWS) {
    const entry = groups[row.group];
    if (!entry) continue;
    const at = Math.max(...Object.values(entry.values).map((value) => value.time));
    const tr = createElement('tr');
    tr.append(
      createElement('th', null, row.label),
      createElement('td', null, row.text(entry.values)),
      createElement(
        'td',
        'weather-measured-where',
        [
          // A real, named place: hidden while a scenario is active, like the METAR station.
          state.scenario
            ? `station ${heightText(entry.station.elevation)}`
            : `${entry.station.name} (${heightText(entry.station.elevation)})`,
          `${entry.distanceKm.toFixed(0)} km ${compassPoint(entry.bearing)}`,
          `${CLOCK.format(at)}, ${minutesAgo(at)}`,
        ].join(' · '),
      ),
    );
    body.append(tr);
  }
  table.append(head, body);
  wrap.append(
    table,
    createElement(
      'p',
      'panel-note',
      'Each value from the nearest ČHMÚ station that measures it, published every 10 minutes with up to an hour’s delay. Data: Czech Hydrometeorological Institute (opendata.chmi.cz, CC BY 4.0).',
    ),
  );
  return wrap;
}

/** The nearest airfield's latest METAR, decoded, with the raw report. */
function renderStation(key) {
  const station = state.weather.station;
  const wrap = createElement('div', 'weather-station');
  if (station.key !== key && station.dataKey !== key) return wrap;
  wrap.append(createElement('h5', null, 'Nearest airfield report (METAR)'));
  if (station.key === key && station.loading) {
    wrap.append(createElement('p', 'panel-note', 'Asking for the nearest airfield…'));
    return wrap;
  }
  if (station.key === key && station.error) {
    wrap.append(createElement('p', 'inline-error', station.error));
    return wrap;
  }
  const report = station.dataKey === key ? station.data : null;
  if (!report) return wrap;
  const { wind, visibility } = report;
  const from = wind.variable
    ? 'variable '
    : Number.isFinite(wind.direction)
      ? `${compassPoint(wind.direction)} `
      : '';
  const windText = Number.isFinite(wind.speed)
    ? `${from}${wind.speed.toFixed(0)} m/s (${wind.knots} kt)${Number.isFinite(wind.gusts) ? `, gusts ${wind.gusts.toFixed(0)} m/s` : ''}`
    : '—';
  const visibilityText = visibility
    ? `${visibility.atLeast ? '≥ ' : ''}${formatVisibility(visibility.metres)} km`
    : '—';
  const cloudText = report.cavok
    ? 'CAVOK (no cloud below 1,500 m, no significant weather)'
    : report.clouds.length
      ? report.clouds
          .map((layer) =>
            `${layer.cover} ${Number.isFinite(layer.baseFeet) ? `${Math.round(layer.baseFeet * 0.3048)} m` : ''}`.trim(),
          )
          .join(', ')
      : 'no cloud reported';
  const ceilingText = Number.isFinite(report.ceilingMetres)
    ? `ceiling ${report.ceilingMetres} m (${report.ceilingFeet.toLocaleString()} ft)`
    : 'no ceiling';
  // The station is a real, named place, so its identifier is hidden while a
  // scenario is active — everything else about the reading (distance, bearing, height) stays.
  const stationLabel = state.scenario
    ? 'Nearest station'
    : `${report.station.id} ${report.station.name}`;
  wrap.append(
    createElement(
      'p',
      'weather-now',
      `${stationLabel}, ${report.distanceKm.toFixed(0)} km ${compassPoint(report.bearing)} of the weather point, station ${heightText(report.station.elevation)} · observed ${CLOCK.format(report.observed)} (${minutesAgo(report.observed)})`,
    ),
    createElement(
      'p',
      'weather-now',
      [
        `${formatNumber(report.temperature)} °C, dew point ${formatNumber(report.dewPoint)} °C`,
        `wind ${windText}`,
        `visibility ${visibilityText}`,
        report.weather ? `weather ${report.weather}` : null,
        `cloud ${cloudText}`,
        ceilingText,
        Number.isFinite(report.qnh) ? `QNH ${report.qnh} hPa` : null,
      ]
        .filter(Boolean)
        .join(', '),
    ),
    createElement('code', 'weather-metar', report.raw),
    createElement(
      'p',
      'panel-note',
      `Measured at the airfield, not in the AOI${report.distanceKm > 25 ? `; ${report.distanceKm.toFixed(0)} km away it shows the wider region, not local effects` : ''}. Cloud heights above the station. METAR via aviationweather.gov (NOAA).`,
    ),
  );
  return wrap;
}
