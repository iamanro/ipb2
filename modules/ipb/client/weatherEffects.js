/**
 * Weather effects matrix (step 1, next to the 48 h forecast): systems and
 * activities × forecast blocks, each cell rated Favourable / Marginal /
 * Unfavourable from editable thresholds. Pure evaluation (`evaluateWeatherCell`,
 * `evaluateWeatherMatrix`) is exported for tests; `renderWeatherEffectsBlock`
 * builds the on-screen/print DOM and owns saving `studies/:id
 * {weather_thresholds}`.
 *
 * Reuses the 48 h forecast the view already fetched (`hours`, the same
 * `{time, temperature, wind, gusts, precipitation, cloud, cloudLow,
 * visibility}` rows `src/weather.js#parseForecast` produces) — never
 * refetches. Light (day/twilight/night, for EO sensors and UAS) comes from
 * `src/astro.js#lightData`, which is pure and DOM-free.
 */
import './tools.css';

import { lightData } from '../../../src/astro.js';

const API = '/api/ipb';

/**
 * Doctrinal-style default thresholds, one entry per factor a system can be
 * rated against. Not sourced from a single classified reference: they follow
 * commonly used ground/aviation planning figures (e.g. rotary wing marginal
 * near 15 kt / 7.7 m/s sustained wind, unfavourable near 25 kt / 12.9 m/s;
 * visibility 3 sm / 4.8 km marginal, 1 sm / 1.6 km unfavourable) and are
 * meant as an editable starting point, not a fixed rule — the analyst can
 * change every value, and "Reset to defaults" always returns to this set.
 * Stored on `studies.weather_thresholds`; `resolveThresholds` fills in any
 * factor a saved study is missing (new factors added later still work).
 */
export const DEFAULT_WEATHER_THRESHOLDS = {
  wind_ms: { marginal: 8, unfavourable: 15 },
  gusts_ms: { marginal: 12, unfavourable: 20 },
  visibility_km: { marginal: 5, unfavourable: 1.6 },
  low_cloud_pct: { marginal: 50, unfavourable: 85 },
  precipitation_mm: { marginal: 1, unfavourable: 6 },
  temperature_c: { marginalLow: -10, marginalHigh: 35, unfavourableLow: -20, unfavourableHigh: 43 },
};

const FACTOR_LABELS = {
  wind: 'Wind',
  gusts: 'Gusts',
  visibility: 'Visibility',
  cloud: 'Low cloud',
  precipitation: 'Precipitation',
  temperature: 'Temperature',
  light: 'Light',
};

/** Rows: systems/activities an analyst cares about, each rated on the
 * factors that actually affect it. Order matches the printed matrix. */
export const WEATHER_SYSTEMS = [
  {
    id: 'dismounted-movement',
    label: 'Dismounted movement',
    factors: ['precipitation', 'visibility', 'temperature'],
  },
  { id: 'wheeled-movement', label: 'Wheeled movement', factors: ['precipitation', 'visibility'] },
  { id: 'tracked-movement', label: 'Tracked movement', factors: ['precipitation'] },
  { id: 'rotary-wing', label: 'Rotary wing', factors: ['wind', 'gusts', 'visibility', 'cloud'] },
  { id: 'uas-small', label: 'UAS (small)', factors: ['wind', 'gusts', 'precipitation', 'light'] },
  { id: 'uas-tactical', label: 'UAS (tactical)', factors: ['wind', 'gusts', 'precipitation'] },
  {
    id: 'observation-isr-eo',
    label: 'Observation/ISR (EO)',
    factors: ['visibility', 'cloud', 'light'],
  },
  { id: 'artillery-mortar', label: 'Artillery/mortar', factors: ['wind', 'visibility'] },
  { id: 'smoke-obscurants', label: 'Smoke/obscurants', factors: ['wind', 'precipitation'] },
];

const round = (value, digits = 0) => Number(value.toFixed(digits));

function rateHighIsBad(value, threshold, unit, label) {
  if (!Number.isFinite(value)) return null;
  const rating =
    value >= threshold.unfavourable
      ? 'unfavourable'
      : value >= threshold.marginal
        ? 'marginal'
        : 'favourable';
  return { rating, detail: `${label} ${round(value, 1)} ${unit}` };
}

function rateLowIsBad(value, threshold, unit, label) {
  if (!Number.isFinite(value)) return null;
  const rating =
    value <= threshold.unfavourable
      ? 'unfavourable'
      : value <= threshold.marginal
        ? 'marginal'
        : 'favourable';
  return { rating, detail: `${label} ${round(value, 1)} ${unit}` };
}

function rateTemperature(value, threshold) {
  if (!Number.isFinite(value)) return null;
  const rating =
    value <= threshold.unfavourableLow || value >= threshold.unfavourableHigh
      ? 'unfavourable'
      : value <= threshold.marginalLow || value >= threshold.marginalHigh
        ? 'marginal'
        : 'favourable';
  return { rating, detail: `${round(value, 1)} °C` };
}

/** `light` is one of `classifyLight`'s results, or null (no data: treated as day). */
function rateLight(light) {
  if (!light || light === 'day') return { rating: 'favourable', detail: 'Daylight' };
  if (light === 'night') return { rating: 'unfavourable', detail: 'Night' };
  return {
    rating: 'marginal',
    detail: light === 'civil-twilight' ? 'Civil twilight' : 'Nautical twilight',
  };
}

const FACTOR_EVALUATORS = {
  wind: (hour, thresholds) => rateHighIsBad(hour.wind, thresholds.wind_ms, 'm/s', 'Wind'),
  gusts: (hour, thresholds) => rateHighIsBad(hour.gusts, thresholds.gusts_ms, 'm/s', 'Gusts'),
  visibility: (hour, thresholds) =>
    rateLowIsBad(
      Number.isFinite(hour.visibility) ? hour.visibility / 1000 : null,
      thresholds.visibility_km,
      'km',
      'Visibility',
    ),
  cloud: (hour, thresholds) =>
    rateHighIsBad(hour.cloudLow, thresholds.low_cloud_pct, '%', 'Low cloud'),
  precipitation: (hour, thresholds) =>
    rateHighIsBad(hour.precipitation, thresholds.precipitation_mm, 'mm', 'Precip.'),
  temperature: (hour, thresholds) => rateTemperature(hour.temperature, thresholds.temperature_c),
  light: (_hour, _thresholds, light) => rateLight(light),
};

const RATING_RANK = { favourable: 0, marginal: 1, unfavourable: 2 };

function worseRating(a, b) {
  return RATING_RANK[b] > RATING_RANK[a] ? b : a;
}

/**
 * One cell: `{ rating: 'favourable'|'marginal'|'unfavourable', reasons:
 * [{ factor, rating, detail }] }`, the worst of the system's applicable
 * factors (a factor with no data at this hour is skipped, not counted
 * favourable). `light` is `classifyLight`'s result for this hour, or null.
 */
export function evaluateWeatherCell(system, hour, thresholds, light) {
  const reasons = [];
  let rating = 'favourable';
  for (const factor of system.factors) {
    const result = FACTOR_EVALUATORS[factor](hour, thresholds, light);
    if (!result) continue;
    reasons.push({ factor, label: FACTOR_LABELS[factor], ...result });
    rating = worseRating(rating, result.rating);
  }
  return { rating, reasons };
}

/**
 * Sun altitude thresholds a day's `lightData` crosses in order
 * (BMNT ≤ BMCT ≤ sunrise ≤ sunset ≤ EECT ≤ EENT): classify a moment as
 * `'day'`, `'civil-twilight'`, `'nautical-twilight'` or `'night'`. Missing
 * events (polar day/night) fall back to `'day'` — rare at the latitudes this
 * app plans for, and erring toward "assume observable" is the safer default
 * for a planning aid.
 */
export function classifyLight(light, timeMs) {
  if (!light) return 'day';
  const { bmnt, bmct, sunrise, sunset, eect, eent } = light;
  if (sunrise != null && sunset != null && timeMs >= sunrise && timeMs <= sunset) return 'day';
  if (sunrise != null && timeMs < sunrise) {
    if (bmct != null && timeMs >= bmct) return 'civil-twilight';
    if (bmnt != null && timeMs >= bmnt) return 'nautical-twilight';
    return 'night';
  }
  if (sunset != null && timeMs > sunset) {
    if (eect != null && timeMs <= eect) return 'civil-twilight';
    if (eent != null && timeMs <= eent) return 'nautical-twilight';
    return 'night';
  }
  return 'day';
}

/** Local midnight of the day containing `timeMs` — `lightData` reads its 24 h window from there. */
function localMidnight(timeMs) {
  const date = new Date(timeMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** One `classifyLight` result per hour, computing `lightData` at most once per calendar day spanned. */
export function forecastLightStates(hours, lat, lon) {
  const cache = new Map();
  return hours.map((hour) => {
    const dayStart = localMidnight(hour.time);
    let light = cache.get(dayStart);
    if (!light) {
      light = Number.isFinite(lat) && Number.isFinite(lon) ? lightData(lat, lon, dayStart) : null;
      cache.set(dayStart, light);
    }
    return classifyLight(light, hour.time);
  });
}

/** Every saved factor merged over the defaults, so a study saved before a
 * factor existed — or missing one key of a pair — still evaluates fully. */
export function resolveThresholds(saved) {
  const result = {};
  for (const [key, value] of Object.entries(DEFAULT_WEATHER_THRESHOLDS)) {
    result[key] = { ...value, ...(saved && typeof saved[key] === 'object' ? saved[key] : {}) };
  }
  return result;
}

/** One row per system, one cell per forecast hour: `[{ system, cells }]`. */
export function evaluateWeatherMatrix(hours, thresholds, lat, lon) {
  const lightStates = forecastLightStates(hours, lat, lon);
  return WEATHER_SYSTEMS.map((system) => ({
    system,
    cells: hours.map((hour, index) =>
      evaluateWeatherCell(system, hour, thresholds, lightStates[index]),
    ),
  }));
}

/** `study.weather_point`, else the AOI/bounds centre — a light approximation
 * of the view's own `weatherPoint`/`aoiCentre`, close enough for day/night. */
export function resolveWeatherEffectsPoint(study) {
  if (study?.weather_point) return study.weather_point;
  if (Array.isArray(study?.bounds) && study.bounds.length === 4) {
    const [west, south, east, north] = study.bounds;
    return { lon: (west + east) / 2, lat: (south + north) / 2 };
  }
  return null;
}

const RATING_BADGE = { favourable: 'F', marginal: 'M', unfavourable: 'U' };
const RATING_WORD = {
  favourable: 'Favourable',
  marginal: 'Marginal',
  unfavourable: 'Unfavourable',
};

const THRESHOLD_FIELDS = [
  { key: 'wind_ms', label: 'Wind (m/s)', kind: 'pair' },
  { key: 'gusts_ms', label: 'Gusts (m/s)', kind: 'pair' },
  { key: 'visibility_km', label: 'Visibility (km)', kind: 'pair', invert: true },
  { key: 'low_cloud_pct', label: 'Low cloud (%)', kind: 'pair' },
  { key: 'precipitation_mm', label: 'Precipitation (mm/3h)', kind: 'pair' },
  { key: 'temperature_c', label: 'Temperature (°C)', kind: 'temperature' },
];

const HOUR_LABEL = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Editable threshold inputs (marginal/unfavourable per factor, plus a
 * reset), `can` gating whether they can be changed. Commits the whole
 * `weather_thresholds` object on every change, since it is stored as one
 * JSON blob.
 */
function renderThresholdForm({ createElement, thresholds, can, onChange }) {
  const form = createElement('div', 'weather-threshold-form');
  const read = () => {
    const next = {};
    for (const field of THRESHOLD_FIELDS) {
      if (field.kind === 'pair') {
        next[field.key] = {
          marginal: Number(form.querySelector(`[data-field="${field.key}.marginal"]`).value),
          unfavourable: Number(
            form.querySelector(`[data-field="${field.key}.unfavourable"]`).value,
          ),
        };
      } else {
        next[field.key] = {
          marginalLow: Number(form.querySelector(`[data-field="${field.key}.marginalLow"]`).value),
          marginalHigh: Number(
            form.querySelector(`[data-field="${field.key}.marginalHigh"]`).value,
          ),
          unfavourableLow: Number(
            form.querySelector(`[data-field="${field.key}.unfavourableLow"]`).value,
          ),
          unfavourableHigh: Number(
            form.querySelector(`[data-field="${field.key}.unfavourableHigh"]`).value,
          ),
        };
      }
    }
    return next;
  };
  const numberInput = (key, value) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.dataset.field = key;
    input.value = String(value);
    input.disabled = !can;
    input.addEventListener('change', () => onChange(read()));
    return input;
  };
  for (const field of THRESHOLD_FIELDS) {
    const row = createElement('div', 'weather-threshold-row');
    row.append(createElement('span', 'weather-threshold-label', field.label));
    if (field.kind === 'pair') {
      const order = field.invert ? ['unfavourable', 'marginal'] : ['marginal', 'unfavourable'];
      for (const sub of order) {
        const label = createElement('label', 'weather-threshold-field');
        label.append(
          createElement('span', null, sub === 'marginal' ? 'Marginal at' : 'Unfavourable at'),
          numberInput(`${field.key}.${sub}`, thresholds[field.key][sub]),
        );
        row.append(label);
      }
    } else {
      for (const sub of ['unfavourableLow', 'marginalLow', 'marginalHigh', 'unfavourableHigh']) {
        const label = createElement('label', 'weather-threshold-field');
        label.append(
          createElement(
            'span',
            null,
            {
              unfavourableLow: 'Unfav. below',
              marginalLow: 'Marg. below',
              marginalHigh: 'Marg. above',
              unfavourableHigh: 'Unfav. above',
            }[sub],
          ),
          numberInput(`${field.key}.${sub}`, thresholds[field.key][sub]),
        );
        row.append(label);
      }
    }
    form.append(row);
  }
  return form;
}

/**
 * The full worksheet block: threshold settings, the matrix table (or an
 * explanatory note when there is no forecast yet), and a legend. `study` is
 * `state.study.study` (mutated in place with the server's response, matching
 * the view's own autosave convention); `hours` is the already-fetched 48 h
 * forecast (`state.weather.forecast.data[0].hours`), or an empty array.
 */
export function renderWeatherEffectsBlock({
  createElement,
  requestJson,
  showError,
  can,
  study,
  hours,
  point,
}) {
  const block = createElement('section', 'worksheet-block weather-effects-block');
  block.append(createElement('h4', null, 'Weather effects matrix'));

  const thresholds = resolveThresholds(study.weather_thresholds);
  const details = document.createElement('details');
  details.className = 'weather-thresholds';
  const summary = document.createElement('summary');
  summary.textContent = 'Thresholds';
  details.append(summary);

  const commit = async (nextThresholds) => {
    try {
      const updated = await requestJson(`${API}/studies/${study.id}`, {
        method: 'PATCH',
        body: { weather_thresholds: nextThresholds },
      });
      Object.assign(study, updated);
    } catch (error) {
      if (error.name !== 'AbortError') showError(block, error.message);
    }
  };

  const form = renderThresholdForm({ createElement, thresholds, can, onChange: commit });
  details.append(form);
  if (can) {
    const reset = createElement('button', 'text-button', 'Reset to defaults');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      for (const field of THRESHOLD_FIELDS) {
        for (const [sub, value] of Object.entries(DEFAULT_WEATHER_THRESHOLDS[field.key])) {
          const input = form.querySelector(`[data-field="${field.key}.${sub}"]`);
          if (input) input.value = String(value);
        }
      }
      commit(DEFAULT_WEATHER_THRESHOLDS);
    });
    details.append(reset);
  }
  block.append(details);

  if (!hours.length) {
    block.append(
      createElement('p', 'panel-note', 'Get the 48-hour forecast above to fill this matrix.'),
    );
    return block;
  }

  const matrix = evaluateWeatherMatrix(hours, thresholds, point?.lat, point?.lon);
  const wrap = createElement('div', 'weather-effects-wrap');
  const table = document.createElement('table');
  table.className = 'data-table weather-effects-matrix';
  const headRow = document.createElement('tr');
  headRow.append(createElement('th', null, 'System'));
  hours.forEach((hour) => headRow.append(createElement('th', null, HOUR_LABEL.format(hour.time))));
  const head = document.createElement('thead');
  head.append(headRow);
  const body = document.createElement('tbody');
  matrix.forEach(({ system, cells }) => {
    const row = document.createElement('tr');
    row.append(createElement('th', 'weather-effects-row-label', system.label));
    cells.forEach((cell, index) => {
      const td = document.createElement('td');
      td.className = `weather-effects-cell rating-${cell.rating}`;
      const badge = createElement('span', 'weather-effects-badge', RATING_BADGE[cell.rating]);
      badge.setAttribute('aria-hidden', 'true');
      td.append(badge);
      const reasonText = cell.reasons.map((reason) => reason.detail).join(' · ') || 'No data';
      td.title = `${RATING_WORD[cell.rating]} — ${reasonText}`;
      td.setAttribute(
        'aria-label',
        `${system.label}, ${HOUR_LABEL.format(hours[index].time)}: ${RATING_WORD[cell.rating]}, ${reasonText}`,
      );
      row.append(td);
    });
    body.append(row);
  });
  table.append(head, body);
  wrap.append(table);
  block.append(wrap);

  block.append(
    createElement(
      'p',
      'panel-note',
      'F favourable · M marginal · U unfavourable, the worst of that system’s applicable factors at each 3 h block. EO/UAS ratings include light from the study’s light data.',
    ),
  );
  return block;
}
