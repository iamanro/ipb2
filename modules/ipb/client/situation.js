/**
 * The IPB "current situation" overlay: `GET /api/exercise/{tracks,reports}`
 * drawn via `mapController.setSituation`, off by default, its on/off state
 * persisted with the other map overlays. A click on a track or report shows
 * a small info card. Live refresh on exercise events.
 */
import { formatDtg } from '../../../src/dtg.js';
import { formatMgrs } from '../../../src/geo.js';
import { subscribe } from '../../../src/live.js';
import { EXERCISE_API, createElement, elements, mapController, requestJson } from './view.js';

let enabled = false;
let unsubscribeLive = null;
let inFlight = 0;
let infoCard = null;

function ensureInfoCard() {
  if (infoCard) return infoCard;
  infoCard = createElement('div', 'situation-info');
  infoCard.hidden = true;
  elements.moduleRoot?.querySelector('.map-panel')?.append(infoCard);
  return infoCard;
}

function closeInfoCard() {
  if (!infoCard) return;
  infoCard.hidden = true;
  infoCard.replaceChildren();
}

/** "B2" admiralty rating, matching the exercise module's own badge text. */
function admiralty(report) {
  return `${report.reliability}${report.credibility}`;
}

function showTrackInfo(track) {
  const card = ensureInfoCard();
  card.hidden = false;
  card.replaceChildren();
  const close = createElement('button', 'icon-button situation-info-close', 'Close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeInfoCard);
  card.append(close);
  card.append(createElement('h5', null, track.designation || `Track ${track.id}`));
  const facts = createElement('dl', 'fact-list');
  const fact = (term, value) => {
    facts.append(createElement('dt', null, term), createElement('dd', null, value));
  };
  fact('Status', track.status);
  fact('Last DTG', track.observed_at ? formatDtg(new Date(track.observed_at).getTime()) : '—');
  fact('MGRS', formatMgrs(track.lon, track.lat));
  fact('History', `${track.history?.length ?? 0} position${(track.history?.length ?? 0) === 1 ? '' : 's'}`);
  card.append(facts);
}

function showReportInfo(report, naiLabel) {
  const card = ensureInfoCard();
  card.hidden = false;
  card.replaceChildren();
  const close = createElement('button', 'icon-button situation-info-close', 'Close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeInfoCard);
  card.append(close);
  card.append(createElement('h5', null, (report.report_type || 'free').toUpperCase()));
  const facts = createElement('dl', 'fact-list');
  const fact = (term, value) => {
    facts.append(createElement('dt', null, term), createElement('dd', null, value));
  };
  fact('DTG', report.occurred_at ? formatDtg(new Date(report.occurred_at).getTime()) : '—');
  fact('Admiralty', admiralty(report));
  if (naiLabel) fact('NAI', naiLabel);
  card.append(facts);
  const text = report.text || '';
  const excerpt = text.length > 160 ? `${text.slice(0, 157)}…` : text;
  card.append(createElement('p', 'situation-info-excerpt', excerpt || '—'));
}

/** Data for the current fetch, kept so onSelect can resolve a report's NAI
 * label without a second request. */
let lastTracks = [];
let lastReports = [];
let lastNaisById = new Map();

function onSelect({ kind, id }) {
  if (kind === 'track') {
    const track = lastTracks.find((entry) => String(entry.id) === String(id));
    if (track) showTrackInfo(track);
    return;
  }
  const report = lastReports.find((entry) => String(entry.id) === String(id));
  if (report) showReportInfo(report, report.nai_id ? lastNaisById.get(String(report.nai_id)) : null);
}

async function refresh() {
  if (!enabled) return;
  const token = ++inFlight;
  try {
    const [tracks, reports, nais] = await Promise.all([
      requestJson(`${EXERCISE_API}/tracks`),
      requestJson(`${EXERCISE_API}/reports`),
      requestJson(`${EXERCISE_API}/nais`),
    ]);
    if (token !== inFlight || !enabled) return;
    lastTracks = tracks;
    lastReports = reports.filter((report) => report.lon != null && report.lat != null);
    lastNaisById = new Map(nais.map((nai) => [String(nai.id), nai.label]));
    mapController?.setSituation({ tracks: lastTracks, reports: lastReports }, { onSelect });
  } catch {
    // A transient failure just leaves the overlay showing its last good
    // data; the next 30 s / live-event refresh retries.
  }
}

/** Switches the overlay on/off; `true` fetches immediately and subscribes
 * to live exercise events, `false` clears the map layer and unsubscribes. */
export function setSituationEnabled(next) {
  enabled = next;
  if (enabled) {
    refresh();
    if (!unsubscribeLive) {
      unsubscribeLive = subscribe((event) => event.module === 'exercise', refresh);
    }
  } else {
    mapController?.setSituation(null);
    closeInfoCard();
    unsubscribeLive?.();
    unsubscribeLive = null;
  }
}

export function isSituationEnabled() {
  return enabled;
}

/** Called once from view.js's unmount, mirroring `setSituationEnabled(false)`
 * plus dropping the info card node. */
export function destroySituation() {
  setSituationEnabled(false);
  infoCard?.remove();
  infoCard = null;
}

/** The Layers-panel row for the toggle, in the same shape `renderOverlayList`
 * builds its own rows in (a `<label class="overlay-option">`). */
export function renderSituationOverlayRow() {
  const row = createElement('label', 'overlay-option');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.dataset.overlay = 'situation';
  checkbox.checked = enabled;
  const text = createElement('span', 'overlay-text', 'Current situation (Exercise)');
  text.append(createElement('small', null, 'Tracks and located reports, live'));
  row.append(checkbox, text);
  return row;
}
