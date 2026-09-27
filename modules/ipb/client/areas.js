/**
 * Step 1: the study's area of operations (AO) and area of interest (AOI),
 * one polygon each (`study.ao`, `study.aoi`; `src/areaPolygon.js`). Drawn on
 * the map, reshaped by dragging corners, or typed/pasted as one corner per
 * line; the worksheet lists every corner in MGRS and decimal degrees.
 * `study.bounds` follows both: the envelope around AO and AOI.
 *
 * Reaches into `./view.js`'s shared internals via its live export block,
 * like `sitemp.js`.
 */
import './areas.css';

import {
  STUDY_AREAS,
  areaCorners,
  areaFromCorners,
  areasBounds,
} from '../../../src/areaPolygon.js';
import { formatArea, formatMgrs } from '../../../src/geo.js';
import { can } from '../../../src/session.js';
import {
  CORNER_FORMATS,
  formatCorner,
  formatDegrees,
  parseCornerLines,
} from './areaCoordinates.js';
import {
  API,
  armFeatureModify,
  askConfirm,
  cancelActiveTool,
  canEditStudy,
  createElement,
  editable,
  elements,
  jumpToCoordinate,
  mapController,
  polygonAreaSquareKm,
  renderMapHint,
  renderStep1Worksheet,
  renderToolPanel,
  requestJson,
  showError,
  showToast,
  state,
  syncMapFeatures,
} from './view.js';

/** A table this long starts folded, so a hand-drawn outline doesn't bury the worksheet. */
const OPEN_TABLE_CORNERS = 20;

const byKey = Object.fromEntries(STUDY_AREAS.map((area) => [area.key, area]));

function canEdit() {
  return can('analyst') && canEditStudy();
}

export function isAreaId(id) {
  return Object.hasOwn(byKey, id);
}

/** The AO and AOI outlines for the map; their feature ids are 'ao' and 'aoi'. */
export function areaFeatures(study) {
  return STUDY_AREAS.filter(({ key }) => study[key]).map(({ key, short }) => ({
    id: key,
    layer: key,
    kind: 'polygon',
    label: short,
    geometry: study[key],
    properties: {},
  }));
}

/** Saves `geometry` (null clears it) as the study's `key` area, with the bounds around both. */
async function saveArea(key, geometry, { fit = true } = {}) {
  if (!canEdit()) return;
  const study = state.study.study;
  const next = { ...study, [key]: geometry };
  const bounds = areasBounds(STUDY_AREAS.map((area) => next[area.key]));
  try {
    const updated = await requestJson(`${API}/studies/${state.studyId}`, {
      method: 'PATCH',
      body: { [key]: geometry, bounds },
    });
    state.study.study = { ...study, ...updated };
    syncMapFeatures();
    renderStep1Worksheet();
    renderToolPanel();
    if (fit && geometry) mapController.fitExtent(areasBounds([geometry]));
  } catch (error) {
    showError(elements.toolPanel, error.message);
    syncMapFeatures();
  }
}

/** `onMapDraw` for a drawn AO/AOI; true when it was one. */
export function handleAreaDrawn(tool, geometry) {
  if (tool.type !== 'draw-area') return false;
  state.tool = null;
  renderMapHint('');
  saveArea(tool.area, geometry);
  return true;
}

/** `onMapFeatureChange` for a reshaped AO/AOI; true when it was one. Reshaping stays on until Escape. */
export function handleAreaReshaped(id, geometry) {
  if (!isAreaId(id)) return false;
  saveArea(id, geometry, { fit: false });
  return true;
}

function armAreaDraw(key) {
  if (!canEdit()) return;
  cancelActiveTool();
  const { short, name } = byKey[key];
  state.tool = { type: 'draw-area', area: key };
  mapController.startDraw('polygon', { layer: key });
  renderMapHint(
    `Draw the ${name.toLowerCase()} (${short}): click each corner and double-click the last, or hold the right mouse button and trace it. Press Escape to cancel.`,
  );
}

function armAreaReshape(key) {
  if (!state.study.study[key]) return;
  armFeatureModify({ id: key, label: byKey[key].short, layer: key });
}

async function clearArea(key) {
  if (!canEdit()) return;
  const { short } = byKey[key];
  if (!(await askConfirm(`Clear the ${short}? Its corners are deleted.`, 'Clear'))) return;
  cancelActiveTool();
  saveArea(key, null, { fit: false });
}

async function copyCorners(key, format) {
  const text = areaCorners(state.study.study[key])
    .map((corner) => formatCorner(corner, format))
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast(`Copied ${byKey[key].short} corners (${CORNER_FORMATS[format]})`);
  } catch {
    showToast('Clipboard unavailable');
  }
}

/** Right-click items for an AO/AOI outline on the map (view.js filters them by role). */
export function areaMenuItems(key) {
  return [
    { label: 'Edit coordinates…', action: () => editAreaCoordinates(key) },
    { label: 'Reshape (drag corners)', action: () => armAreaReshape(key) },
    { label: 'Copy corners (MGRS)', action: () => copyCorners(key, 'mgrs'), mutating: false },
    { label: 'Clear', action: () => clearArea(key) },
  ];
}

// -- the coordinate editor ---------------------------------------------------------

/**
 * One corner per line, prefilled from the area. Resolves to the corners
 * (`[[lon, lat], …]`) on Save, or null on Cancel.
 */
function openCornerEditor({ title, corners, root }) {
  return new Promise((resolve) => {
    let format = state.areaFormat;
    const dialog = createElement('dialog', 'workspace-dialog area-editor');
    const form = createElement('form');
    form.method = 'dialog';
    form.noValidate = true;
    form.append(createElement('h2', 'dialog-message', title));

    const formatLabel = createElement('label', 'dialog-field');
    formatLabel.append(createElement('span', null, 'Show corners as'));
    const formatSelect = createElement('select', 'dialog-input');
    for (const [value, label] of Object.entries(CORNER_FORMATS)) {
      formatSelect.append(new Option(label, value));
    }
    formatSelect.value = format;
    formatLabel.append(formatSelect);

    const textLabel = createElement('label', 'dialog-field');
    textLabel.append(
      createElement('span', null, 'Corners, one per line, in order around the area'),
    );
    const textarea = createElement('textarea', 'dialog-input area-editor-text');
    textarea.rows = 12;
    textarea.spellcheck = false;
    textarea.setAttribute('aria-describedby', 'area-editor-hint area-editor-status');
    textLabel.append(textarea);
    const hint = createElement(
      'p',
      'panel-note',
      'Any of MGRS (33U XR 80270 08270), UTM (33U 580270 5508270) or degrees (49.70123, 17.50421 — latitude first). Paste from a spreadsheet or an order; a last line repeating the first is ignored.',
    );
    hint.id = 'area-editor-hint';
    const status = createElement('p', 'area-editor-status');
    status.id = 'area-editor-status';
    status.setAttribute('aria-live', 'polite');

    const actions = createElement('div', 'dialog-actions');
    const cancel = createElement('button', 'text-button', 'Cancel');
    cancel.type = 'button';
    const save = createElement('button', 'dialog-accept', 'Save');
    save.type = 'submit';
    actions.append(cancel, save);
    form.append(formatLabel, textLabel, hint, status, actions);
    dialog.append(form);
    root.append(dialog);

    // Untouched lines keep their exact corner (see parseCornerLines); after
    // a format switch, the corners as read so far become the originals.
    let originals = corners;
    const fill = () => {
      textarea.value = originals.map((corner) => formatCorner(corner, format)).join('\n');
    };
    const read = () => parseCornerLines(textarea.value, { originals, format });
    const paintStatus = () => {
      const { corners: found, errors } = read();
      status.classList.toggle('inline-error', errors.length > 0);
      if (errors.length) {
        status.textContent = errors
          .map((error) =>
            error.line ? `Line ${error.line}: "${error.text}" is not a coordinate.` : error.text,
          )
          .join(' ');
      } else {
        const area = polygonAreaSquareKm(areaFromCorners(found));
        status.textContent = `${found.length} corners · ${formatArea(area)}`;
      }
      return errors.length === 0;
    };
    fill();
    paintStatus();
    textarea.addEventListener('input', paintStatus);
    formatSelect.addEventListener('change', () => {
      const { corners: current, errors } = read();
      if (!errors.length) originals = current;
      format = formatSelect.value;
      state.areaFormat = format;
      fill();
      paintStatus();
    });

    let result = null;
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!paintStatus()) {
        textarea.focus();
        return;
      }
      result = read().corners;
      dialog.close();
    });
    dialog.addEventListener(
      'close',
      () => {
        dialog.remove();
        resolve(result);
      },
      { once: true },
    );
    dialog.showModal();
    textarea.focus();
  });
}

export async function editAreaCoordinates(key) {
  if (!canEdit()) return;
  cancelActiveTool();
  const { short, name } = byKey[key];
  const geometry = state.study.study[key];
  const corners = await openCornerEditor({
    title: geometry ? `${short} · ${name}: corners` : `Enter the ${short} (${name.toLowerCase()})`,
    corners: areaCorners(geometry),
    root: elements.moduleRoot,
  });
  if (corners) saveArea(key, areaFromCorners(corners));
}

// -- tools panel -----------------------------------------------------------------

/** The guide's AO or AOI task: its size, and draw / enter coordinates / reshape / clear. */
export function renderAreaTool(key) {
  const geometry = state.study?.study?.[key];
  const row = createElement('div', 'area-tool');
  row.append(
    createElement(
      'p',
      'area-tool-summary',
      geometry
        ? `${areaCorners(geometry).length} corners · ${formatArea(polygonAreaSquareKm(geometry))}`
        : 'Not set yet.',
    ),
  );
  const buttons = createElement('div', 'draw-buttons');
  const draw = editable(
    createElement(
      'button',
      geometry ? 'chip-button' : 'primary-button',
      geometry ? 'Redraw' : 'Draw on map',
    ),
  );
  draw.type = 'button';
  draw.addEventListener('click', () => armAreaDraw(key));
  const coordinates = editable(
    createElement('button', 'chip-button', geometry ? 'Coordinates…' : 'Enter coordinates…'),
  );
  coordinates.type = 'button';
  coordinates.addEventListener('click', () => editAreaCoordinates(key));
  buttons.append(draw, coordinates);
  if (geometry) {
    const reshape = editable(createElement('button', 'chip-button', 'Reshape'));
    reshape.type = 'button';
    reshape.title = 'Drag its corners on the map; drag the middle of a side to add a corner';
    reshape.addEventListener('click', () => armAreaReshape(key));
    const clear = editable(createElement('button', 'chip-button', 'Clear'));
    clear.type = 'button';
    clear.addEventListener('click', () => clearArea(key));
    buttons.append(reshape, clear);
  }
  row.append(buttons);
  return row;
}

// -- worksheet -------------------------------------------------------------------

function cornerTable(key, geometry) {
  const table = createElement('table', 'data-table area-corners');
  const head = createElement('thead');
  const headRow = createElement('tr');
  ['#', 'MGRS', 'Latitude', 'Longitude'].forEach((label) =>
    headRow.append(createElement('th', null, label)),
  );
  head.append(headRow);
  const body = createElement('tbody');
  areaCorners(geometry).forEach(([lon, lat], index) => {
    const row = createElement('tr');
    const numberCell = createElement('td');
    const go = createElement('button', 'text-button', String(index + 1));
    go.type = 'button';
    go.setAttribute('aria-label', `Show ${byKey[key].short} corner ${index + 1} on the map`);
    go.addEventListener('click', () => jumpToCoordinate(lon, lat));
    numberCell.append(go);
    row.append(
      numberCell,
      createElement('td', 'area-coordinate', formatMgrs(lon, lat, 5, { spaced: true })),
      ...formatDegrees(lon, lat)
        .split(/ (?=\d)/)
        .map((text) => createElement('td', 'area-coordinate', text)),
    );
    body.append(row);
  });
  table.append(head, body);
  return table;
}

/** Step 1 worksheet block: each area's size, envelope and every corner. */
export function renderAreaWorksheet() {
  const section = createElement('section', 'worksheet-block area-sheet');
  const study = state.study.study;
  for (const { key, short, name } of STUDY_AREAS) {
    const block = createElement('div', 'area-sheet-area');
    block.append(createElement('h4', null, `${short} · ${name}`));
    const geometry = study[key];
    if (!geometry) {
      block.append(
        createElement(
          'p',
          'panel-note',
          'Not set. Draw it or enter its corners in the tools panel.',
        ),
      );
      section.append(block);
      continue;
    }
    const corners = areaCorners(geometry);
    const [west, south, east, north] = areasBounds([geometry]);
    const facts = createElement('dl', 'fact-list');
    facts.append(
      createElement('dt', null, 'Area'),
      createElement('dd', null, formatArea(polygonAreaSquareKm(geometry))),
      createElement('dt', null, 'Envelope'),
      createElement('dd', null, `${formatMgrs(west, south)} → ${formatMgrs(east, north)}`),
    );
    block.append(facts);
    const details = createElement('details', 'area-corners-details');
    details.open = corners.length <= OPEN_TABLE_CORNERS;
    details.append(
      createElement('summary', null, `${corners.length} corners`),
      cornerTable(key, geometry),
    );
    const copyRow = createElement('div', 'draw-buttons');
    for (const [format, label] of Object.entries(CORNER_FORMATS)) {
      const copy = createElement('button', 'chip-button', `Copy as ${label}`);
      copy.type = 'button';
      copy.addEventListener('click', () => copyCorners(key, format));
      copyRow.append(copy);
    }
    details.append(copyRow);
    block.append(details);
    section.append(block);
  }
  return section;
}
