/**
 * Map tools toolbar: measure (distance/area/bearing), the tactical graphics
 * palette, and range rings (manual or from a weapon's WEG card). Mounted
 * once near the map's own controls; one active tool at a time, Escape
 * cancels (the host view routes Escape/step-switch through
 * `cancelActiveTool()`, and draw/click completion through
 * `handleDraw`/`handleClick` — see `initMapToolbar`'s return value).
 *
 * Pure helpers (`parseRadiiInput`, `rangeRingsFromEntries`,
 * `defaultAffiliationFor`, `formatMeasureReadout`) are exported for tests;
 * everything else is DOM/map wiring.
 */
import './tools.css';

import { parseCoordinate } from '../../../src/geo.js';
import { TACTICAL_GRAPHICS, graphicColor } from '../../../src/tactical.js';

/** 16px line icons for the status-bar tool buttons (currentColor, decorative). */
const TOOL_ICONS = {
  measure:
    '<svg class="status-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 11.5 11.5 2 14 4.5 4.5 14z"/><path d="M5 10.5l1 1M7 8.5l1.5 1.5M9 6.5l1 1M11 4.5l1.5 1.5"/></svg>',
  graphics:
    '<svg class="status-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 13.5 10 6"/><path d="M6.5 5.5H10.5V9.5"/><path d="M2.5 3h6"/></svg>',
  'range-ring':
    '<svg class="status-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><circle cx="8" cy="8" r="3.2"/><circle cx="8" cy="8" r="0.7"/></svg>',
};
const API = '/api/ipb';
const EQUIPMENT_API = '/api/equipment';

/** Palette grouping, in print/UI order. */
export const GRAPHIC_GROUPS = [
  {
    label: 'Control measures',
    keys: ['phase-line', 'boundary', 'axis-of-advance', 'direction-of-attack'],
  },
  { label: 'Areas', keys: ['objective', 'assembly-area', 'battle-position', 'engagement-area'] },
  { label: 'Obstacles', keys: ['minefield', 'obstacle-line', 'block', 'fix', 'turn', 'disrupt'] },
];

/** Mirrors `src/symbols/sidc.js`'s `AMPLIFIER_BY_ECHELON_NAME` keys — the
 * app's one echelon-name convention, smallest first. */
export const ECHELON_NAMES = [
  'team',
  'squad',
  'section',
  'platoon',
  'company',
  'battalion',
  'regiment',
  'brigade',
  'division',
  'corps',
  'army',
];

export const AFFILIATIONS = ['friendly', 'hostile', 'neutral', 'unknown', 'none'];

export const MEASURE_MODES = [
  { id: 'distance', label: 'Distance' },
  { id: 'area', label: 'Area' },
  { id: 'bearing', label: 'Bearing' },
];

const MAX_RING_RADII = 8;
const MAX_RING_METRES = 100_000;

/** A drawn graphic's default affiliation: hostile inside a selected COA
 * (step 4's SITEMP is the enemy's), friendly otherwise. */
export function defaultAffiliationFor(selectedCoaId) {
  return selectedCoaId ? 'hostile' : 'friendly';
}

/** "1.85 km" text for a live measure readout, copyable as-is. */
export function formatMeasureReadout(payload) {
  if (!payload) return '';
  if (payload.mode === 'distance') {
    if (!payload.segments.length) return '';
    return payload.segments.length > 1
      ? `${payload.segments.map((segment) => segment.label).join(' + ')} = Σ ${payload.totalLabel}`
      : payload.totalLabel;
  }
  if (payload.mode === 'area') {
    return `${payload.areaLabel} · perimeter ${payload.perimeterLabel}`;
  }
  if (payload.mode === 'bearing') {
    if (!Number.isFinite(payload.degrees)) return '';
    return `${payload.degreesLabel}° (${payload.milsLabel} mils) · ${payload.distanceLabel}`;
  }
  return '';
}

const RADIUS_TOKEN = /^(\d+(?:\.\d+)?)\s*(km|m)?$/i;

/**
 * A comma list like `"2km, 750m, 5"` (bare numbers default to km, the usual
 * unit for weapon/observation ranges) → ascending, de-duplicated metres, or
 * `{ error }`. Mirrors the server's own range-ring limits (1–8 rings, each
 * at most 100 km) so a bad entry is caught before the request.
 */
export function parseRadiiInput(text) {
  const parts = String(text ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return { error: 'Enter at least one radius.' };
  const metres = [];
  for (const part of parts) {
    const match = RADIUS_TOKEN.exec(part);
    if (!match) return { error: `Could not read "${part}" — try e.g. "2km" or "500m".` };
    const value = Number(match[1]);
    const unit = (match[2] || 'km').toLowerCase();
    const asMetres = unit === 'km' ? value * 1000 : value;
    if (!(asMetres > 0)) return { error: `"${part}" must be a positive number.` };
    metres.push(Math.round(asMetres));
  }
  const radii = [...new Set(metres)].sort((a, b) => a - b);
  if (radii.length !== metres.length) return { error: 'Radii must be distinct.' };
  if (radii.length > MAX_RING_RADII) return { error: `At most ${MAX_RING_RADII} radii.` };
  if (radii.some((value) => value > MAX_RING_METRES)) {
    return { error: `Radii must be at most ${MAX_RING_METRES / 1000} km.` };
  }
  return { radii };
}

const RANGE_KIND_ABBR = {
  effective: 'eff',
  maximum: 'max',
  minimum: 'min',
  sight: 'sight',
  other: '',
};

/**
 * Selected WEG card range entries (`{ kind, min_m, max_m }`, from `GET
 * /api/equipment/cards/:id/ranges`) → `{ radii, ringLabels }`: one ring per
 * entry's max range (falling back to min when max is missing), ascending,
 * de-duplicated by rounded metres, labelled e.g. "2A46M eff 3.0 km".
 */
export function rangeRingsFromEntries(entries, systemName) {
  const withRadius = (entries ?? [])
    .map((entry) => ({
      ...entry,
      radius: Number.isFinite(entry.max_m) ? entry.max_m : entry.min_m,
    }))
    .filter((entry) => Number.isFinite(entry.radius) && entry.radius > 0);
  const byRadius = new Map();
  for (const entry of withRadius) {
    const key = Math.round(entry.radius);
    if (!byRadius.has(key)) byRadius.set(key, entry);
  }
  const sorted = [...byRadius.entries()].sort((a, b) => a[0] - b[0]).slice(0, MAX_RING_RADII);
  const radii = sorted.map(([radius]) => radius);
  const ringLabels = sorted.map(([radius, entry]) => {
    const abbr = RANGE_KIND_ABBR[entry.kind] ?? entry.kind;
    const km =
      radius >= 10_000 ? `${Math.round(radius / 1000)} km` : `${(radius / 1000).toFixed(1)} km`;
    return [systemName, abbr, km].filter(Boolean).join(' ');
  });
  return { radii, ringLabels };
}

// -- DOM: the toolbar ---------------------------------------------------------

function iconButtonRow(createElement, entries) {
  const row = createElement('div', 'graphic-key-grid');
  entries.forEach(({ label, onClick, pressed, title }) => {
    const button = createElement('button', 'chip-button', label);
    button.type = 'button';
    if (title) button.title = title;
    if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed));
    button.addEventListener('click', onClick);
    row.append(button);
  });
  return row;
}

/**
 * Mounts the toolbar into `root` (an element near the map's own controls).
 * `mapController` is the one from `createMap`; `can` is `() => boolean`
 * (analyst or above); `getStudy`/`getStudyId`/`getSelectedCoaId` are live
 * getters; `onFeaturesChanged(feature)` is told every created/updated/
 * deleted feature so the host can resync the map and worksheets.
 *
 * Returns `{ handleDraw, handleClick, cancelActiveTool, destroy }`: the host
 * view's `onMapDraw`/`onMapClick`/`cancelActiveTool` each call the matching
 * method first and only fall through to their own handling when it returns
 * falsy (unclaimed).
 */
export function initMapToolbar({
  root,
  mapController,
  requestJson,
  createElement,
  showError,
  can,
  getStudy,
  getStudyId,
  getSelectedCoaId,
  onFeaturesChanged,
}) {
  root.replaceChildren();
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', 'Map tools');

  /** `{ type: 'measure', mode } | { type: 'draw-graphic', ... } | { type: 'place-range-ring', ... } | null` */
  let activeTool = null;
  let openPanel = null; // 'measure' | 'graphics' | 'range-ring' | null
  let measureResult = null;

  const row = createElement('div', 'map-tools-row');
  const panelHost = createElement('div', 'map-tool-panel-host');
  root.append(row, panelHost);

  const toggleButtons = {};

  function updateToggleButtons() {
    for (const [name, button] of Object.entries(toggleButtons)) {
      button.setAttribute('aria-pressed', String(openPanel === name));
    }
  }

  function stopMapInteraction() {
    if (activeTool?.type === 'measure') mapController.stopMeasure();
    else if (activeTool) mapController.cancelDraw();
    activeTool = null;
    measureResult = null;
  }

  function cancelActiveTool() {
    if (!activeTool && !openPanel) return;
    stopMapInteraction();
    openPanel = null;
    updateToggleButtons();
    renderPanel();
  }

  function setOpenPanel(name) {
    if (openPanel === name) {
      cancelActiveTool();
      return;
    }
    stopMapInteraction();
    openPanel = name;
    updateToggleButtons();
    renderPanel();
  }

  // -- Measure ----------------------------------------------------------------

  function renderMeasurePanel() {
    const panel = createElement('div', 'map-tool-panel');
    panel.append(createElement('h4', null, 'Measure'));
    panel.append(
      iconButtonRow(
        createElement,
        MEASURE_MODES.map((mode) => ({
          label: mode.label,
          pressed: activeTool?.type === 'measure' && activeTool.mode === mode.id,
          onClick: () => startMeasure(mode.id),
        })),
      ),
    );
    if (activeTool?.type === 'measure') {
      const readout = createElement('div', 'measure-readout');
      const output = document.createElement('output');
      output.textContent = formatMeasureReadout(measureResult) || 'Click the map to start.';
      const copy = createElement('button', 'icon-button', 'Copy');
      copy.type = 'button';
      copy.disabled = !measureResult;
      copy.addEventListener('click', async () => {
        const text = formatMeasureReadout(measureResult);
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Clipboard permission denied or unavailable: the readout stays selectable text.
        }
      });
      readout.append(output, copy);
      panel.append(readout);
      panel.append(
        createElement(
          'p',
          'tool-hint',
          'Double-click (distance/area) or click twice (bearing) to finish; Escape cancels.',
        ),
      );
    }
    return panel;
  }

  function startMeasure(mode) {
    activeTool = { type: 'measure', mode };
    measureResult = null;
    mapController.startMeasure({
      mode,
      onResult: (payload) => {
        measureResult = payload;
        if (openPanel === 'measure') renderPanel();
      },
    });
    renderPanel();
  }

  // -- Graphics -----------------------------------------------------------------

  const graphicForm = {
    graphic: 'phase-line',
    name: '',
    affiliation: defaultAffiliationFor(getSelectedCoaId()),
    echelon: 'battalion',
    widthM: 1000,
    associateCoa: Boolean(getSelectedCoaId()),
  };

  function renderGraphicsPanel() {
    const panel = createElement('div', 'map-tool-panel');
    panel.append(createElement('h4', null, 'Tactical graphics'));
    if (!can()) {
      panel.append(createElement('p', 'panel-note', 'Read-only: your role cannot add graphics.'));
      return panel;
    }
    if (!getStudyId()) {
      panel.append(createElement('p', 'panel-note', 'Open a study first.'));
      return panel;
    }

    for (const group of GRAPHIC_GROUPS) {
      panel.append(createElement('p', 'graphic-group-label', group.label));
      panel.append(
        iconButtonRow(
          createElement,
          group.keys.map((key) => ({
            label: TACTICAL_GRAPHICS[key].label,
            pressed: activeTool?.type === 'draw-graphic' && activeTool.graphic === key,
            title: `Colour: ${graphicColor(graphicForm.affiliation, false)}`,
            onClick: () => armGraphicDraw(key),
          })),
        ),
      );
    }

    const nameLabel = createElement('label', 'inline-field');
    nameLabel.append(createElement('span', null, 'Name'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = graphicForm.name;
    nameInput.placeholder = 'e.g. PL WHISKEY';
    nameInput.addEventListener('input', () => {
      graphicForm.name = nameInput.value;
    });
    nameLabel.append(nameInput);
    panel.append(nameLabel);

    const affiliationLabel = createElement('label', 'inline-field');
    affiliationLabel.append(createElement('span', null, 'Affiliation'));
    const affiliationSelect = document.createElement('select');
    AFFILIATIONS.forEach((value) =>
      affiliationSelect.append(new Option(value, value, false, value === graphicForm.affiliation)),
    );
    affiliationSelect.addEventListener('change', () => {
      graphicForm.affiliation = affiliationSelect.value;
    });
    affiliationLabel.append(affiliationSelect);
    panel.append(affiliationLabel);

    if (graphicForm.graphic === 'boundary') {
      const echelonLabel = createElement('label', 'inline-field');
      echelonLabel.append(createElement('span', null, 'Echelon'));
      const echelonSelect = document.createElement('select');
      ECHELON_NAMES.forEach((name) =>
        echelonSelect.append(new Option(name, name, false, name === graphicForm.echelon)),
      );
      echelonSelect.addEventListener('change', () => {
        graphicForm.echelon = echelonSelect.value;
      });
      echelonLabel.append(echelonSelect);
      panel.append(echelonLabel);
    }

    if (graphicForm.graphic === 'axis-of-advance') {
      const widthLabel = createElement('label', 'inline-field');
      widthLabel.append(createElement('span', null, 'Corridor width (m)'));
      const widthInput = document.createElement('input');
      widthInput.type = 'number';
      widthInput.min = '100';
      widthInput.max = '20000';
      widthInput.value = String(graphicForm.widthM);
      widthInput.addEventListener('change', () => {
        const value = Number(widthInput.value);
        if (Number.isFinite(value) && value > 0) graphicForm.widthM = value;
      });
      widthLabel.append(widthInput);
      panel.append(widthLabel);
    }

    if (getSelectedCoaId()) {
      const coaLabel = document.createElement('label');
      coaLabel.className = 'inline-field';
      const coaCheckbox = document.createElement('input');
      coaCheckbox.type = 'checkbox';
      coaCheckbox.checked = graphicForm.associateCoa;
      coaCheckbox.addEventListener('change', () => {
        graphicForm.associateCoa = coaCheckbox.checked;
      });
      coaLabel.append(coaCheckbox, createElement('span', null, ' Associate with the selected COA'));
      panel.append(coaLabel);
    }

    if (activeTool?.type === 'draw-graphic') {
      panel.append(
        createElement(
          'p',
          'tool-hint',
          `Draw the ${TACTICAL_GRAPHICS[activeTool.graphic].geometry === 'polygon' ? 'area' : 'line'} on the map. Escape cancels.`,
        ),
      );
    } else {
      panel.append(createElement('p', 'tool-hint', 'Pick a graphic above to start drawing.'));
    }
    return panel;
  }

  function armGraphicDraw(key) {
    if (activeTool?.type === 'draw-graphic' && activeTool.graphic === key) {
      cancelActiveTool();
      return;
    }
    stopMapInteraction();
    graphicForm.graphic = key;
    const entry = TACTICAL_GRAPHICS[key];
    const geometryKind = entry.geometry === 'polygon' ? 'polygon' : 'line';
    activeTool = {
      type: 'draw-graphic',
      graphic: key,
      geometryKind,
      name: graphicForm.name,
      affiliation: graphicForm.affiliation,
      echelon: key === 'boundary' ? graphicForm.echelon : undefined,
      widthM: key === 'axis-of-advance' ? graphicForm.widthM : undefined,
      coaId: graphicForm.associateCoa ? getSelectedCoaId() : undefined,
    };
    mapController.startDraw(geometryKind, {
      graphic: key,
      affiliation: graphicForm.affiliation,
      name: graphicForm.name,
    });
    renderPanel();
  }

  /** Claims a finished draw started by `armGraphicDraw`; false lets the host's own draw handling run. */
  function handleDraw({ geometry }) {
    if (!activeTool || activeTool.type !== 'draw-graphic') return false;
    const tool = activeTool;
    activeTool = null;
    renderPanel();
    createGraphicFeature(tool, geometry);
    return true;
  }

  async function createGraphicFeature(tool, geometry) {
    const studyId = getStudyId();
    if (!studyId) return;
    const properties = { graphic: tool.graphic, name: tool.name, affiliation: tool.affiliation };
    if (tool.echelon) properties.echelon = tool.echelon;
    if (tool.widthM) properties.width_m = tool.widthM;
    if (tool.coaId) properties.coa_id = tool.coaId;
    try {
      const feature = await requestJson(`${API}/studies/${studyId}/features`, {
        method: 'POST',
        body: { layer: 'graphic', kind: 'graphic', label: tool.name, geometry, properties },
      });
      getStudy()?.features.push(feature);
      onFeaturesChanged(feature);
    } catch (error) {
      if (error.name !== 'AbortError') showError(panelHost, error.message);
    }
  }

  // -- Range rings ----------------------------------------------------------------

  const ringForm = {
    source: 'manual',
    radiiText: '',
    name: '',
    affiliation: 'hostile',
    center: '',
    searchQuery: '',
    searchResults: [],
    selectedCardId: null,
    selectedCardLabel: '',
    rangeEntries: [],
    selectedRangeIndexes: new Set(),
  };

  async function searchWegCards() {
    const query = ringForm.searchQuery.trim();
    if (!query) {
      ringForm.searchResults = [];
      renderPanel();
      return;
    }
    try {
      const result = await requestJson(
        `${EQUIPMENT_API}/cards?${new URLSearchParams({ q: query, limit: '15' })}`,
      );
      ringForm.searchResults = result.items;
    } catch (error) {
      if (error.name !== 'AbortError') showError(panelHost, error.message);
      ringForm.searchResults = [];
    }
    renderPanel();
  }

  async function loadRanges(identifier, label) {
    ringForm.selectedCardId = identifier;
    ringForm.selectedCardLabel = label;
    ringForm.rangeEntries = [];
    ringForm.selectedRangeIndexes = new Set();
    renderPanel();
    try {
      ringForm.rangeEntries = await requestJson(
        `${EQUIPMENT_API}/cards/${encodeURIComponent(identifier)}/ranges`,
      );
    } catch (error) {
      if (error.name !== 'AbortError') showError(panelHost, error.message);
    }
    renderPanel();
  }

  function applySelectedRanges() {
    const chosen = ringForm.rangeEntries.filter((_entry, index) =>
      ringForm.selectedRangeIndexes.has(index),
    );
    const { radii, ringLabels } = rangeRingsFromEntries(chosen, ringForm.selectedCardLabel);
    if (!radii.length) return;
    ringForm.radiiText = radii
      .map((metres) => (metres >= 10_000 ? `${metres / 1000}km` : `${metres}m`))
      .join(', ');
    ringForm.ringLabels = ringLabels;
    ringForm.source = 'manual';
    renderPanel();
  }

  function renderRangeRingPanel() {
    const panel = createElement('div', 'map-tool-panel');
    panel.append(createElement('h4', null, 'Range rings'));
    if (!can()) {
      panel.append(
        createElement('p', 'panel-note', 'Read-only: your role cannot add range rings.'),
      );
      return panel;
    }
    if (!getStudyId()) {
      panel.append(createElement('p', 'panel-note', 'Open a study first.'));
      return panel;
    }

    const nameLabel = createElement('label', 'inline-field');
    nameLabel.append(createElement('span', null, 'Name'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = ringForm.name;
    nameInput.placeholder = 'e.g. 2A46M battery';
    nameInput.addEventListener('input', () => {
      ringForm.name = nameInput.value;
    });
    nameLabel.append(nameInput);
    panel.append(nameLabel);

    const affiliationLabel = createElement('label', 'inline-field');
    affiliationLabel.append(createElement('span', null, 'Affiliation'));
    const affiliationSelect = document.createElement('select');
    AFFILIATIONS.forEach((value) =>
      affiliationSelect.append(new Option(value, value, false, value === ringForm.affiliation)),
    );
    affiliationSelect.addEventListener('change', () => {
      ringForm.affiliation = affiliationSelect.value;
    });
    affiliationLabel.append(affiliationSelect);
    panel.append(affiliationLabel);

    const radiiLabel = createElement('label', 'inline-field');
    radiiLabel.append(createElement('span', null, 'Radii (km/m, comma list)'));
    const radiiInput = document.createElement('input');
    radiiInput.type = 'text';
    radiiInput.value = ringForm.radiiText;
    radiiInput.placeholder = 'e.g. 2km, 5km, 8km';
    radiiInput.addEventListener('input', () => {
      ringForm.radiiText = radiiInput.value;
    });
    radiiLabel.append(radiiInput);
    panel.append(radiiLabel);

    const fromWeapon = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'From weapon';
    fromWeapon.append(summary);

    const study = getStudy();
    const threats = (study?.threats ?? []).filter((threat) => threat.equipment_identifier);
    if (threats.length) {
      fromWeapon.append(createElement('p', 'graphic-group-label', 'From a threat'));
      const threatSelect = document.createElement('select');
      threatSelect.append(new Option('Choose a threat…', ''));
      threats.forEach((threat) =>
        threatSelect.append(new Option(threat.name, threat.equipment_identifier)),
      );
      threatSelect.addEventListener('change', () => {
        if (threatSelect.value)
          loadRanges(
            threatSelect.value,
            threats.find((t) => t.equipment_identifier === threatSelect.value)?.name ??
              threatSelect.value,
          );
      });
      fromWeapon.append(threatSelect);
    }

    fromWeapon.append(createElement('p', 'graphic-group-label', 'Search a WEG card'));
    const searchRow = createElement('div', 'inline-form');
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.value = ringForm.searchQuery;
    searchInput.placeholder = 'System name…';
    searchInput.addEventListener('input', () => {
      ringForm.searchQuery = searchInput.value;
    });
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') searchWegCards();
    });
    const searchButton = createElement('button', 'chip-button', 'Search');
    searchButton.type = 'button';
    searchButton.addEventListener('click', searchWegCards);
    searchRow.append(searchInput, searchButton);
    fromWeapon.append(searchRow);
    if (ringForm.searchResults.length) {
      const results = createElement('ul', 'graphics-list');
      ringForm.searchResults.forEach((item) => {
        const row = createElement('li', 'graphic-row');
        const button = createElement('button', 'text-button', item.display_name || item.name);
        button.type = 'button';
        button.addEventListener('click', () =>
          loadRanges(item.identifier, item.display_name || item.name),
        );
        row.append(button);
        results.append(row);
      });
      fromWeapon.append(results);
    }

    if (ringForm.selectedCardId) {
      fromWeapon.append(
        createElement('p', 'graphic-group-label', `Ranges — ${ringForm.selectedCardLabel}`),
      );
      if (!ringForm.rangeEntries.length) {
        fromWeapon.append(
          createElement('p', 'panel-note', 'No weapon ranges parsed for this card.'),
        );
      } else {
        const list = createElement('ul', 'graphics-list');
        ringForm.rangeEntries.forEach((entry, index) => {
          const row = createElement('li', 'graphic-row');
          const label = document.createElement('label');
          label.className = 'inline-field inline-field-row';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = ringForm.selectedRangeIndexes.has(index);
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) ringForm.selectedRangeIndexes.add(index);
            else ringForm.selectedRangeIndexes.delete(index);
          });
          const max = Number.isFinite(entry.max_m) ? `${Math.round(entry.max_m)} m` : '—';
          const min = Number.isFinite(entry.min_m) ? `${Math.round(entry.min_m)} m` : '—';
          label.append(
            checkbox,
            createElement('span', null, ` ${entry.system} — ${entry.kind}: ${min}–${max}`),
          );
          row.append(label);
          list.append(row);
        });
        fromWeapon.append(list);
        const useButton = createElement('button', 'chip-button', 'Use selected ranges');
        useButton.type = 'button';
        useButton.addEventListener('click', applySelectedRanges);
        fromWeapon.append(useButton);
      }
    }
    panel.append(fromWeapon);

    const centerLabel = createElement('label', 'inline-field');
    centerLabel.append(createElement('span', null, 'Centre (MGRS/UTM/DD)'));
    const centerInput = document.createElement('input');
    centerInput.type = 'text';
    centerInput.value = ringForm.center;
    centerInput.addEventListener('input', () => {
      ringForm.center = centerInput.value;
    });
    centerLabel.append(centerInput);
    panel.append(centerLabel);

    const actions = createElement('div', 'map-tools-row');
    const placeTyped = createElement('button', 'primary-button', 'Place at typed centre');
    placeTyped.type = 'button';
    placeTyped.addEventListener('click', () => placeRangeRingFromInput());
    const pickButton = createElement(
      'button',
      'chip-button',
      activeTool?.type === 'place-range-ring' ? 'Click the map…' : 'Pick centre on map',
    );
    pickButton.type = 'button';
    pickButton.setAttribute('aria-pressed', String(activeTool?.type === 'place-range-ring'));
    pickButton.addEventListener('click', () => armRangeRingPick());
    actions.append(placeTyped, pickButton);
    panel.append(actions);

    return panel;
  }

  function readRingFormOrShowError() {
    const parsed = parseRadiiInput(ringForm.radiiText);
    if (parsed.error) {
      showError(panelHost, parsed.error);
      return null;
    }
    if (!ringForm.name.trim()) {
      showError(panelHost, 'A name is required.');
      return null;
    }
    return {
      radii: parsed.radii,
      ringLabels:
        ringForm.ringLabels?.length === parsed.radii.length ? ringForm.ringLabels : undefined,
      affiliation: ringForm.affiliation,
      name: ringForm.name,
    };
  }

  function placeRangeRingFromInput() {
    const values = readRingFormOrShowError();
    if (!values) return;
    const parsed = parseCoordinate(ringForm.center.trim());
    if (!parsed) {
      showError(panelHost, 'Could not read that centre position.');
      return;
    }
    createRangeRingFeature(values, parsed.lon, parsed.lat);
  }

  function armRangeRingPick() {
    if (activeTool?.type === 'place-range-ring') {
      cancelActiveTool();
      return;
    }
    const values = readRingFormOrShowError();
    if (!values) return;
    stopMapInteraction();
    activeTool = { type: 'place-range-ring', ...values };
    renderPanel();
  }

  /** Claims a map click started by `armRangeRingPick`; false lets the host's own click handling run. */
  function handleClick({ lon, lat }) {
    if (!activeTool || activeTool.type !== 'place-range-ring') return false;
    const tool = activeTool;
    activeTool = null;
    renderPanel();
    createRangeRingFeature(tool, lon, lat);
    return true;
  }

  async function createRangeRingFeature(values, lon, lat) {
    const studyId = getStudyId();
    if (!studyId) return;
    try {
      const feature = await requestJson(`${API}/studies/${studyId}/features`, {
        method: 'POST',
        body: {
          layer: 'range-ring',
          kind: 'range-ring',
          label: values.name,
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: {
            radii: values.radii,
            ringLabels: values.ringLabels,
            affiliation: values.affiliation,
            name: values.name,
          },
        },
      });
      getStudy()?.features.push(feature);
      onFeaturesChanged(feature);
    } catch (error) {
      if (error.name !== 'AbortError') showError(panelHost, error.message);
    }
  }

  // -- Wiring ---------------------------------------------------------------------

  function renderPanel() {
    panelHost.replaceChildren();
    if (openPanel === 'measure') panelHost.append(renderMeasurePanel());
    else if (openPanel === 'graphics') panelHost.append(renderGraphicsPanel());
    else if (openPanel === 'range-ring') panelHost.append(renderRangeRingPanel());
    panelHost.hidden = !openPanel;
  }

  // Icon plus word in the status bar; the word collapses (tools.css container
  // query) when the bar is squeezed between both open sheets, and then the
  // title and the visually hidden word still name the button.
  for (const [name, label, title] of [
    ['measure', 'Measure', 'Measure distance, area or bearing'],
    ['graphics', 'Graphics', 'Tactical graphics'],
    ['range-ring', 'Rings', 'Range rings'],
  ]) {
    const button = createElement('button', 'map-tool-button');
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    button.title = title;
    button.insertAdjacentHTML('afterbegin', TOOL_ICONS[name]);
    button.append(createElement('span', 'map-tool-label', label));
    button.addEventListener('click', () => setOpenPanel(name));
    toggleButtons[name] = button;
    row.append(button);
  }
  renderPanel();

  return {
    handleDraw,
    handleClick,
    cancelActiveTool,
    /** Called after the host's own study/COA state changes, so the graphics
     * form's affiliation default and the "From a threat" list stay current. */
    refresh() {
      graphicForm.affiliation = defaultAffiliationFor(getSelectedCoaId());
      graphicForm.associateCoa = Boolean(getSelectedCoaId());
      if (openPanel) renderPanel();
    },
    destroy() {
      cancelActiveTool();
      root.replaceChildren();
    },
  };
}

// -- DOM: graphics / range-ring list (step worksheet) ---------------------------

/**
 * `graphic`/`range-ring` features as an editable list: rename, delete,
 * zoom-to. `features` is `study.features` (unfiltered; this filters to the
 * two layers itself).
 */
export function renderGraphicsAndRingsList({
  createElement,
  requestJson,
  showError,
  askText,
  askConfirm,
  can,
  mapController,
  renderRowMenu,
  features,
  onChanged,
}) {
  const container = createElement('section', 'worksheet-block');
  container.append(createElement('h4', null, 'Graphics and range rings'));

  const graphics = features.filter((feature) => feature.layer === 'graphic');
  const rings = features.filter((feature) => feature.layer === 'range-ring');

  async function renameFeature(feature) {
    const label = await askText('Rename', feature.label);
    if (!label || label === feature.label) return;
    try {
      const updated = await requestJson(
        `${API}/studies/${feature.study_id}/features/${feature.id}`,
        {
          method: 'PATCH',
          body: { label },
        },
      );
      Object.assign(feature, updated);
      onChanged();
    } catch (error) {
      if (error.name !== 'AbortError') showError(container, error.message);
    }
  }

  async function deleteFeature(feature) {
    if (!(await askConfirm(`Delete "${feature.label}"?`))) return;
    try {
      await requestJson(`${API}/studies/${feature.study_id}/features/${feature.id}`, {
        method: 'DELETE',
      });
      onChanged(feature.id);
    } catch (error) {
      if (error.name !== 'AbortError') showError(container, error.message);
    }
  }

  function renderRow(feature, detail) {
    const row = createElement('li', 'graphic-row');
    const text = createElement('button', 'graphic-row-text');
    text.type = 'button';
    text.title = 'Go to this feature';
    text.append(
      createElement('strong', null, feature.label || '(unnamed)'),
      createElement('small', null, detail),
    );
    text.addEventListener('click', () => mapController.fitFeature(feature.id));
    row.append(text);
    if (can) {
      const menu = renderRowMenu([
        { label: 'Rename', action: () => renameFeature(feature) },
        { label: 'Delete', action: () => deleteFeature(feature) },
      ]);
      if (menu) row.append(menu);
    }
    return row;
  }

  const graphicsGroup = createElement('div', 'field-group');
  graphicsGroup.append(createElement('h5', null, `Graphics (${graphics.length})`));
  if (graphics.length) {
    const list = createElement('ul', 'graphics-list');
    graphics.forEach((feature) => {
      const detail = [
        TACTICAL_GRAPHICS[feature.properties?.graphic]?.label ?? feature.properties?.graphic,
        feature.properties?.affiliation,
        feature.properties?.echelon,
      ]
        .filter(Boolean)
        .join(' · ');
      list.append(renderRow(feature, detail));
    });
    graphicsGroup.append(list);
  } else {
    graphicsGroup.append(createElement('p', 'panel-note', 'None drawn yet.'));
  }
  container.append(graphicsGroup);

  const ringsGroup = createElement('div', 'field-group');
  ringsGroup.append(createElement('h5', null, `Range rings (${rings.length})`));
  if (rings.length) {
    const list = createElement('ul', 'range-rings-list');
    rings.forEach((feature) => {
      const radii = (feature.properties?.radii ?? [])
        .map((metres) => formatMgrsRadius(metres))
        .join(', ');
      list.append(renderRow(feature, radii));
    });
    ringsGroup.append(list);
  } else {
    ringsGroup.append(createElement('p', 'panel-note', 'None placed yet.'));
  }
  container.append(ringsGroup);

  return container;
}

function formatMgrsRadius(metres) {
  return metres >= 10_000 ? `${Math.round(metres / 1000)} km` : `${metres} m`;
}
