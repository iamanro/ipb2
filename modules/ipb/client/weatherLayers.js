// IPB map: the online weather overlays (radar, forecast layers) and their legend.

import { buildScenarioNameIndex } from '../../../src/map.js';
import {
  CLOUD_LAYER,
  EUMETSAT_ATTRIBUTION,
  LIGHTNING_LAYER,
  OPEN_METEO_ATTRIBUTION,
  RAINVIEWER_API,
  RAINVIEWER_ATTRIBUTION,
  RAINVIEWER_MAX_ZOOM,
  latestWmsTime,
  parseWind,
  radarFrames,
  windLattice,
  windUrl,
  wmsCapabilitiesUrl,
} from '../../../src/weather.js';

import {
  BASEMAPS,
  CLOCK,
  MINUTE,
  WEATHER_BY_ID,
  WEATHER_OVERLAYS,
  WEATHER_UNAVAILABLE,
  applyOverlays,
  basemapSpec,
  createElement,
  elements,
  mapController,
  renderOverlayList,
  requestJson,
  saveMapView,
  state,
} from './view.js';

const RADAR_FRAME_MS = 700;

// --- Weather (online) ------------------------------------------------------------

export function minutesAgo(time) {
  const minutes = Math.max(0, Math.round((Date.now() - time) / MINUTE));
  return minutes < 1 ? 'just now' : `${minutes} min ago`;
}

/** What the Layers panel says under a weather overlay's name. */
function weatherStatus(overlay) {
  const entry = state.weather[overlay.id];
  if (!state.overlays[overlay.id]) return overlay.source;
  if (entry.error) return entry.error;
  const time = weatherTime(overlay.id);
  if (time !== null) return `${overlay.source} · ${CLOCK.format(time)} (${minutesAgo(time)})`;
  return entry.loading ? 'Loading…' : overlay.source;
}

/** The time of the data shown for a weather overlay, or null. */
function weatherTime(id) {
  const entry = state.weather[id];
  if (id === 'radar') return entry.frames[entry.index]?.time ?? null;
  if (id === 'wind') return entry.points[0]?.time ?? null;
  return entry.time;
}

export function renderWeatherRows() {
  const heading = createElement('div', 'overlay-group', 'Weather');
  heading.append(createElement('span', 'basemap-note', 'online'));
  const rows = [heading];
  for (const overlay of WEATHER_OVERLAYS) {
    const on = state.overlays[overlay.id];
    const entry = state.weather[overlay.id];
    const row = createElement('label', 'overlay-option');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.overlay = overlay.id;
    checkbox.checked = on;
    const text = createElement('span', 'overlay-text', overlay.label);
    const status = createElement('small', null, weatherStatus(overlay));
    status.classList.toggle('weather-error', Boolean(on && entry.error));
    if (overlay.id === 'radar') status.dataset.radarStatus = '';
    text.append(status);
    row.append(checkbox, text);
    rows.push(row);
    // Outside the <label>, so its buttons don't toggle the checkbox.
    if (overlay.id === 'radar' && on && entry.frames.length > 1) rows.push(renderRadarControls());
  }
  return rows;
}

function renderRadarControls() {
  const radar = state.weather.radar;
  const controls = createElement('div', 'radar-controls');
  const play = createElement('button', 'readout-toggle', radar.playing ? 'Pause' : 'Play');
  play.type = 'button';
  play.dataset.radar = 'play';
  play.setAttribute('aria-pressed', String(radar.playing));
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(radar.frames.length - 1);
  slider.value = String(radar.index);
  slider.dataset.radar = 'frame';
  slider.setAttribute('aria-label', 'Radar frame');
  controls.append(play, slider);
  return controls;
}

function weatherSpec() {
  const { overlays, weather } = state;
  const wms = (id, layer) =>
    overlays[id] && weather[id].time !== null
      ? { layer, time: weather[id].time, attributions: EUMETSAT_ATTRIBUTION }
      : null;
  return {
    clouds: wms('clouds', CLOUD_LAYER),
    lightning: wms('lightning', LIGHTNING_LAYER),
    radar:
      overlays.radar && weather.radar.frames.length
        ? {
            frames: weather.radar.frames,
            index: weather.radar.index,
            maxZoom: RAINVIEWER_MAX_ZOOM,
            attributions: RAINVIEWER_ATTRIBUTION,
          }
        : null,
    wind:
      overlays.wind && weather.wind.points.length
        ? { points: weather.wind.points, attributions: OPEN_METEO_ATTRIBUTION }
        : null,
  };
}

function applyWeather() {
  mapController?.setWeather(weatherSpec());
}

/** Newest image time of a Meteosat WMS layer, from its small per-layer capabilities. */
async function loadWmsTime(id, layer) {
  const response = await fetch(wmsCapabilitiesUrl(layer), { signal: state.session.signal });
  if (!response.ok) throw new Error(`EUMETSAT ${response.status}`);
  const time = latestWmsTime(await response.text());
  if (time === null) throw new Error('EUMETSAT: no image time');
  state.weather[id].time = time;
}

async function loadRadar() {
  const radar = state.weather.radar;
  const frames = radarFrames(await requestJson(RAINVIEWER_API));
  if (!frames.length) throw new Error('RainViewer: no frames');
  const shown = radar.frames[radar.index]?.time;
  const atNewest = radar.index === radar.frames.length - 1;
  radar.frames = frames;
  // Follow the newest frame unless the analyst stepped back to an older one.
  const kept = frames.findIndex((frame) => frame.time === shown);
  radar.index = atNewest || kept < 0 ? frames.length - 1 : kept;
}

/** Wind at the lattice points of the current view; fetches only missing or stale ones. */
async function loadWind() {
  const wind = state.weather.wind;
  const view = wind.view ?? {
    bounds: mapController.getBounds(),
    size: [elements.mapTarget.clientWidth, elements.mapTarget.clientHeight],
  };
  const { points } = windLattice(view.bounds, view.size);
  const now = Date.now();
  const { refresh } = WEATHER_BY_ID.get('wind');
  for (const [key, reading] of wind.readings) {
    if (now - reading.fetchedAt > 4 * refresh) wind.readings.delete(key);
  }
  const missing = points.filter(
    (point) => !(now - (wind.readings.get(point.key)?.fetchedAt ?? 0) < refresh),
  );
  if (missing.length) {
    const readings = parseWind(await requestJson(windUrl(missing)), missing);
    for (const reading of readings) wind.readings.set(reading.key, { ...reading, fetchedAt: now });
  }
  wind.points = points.map((point) => wind.readings.get(point.key)).filter(Boolean);
}

const WEATHER_LOADERS = {
  clouds: () => loadWmsTime('clouds', CLOUD_LAYER),
  lightning: () => loadWmsTime('lightning', LIGHTNING_LAYER),
  radar: loadRadar,
  wind: loadWind,
};

/** Run one overlay's loader; a request made while one is running runs after it. */
function loadWeather(id) {
  const entry = state.weather[id];
  if (entry.loading) {
    entry.again = true;
    return;
  }
  entry.loading = true;
  renderOverlayList();
  WEATHER_LOADERS[id]()
    .then(
      () => {
        entry.error = null;
      },
      (error) => {
        if (error.name !== 'AbortError') entry.error = WEATHER_UNAVAILABLE;
      },
    )
    .finally(() => {
      entry.loading = false;
      entry.checkedAt = Date.now();
      if (state.session.signal.aborted) return;
      applyWeather();
      renderOverlayList();
      if (entry.again) {
        entry.again = false;
        if (state.overlays[id]) loadWeather(id);
      }
    });
}

/** Load every switched-on overlay whose data is older than its refresh period. */
export function refreshWeather() {
  const now = Date.now();
  for (const overlay of WEATHER_OVERLAYS) {
    const entry = state.weather[overlay.id];
    if (state.overlays[overlay.id] && now - entry.checkedAt >= overlay.refresh) {
      loadWeather(overlay.id);
    }
  }
}

/** Check once a minute while the page is visible; each overlay keeps its own period. */
export function scheduleWeatherRefresh() {
  state.timers.set(
    'weather',
    window.setTimeout(() => {
      if (document.visibilityState === 'visible') refreshWeather();
      scheduleWeatherRefresh();
    }, MINUTE),
  );
}

export function toggleWeather(id, on) {
  state.overlays[id] = on;
  const entry = state.weather[id];
  // Switching back on after a failure retries at once.
  if (on && entry.error) entry.checkedAt = 0;
  if (!on && id === 'radar') setRadarPlaying(false);
  applyWeather();
  renderOverlayList();
  if (on) refreshWeather();
  saveMapView();
}

export function onWeatherViewChange(view) {
  state.weather.wind.view = view;
  if (!state.overlays.wind) return;
  window.clearTimeout(state.timers.get('wind'));
  state.timers.set(
    'wind',
    window.setTimeout(() => loadWeather('wind'), 400),
  );
}

export function showRadarFrame(index) {
  const radar = state.weather.radar;
  radar.index = index;
  applyWeather();
  // Update in place: re-rendering would steal the slider from under the pointer.
  const status = elements.overlayList.querySelector('[data-radar-status]');
  if (status) status.textContent = weatherStatus(WEATHER_BY_ID.get('radar'));
  const slider = elements.overlayList.querySelector('[data-radar="frame"]');
  if (slider) slider.value = String(index);
}

export function setRadarPlaying(playing) {
  const radar = state.weather.radar;
  radar.playing = playing;
  window.clearTimeout(state.timers.get('radar-play'));
  if (playing) {
    const tick = () => {
      const last = radar.frames.length - 1;
      showRadarFrame(radar.index >= last ? 0 : radar.index + 1);
      // Linger on the newest frame so the loop reads as "up to now".
      const delay = radar.index === last ? 3 * RADAR_FRAME_MS : RADAR_FRAME_MS;
      state.timers.set('radar-play', window.setTimeout(tick, delay));
    };
    state.timers.set('radar-play', window.setTimeout(tick, RADAR_FRAME_MS));
  }
  const button = elements.overlayList.querySelector('[data-radar="play"]');
  if (button) {
    button.textContent = playing ? 'Pause' : 'Play';
    button.setAttribute('aria-pressed', String(playing));
  }
}

/** "Clouds 21:45, Radar 21:50" for the print caption. */
export function weatherCaption() {
  return WEATHER_OVERLAYS.filter((overlay) => state.overlays[overlay.id])
    .map((overlay) => {
      const time = weatherTime(overlay.id);
      return time === null ? null : `${overlay.caption} ${CLOCK.format(time)}`;
    })
    .filter(Boolean);
}

/** OpenTopoMap's labels are baked into its tiles and real, so it is disabled whenever
 * a scenario is active, so a renamed/hidden place can never leak through it. */
export function scenarioBlocksBasemap(id) {
  return id === 'topo-online' && Boolean(state.scenario);
}

function basemapRadio(basemap) {
  const blocked = scenarioBlocksBasemap(basemap.id);
  const available = !blocked && Boolean(basemapSpec(basemap.id));
  const button = createElement('button', 'basemap-option', basemap.label);
  button.type = 'button';
  button.dataset.basemap = basemap.id;
  button.setAttribute('role', 'radio');
  button.setAttribute('aria-checked', String(state.basemap === basemap.id));
  button.tabIndex = state.basemap === basemap.id ? 0 : -1;
  button.disabled = !available;
  button.title = blocked
    ? `Disabled: shows real place names, hidden while "${state.scenario.name}" is active.`
    : available
      ? (basemap.title ?? '')
      : basemap.missing;
  return button;
}

/** Basemap radios as a single list with one "Online" note ahead of the
 * basemaps that need internet, rather than a badge on every online button. */
export function renderBasemapSwitch() {
  const offline = BASEMAPS.filter((basemap) => !basemap.note);
  const online = BASEMAPS.filter((basemap) => basemap.note === 'online');
  const group = createElement('div', 'basemap-group');
  group.append(...offline.map(basemapRadio));
  const onlineGroup = createElement('div', 'basemap-group basemap-group-online');
  onlineGroup.append(
    createElement('p', 'basemap-online-note', 'Online (needs internet)'),
    ...online.map(basemapRadio),
  );
  elements.basemapSwitch.replaceChildren(group, onlineGroup);
  const current = BASEMAPS.find((basemap) => basemap.id === state.basemap);
  if (elements.mapMenuLabel) elements.mapMenuLabel.textContent = current?.label ?? state.basemap;
}

export function applyBasemap(id) {
  if (scenarioBlocksBasemap(id)) id = 'roads';
  const spec = basemapSpec(id);
  if (!spec) {
    // A remembered basemap whose data has since gone (e.g. imagery deleted).
    if (id !== 'roads') applyBasemap('roads');
    return;
  }
  state.basemap = id;
  mapController.setBasemap(spec);
  renderBasemapSwitch();
  applyOverlays(); // basemaps like Topo include overlays of their own
  saveMapView();
}

/** The active scenario's places, indexed for the name-match rule in src/map.js. */
export function scenarioPlaceIndex() {
  return buildScenarioNameIndex(state.scenario);
}

/** Shortened for the masthead chip; the full name is always in its title. */
function shortenScenarioName(name, max = 22) {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

export function renderScenarioChip() {
  const chip = elements.scenarioChip;
  if (chip) {
    chip.hidden = !state.scenario;
    if (state.scenario) {
      chip.textContent = `Scenario: ${shortenScenarioName(state.scenario.name)}`;
      chip.title = state.scenario.name;
    }
  }
  const notice = elements.mapPopoverScenario;
  if (notice) {
    notice.hidden = !state.scenario;
    if (state.scenario) {
      notice.textContent = `Scenario active: "${state.scenario.name}" — OpenTopoMap is disabled while it shows real place names.`;
    }
  }
}
