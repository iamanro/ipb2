/**
 * Products and exchange: GeoJSON/KML export (plain downloads of the
 * server's own `studies/:id/export.*`), client-side import parsing of
 * GeoJSON and KML into `features/bulk` bodies, and the study's
 * classification marking. Parsing (`parseGeoJson`, `parseKml`,
 * `buildImportPlan`) is pure — no DOM — and exported for tests, including a
 * round-trip against `modules/ipb/server/export.js`'s own output.
 * `renderExchangeTools`/`renderClassificationField` build the on-screen DOM.
 */
import './tools.css';

const API = '/api/ipb';

export const DEFAULT_CLASSIFICATION = 'UNCLASSIFIED // EXERCISE';

/** Mirrors `modules/ipb/server/store.js`'s `LAYERS`/`FEATURE_KINDS`/
 * `GRAPHIC_GEOMETRY` — small, stable doctrine tables duplicated here so the
 * browser bundle never imports the (Node-only) server module. */
export const LAYERS = [
  'aoi',
  'mcoo',
  'key-terrain',
  'avenue',
  'obstacle',
  'nai',
  'tai',
  'coa',
  'note',
  'unit',
  'graphic',
  'range-ring',
];
export const FEATURE_KINDS = ['point', 'line', 'polygon', 'symbol', 'graphic', 'range-ring'];
export const GRAPHIC_GEOMETRY = {
  'phase-line': 'line',
  boundary: 'line',
  'axis-of-advance': 'line',
  'direction-of-attack': 'line',
  objective: 'polygon',
  'assembly-area': 'polygon',
  'battle-position': 'polygon',
  'engagement-area': 'polygon',
  minefield: 'polygon',
  'obstacle-line': 'line',
  block: 'line',
  fix: 'line',
  turn: 'line',
  disrupt: 'line',
};
export const MAX_BULK_FEATURES = 2000;

/** Layers a foreign (non-app) import's features can be filed under. */
export const FOREIGN_TARGET_LAYERS = [
  { id: 'note', label: 'Note' },
  { id: 'obstacle', label: 'Obstacle' },
  { id: 'nai', label: 'Named area of interest' },
  { id: 'key-terrain', label: 'Key terrain' },
];

// -- XML escaping (the inverse of export.js's) -------------------------------

const XML_UNESCAPES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlUnescape(text) {
  return String(text ?? '').replace(/&(amp|lt|gt|quot|apos);/g, (_match, name) => XML_UNESCAPES[name]);
}

// -- KML parsing --------------------------------------------------------------
//
// Regex, not a DOM/XML parser: this only ever needs to read Placemarks with
// a Point/LineString/Polygon(/MultiGeometry of one), one Folder per layer,
// and a flat ExtendedData — exactly the shapes `export.js#toKml` produces —
// so a small, dependency-free, environment-agnostic parser (works the same
// under Vitest as in the browser) is enough for a real round-trip, without
// pulling in a full XML/KML library for one feature.

function firstTag(xml, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
  return match ? match[1] : null;
}

function allTagBlocks(xml, tag) {
  const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const blocks = [];
  let match = regex.exec(xml);
  while (match) {
    blocks.push(match[1]);
    match = regex.exec(xml);
  }
  return blocks;
}

function parseCoordinateTuple(text) {
  const [lon, lat] = text.trim().split(',').map(Number);
  return [lon, lat];
}

function parseCoordinateList(text) {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(parseCoordinateTuple);
}

function parseSimpleGeometry(tag, block) {
  if (tag === 'Point') {
    const coordinates = firstTag(block, 'coordinates');
    return coordinates ? { type: 'Point', coordinates: parseCoordinateTuple(coordinates) } : null;
  }
  if (tag === 'LineString') {
    const coordinates = firstTag(block, 'coordinates');
    return coordinates ? { type: 'LineString', coordinates: parseCoordinateList(coordinates) } : null;
  }
  // Polygon
  const outer = firstTag(block, 'outerBoundaryIs');
  const outerRingText = outer && firstTag(firstTag(outer, 'LinearRing') ?? '', 'coordinates');
  if (!outerRingText) return null;
  const rings = [parseCoordinateList(outerRingText)];
  for (const innerBlock of allTagBlocks(block, 'innerBoundaryIs')) {
    const ringText = firstTag(firstTag(innerBlock, 'LinearRing') ?? '', 'coordinates');
    if (ringText) rings.push(parseCoordinateList(ringText));
  }
  return { type: 'Polygon', coordinates: rings };
}

/** A Placemark's geometry: Point/LineString/Polygon, or a MultiGeometry of
 * one of those (the only shapes `export.js#geometryXml` ever writes); a
 * MultiGeometry mixing geometry types is not one of ours and is skipped. */
function parsePlacemarkGeometry(block) {
  const multi = firstTag(block, 'MultiGeometry');
  if (multi !== null) {
    const points = allTagBlocks(multi, 'Point').map((entry) => parseSimpleGeometry('Point', entry)).filter(Boolean);
    const lines = allTagBlocks(multi, 'LineString')
      .map((entry) => parseSimpleGeometry('LineString', entry))
      .filter(Boolean);
    const polygons = allTagBlocks(multi, 'Polygon')
      .map((entry) => parseSimpleGeometry('Polygon', entry))
      .filter(Boolean);
    if (points.length && !lines.length && !polygons.length) {
      return { type: 'MultiPoint', coordinates: points.map((point) => point.coordinates) };
    }
    if (lines.length && !points.length && !polygons.length) {
      return { type: 'MultiLineString', coordinates: lines.map((line) => line.coordinates) };
    }
    if (polygons.length && !points.length && !lines.length) {
      return { type: 'MultiPolygon', coordinates: polygons.map((polygon) => polygon.coordinates) };
    }
    return null;
  }
  for (const tag of ['Point', 'LineString', 'Polygon']) {
    const inner = firstTag(block, tag);
    if (inner !== null) return parseSimpleGeometry(tag, inner);
  }
  return null;
}

const EXTENDED_DATA_ENTRY = /<Data\s+name="([^"]*)"\s*>\s*<value>([\s\S]*?)<\/value>\s*<\/Data>/g;

/** `sidc`/`graphic` stay strings; `coa_id` becomes an integer, `radii` a number array. */
function parseExtendedData(block) {
  const extended = firstTag(block, 'ExtendedData');
  if (extended === null) return {};
  const properties = {};
  const regex = new RegExp(EXTENDED_DATA_ENTRY);
  let match = regex.exec(extended);
  while (match) {
    const key = xmlUnescape(match[1]);
    const value = xmlUnescape(match[2]);
    if (key === 'coa_id') properties.coa_id = Number(value);
    else if (key === 'radii') properties.radii = value.split(',').map(Number).filter(Number.isFinite);
    else properties[key] = value;
    match = regex.exec(extended);
  }
  return properties;
}

function parsePlacemarks(xml) {
  return allTagBlocks(xml, 'Placemark').map((block) => {
    const name = firstTag(block, 'name');
    return {
      label: name !== null ? xmlUnescape(name) : '',
      geometry: parsePlacemarkGeometry(block),
      properties: parseExtendedData(block),
    };
  });
}

/**
 * KML Placemarks as `[{ label, geometry, properties, folderLayer? }]`.
 * `export.js#toKml` writes one `<Folder><name>layer</name>` per layer:
 * `folderLayer` carries that name through, which is how `classifyImportItem`
 * recovers `layer` for a re-imported app export (KML's ExtendedData does not
 * carry `layer`/`kind`, only `sidc`/`graphic`/`coa_id`/`radii`). A KML file
 * without that Folder convention just gets its Placemarks read flat.
 */
export function parseKml(text) {
  const folderRegex = /<Folder\b[^>]*>\s*<name>([\s\S]*?)<\/name>([\s\S]*?)<\/Folder>/g;
  const items = [];
  let sawFolder = false;
  let match = folderRegex.exec(text);
  while (match) {
    sawFolder = true;
    const folderLayer = xmlUnescape(match[1]);
    for (const placemark of parsePlacemarks(match[2])) items.push({ ...placemark, folderLayer });
    match = folderRegex.exec(text);
  }
  if (!sawFolder) items.push(...parsePlacemarks(text));
  return items;
}

// -- GeoJSON parsing ----------------------------------------------------------

/**
 * A GeoJSON `Feature`/`FeatureCollection` (or a bare array of Features) as
 * `[{ label, geometry, properties }]`. `label` is `properties.label` (the
 * app's own export) or `properties.name` (common in third-party GeoJSON).
 */
export function parseGeoJson(text) {
  const json = JSON.parse(text);
  const raw =
    json?.type === 'FeatureCollection'
      ? (json.features ?? [])
      : json?.type === 'Feature'
        ? [json]
        : Array.isArray(json)
          ? json
          : [];
  return raw
    .filter((feature) => feature && feature.type === 'Feature' && feature.geometry)
    .map((feature) => {
      const properties = { ...feature.properties };
      const label =
        typeof properties.label === 'string'
          ? properties.label
          : typeof properties.name === 'string'
            ? properties.name
            : '';
      return { label, geometry: feature.geometry, properties };
    });
}

/** `.kml` by extension or a leading `<?xml`/`<kml`; everything else is GeoJSON. */
export function detectFormat(filename, text) {
  const lower = (filename ?? '').toLowerCase();
  if (lower.endsWith('.kml')) return 'kml';
  if (lower.endsWith('.geojson') || lower.endsWith('.json')) return 'geojson';
  return /^\s*(<\?xml|<kml\b)/i.test(text ?? '') ? 'kml' : 'geojson';
}

export function parseImportItems(text, filename) {
  return detectFormat(filename, text) === 'kml' ? parseKml(text) : parseGeoJson(text);
}

// -- Classifying and validating parsed items ---------------------------------

const KIND_BY_GEOMETRY_TYPE = {
  Point: 'point',
  MultiPoint: 'point',
  LineString: 'line',
  MultiLineString: 'line',
  Polygon: 'polygon',
  MultiPolygon: 'polygon',
};

function matchesGeometryKind(geometry, expectedKind) {
  if (!geometry) return false;
  if (expectedKind === 'line') return geometry.type === 'LineString' || geometry.type === 'MultiLineString';
  return geometry.type === 'Polygon' || geometry.type === 'MultiPolygon';
}

/**
 * Whether a parsed item is the app's own export (a real `layer` — from
 * `properties.layer` for GeoJSON, or the KML Folder name — and a `kind`,
 * given directly or inferred from `properties.graphic`/`radii`/`sidc` and
 * the geometry for a KML round trip), or foreign data.
 */
export function classifyImportItem(item) {
  const properties = item.properties ?? {};
  const layer = typeof properties.layer === 'string' ? properties.layer : (item.folderLayer ?? null);
  if (typeof layer !== 'string' || !LAYERS.includes(layer)) return { native: false, layer: null, kind: null };
  let kind = typeof properties.kind === 'string' ? properties.kind : null;
  if (!kind) {
    if (properties.graphic) kind = 'graphic';
    else if (Array.isArray(properties.radii)) kind = 'range-ring';
    else if (layer === 'unit' && properties.sidc) kind = 'symbol';
    else kind = KIND_BY_GEOMETRY_TYPE[item.geometry?.type] ?? null;
  }
  return kind && FEATURE_KINDS.includes(kind) ? { native: true, layer, kind } : { native: false, layer: null, kind: null };
}

/** A light preflight of the three semantically-checked layers, so an
 * obviously bad row is skipped with a reason instead of failing the whole
 * (all-or-nothing) bulk import. */
function nativeItemProblem(layer, kind, geometry, properties) {
  if (layer === 'unit') {
    if (kind !== 'symbol' || typeof properties.sidc !== 'string' || !/^\d{20}$/.test(properties.sidc)) {
      return 'a unit needs kind "symbol" and a valid 20-digit sidc';
    }
  } else if (layer === 'graphic') {
    const expectedKind = GRAPHIC_GEOMETRY[properties.graphic];
    if (!expectedKind) return `unknown graphic type "${properties.graphic}"`;
    if (!matchesGeometryKind(geometry, expectedKind)) {
      return `graphic "${properties.graphic}" must be a ${expectedKind}`;
    }
  } else if (layer === 'range-ring') {
    if (geometry?.type !== 'Point') return 'a range ring must be a Point';
    if (!Array.isArray(properties.radii) || !properties.radii.length) return 'a range ring needs radii';
  }
  return null;
}

function withoutKeys(properties, keys) {
  const rest = { ...properties };
  for (const key of keys) delete rest[key];
  return rest;
}

/**
 * `items` (from `parseImportItems`) → `{ counts, skipped, toCreate }`:
 *   counts     by raw geometry type, over every item, for the preview;
 *   skipped    `[{ label, reason }]`, unsupported geometry or a bad native
 *              row, or foreign data with no `targetLayer` chosen;
 *   toCreate   `features/bulk`-ready bodies (still capped by the caller at
 *              `MAX_BULK_FEATURES`).
 * `targetLayer` (one of `FOREIGN_TARGET_LAYERS`) is where non-app features
 * are filed, labelled with their own name.
 */
export function buildImportPlan(items, { targetLayer } = {}) {
  const counts = {};
  const skipped = [];
  const toCreate = [];
  for (const item of items) {
    const type = item.geometry?.type ?? 'none';
    counts[type] = (counts[type] ?? 0) + 1;
    const label = item.label || '';
    if (!item.geometry) {
      skipped.push({ label, reason: 'No geometry' });
      continue;
    }
    const geomKind = KIND_BY_GEOMETRY_TYPE[type];
    if (!geomKind) {
      skipped.push({ label, reason: `Unsupported geometry: ${type}` });
      continue;
    }
    const { native, layer, kind } = classifyImportItem(item);
    if (native) {
      const properties = withoutKeys(item.properties, ['layer', 'kind', 'label']);
      const problem = nativeItemProblem(layer, kind, item.geometry, properties);
      if (problem) {
        skipped.push({ label, reason: problem });
        continue;
      }
      toCreate.push({ layer, kind, label, geometry: item.geometry, properties });
    } else if (targetLayer) {
      toCreate.push({ layer: targetLayer, kind: geomKind, label, geometry: item.geometry, properties: {} });
    } else {
      skipped.push({ label, reason: 'No target layer chosen for this foreign feature' });
    }
  }
  return { counts, skipped, toCreate };
}

// -- DOM: export/import tools (step 1 tool panel) ----------------------------

/**
 * Export (plain downloads of the server's own `export.geojson`/`.kml`,
 * available to every role) and import (analyst or above): a file picker, a
 * target-layer choice for foreign data, a preview, then
 * `POST studies/:id/features/bulk`. `onImported(items)` is told the created
 * features so the caller can push them into `study.features` and resync.
 */
export function renderExchangeTools({ createElement, requestJson, showError, can, getStudyId, onImported }) {
  const container = createElement('div', 'field-group');
  container.append(createElement('h3', null, 'Data exchange'));

  const exportRow = createElement('div', 'exchange-actions');
  for (const [format, label] of [
    ['geojson', 'Export GeoJSON'],
    ['kml', 'Export KML'],
  ]) {
    const button = createElement('button', 'chip-button', label);
    button.type = 'button';
    button.disabled = !getStudyId();
    button.addEventListener('click', () => {
      const studyId = getStudyId();
      if (!studyId) return;
      const link = document.createElement('a');
      link.href = `${API}/studies/${studyId}/export.${format}`;
      document.body.append(link);
      link.click();
      link.remove();
    });
    exportRow.append(button);
  }
  container.append(exportRow);

  const importGroup = createElement('div', 'field-group');
  importGroup.append(createElement('h3', null, 'Import'));
  if (!can) {
    importGroup.append(
      createElement(
        'p',
        'panel-note',
        'Importing needs analyst access or above, and edit access to this study.',
      ),
    );
    container.append(importGroup);
    return container;
  }
  if (!getStudyId()) {
    importGroup.append(createElement('p', 'panel-note', 'Open a study to import into it.'));
    container.append(importGroup);
    return container;
  }

  importGroup.append(
    createElement(
      'p',
      'tool-hint',
      'GeoJSON or KML. The app’s own export keeps its layer and kind; anything else is filed under the layer below, named from the file.',
    ),
  );

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.geojson,.json,.kml';
  fileInput.setAttribute('aria-label', 'Choose a GeoJSON or KML file to import');
  importGroup.append(fileInput);

  const targetLabel = createElement('label', 'inline-field');
  targetLabel.append(createElement('span', null, 'Target layer for foreign features'));
  const targetSelect = document.createElement('select');
  FOREIGN_TARGET_LAYERS.forEach((layer) => targetSelect.append(new Option(layer.label, layer.id)));
  targetLabel.append(targetSelect);
  importGroup.append(targetLabel);

  const preview = createElement('div', 'import-preview');
  preview.hidden = true;
  importGroup.append(preview);
  container.append(importGroup);

  let plan = null;

  function renderPreview() {
    preview.replaceChildren();
    if (!plan) {
      preview.hidden = true;
      return;
    }
    preview.hidden = false;
    const counts = Object.entries(plan.counts)
      .map(([type, count]) => `${type}: ${count}`)
      .join(', ');
    preview.append(
      createElement('p', null, `${plan.toCreate.length} feature${plan.toCreate.length === 1 ? '' : 's'} ready (${counts}).`),
    );
    const overLimit = plan.toCreate.length > MAX_BULK_FEATURES;
    if (overLimit) {
      preview.append(
        createElement('p', 'inline-error', `At most ${MAX_BULK_FEATURES} features per import; trim the file and try again.`),
      );
    }
    if (plan.skipped.length) {
      preview.append(createElement('p', null, `${plan.skipped.length} skipped:`));
      const skipList = createElement('ul', 'import-skip-list');
      plan.skipped
        .slice(0, 50)
        .forEach((entry) => skipList.append(createElement('li', null, `${entry.label || '(unnamed)'}: ${entry.reason}`)));
      preview.append(skipList);
    }
    if (plan.toCreate.length && !overLimit) {
      const confirmButton = createElement('button', 'primary-button', 'Import');
      confirmButton.type = 'button';
      confirmButton.addEventListener('click', async () => {
        confirmButton.disabled = true;
        confirmButton.textContent = 'Importing…';
        try {
          const studyId = getStudyId();
          const result = await requestJson(`${API}/studies/${studyId}/features/bulk`, {
            method: 'POST',
            body: { features: plan.toCreate },
          });
          plan = null;
          fileInput.value = '';
          renderPreview();
          onImported(result.items);
        } catch (error) {
          if (error.name !== 'AbortError') showError(preview, error.message);
          confirmButton.disabled = false;
          confirmButton.textContent = 'Import';
        }
      });
      preview.append(confirmButton);
    }
  }

  async function reparse() {
    const file = fileInput.files?.[0];
    if (!file) {
      plan = null;
      renderPreview();
      return;
    }
    try {
      const text = await file.text();
      const items = parseImportItems(text, file.name);
      plan = buildImportPlan(items, { targetLayer: targetSelect.value });
      renderPreview();
    } catch (error) {
      plan = null;
      renderPreview();
      showError(importGroup, `Could not read "${file.name}": ${error.message}`);
    }
  }
  fileInput.addEventListener('change', reparse);
  targetSelect.addEventListener('change', reparse);

  return container;
}

// -- DOM: classification marking (step 1 worksheet) --------------------------

/**
 * The study's classification marking, editable in step 1 (`PATCH studies/:id
 * {classification}`); `study` is `state.study.study`, mutated in place with
 * the server's response, matching the view's own autosave convention.
 * `onSaved(text)` lets the caller update the print banners without a full
 * worksheet re-render.
 */
export function renderClassificationField({ createElement, requestJson, showError, can, study, studyId, getStudyId, onSaved }) {
  const wrap = createElement('div', 'classification-field');
  const label = createElement('label', 'field-label', 'Classification marking');
  label.setAttribute('for', 'classification-input');
  const input = document.createElement('input');
  input.id = 'classification-input';
  input.type = 'text';
  input.value = study.classification || DEFAULT_CLASSIFICATION;
  input.disabled = !can;
  const printCopy = createElement('div', 'print-copy classification-print-copy', input.value);
  let timer;
  input.addEventListener('input', () => {
    printCopy.textContent = input.value;
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      try {
        const updated = await requestJson(`${API}/studies/${studyId}`, {
          method: 'PATCH',
          body: { classification: input.value },
        });
        Object.assign(study, updated);
        if (!getStudyId || getStudyId() === studyId) onSaved?.(updated.classification);
      } catch (error) {
        if (error.name !== 'AbortError') showError(wrap, error.message);
      }
    }, 180);
  });
  wrap.append(label, input, printCopy);
  return wrap;
}

const CELL_LABELS = { white: 'WHITE', blue: 'BLUE', red: 'RED' };

/** Sets the top/bottom print banner text (empty when there is no open
 * study). `ownerCell`, given, is appended (e.g. "UNCLASSIFIED // EXERCISE —
 * BLUE") so a printed worksheet always names the cell it belongs to next to
 * its classification marking. */
export function applyClassificationBanner(topEl, bottomEl, text, ownerCell) {
  const base = text || '';
  const cellSuffix = base && ownerCell ? ` — ${CELL_LABELS[ownerCell] ?? ownerCell.toUpperCase()}` : '';
  const value = base ? `${base}${cellSuffix}` : '';
  if (topEl) topEl.textContent = value;
  if (bottomEl) bottomEl.textContent = value;
}
