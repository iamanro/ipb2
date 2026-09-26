/**
 * A reusable location input: a text box that accepts MGRS, UTM or decimal
 * degrees (`src/geo.js`'s `parseCoordinate`), with live validation and a
 * normalized-MGRS echo, a "Pick on map" button that opens a small map
 * dialog (`createMap`, the active scenario applied), and a clear button.
 *
 * `createLocationField({ initial, onChange, ariaLabel })` returns
 * `{ element, getValue(), setValue(value), setDisabled(bool), destroy() }`.
 * `getValue()`/the value passed to `onChange` is `{ lon, lat } | null`.
 * Reused by `reportForm.js` (report location, inject location) and
 * `situation.js` (add/edit track); safe to embed anywhere, including a
 * `<dialog>`, since its own picker dialog is a sibling in `document.body`.
 */
import { clientId } from '../../../src/live.js';
import { formatDecimal, formatMgrs, parseCoordinate } from '../../../src/geo.js';
import { createMap } from '../../../src/map.js';
import { handleUnauthorized } from '../../../src/session.js';

const API = '/api/exercise';
const TERRAIN_API = '/api/terrain';
/** Approximate centre of Czechia — same fallback view as the Geography tab's map. */
const DEFAULT_CENTER = [15.47, 49.82];
const DEFAULT_ZOOM = 7;
const POINT_ZOOM_MARGIN = 0.01;

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function requestJson(path, { method = 'GET', body } = {}) {
  const options = { method, headers: { 'X-Client-Id': clientId } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) handleUnauthorized();
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

export function createLocationField({ initial = null, onChange, ariaLabel = 'Location' } = {}) {
  let value = initial ? { lon: initial.lon, lat: initial.lat } : null;
  let pickerMap = null;
  let pickerDialog = null;

  const root = createElement('div', 'location-field');
  const row = createElement('div', 'location-field-row');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'location-field-input';
  input.placeholder = 'MGRS, UTM, or decimal degrees';
  input.setAttribute('aria-label', ariaLabel);
  input.autocomplete = 'off';
  const pickButton = createElement('button', 'chip-button', 'Pick on map');
  pickButton.type = 'button';
  const clearButton = createElement('button', 'icon-button', 'Clear');
  clearButton.type = 'button';
  clearButton.setAttribute('aria-label', `Clear ${ariaLabel.toLowerCase()}`);
  row.append(input, pickButton, clearButton);
  const echo = createElement('p', 'location-field-echo');
  echo.setAttribute('aria-live', 'polite');
  const errorNode = createElement('p', 'location-field-error');
  errorNode.setAttribute('role', 'alert');
  errorNode.hidden = true;
  root.append(row, echo, errorNode);

  function reflect() {
    clearButton.disabled = !value;
    echo.textContent = value
      ? `\u2192 ${formatMgrs(value.lon, value.lat)} (${formatDecimal(value.lon, value.lat)})`
      : '';
  }

  function setValue(next, { silent = false, updateInput = true } = {}) {
    value = next ? { lon: next.lon, lat: next.lat } : null;
    if (updateInput) input.value = value ? formatMgrs(value.lon, value.lat) : '';
    errorNode.hidden = true;
    reflect();
    if (!silent && onChange) onChange(value);
  }

  input.addEventListener('input', () => {
    const text = input.value.trim();
    if (!text) {
      setValue(null, { updateInput: false });
      return;
    }
    const parsed = parseCoordinate(text);
    if (!parsed) {
      value = null;
      echo.textContent = '';
      errorNode.textContent = 'Not a recognized MGRS, UTM, or decimal-degree coordinate.';
      errorNode.hidden = false;
      if (onChange) onChange(null);
      return;
    }
    setValue({ lon: parsed.lon, lat: parsed.lat }, { updateInput: false });
  });

  clearButton.addEventListener('click', () => setValue(null));

  function buildPickerDialog() {
    pickerDialog = document.createElement('dialog');
    pickerDialog.className = 'location-picker-dialog';
    pickerDialog.setAttribute('aria-label', ariaLabel);
    const header = createElement('div', 'location-picker-header');
    header.append(createElement('p', 'dialog-message', 'Click the map to set the location.'));
    const cancelButton = createElement('button', 'location-picker-cancel', 'Cancel');
    cancelButton.type = 'button';
    cancelButton.addEventListener('click', () => pickerDialog.close());
    header.append(cancelButton);
    const mapTarget = createElement('div', 'location-picker-map');
    pickerDialog.append(header, mapTarget);
    document.body.append(pickerDialog);
    pickerMap = createMap({
      target: mapTarget,
      basemapUrl: `${TERRAIN_API}/tiles/vector.pmtiles`,
      center: value ? [value.lon, value.lat] : DEFAULT_CENTER,
      zoom: value ? 13 : DEFAULT_ZOOM,
      onClick: ({ lon, lat }) => {
        setValue({ lon, lat });
        pickerDialog.close();
      },
    });
  }

  async function openPicker() {
    if (!pickerDialog) buildPickerDialog();
    pickerDialog.showModal();
    if (value) {
      pickerMap.fitExtent([
        value.lon - POINT_ZOOM_MARGIN,
        value.lat - POINT_ZOOM_MARGIN,
        value.lon + POINT_ZOOM_MARGIN,
        value.lat + POINT_ZOOM_MARGIN,
      ]);
    }
    try {
      const { scenario } = await requestJson(`${API}/scenario/active`);
      pickerMap.setScenario(scenario);
    } catch {
      // The picker still works without a scenario overlay.
    }
  }

  pickButton.addEventListener('click', () => {
    openPicker();
  });

  function setDisabled(disabled) {
    input.disabled = disabled;
    pickButton.disabled = disabled;
    clearButton.disabled = disabled && true;
    if (!disabled) clearButton.disabled = !value;
  }

  function destroy() {
    pickerMap?.destroy();
    pickerMap = null;
    pickerDialog?.remove();
    pickerDialog = null;
  }

  reflect();
  if (value) input.value = formatMgrs(value.lon, value.lat);

  return { element: root, getValue: () => value, setValue, setDisabled, destroy };
}
