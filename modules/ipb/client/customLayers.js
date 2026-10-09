// IPB map: user-defined custom layers.

import { formatMgrs, parseCoordinate } from '../../../src/geo.js';
import { can } from '../../../src/session.js';

import {
  API,
  askConfirm,
  askFields,
  askText,
  canEditStudy,
  cancelActiveTool,
  createElement,
  editable,
  elements,
  jumpToCoordinate,
  mapController,
  renderMapHint,
  requestJson,
  showError,
  state,
  syncMapFeatures,
} from './view.js';
import { renderRowMenu } from './menus.js';

// --- Custom layers -------------------------------------------------------------

/** Distinct, print-safe colours offered to new layers in turn. */
const LAYER_COLORS = ['#d35400', '#8e44ad', '#16a085', '#c0392b', '#2c3e50', '#b7950b'];
const POINT_ID_PREFIX = 'point-';

function pointMapId(point) {
  return `${POINT_ID_PREFIX}${point.id}`;
}

export function findPoint(mapId) {
  if (!String(mapId).startsWith(POINT_ID_PREFIX)) return null;
  const id = Number(String(mapId).slice(POINT_ID_PREFIX.length));
  return state.study?.points.find((point) => point.id === id) ?? null;
}

function findLayer(id) {
  return state.study?.layers.find((layer) => layer.id === id) ?? null;
}

/** Points of the visible custom layers, as map features coloured by layer. */
export function customLayerFeatures() {
  if (!state.study) return [];
  const visible = new Map(
    state.study.layers.filter((layer) => layer.visible).map((layer) => [layer.id, layer]),
  );
  return state.study.points
    .filter((point) => visible.has(point.layer_id))
    .map((point) => ({
      id: pointMapId(point),
      layer: 'custom',
      kind: 'point',
      label: point.name,
      geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
      properties: { color: visible.get(point.layer_id).color },
    }));
}

/** Re-render everything that shows custom layers. */
function refreshCustomLayers() {
  syncMapFeatures();
  renderCustomLayers();
  renderLayersPrint();
}

async function createLayer() {
  if (!(can('analyst') && canEditStudy())) return null;
  const name = await askText('Name of the new layer', '', 'Create');
  if (!name) return null;
  const color = LAYER_COLORS[state.study.layers.length % LAYER_COLORS.length];
  try {
    const layer = await requestJson(`${API}/studies/${state.studyId}/layers`, {
      method: 'POST',
      body: { name, color },
    });
    state.study.layers.push(layer);
    state.activeLayerId = layer.id;
    refreshCustomLayers();
    return layer;
  } catch (error) {
    showError(elements.customLayers, error.message);
    return null;
  }
}

async function updateLayer(layer, patch) {
  if (!(can('analyst') && canEditStudy())) return;
  try {
    Object.assign(
      layer,
      await requestJson(`${API}/studies/${layer.study_id}/layers/${layer.id}`, {
        method: 'PATCH',
        body: patch,
      }),
    );
    refreshCustomLayers();
  } catch (error) {
    showError(elements.customLayers, error.message);
  }
}

async function renameLayer(layer) {
  const name = await askText('Rename layer', layer.name);
  if (name && name !== layer.name) updateLayer(layer, { name });
}

async function deleteLayer(layer) {
  if (!(can('analyst') && canEditStudy())) return;
  const count = state.study.points.filter((point) => point.layer_id === layer.id).length;
  const message = count
    ? `Delete layer "${layer.name}" and its ${count} point${count === 1 ? '' : 's'}?`
    : `Delete layer "${layer.name}"?`;
  if (!(await askConfirm(message))) return;
  try {
    await requestJson(`${API}/studies/${layer.study_id}/layers/${layer.id}`, { method: 'DELETE' });
    state.study.layers = state.study.layers.filter((entry) => entry.id !== layer.id);
    state.study.points = state.study.points.filter((point) => point.layer_id !== layer.id);
    if (state.activeLayerId === layer.id) state.activeLayerId = null;
    if (state.tool?.type === 'point-add' && state.tool.layerId === layer.id) cancelActiveTool();
    refreshCustomLayers();
  } catch (error) {
    showError(elements.customLayers, error.message);
  }
}

/**
 * Ask for a point's name, position and note. `initial` fills the fields;
 * an unreadable position asks again, keeping what was typed. Resolves to
 * `{ name, note, lon, lat }`, or null when cancelled.
 */
async function askPoint(title, initial) {
  let values = {
    name: initial.name ?? '',
    position: formatMgrs(initial.lon, initial.lat),
    note: initial.note ?? '',
  };
  let message = title;
  for (;;) {
    const answer = await askFields(message, [
      { id: 'name', label: 'Name', value: values.name, placeholder: 'e.g. OP 1' },
      { id: 'position', label: 'Position (MGRS, UTM or DD)', value: values.position },
      { id: 'note', label: 'Note', value: values.note, multiline: true },
    ]);
    if (!answer) return null;
    values = answer;
    const parsed = parseCoordinate(answer.position);
    if (!answer.name) message = `${title} — a name is required.`;
    else if (!parsed) message = `${title} — could not read the position "${answer.position}".`;
    else return { name: answer.name, note: answer.note || null, lon: parsed.lon, lat: parsed.lat };
  }
}

async function createPoint(layerId, values) {
  if (!(can('analyst') && canEditStudy())) return null;
  try {
    const point = await requestJson(`${API}/studies/${state.studyId}/points`, {
      method: 'POST',
      body: { layer_id: layerId, ...values },
    });
    state.study.points.push(point);
    const layer = findLayer(layerId);
    // A point added to a hidden layer should not silently vanish.
    if (layer && !layer.visible) await updateLayer(layer, { visible: true });
    state.activeLayerId = layerId;
    refreshCustomLayers();
    return point;
  } catch (error) {
    showError(elements.customLayers, error.message);
    return null;
  }
}

/** Ask for name and note of a point at a clicked position, then save it. */
export async function addPointAt(layerId, lon, lat) {
  const layer = findLayer(layerId);
  if (!layer) return;
  const values = await askPoint(`New point in "${layer.name}"`, { lon, lat });
  if (values) await createPoint(layerId, values);
}

/** Add to a layer chosen from the context menu; "New layer…" creates one first. */
export async function addPointToNewLayer(lon, lat) {
  const layer = await createLayer();
  if (layer) await addPointAt(layer.id, lon, lat);
}

export async function updatePoint(point, patch) {
  if (!(can('analyst') && canEditStudy())) return;
  try {
    Object.assign(
      point,
      await requestJson(`${API}/studies/${point.study_id}/points/${point.id}`, {
        method: 'PATCH',
        body: patch,
      }),
    );
    refreshCustomLayers();
  } catch (error) {
    showError(elements.customLayers, error.message);
  }
}

export async function editPoint(point) {
  const values = await askPoint('Edit point', point);
  if (values) await updatePoint(point, values);
}

export async function deletePoint(point) {
  if (!(can('analyst') && canEditStudy())) return;
  if (!(await askConfirm(`Delete point "${point.name}"?`))) return;
  try {
    await requestJson(`${API}/studies/${point.study_id}/points/${point.id}`, { method: 'DELETE' });
    state.study.points = state.study.points.filter((entry) => entry.id !== point.id);
    refreshCustomLayers();
  } catch (error) {
    showError(elements.customLayers, error.message);
  }
}

/** Drag one point to a new position; saved on release, then the mode ends. */
export function armPointMove(point) {
  if (!(can('analyst') && canEditStudy())) return;
  cancelActiveTool();
  state.tool = { type: 'point-move', pointId: point.id };
  mapController.startModify(pointMapId(point));
  renderMapHint(`Drag "${point.name}" to its new position. Press Escape to cancel.`);
}

/** Keep adding points to `layerId` with each map click until Escape. */
function armPointAdd(layerId) {
  if (!(can('analyst') && canEditStudy())) return;
  const armed = state.tool?.type === 'point-add' && state.tool.layerId === layerId;
  cancelActiveTool();
  if (armed) return;
  state.tool = { type: 'point-add', layerId };
  renderMapHint(
    `Click the map to add points to "${findLayer(layerId).name}". Press Escape when done.`,
  );
  renderCustomLayers();
}

function centreOnPoint(point) {
  jumpToCoordinate(point.lon, point.lat);
  mapController.selectFeature(pointMapId(point));
}

export function renderCustomLayers() {
  const container = elements.customLayers;
  container.hidden = !state.study;
  container.replaceChildren();
  if (!state.study) return;

  const header = createElement('div', 'custom-layers-header');
  header.append(createElement('h3', null, 'Custom layers'));
  const create = editable(createElement('button', 'text-button', '+ New layer'));
  create.type = 'button';
  create.addEventListener('click', createLayer);
  header.append(create);
  container.append(header);

  const { layers, points } = state.study;
  if (!layers.length) {
    container.append(
      createElement(
        'p',
        'tool-hint',
        'Your own named layers of points (observation posts, contacts, landmarks…), each point with a name and a note. Create a layer, then add points by MGRS or by clicking the map; or right-click the map: Add point here.',
      ),
    );
    return;
  }

  const list = createElement('ul', 'custom-layer-list');
  for (const layer of layers) {
    const layerPoints = points.filter((point) => point.layer_id === layer.id);
    const active = state.activeLayerId === layer.id;
    const item = createElement('li', 'custom-layer');
    item.classList.toggle('active', active);

    const row = createElement('div', 'custom-layer-row');
    const visible = document.createElement('input');
    visible.type = 'checkbox';
    visible.checked = layer.visible;
    visible.title = 'Show on the map';
    visible.setAttribute('aria-label', `Show ${layer.name} on the map`);
    editable(visible);
    visible.addEventListener('change', () => updateLayer(layer, { visible: visible.checked }));
    const color = document.createElement('input');
    color.type = 'color';
    color.value = layer.color;
    color.title = 'Layer colour';
    color.setAttribute('aria-label', `Colour of ${layer.name}`);
    editable(color);
    color.addEventListener('change', () => updateLayer(layer, { color: color.value }));
    const name = createElement('button', 'custom-layer-name', layer.name);
    name.type = 'button';
    name.setAttribute('aria-expanded', String(active));
    name.append(createElement('small', null, ` ${layerPoints.length}`));
    name.addEventListener('click', () => {
      state.activeLayerId = active ? null : layer.id;
      renderCustomLayers();
    });
    const menu = renderRowMenu([
      { label: 'Rename', action: () => renameLayer(layer) },
      { label: 'Delete', action: () => deleteLayer(layer) },
    ]);
    row.append(visible, color, name);
    if (menu) row.append(menu);
    item.append(row);
    if (active) item.append(renderLayerEditor(layer, layerPoints));
    list.append(item);
  }
  container.append(list);
}

function renderLayerEditor(layer, layerPoints) {
  const editor = createElement('div', 'custom-layer-editor');

  const form = createElement('div', 'custom-point-form');
  const input = (placeholder, label) => {
    const control = document.createElement('input');
    control.type = 'text';
    control.placeholder = placeholder;
    control.setAttribute('aria-label', label);
    return control;
  };
  const nameInput = editable(input('Name', 'Point name'), { hide: true });
  const positionInput = editable(input('MGRS, UTM or DD', 'Point position'), { hide: true });
  const noteInput = editable(input('Note (optional)', 'Point note'), { hide: true });
  const add = editable(createElement('button', 'chip-button', 'Add'));
  add.type = 'button';
  const error = createElement('p', 'inline-error');
  error.hidden = true;
  const submit = async () => {
    const parsed = parseCoordinate(positionInput.value.trim());
    const problem = !nameInput.value.trim()
      ? 'A name is required.'
      : !parsed
        ? 'Could not read that position.'
        : null;
    error.hidden = !problem;
    if (problem) {
      error.textContent = problem;
      return;
    }
    const point = await createPoint(layer.id, {
      name: nameInput.value.trim(),
      note: noteInput.value.trim() || null,
      lon: parsed.lon,
      lat: parsed.lat,
    });
    if (point) centreOnPoint(point);
  };
  add.addEventListener('click', submit);
  for (const control of [nameInput, positionInput, noteInput]) {
    control.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
  }
  const armed = state.tool?.type === 'point-add' && state.tool.layerId === layer.id;
  const byClick = editable(
    createElement('button', 'chip-button', armed ? 'Stop adding' : 'Add on map'),
  );
  byClick.title = 'Each click on the map adds a point to this layer';
  byClick.type = 'button';
  byClick.setAttribute('aria-pressed', String(armed));
  byClick.addEventListener('click', () => armPointAdd(layer.id));
  form.append(nameInput, positionInput, noteInput, add);
  editor.append(form, error, byClick);

  const list = createElement('ul', 'custom-point-list');
  for (const point of layerPoints) {
    const item = createElement('li', 'custom-point');
    const primary = createElement('button', 'custom-point-text');
    primary.type = 'button';
    primary.title = 'Go to this point';
    primary.append(
      createElement('strong', null, point.name),
      createElement('span', 'custom-point-position', formatMgrs(point.lon, point.lat)),
    );
    if (point.note) primary.append(createElement('span', 'custom-point-note', point.note));
    primary.addEventListener('click', () => centreOnPoint(point));
    const menu = renderRowMenu([
      { label: 'Edit', action: () => editPoint(point) },
      { label: 'Move', action: () => armPointMove(point) },
      { label: 'Delete', action: () => deletePoint(point) },
    ]);
    const row = createElement('div', 'custom-point-row');
    row.append(primary);
    if (menu) row.append(menu);
    item.append(row);
    list.append(item);
  }
  if (!layerPoints.length) {
    editor.append(createElement('p', 'tool-hint', 'No points yet.'));
  }
  editor.append(list);
  return editor;
}

/** Every custom layer with points, as a table, for print. */
export function renderLayersPrint() {
  const container = elements.layersPrint;
  container.replaceChildren();
  const layers = (state.study?.layers ?? []).filter((layer) =>
    state.study.points.some((point) => point.layer_id === layer.id),
  );
  if (!layers.length) return;
  container.append(createElement('h3', null, 'Custom layers'));
  for (const layer of layers) {
    const heading = createElement('h4', null, layer.name);
    heading.style.setProperty('--chip', layer.color);
    container.append(heading);
    const table = document.createElement('table');
    table.className = 'data-table';
    const headRow = document.createElement('tr');
    for (const label of ['Name', 'MGRS', 'Note']) headRow.append(createElement('th', null, label));
    const head = document.createElement('thead');
    head.append(headRow);
    const body = document.createElement('tbody');
    for (const point of state.study.points.filter((entry) => entry.layer_id === layer.id)) {
      const row = document.createElement('tr');
      row.append(
        createElement('td', null, point.name),
        createElement('td', null, formatMgrs(point.lon, point.lat)),
        createElement('td', 'custom-point-note', point.note ?? ''),
      );
      body.append(row);
    }
    table.append(head, body);
    container.append(table);
  }
}
