/**
 * Study export formatting: RFC 7946 GeoJSON and KML 2.2. Kept apart from
 * `store.js` so encoding concerns (XML escaping, KML's AABBGGRR colours)
 * don't clutter the data layer; both functions are pure (row data in, text
 * out), which also makes them easy to test directly.
 */
import { affiliationOf } from '../../../src/symbols/sidc.js';

/** Fixed colour per non-unit, non-graphic layer; unit/graphic follow affiliation instead. */
const LAYER_COLOR = {
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
const AFFILIATION_COLOR = {
  friendly: '#3d8bff',
  hostile: '#ff4d4d',
  neutral: '#3fbf5f',
  unknown: '#e6c229',
};
/** "None" affiliation and any layer without a fixed colour: ink. */
const INK = '#2c3e50';

function colorFor(feature) {
  const properties = feature.properties || {};
  if (feature.layer === 'unit' && typeof properties.sidc === 'string') {
    return AFFILIATION_COLOR[affiliationOf(properties.sidc)] || INK;
  }
  if (feature.layer === 'graphic') {
    return AFFILIATION_COLOR[properties.affiliation] || INK;
  }
  return LAYER_COLOR[feature.layer] || INK;
}

/** A study name as a safe download filename stem: letters, digits, space, `_`, `-`. */
export function sanitizeFilename(name) {
  const cleaned = String(name ?? '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return cleaned || 'study';
}

// -- GeoJSON ------------------------------------------------------------------

/** A FeatureCollection in WGS84 (RFC 7946 default; no `crs` member). */
export function toGeoJson(study, features) {
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
        ...feature.properties,
      },
    })),
  };
}

// -- KML ------------------------------------------------------------------------

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
}

/** `#rrggbb` → KML's `aabbggrr`, fully opaque. */
function kmlColor(hex) {
  const clean = hex.replace('#', '');
  const [r, g, b] = [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4, 6)];
  return `ff${b}${g}${r}`;
}

function coordinatesText(points) {
  return points.map((point) => point.slice(0, 2).join(',')).join(' ');
}

function ringXml(points) {
  return `<LinearRing><coordinates>${coordinatesText(points)}</coordinates></LinearRing>`;
}

function polygonXml(rings) {
  const [outer, ...holes] = rings;
  const inner = holes.map((hole) => `<innerBoundaryIs>${ringXml(hole)}</innerBoundaryIs>`).join('');
  return `<Polygon><outerBoundaryIs>${ringXml(outer)}</outerBoundaryIs>${inner}</Polygon>`;
}

function geometryXml(geometry) {
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

function extendedDataXml(properties) {
  const entries = [];
  if (properties.sidc) entries.push(['sidc', properties.sidc]);
  if (properties.graphic) entries.push(['graphic', properties.graphic]);
  if (properties.coa_id !== undefined && properties.coa_id !== null) {
    entries.push(['coa_id', properties.coa_id]);
  }
  if (Array.isArray(properties.radii) && properties.radii.length) {
    entries.push(['radii', properties.radii.join(',')]);
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

function styleXml(color) {
  const kml = kmlColor(color);
  return (
    '<Style>' +
    `<LineStyle><color>${kml}</color><width>2</width></LineStyle>` +
    `<PolyStyle><color>${kml}</color><fill>1</fill><outline>1</outline></PolyStyle>` +
    `<IconStyle><color>${kml}</color></IconStyle>` +
    '</Style>'
  );
}

function placemarkXml(feature) {
  return (
    '<Placemark>' +
    `<name>${xmlEscape(feature.label || feature.layer)}</name>` +
    styleXml(colorFor(feature)) +
    extendedDataXml(feature.properties || {}) +
    geometryXml(feature.geometry) +
    '</Placemark>'
  );
}

/** KML 2.2: one `<Folder>` per layer, in the order layers first appear. */
export function toKml(study, features) {
  const byLayer = new Map();
  for (const feature of features) {
    if (!byLayer.has(feature.layer)) byLayer.set(feature.layer, []);
    byLayer.get(feature.layer).push(feature);
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
