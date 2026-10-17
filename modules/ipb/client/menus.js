// IPB map: the right-click context menu and the per-row "⋯" menus.

import { formatMetres, formatMgrs } from '../../../src/geo.js';
import { can } from '../../../src/session.js';
import { areaMenuItems, handleAreaDrawn, handleAreaReshaped, isAreaId } from './areas.js';
import { handleSitempClick, unitMenuItems } from './sitemp.js';

import {
  API,
  FEATURE_LAYERS,
  TERRAIN_API,
  armFeatureDraw,
  askText,
  canEditStudy,
  cancelActiveTool,
  closeAllPopovers,
  createElement,
  deleteFeature,
  elements,
  mapController,
  mapToolsController,
  reRenderContainingWorksheet,
  renameFeature,
  renderMapHint,
  requestJson,
  showElevationReadout,
  showError,
  showToast,
  state,
  syncMapFeatures,
} from './view.js';
import {
  addPointAt,
  addPointToNewLayer,
  armPointMove,
  deletePoint,
  editPoint,
  findPoint,
  updatePoint,
} from './customLayers.js';
import { setWeatherPoint } from './step1.js';
import { handleAvenuePick, handleLosPick, handleViewshedPick } from './step2.js';

// --- Context menu --------------------------------------------------------

export function closeContextMenu() {
  elements.moduleRoot?.querySelector(':scope > .context-menu')?.remove();
  document.removeEventListener('mousedown', onContextMenuOutside, true);
  document.removeEventListener('contextmenu', onContextMenuOutside, true);
  document.removeEventListener('keydown', onContextMenuKeydown, true);
}

/** A real click is mousedown → mouseup → click. Closing on a mousedown
 * inside the menu would remove the item before its click fires, so only
 * presses outside the menu dismiss it. */
function onContextMenuOutside(event) {
  const menu = elements.moduleRoot?.querySelector(':scope > .context-menu');
  if (menu?.contains(event.target)) {
    if (event.type === 'contextmenu') event.preventDefault();
    return;
  }
  closeContextMenu();
}

function onContextMenuKeydown(event) {
  if (event.key === 'Escape') closeContextMenu();
}

/** Renders `items` into `menu`; a submenu item drills down in place with a
 * "Back" entry, rather than opening a nested flyout. */
function renderContextMenuItems(menu, items, onBack) {
  menu.replaceChildren();
  if (onBack) {
    const back = createElement('li', 'context-menu-item context-menu-back', '← Back');
    back.addEventListener('click', (event) => {
      event.stopPropagation();
      onBack();
    });
    menu.append(back);
  }
  items.forEach((item) => {
    const li = createElement('li', 'context-menu-item', item.label);
    if (item.disabled) {
      li.classList.add('disabled');
    } else {
      li.addEventListener('click', (event) => {
        event.stopPropagation();
        if (item.submenu) {
          renderContextMenuItems(menu, item.submenu, () =>
            renderContextMenuItems(menu, items, onBack),
          );
        } else {
          closeContextMenu();
          item.action();
        }
      });
    }
    menu.append(li);
  });
}

function openContextMenu(x, y, items) {
  closeContextMenu();
  const menu = createElement('ul', 'context-menu');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  renderContextMenuItems(menu, items);
  elements.moduleRoot.append(menu);
  // Clamp on-screen once the menu has a real size.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, y - rect.height)}px`;
  window.setTimeout(() => {
    document.addEventListener('mousedown', onContextMenuOutside, true);
    document.addEventListener('contextmenu', onContextMenuOutside, true);
    document.addEventListener('keydown', onContextMenuKeydown, true);
  }, 0);
}

/**
 * Copy via the legacy selection path. `navigator.clipboard` only exists in
 * secure contexts, so opening the app by IP over plain http needs this; it
 * works because it runs inside the menu click's user activation.
 */
function copyWithSelection(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

async function copyCoordinates(lon, lat) {
  const text = formatMgrs(lon, lat);
  let copied = false;
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // Permission denied: fall through to the selection path.
    }
  }
  copied ||= copyWithSelection(text);
  showToast(copied ? `Copied ${text}` : `${text} (clipboard unavailable)`);
}

/** Feeds the existing pick-two-points line-of-sight flow without requiring
 * the panel's "Pick two points" button to be armed first. */
function setLosPoint(lon, lat, role) {
  if (!(can('analyst') && canEditStudy())) return;
  if (state.tool?.type !== 'los-pick') {
    state.tool = { type: 'los-pick' };
    state.losPicks = [];
  }
  if (role === 'observer') {
    if (state.losPicks.length >= 1) state.losPicks[0] = { lon, lat };
    else state.losPicks.push({ lon, lat });
    syncMapFeatures();
    renderMapHint('Click, or right-click and choose "Set as LOS target", to finish.');
    return;
  }
  handleLosPick(lon, lat);
}

export function armFeatureModify(feature) {
  if (!(can('analyst') && canEditStudy())) return;
  cancelActiveTool();
  state.tool = { type: 'modify-feature', featureId: feature.id };
  mapController.startModify(feature.id);
  renderMapHint(
    `Drag vertices to reshape "${feature.label || feature.layer}". Press Escape when done.`,
  );
}

/** Layer/kind combinations offered by the toolbar, reused for "Draw here". */
function drawHereItems(lon, lat) {
  return Object.entries(FEATURE_LAYERS).map(([layer, config]) => ({
    label: config.label,
    submenu: config.kinds.map((kind) => {
      const disabled = layer === 'coa' && !state.selectedCoaId;
      return {
        label: kind === 'point' ? 'Point here' : `Start ${kind}`,
        disabled,
        action: () => {
          if (disabled) return;
          if (kind === 'point') {
            handleFeatureDrawn(
              { layer, coaId: layer === 'coa' ? state.selectedCoaId : undefined },
              'point',
              {
                type: 'Point',
                coordinates: [lon, lat],
              },
            );
          } else {
            armFeatureDraw(layer, kind);
          }
        },
      };
    }),
  }));
}

/** Drops every mutating item (and mutating-only submenu) from a built context
 * menu for a read-only role; navigation/copy/read items (`mutating: false`)
 * stay. The single filter point for all three menu builders below. */
function filterMenuForRole(items) {
  if (can('analyst') && canEditStudy()) return items;
  return items.filter((item) => item.mutating === false);
}

// --- Row menus ("⋯") --------------------------------------------------------
// One shared control for worksheet-list rows with 3+ actions: a primary
// button (the row's own select/zoom/go-to) plus a "⋯" menu for the rest.
// Reused by view.js's own lists and, via export, by sitemp.js and
// mapTools.js. Also closed whenever the Map popover or study menu opens,
// and vice versa — only one popover is ever open at a time.

let openRowMenu = null;

// { button, menu }

export function closeRowMenu() {
  if (!openRowMenu) return;
  const { button, menu } = openRowMenu;
  menu.remove();
  button.setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', onRowMenuOutside, true);
  document.removeEventListener('keydown', onRowMenuKeydown, true);
  openRowMenu = null;
}

function onRowMenuOutside(event) {
  if (!openRowMenu) return;
  if (openRowMenu.menu.contains(event.target) || openRowMenu.button.contains(event.target)) return;
  closeRowMenu();
}

function onRowMenuKeydown(event) {
  if (!openRowMenu) return;
  const items = [...openRowMenu.menu.querySelectorAll('[role="menuitem"]')];
  const index = items.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    const { button } = openRowMenu;
    closeRowMenu();
    button.focus();
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    items[(index + 1 + items.length) % items.length]?.focus();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    items[(index - 1 + items.length) % items.length]?.focus();
  } else if (event.key === 'Tab') {
    closeRowMenu();
  }
}

function openRowMenuFor(button, items) {
  closeAllPopovers();
  const menu = createElement('div', 'row-menu');
  menu.setAttribute('role', 'menu');
  items.forEach((item) => {
    const entry = createElement(
      'button',
      `row-menu-item${item.danger || /delete/i.test(item.label) ? ' danger' : ''}`,
      item.label,
    );
    entry.type = 'button';
    entry.setAttribute('role', 'menuitem');
    entry.tabIndex = -1;
    entry.addEventListener('click', () => {
      closeRowMenu();
      button.focus();
      item.action();
    });
    menu.append(entry);
  });
  elements.moduleRoot.append(menu);
  const rect = button.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  const wouldOverflow = rect.bottom + menu.offsetHeight + 4 > window.innerHeight;
  menu.style.top = wouldOverflow
    ? `${Math.max(4, rect.top - menu.offsetHeight - 4)}px`
    : `${rect.bottom + 4}px`;
  button.setAttribute('aria-expanded', 'true');
  openRowMenu = { button, menu };
  menu.querySelector('[role="menuitem"]')?.focus();
  window.setTimeout(() => {
    document.addEventListener('mousedown', onRowMenuOutside, true);
    document.addEventListener('keydown', onRowMenuKeydown, true);
  }, 0);
}

/**
 * Builds a row's "⋯" menu button for `items` (`{ label, action, danger?,
 * mutating? }`), role-filtered via `filterMenuForRole` — returns `null` when
 * nothing is left (e.g. an observer with no mutating items), so the caller
 * can omit the button entirely rather than show an empty menu.
 */
export function renderRowMenu(items) {
  const filtered = filterMenuForRole(items);
  if (!filtered.length) return null;
  const button = createElement('button', 'row-menu-toggle', '⋯');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', 'More actions');
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (openRowMenu?.button === button) {
      closeRowMenu();
      return;
    }
    openRowMenuFor(button, filtered);
  });
  return button;
}

function buildMapContextMenu(lon, lat) {
  return filterMenuForRole([
    { label: 'Copy coordinates', action: () => copyCoordinates(lon, lat), mutating: false },
    {
      label: 'Set as LOS point',
      submenu: [
        { label: 'Set as observer', action: () => setLosPoint(lon, lat, 'observer') },
        { label: 'Set as target', action: () => setLosPoint(lon, lat, 'target') },
      ],
    },
    { label: 'Add observation post here', action: () => handleViewshedPick(lon, lat) },
    { label: 'Draw here', submenu: drawHereItems(lon, lat) },
    {
      label: 'Show elevation here',
      action: () => showElevationReadout(lon, lat),
      mutating: false,
    },
    { label: 'Set weather point here', action: () => setWeatherPoint({ lon, lat }) },
    {
      label: 'Add point here',
      submenu: [
        ...(state.study?.layers ?? []).map((layer) => ({
          label: layer.name,
          action: () => addPointAt(layer.id, lon, lat),
        })),
        { label: 'New layer…', action: () => addPointToNewLayer(lon, lat) },
      ],
    },
  ]);
}

function buildPointContextMenu(point) {
  return filterMenuForRole([
    { label: 'Edit…', action: () => editPoint(point) },
    { label: 'Move (drag)', action: () => armPointMove(point) },
    {
      label: 'Copy coordinates',
      action: () => copyCoordinates(point.lon, point.lat),
      mutating: false,
    },
    { label: 'Delete', action: () => deletePoint(point) },
  ]);
}

function buildFeatureContextMenu(featureId, lon, lat) {
  const feature = state.study?.features.find((entry) => String(entry.id) === String(featureId));
  if (!feature) return buildMapContextMenu(lon, lat);
  const [pointLon, pointLat] =
    feature.kind === 'point' || feature.kind === 'symbol'
      ? feature.geometry.coordinates
      : [lon, lat];
  if (feature.layer === 'unit') {
    return filterMenuForRole([
      ...unitMenuItems(feature),
      { label: 'Zoom to', action: () => mapController.fitFeature(feature.id), mutating: false },
      {
        label: 'Copy coordinates',
        action: () => copyCoordinates(pointLon, pointLat),
        mutating: false,
      },
    ]);
  }
  return filterMenuForRole([
    { label: 'Zoom to', action: () => mapController.fitFeature(feature.id), mutating: false },
    { label: 'Rename', action: () => renameFeature(feature) },
    { label: 'Start modify (drag vertices)', action: () => armFeatureModify(feature) },
    {
      label: 'Copy coordinates',
      action: () => copyCoordinates(pointLon, pointLat),
      mutating: false,
    },
    { label: 'Delete', action: () => deleteFeature(feature) },
  ]);
}

export function onMapContextMenu({ lon, lat, featureId, clientX, clientY }) {
  const point = findPoint(featureId);
  const items = point
    ? buildPointContextMenu(point)
    : isAreaId(featureId)
      ? filterMenuForRole(areaMenuItems(featureId))
      : featureId !== null
        ? buildFeatureContextMenu(featureId, lon, lat)
        : buildMapContextMenu(lon, lat);
  openContextMenu(clientX, clientY, items);
}

export let pointerElevationTimer = null;

export let pointerElevationController = null;

/** Debounced ~250 ms after the pointer stops, cancelling a stale in-flight
 * request; "—" is shown until the first result and outside the elevation
 * data (which `requestJson` treats as elevation: null, not an error). */
function scheduleElevationReadout(lon, lat) {
  window.clearTimeout(pointerElevationTimer);
  pointerElevationTimer = window.setTimeout(async () => {
    pointerElevationController?.abort();
    const controller = new AbortController();
    pointerElevationController = controller;
    try {
      const params = new URLSearchParams({ at: `${lon},${lat}` });
      const result = await requestJson(`${TERRAIN_API}/elevation?${params}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      elements.pointerElevation.textContent = Number.isFinite(result.elevation)
        ? formatMetres(result.elevation)
        : '—';
    } catch (error) {
      if (error.name === 'AbortError') return;
      elements.pointerElevation.textContent = '—';
    }
  }, 250);
}

export function onMapPointerMove({ lon, lat }) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    elements.pointerMgrs.textContent = '—';
    elements.pointerElevation.textContent = '—';
    window.clearTimeout(pointerElevationTimer);
    pointerElevationController?.abort();
    return;
  }
  elements.pointerMgrs.textContent = formatMgrs(lon, lat, 5, { spaced: true });
  scheduleElevationReadout(lon, lat);
}

export function onMapClick({ lon, lat }) {
  if (mapToolsController?.handleClick({ lon, lat })) return;
  const tool = state.tool;
  if (!tool) {
    if (state.step === 2) showElevationReadout(lon, lat);
    return;
  }
  if (handleSitempClick(lon, lat)) return;
  if (tool.type === 'los-pick') {
    handleLosPick(lon, lat);
    return;
  }
  if (tool.type === 'viewshed-pick') {
    handleViewshedPick(lon, lat);
    return;
  }
  if (tool.type === 'point-add') {
    // Stays armed: each click adds another point until Escape.
    addPointAt(tool.layerId, lon, lat);
    return;
  }
  if (tool.type === 'weather-pick') {
    state.tool = null;
    renderMapHint('');
    setWeatherPoint({ lon, lat });
    return;
  }
  if (tool.type === 'avenue-pick') handleAvenuePick(lon, lat);
}

async function handleFeatureDrawn(tool, kind, geometry) {
  if (!(can('analyst') && canEditStudy())) return;
  state.tool = null;
  renderMapHint('');
  const layerLabel = FEATURE_LAYERS[tool.layer].label;
  const label = await askText(`Label for this ${layerLabel.toLowerCase()}`, '', 'Add');
  if (label === null) {
    mapController.cancelDraw();
    syncMapFeatures();
    return;
  }
  try {
    const feature = await requestJson(`${API}/studies/${state.studyId}/features`, {
      method: 'POST',
      body: {
        layer: tool.layer,
        kind,
        label: label || layerLabel,
        geometry,
        properties: tool.coaId ? { coa_id: tool.coaId } : undefined,
      },
    });
    state.study.features.push(feature);
    syncMapFeatures();
    reRenderContainingWorksheet(tool.layer);
  } catch (error) {
    showError(elements.toolPanel, error.message);
  }
}

export function onMapDraw({ kind, geometry }) {
  if (mapToolsController?.handleDraw({ kind, geometry })) return;
  const tool = state.tool;
  if (!tool) return;
  // Defense in depth: every arming path already checks the role (so this
  // never triggers from the ordinary UI), but a tool set some other way
  // still can't complete a mutation for a read-only role.
  if (!(can('analyst') && canEditStudy())) {
    state.tool = null;
    mapController.cancelDraw();
    return;
  }
  if (handleAreaDrawn(tool, geometry)) return;
  if (tool.type !== 'draw-feature') return;
  handleFeatureDrawn(tool, kind, geometry);
}

async function handleFeatureModified(id, geometry) {
  if (!(can('analyst') && canEditStudy())) return;
  const feature = state.study.features.find((entry) => String(entry.id) === String(id));
  if (!feature) return;
  try {
    const updated = await requestJson(`${API}/studies/${feature.study_id}/features/${id}`, {
      method: 'PATCH',
      body: { geometry },
    });
    Object.assign(feature, updated);
    syncMapFeatures();
    reRenderContainingWorksheet(feature.layer);
  } catch (error) {
    showError(elements.toolPanel, error.message);
  }
}

export function onMapFeatureChange({ id, geometry }) {
  const point = findPoint(id);
  if (point) {
    const [lon, lat] = geometry.coordinates;
    cancelActiveTool();
    updatePoint(point, { lon, lat });
    return;
  }
  if (handleAreaReshaped(id, geometry)) return;
  handleFeatureModified(id, geometry);
}
