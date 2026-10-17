/**
 * Study export formatting: RFC 7946 GeoJSON and KML 2.2. Kept apart from
 * `store.js` so encoding concerns (XML escaping, KML's AABBGGRR colours)
 * don't clutter the data layer; both functions are pure (row data in, text
 * out), which also makes them easy to test directly.
 */
import { readGeometry, type Geometry, type Position } from '../../../server/geometry.ts';
import { isJsonObject, type JsonObject } from '../../../server/http.ts';
import { affiliationOf } from '../../../src/symbols/sidc.js';

/** A study as export needs it. */
type ExportStudy = { name: string };

/** Fixed colour per non-unit, non-graphic layer; unit/graphic follow affiliation instead. */
const LAYER_COLOR: Record<string, string> = {
  aoi: '#e6c229',
  mcoo: '#8e44ad',
  'key-terrain': '#16a085',
  avenue: '#2980b9',
  obstacle: '#c0392b',
  nai: '#f39c12',
  tai: '#d35400',
  coa: '#7f8c8d',
  note: '#34495e',
  'range-ring': '#3d8bff',
};
const AFFILIATION_COLOR: Record<string, string> = {
  friendly: '#3d8bff',
  hostile: '#ff4d4d',
  neutral: '#3fbf5f',
  unknown: '#e6c229',
};
/** "None" affiliation and any layer without a fixed colour: ink. */
const INK = '#2c3e50';

/** A stored feature row (as the store shapes it): fields read with their types. */
function featureLayer(feature: JsonObject): string {
  return typeof feature.layer === 'string' ? feature.layer : '';
}
function featureProperties(feature: JsonObject): JsonObject {
  return isJsonObject(feature.properties) ? feature.properties : {};
}

function colorFor(feature: JsonObject) {
  const properties = featureProperties(feature);
  const layer = featureLayer(feature);
  if (layer === 'unit' && typeof properties.sidc === 'string') {
    return AFFILIATION_COLOR[affiliationOf(properties.sidc)] || INK;
  }
  if (layer === 'graphic') {
    const affiliation = properties.affiliation;
    return (typeof affiliation === 'string' && AFFILIATION_COLOR[affiliation]) || INK;
  }
  return LAYER_COLOR[layer] || INK;
}

/** A study name as a safe download filename stem: letters, digits, space, `_`, `-`. */
export function sanitizeFilename(name: string | null | undefined) {
  const cleaned = (name ?? '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return cleaned || 'study';
}

// -- GeoJSON ------------------------------------------------------------------

/** A FeatureCollection in WGS84 (RFC 7946 default; no `crs` member). */
export function toGeoJson(study: ExportStudy, features: JsonObject[]) {
  return {
    type: 'FeatureCollection',
    properties: { study: study.name, exported_at: new Date().toISOString() },
    features: features.map((feature) => ({
      type: 'Feature',
      id: feature.id,
      geometry: feature.geometry,
      properties: {
        layer: feature.layer,
        kind: feature.kind,
        label: feature.label,
        ...featureProperties(feature),
      },
    })),
  };
}

// -- KML ------------------------------------------------------------------------

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function xmlEscape(value: string | number | boolean | null | undefined) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

/** `#rrggbb` → KML's `aabbggrr`, fully opaque. */
function kmlColor(hex: string) {
  const clean = hex.replace('#', '');
  const [r, g, b] = [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4, 6)];
  return `ff${b}${g}${r}`;
}

function coordinatesText(points: Position[]) {
  return points.map((point) => point.slice(0, 2).join(',')).join(' ');
}

function ringXml(points: Position[]) {
  return `<LinearRing><coordinates>${coordinatesText(points)}</coordinates></LinearRing>`;
}

function polygonXml(rings: Position[][]) {
  const [outer, ...holes] = rings;
  const inner = holes.map((hole) => `<innerBoundaryIs>${ringXml(hole)}</innerBoundaryIs>`).join('');
  return `<Polygon><outerBoundaryIs>${ringXml(outer)}</outerBoundaryIs>${inner}</Polygon>`;
}

function geometryXml(geometry: Geometry | null) {
  if (!geometry) return '';
  switch (geometry.type) {
    case 'Point':
      return `<Point><coordinates>${coordinatesText([geometry.coordinates])}</coordinates></Point>`;
    case 'MultiPoint':
      return `<MultiGeometry>${geometry.coordinates
        .map((point) => `<Point><coordinates>${coordinatesText([point])}</coordinates></Point>`)
        .join('')}</MultiGeometry>`;
    case 'LineString':
      return `<LineString><coordinates>${coordinatesText(geometry.coordinates)}</coordinates></LineString>`;
    case 'MultiLineString':
      return `<MultiGeometry>${geometry.coordinates
        .map(
          (line) => `<LineString><coordinates>${coordinatesText(line)}</coordinates></LineString>`,
        )
        .join('')}</MultiGeometry>`;
    case 'Polygon':
      return polygonXml(geometry.coordinates);
    case 'MultiPolygon':
      return `<MultiGeometry>${geometry.coordinates.map(polygonXml).join('')}</MultiGeometry>`;
    default:
      return '';
  }
}

/** A property value as KML text: scalars as-is, anything structured as JSON. */
function propertyText(value: JsonObject[string]): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
}

function extendedDataXml(properties: JsonObject) {
  const entries: [string, string][] = [];
  if (properties.sidc) entries.push(['sidc', propertyText(properties.sidc)]);
  if (properties.graphic) entries.push(['graphic', propertyText(properties.graphic)]);
  if (properties.coa_id !== undefined && properties.coa_id !== null) {
    entries.push(['coa_id', propertyText(properties.coa_id)]);
  }
  if (Array.isArray(properties.radii) && properties.radii.length) {
    entries.push(['radii', properties.radii.map(propertyText).join(',')]);
  }
  if (!entries.length) return '';
  const data = entries
    .map(
      ([name, value]) =>
        `<Data name="${xmlEscape(name)}"><value>${xmlEscape(value)}</value></Data>`,
    )
    .join('');
  return `<ExtendedData>${data}</ExtendedData>`;
}

function styleXml(color: string) {
  const kml = kmlColor(color);
  return (
    '<Style>' +
    `<LineStyle><color>${kml}</color><width>2</width></LineStyle>` +
    `<PolyStyle><color>${kml}</color><fill>1</fill><outline>1</outline></PolyStyle>` +
    `<IconStyle><color>${kml}</color></IconStyle>` +
    '</Style>'
  );
}

function placemarkXml(feature: JsonObject) {
  const label = typeof feature.label === 'string' ? feature.label : '';
  return (
    '<Placemark>' +
    `<name>${xmlEscape(label || featureLayer(feature))}</name>` +
    styleXml(colorFor(feature)) +
    extendedDataXml(featureProperties(feature)) +
    geometryXml(readGeometry(feature.geometry)) +
    '</Placemark>'
  );
}

/** KML 2.2: one `<Folder>` per layer, in the order layers first appear. */
export function toKml(study: ExportStudy, features: JsonObject[]) {
  const byLayer = new Map<string, JsonObject[]>();
  for (const feature of features) {
    const layer = featureLayer(feature);
    const items = byLayer.get(layer) ?? [];
    items.push(feature);
    byLayer.set(layer, items);
  }
  const folders = [...byLayer.entries()]
    .map(
      ([layer, items]) =>
        `<Folder><name>${xmlEscape(layer)}</name>${items.map(placemarkXml).join('')}</Folder>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<kml xmlns="http://www.opengis.net/kml/2.2">' +
    `<Document><name>${xmlEscape(study.name)}</name>${folders}</Document>` +
    '</kml>'
  );
}
