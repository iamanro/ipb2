/**
 * The Situation tab: the current exercise situation (tracks + reports) on a
 * full-height map — `createMap`/`setSituation`, same basemap/terrain-meta
 * handling as the Geography tab — plus the imported NAIs/TAIs drawn as
 * labelled outlines (`setFeatures` with `layer: 'nai'|'tai'`, which
 * `src/map.js` already styles as boxed-label outlines). A side panel lists
 * tracks grouped by status, a track/report detail card, a time filter over
 * scenario time, and add/edit/delete for tracks.
 *
 * `createSituationController(ctx)` returns `{ enter(container), leave() }`,
 * the same shape `collection.js`/`products.js`/`reportForm.js`'s Reports
 * controller use — see `view.js`'s shared `ctx` (this one also uses
 * `ctx.switchTab` to jump to the Reports tab from a linked report).
 */
import { formatDtg } from '../../../src/dtg.js';
import { formatMgrs } from '../../../src/geo.js';
import { subscribe } from '../../../src/live.js';
import { createMap } from '../../../src/map.js';
import { canEditClient, renderCellBadge, renderReleaseControl } from '../../../src/release.js';
import { can, currentUser, sessionMode } from '../../../src/session.js';
import { openSymbolPicker } from '../../../src/symbols/picker.js';
import { DEFAULT_SIDC, withAffiliation } from '../../../src/symbols/sidc.js';
import { symbolElement } from '../../../src/symbols/symbol.js';

import { createLocationField } from './locationField.js';
import { appendOwnerReassign } from './ownerReassign.js';
import './situation.css';

const API = '/api/exercise';
const TERRAIN_API = '/api/terrain';
/** Approximate centre of Czechia — same fallback view as the Geography tab's map. */
const CZECHIA_CENTER = [15.47, 49.82];
const CZECHIA_ZOOM = 7;
const POINT_ZOOM_MARGIN = 0.02;

const TRACK_STATUSES = ['confirmed', 'suspected', 'destroyed', 'lost'];
const TRACK_STATUS_LABEL = {
  confirmed: 'Confirmed',
  suspected: 'Suspected',
  destroyed: 'Destroyed',
  lost: 'Lost',
};
/** `null` = every report regardless of scenario time. */
const TIME_FILTER_HOURS = [null, 1, 3, 6, 12, 24, 48];

/** The situation map's basemap spec for an id, or null while its data is missing
 * (mirrors the Geography tab's `geoBasemapSpec` in view.js). */
function basemapSpec(id, terrainMeta) {
  const vector = { attributions: terrainMeta?.basemap.attribution };
  if (id === 'satellite') {
    return (
      terrainMeta?.imagery && {
        vector,
        imagery: {
          url: terrainMeta.imagery.url,
          minZoom: terrainMeta.imagery.minZoom,
          maxZoom: terrainMeta.imagery.maxZoom,
          extent: terrainMeta.imagery.bounds,
          attributions: terrainMeta.imagery.attribution,
          dark: true,
        },
      }
    );
  }
  return { vector };
}

/** See reportForm.js's own copy of this check for why "no cell" is
 * defensive, not the real gate. */
function hasCell() {
  if (sessionMode() !== 'on') return true;
  const user = currentUser();
  return Boolean(user?.admin) || Boolean(user?.cell);
}

export function createSituationController(ctx) {
  const { requestJson, createElement: el, askConfirm, showError, api } = ctx;

  const data = { tracks: [], reports: [], nais: [], clock: null };
  let panel = null;
  let sidebar = null;
  let basemapSwitchEl = null;
  let map = null;
  let unsubscribe = null;

  let terrainMeta = null;
  let basemapId = 'roads';
  let selectedTrackId = null;
  let selectedReportId = null;
  let hoursFilter = null;
  let addingTrack = false;
  let addTrackField = null;
  let editingTrackId = null;

  async function load() {
    const [tracks, reports, nais, clock] = await Promise.all([
      requestJson(`${api}/tracks`),
      requestJson(`${api}/reports`),
      requestJson(`${api}/nais`),
      requestJson(`${api}/clock`),
    ]);
    data.tracks = tracks;
    data.reports = reports;
    data.nais = nais;
    data.clock = clock;
  }

  function filteredReports() {
    if (hoursFilter == null || !data.clock) return data.reports;
    const cutoff = new Date(data.clock.now).getTime() - hoursFilter * 3_600_000;
    return data.reports.filter((report) => {
      const at = new Date(report.occurred_at || report.created_at).getTime();
      return at >= cutoff;
    });
  }

  function naiFeatures() {
    return data.nais
      .filter((nai) => nai.geometry)
      .map((nai) => ({
        id: nai.id,
        layer: nai.kind === 'tai' ? 'tai' : 'nai',
        kind: nai.geometry.type === 'Point' ? 'point' : 'polygon',
        label: nai.label,
        geometry: nai.geometry,
        properties: {},
      }));
  }

  function onMapSelect({ kind, id }) {
    if (kind === 'track') {
      selectedTrackId = id;
      selectedReportId = null;
      focusPoint(data.tracks.find((track) => track.id === id));
    } else {
      selectedReportId = id;
      selectedTrackId = null;
    }
    renderSidebar();
  }

  function updateMapData() {
    if (!map) return;
    map.setFeatures(naiFeatures());
    map.setSituation({ tracks: data.tracks, reports: filteredReports() }, { onSelect: onMapSelect });
  }

  function focusPoint(point) {
    if (!map || !point) return;
    map.fitExtent([
      point.lon - POINT_ZOOM_MARGIN,
      point.lat - POINT_ZOOM_MARGIN,
      point.lon + POINT_ZOOM_MARGIN,
      point.lat + POINT_ZOOM_MARGIN,
    ]);
  }

  // -- basemap switch (mirrors the Geography tab) --------------------------------

  function applyBasemap(id) {
    const spec = basemapSpec(id, terrainMeta);
    if (!spec) {
      if (id !== 'roads') applyBasemap('roads');
      return;
    }
    basemapId = id;
    map.setBasemap(spec);
    renderBasemapSwitch();
  }

  function renderBasemapSwitch() {
    if (!basemapSwitchEl) return;
    basemapSwitchEl.replaceChildren();
    [
      { id: 'roads', label: 'Roads' },
      { id: 'satellite', label: 'Satellite' },
    ].forEach(({ id, label }) => {
      const available = Boolean(basemapSpec(id, terrainMeta));
      const button = el('button', 'basemap-option', label);
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(basemapId === id));
      button.disabled = !available;
      button.addEventListener('click', () => applyBasemap(id));
      basemapSwitchEl.append(button);
    });
  }

  // -- sidebar: time filter, add track --------------------------------------------

  function renderTimeFilter(container) {
    const row = el('div', 'situation-time-filter');
    const label = el('label', 'field-label-inline', 'Reports within');
    const select = document.createElement('select');
    TIME_FILTER_HOURS.forEach((hours) => {
      select.append(new Option(hours == null ? 'All scenario time' : `Last ${hours}h`, hours == null ? 'all' : String(hours)));
    });
    select.value = hoursFilter == null ? 'all' : String(hoursFilter);
    select.addEventListener('change', () => {
      hoursFilter = select.value === 'all' ? null : Number.parseInt(select.value, 10);
      updateMapData();
      renderSidebar();
    });
    label.append(select);
    row.append(label);
    if (data.clock) {
      row.append(el('p', 'panel-note', `Scenario time: ${formatDtg(new Date(data.clock.now).getTime())}`));
    }
    container.append(row);
  }

  function renderAddTrack(container) {
    if (!can('analyst') || !hasCell()) return;
    if (!addingTrack) {
      const button = el('button', 'chip-button', 'Add track');
      button.type = 'button';
      button.addEventListener('click', () => {
        addingTrack = true;
        renderSidebar();
      });
      container.append(button);
      return;
    }

    const form = el('div', 'situation-add-track-form field-group');
    form.append(el('h3', null, 'New track'));
    const designationInput = document.createElement('input');
    designationInput.type = 'text';
    designationInput.placeholder = 'Designation';
    designationInput.setAttribute('aria-label', 'Track designation');
    const statusSelect = document.createElement('select');
    statusSelect.setAttribute('aria-label', 'Track status');
    TRACK_STATUSES.forEach((status) => statusSelect.append(new Option(TRACK_STATUS_LABEL[status], status)));

    let sidc = withAffiliation(DEFAULT_SIDC, 'hostile');
    const sidcPreview = el('span', 'report-sidc-preview');
    const renderSidc = () => sidcPreview.replaceChildren(symbolElement(sidc, { size: 26 }, 'Track symbol'));
    renderSidc();
    const sidcButton = el('button', 'chip-button', 'Symbol\u2026');
    sidcButton.type = 'button';
    sidcButton.addEventListener('click', async () => {
      const picked = await openSymbolPicker({ initial: sidc, affiliation: 'hostile', title: 'Track symbol' });
      if (picked) {
        sidc = picked;
        renderSidc();
      }
    });

    addTrackField?.destroy();
    addTrackField = createLocationField({ ariaLabel: 'Track location' });
    const errorNode = el('p', 'field-error', 'Pick a valid location.');
    errorNode.setAttribute('role', 'alert');
    errorNode.hidden = true;

    const actions = el('div', 'inline-form');
    const saveButton = el('button', 'primary-button', 'Add track');
    saveButton.type = 'button';
    saveButton.addEventListener('click', async () => {
      const point = addTrackField.getValue();
      if (!point) {
        errorNode.hidden = false;
        return;
      }
      try {
        await requestJson(`${api}/tracks`, {
          method: 'POST',
          body: {
            sidc,
            designation: designationInput.value.trim() || null,
            status: statusSelect.value,
            lon: point.lon,
            lat: point.lat,
            observed_at: data.clock?.now ?? new Date().toISOString(),
          },
        });
        addingTrack = false;
        await load();
        updateMapData();
        renderSidebar();
      } catch (error) {
        showError(form, error.message);
      }
    });
    const cancelButton = el('button', 'text-button', 'Cancel');
    cancelButton.type = 'button';
    cancelButton.addEventListener('click', () => {
      addingTrack = false;
      renderSidebar();
    });
    actions.append(saveButton, cancelButton);

    form.append(designationInput, statusSelect, sidcPreview, sidcButton, addTrackField.element, errorNode, actions);
    container.append(form);
  }

  // -- track list, grouped by status ---------------------------------------------

  function renderTrackList(container) {
    const section = el('div', 'situation-track-list');
    if (!data.tracks.length) {
      section.append(el('p', 'panel-note', 'No tracks yet.'));
      container.append(section);
      return;
    }
    TRACK_STATUSES.forEach((status) => {
      const group = data.tracks.filter((track) => track.status === status);
      if (!group.length) return;
      const groupEl = el('div', 'situation-track-group');
      groupEl.append(el('h4', null, `${TRACK_STATUS_LABEL[status]} (${group.length})`));
      const list = el('ul', 'situation-track-items');
      group.forEach((track) => {
        const item = document.createElement('li');
        const selected = selectedTrackId === track.id;
        const button = el('button', `situation-track-item status-${track.status}${selected ? ' selected' : ''}`);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(selected));
        button.append(
          symbolElement(track.sidc, { size: 22 }, `${TRACK_STATUS_LABEL[track.status]} track`),
          el('span', 'situation-track-designation', track.designation || track.sidc),
          el('span', 'panel-note', formatDtg(new Date(track.observed_at).getTime())),
          el('span', 'panel-note', formatMgrs(track.lon, track.lat)),
        );
        button.addEventListener('click', () => {
          selectedTrackId = track.id;
          selectedReportId = null;
          focusPoint(track);
          renderSidebar();
        });
        item.append(button);
        list.append(item);
      });
      groupEl.append(list);
      section.append(groupEl);
    });
    container.append(section);
  }

  // -- track detail: history, linked reports, edit, delete ------------------------

  function renderTrackEditForm(container, track) {
    const form = el('div', 'situation-track-edit inline-form');
    const designationInput = document.createElement('input');
    designationInput.type = 'text';
    designationInput.value = track.designation || '';
    designationInput.setAttribute('aria-label', 'Designation');
    const statusSelect = document.createElement('select');
    statusSelect.setAttribute('aria-label', 'Status');
    TRACK_STATUSES.forEach((status) =>
      statusSelect.append(new Option(TRACK_STATUS_LABEL[status], status, status === track.status, status === track.status)),
    );
    let sidc = track.sidc;
    const sidcPreview = el('span', 'report-sidc-preview');
    const renderSidc = () => sidcPreview.replaceChildren(symbolElement(sidc, { size: 24 }, 'Track symbol'));
    renderSidc();
    const sidcButton = el('button', 'chip-button', 'Symbol\u2026');
    sidcButton.type = 'button';
    sidcButton.addEventListener('click', async () => {
      const picked = await openSymbolPicker({ initial: sidc, title: 'Track symbol' });
      if (picked) {
        sidc = picked;
        renderSidc();
      }
    });
    const notesInput = document.createElement('textarea');
    notesInput.rows = 2;
    notesInput.value = track.notes || '';
    notesInput.placeholder = 'Notes';
    notesInput.setAttribute('aria-label', 'Notes');

    const saveButton = el('button', 'primary-button', 'Save');
    saveButton.type = 'button';
    saveButton.addEventListener('click', async () => {
      try {
        await requestJson(`${api}/tracks/${track.id}`, {
          method: 'PATCH',
          body: {
            designation: designationInput.value.trim() || null,
            status: statusSelect.value,
            sidc,
            notes: notesInput.value.trim() || null,
          },
        });
        editingTrackId = null;
        await load();
        updateMapData();
        renderSidebar();
      } catch (error) {
        showError(form, error.message);
      }
    });
    const cancelButton = el('button', 'text-button', 'Cancel');
    cancelButton.type = 'button';
    cancelButton.addEventListener('click', () => {
      editingTrackId = null;
      renderSidebar();
    });
    form.append(designationInput, statusSelect, sidcPreview, sidcButton, notesInput, saveButton, cancelButton);
    container.append(form);
  }

  async function deleteTrack(track) {
    if (!(await askConfirm(`Delete track ${track.designation || track.sidc}? This removes its history.`))) return;
    await requestJson(`${api}/tracks/${track.id}`, { method: 'DELETE' });
    selectedTrackId = null;
    await load();
    updateMapData();
    renderSidebar();
  }

  async function releaseTrack(track, cells) {
    await requestJson(`${api}/tracks/${track.id}/release`, { method: 'POST', body: { cells } });
    await load();
    renderSidebar();
  }

  async function reassignTrackOwner(track, ownerCell) {
    await requestJson(`${api}/tracks/${track.id}/owner`, { method: 'PATCH', body: { owner_cell: ownerCell } });
    await load();
    renderSidebar();
  }

  function renderTrackDetail(container) {
    const track = data.tracks.find((entry) => entry.id === selectedTrackId);
    if (!track) return;
    const card = el('div', 'situation-detail-card field-group');
    const header = el('div', 'panel-header-row');
    header.append(el('h3', null, track.designation || track.sidc));
    const closeButton = el('button', 'text-button', 'Close');
    closeButton.type = 'button';
    closeButton.addEventListener('click', () => {
      selectedTrackId = null;
      renderSidebar();
    });
    header.append(closeButton);
    card.append(header);
    card.append(renderCellBadge(track.owner_cell));
    card.append(
      renderReleaseControl({
        item: track,
        onRelease: (cells) => releaseTrack(track, cells),
      }),
    );
    appendOwnerReassign(card, track.owner_cell, (ownerCell) => reassignTrackOwner(track, ownerCell));
    card.append(
      symbolElement(
        track.sidc,
        { size: 32, designation: track.designation, dtg: formatDtg(new Date(track.observed_at).getTime()) },
        'Track symbol',
      ),
    );
    card.append(
      el(
        'p',
        'panel-note',
        `${TRACK_STATUS_LABEL[track.status]} \u00b7 Last: ${formatDtg(new Date(track.observed_at).getTime())} \u00b7 ${formatMgrs(track.lon, track.lat)}`,
      ),
    );
    if (track.notes) card.append(el('p', null, track.notes));

    card.append(el('h4', null, 'History'));
    const table = document.createElement('table');
    table.className = 'data-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['DTG', 'MGRS', 'Report'].forEach((label) => headRow.append(el('th', null, label)));
    thead.append(headRow);
    table.append(thead);
    const tbody = document.createElement('tbody');
    [...track.history].reverse().forEach((position) => {
      const row = document.createElement('tr');
      row.append(
        el('td', null, formatDtg(new Date(position.observed_at).getTime())),
        el('td', null, formatMgrs(position.lon, position.lat)),
        el('td', null, position.report_id ? `#${position.report_id}` : '\u2014'),
      );
      tbody.append(row);
    });
    table.append(tbody);
    card.append(table);

    const linkedReports = data.reports.filter((report) => report.track_id === track.id);
    if (linkedReports.length) {
      card.append(el('h4', null, 'Linked reports'));
      const list = el('ul', 'situation-linked-reports');
      linkedReports.forEach((report) => {
        const item = document.createElement('li');
        const at = formatDtg(new Date(report.occurred_at || report.created_at).getTime());
        const button = el('button', 'text-button', `${at} \u2014 ${report.text.slice(0, 60)}`);
        button.type = 'button';
        button.addEventListener('click', () => ctx.switchTab?.('reports'));
        item.append(button);
        list.append(item);
      });
      card.append(list);
    }

    // C2b: release grants read only, so Edit/Delete need canEditClient on
    // top of the analyst role — a cell this track was only released to
    // still sees its detail card, but never these controls.
    if (can('analyst') && canEditClient(track)) {
      if (editingTrackId === track.id) {
        renderTrackEditForm(card, track);
      } else {
        const actions = el('div', 'inline-form');
        const editButton = el('button', 'chip-button', 'Edit');
        editButton.type = 'button';
        editButton.addEventListener('click', () => {
          editingTrackId = track.id;
          renderSidebar();
        });
        const deleteButton = el('button', 'chip-button danger', 'Delete');
        deleteButton.type = 'button';
        deleteButton.addEventListener('click', () => deleteTrack(track));
        actions.append(editButton, deleteButton);
        card.append(actions);
      }
    }
    container.append(card);
  }

  function renderReportDetail(container) {
    const report = data.reports.find((entry) => entry.id === selectedReportId);
    if (!report) return;
    const card = el('div', 'situation-detail-card field-group');
    const header = el('div', 'panel-header-row');
    header.append(el('h3', null, `${report.report_type.toUpperCase()} \u00b7 ${report.reliability}${report.credibility}`));
    const closeButton = el('button', 'text-button', 'Close');
    closeButton.type = 'button';
    closeButton.addEventListener('click', () => {
      selectedReportId = null;
      renderSidebar();
    });
    header.append(closeButton);
    card.append(header);
    card.append(el('p', null, report.text));
    card.append(
      el(
        'p',
        'panel-note',
        `${formatDtg(new Date(report.occurred_at || report.created_at).getTime())} \u00b7 ${formatMgrs(report.lon, report.lat)}`,
      ),
    );
    const link = el('button', 'chip-button', 'Open in Reports tab');
    link.type = 'button';
    link.addEventListener('click', () => ctx.switchTab?.('reports'));
    card.append(link);
    container.append(card);
  }

  function renderSidebar() {
    if (!sidebar) return;
    sidebar.replaceChildren();
    renderTimeFilter(sidebar);
    renderAddTrack(sidebar);
    if (selectedTrackId != null) renderTrackDetail(sidebar);
    if (selectedReportId != null) renderReportDetail(sidebar);
    renderTrackList(sidebar);
  }

  // -- mount ------------------------------------------------------------------

  async function enter(container) {
    panel = container;
    panel.replaceChildren(el('p', 'panel-note', 'Loading situation\u2026'));
    try {
      await load();
    } catch (error) {
      if (error.name === 'AbortError') return;
      panel.replaceChildren(el('p', 'inline-error', error.message));
      return;
    }

    panel.replaceChildren();
    const layout = el('div', 'situation-layout');
    const mapWrap = el('div', 'situation-map-wrap');
    const mapTarget = el('div', 'situation-map-target');
    const mapChrome = el('div', 'situation-map-chrome');
    basemapSwitchEl = el('div', 'basemap-switch');
    basemapSwitchEl.setAttribute('role', 'radiogroup');
    basemapSwitchEl.setAttribute('aria-label', 'Basemap');
    mapChrome.append(basemapSwitchEl);
    mapWrap.append(mapTarget, mapChrome);
    sidebar = el('aside', 'situation-sidebar');
    layout.append(mapWrap, sidebar);
    panel.append(layout);

    map = createMap({
      target: mapTarget,
      basemapUrl: `${TERRAIN_API}/tiles/vector.pmtiles`,
      center: CZECHIA_CENTER,
      zoom: CZECHIA_ZOOM,
    });
    renderBasemapSwitch();
    updateMapData();
    renderSidebar();

    try {
      terrainMeta = await requestJson(`${TERRAIN_API}/meta`);
      applyBasemap(basemapId);
    } catch {
      // The vector basemap already renders without terrain meta.
    }
    try {
      const { scenario } = await requestJson(`${API}/scenario/active`);
      map.setScenario(scenario);
    } catch {
      // The situation still shows without a scenario overlay.
    }

    unsubscribe = subscribe(
      (event) => event.module === 'exercise',
      () => {
        load()
          .then(() => {
            updateMapData();
            renderSidebar();
          })
          .catch(() => {});
      },
    );
  }

  function leave() {
    unsubscribe?.();
    unsubscribe = null;
    addTrackField?.destroy();
    addTrackField = null;
    map?.destroy();
    map = null;
    sidebar = null;
    basemapSwitchEl = null;
    panel = null;
    selectedTrackId = null;
    selectedReportId = null;
    addingTrack = false;
    editingTrackId = null;
  }

  return { enter, leave };
}
