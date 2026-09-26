import polygonClipping from 'polygon-clipping';

import { HttpError } from '../../../server/http.js';

/**
 * Pure helpers for the exercise scenario's geography: colour/region/geometry
 * validation, and the built-in EXAMPLE scenario, which unions kraje from
 * `regions.json` into three invented countries (a Skolkan-style setup). No
 * database access here; `store.js` does all the reading and writing.
 */

export const AFFILIATIONS = ['friendly', 'hostile', 'neutral', 'unknown'];

export const DEFAULT_COLORS = {
  friendly: '#3d8bff',
  hostile: '#ff4d4d',
  neutral: '#3fbf5f',
  unknown: '#e6c229',
};

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const REGION_ID_PATTERN = /^(kraj|okres):\w+$/;
/** A place `kind` is a vector-tile class ('city', 'hamlet', …) or 'peak'/'water'. */
const KIND_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_GEOMETRY_BYTES = 2 * 1024 * 1024;

export function requireColor(value) {
  if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) {
    throw new HttpError(400, 'color must be a "#rrggbb" hex value.');
  }
  return value.toLowerCase();
}

/** `regions`: unique strings shaped like `kraj:<KOD>` or `okres:<KOD>`. Absent → none. */
export function normalizeRegionIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'regions must be an array of region ids.');
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || !REGION_ID_PATTERN.test(id)) {
      throw new HttpError(400, `"${id}" is not a valid region id.`);
    }
    if (seen.has(id)) throw new HttpError(400, `region "${id}" is listed more than once.`);
    seen.add(id);
  }
  return [...seen];
}

export function requirePlaceKind(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!KIND_PATTERN.test(trimmed)) {
    throw new HttpError(400, 'kind must be a short lowercase token.');
  }
  return trimmed;
}

function finiteCoordinate(point) {
  return (
    Array.isArray(point) &&
    point.length >= 2 &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]) &&
    point[0] >= -180 &&
    point[0] <= 180 &&
    point[1] >= -90 &&
    point[1] <= 90
  );
}

/**
 * Validates a GeoJSON Polygon/MultiPolygon and normalizes it to MultiPolygon.
 * `null`/`undefined` clear the geometry. Rejects anything serializing over
 * 2 MB with a 413, per contract.
 */
export function normalizeGeometry(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'geometry must be a GeoJSON Polygon or MultiPolygon.');
  }
  const { type, coordinates } = value;
  if (type !== 'Polygon' && type !== 'MultiPolygon') {
    throw new HttpError(400, 'geometry.type must be Polygon or MultiPolygon.');
  }
  if (!Array.isArray(coordinates) || !coordinates.length) {
    throw new HttpError(400, 'geometry.coordinates must be a non-empty array.');
  }
  const polygons = type === 'Polygon' ? [coordinates] : coordinates;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) {
      throw new HttpError(400, 'geometry has an empty polygon.');
    }
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4 || !ring.every(finiteCoordinate)) {
        throw new HttpError(400, 'geometry has a degenerate ring or an off-globe coordinate.');
      }
    }
  }
  const normalized = { type: 'MultiPolygon', coordinates: polygons };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_GEOMETRY_BYTES) {
    throw new HttpError(413, 'geometry is larger than the 2 MB limit.');
  }
  return normalized;
}

// -- example scenario ---------------------------------------------------------

export const EXAMPLE_SCENARIO_NAME = 'EXAMPLE – Skolkan-style (invented)';

/** Official kraj names, matched against `regions.json` (level: 'kraj', name: …). */
const EXAMPLE_COUNTRIES = [
  {
    name: 'Arnland',
    affiliation: 'friendly',
    kraje: [
      'Hlavní město Praha',
      'Středočeský kraj',
      'Jihočeský kraj',
      'Plzeňský kraj',
      'Karlovarský kraj',
      'Ústecký kraj',
      'Liberecký kraj',
    ],
  },
  {
    name: 'Framland',
    affiliation: 'neutral',
    kraje: ['Královéhradecký kraj', 'Pardubický kraj', 'Kraj Vysočina'],
  },
  {
    name: 'Donovia',
    affiliation: 'hostile',
    kraje: ['Jihomoravský kraj', 'Olomoucký kraj', 'Zlínský kraj', 'Moravskoslezský kraj'],
  },
];

/** Invented names over real city-centre coordinates (WGS84). */
const EXAMPLE_PLACES = [
  { real_name: 'Praha', name: 'Arnholm', lon: 14.4378, lat: 50.0755 },
  { real_name: 'Plzeň', name: 'Västerby', lon: 13.3776, lat: 49.7475 },
  { real_name: 'České Budějovice', name: 'Södervik', lon: 14.4743, lat: 48.9745 },
  { real_name: 'Ústí nad Labem', name: 'Elbhavn', lon: 14.0328, lat: 50.6607 },
  { real_name: 'Liberec', name: 'Nordmark', lon: 15.0543, lat: 50.7663 },
  { real_name: 'Karlovy Vary', name: 'Kärlsbad', lon: 12.8746, lat: 50.2318 },
  { real_name: 'Hradec Králové', name: 'Kronstad', lon: 15.8327, lat: 50.2092 },
  { real_name: 'Pardubice', name: 'Pardal', lon: 15.7812, lat: 50.0343 },
  { real_name: 'Jihlava', name: 'Iglau', lon: 15.5912, lat: 49.3961 },
  { real_name: 'Brno', name: 'Brunograd', lon: 16.6068, lat: 49.1951 },
  { real_name: 'Olomouc', name: 'Olmgrad', lon: 17.2509, lat: 49.5938 },
  { real_name: 'Ostrava', name: 'Ostrov', lon: 18.2625, lat: 49.8209 },
  { real_name: 'Zlín', name: 'Zlinsk', lon: 17.6683, lat: 49.2265 },
];

function normalizeKrajName(name) {
  return name.trim().toLowerCase();
}

function krajGeometryCoordinates(feature) {
  const { type, coordinates } = feature.geometry;
  return type === 'Polygon' ? [coordinates] : coordinates;
}

/**
 * Builds the EXAMPLE scenario's countries (union of member kraje, matched by
 * name) and places from a `regions.json` FeatureCollection. Pure: returns a
 * plan for `store.js` to insert, throws a plain `Error` (a data problem, not
 * a client error) if a named kraj is missing.
 */
export function planExampleScenario(regionsCollection) {
  const byName = new Map(
    (regionsCollection.features || [])
      .filter((feature) => feature.properties?.level === 'kraj')
      .map((feature) => [normalizeKrajName(feature.properties.name), feature]),
  );
  const countries = EXAMPLE_COUNTRIES.map((spec) => {
    const features = spec.kraje.map((name) => {
      const feature = byName.get(normalizeKrajName(name));
      if (!feature) {
        throw new Error(`Example scenario: kraj "${name}" was not found in regions.json.`);
      }
      return feature;
    });
    const unionCoordinates = polygonClipping.union(...features.map(krajGeometryCoordinates));
    return {
      name: spec.name,
      affiliation: spec.affiliation,
      color: DEFAULT_COLORS[spec.affiliation],
      regions: features.map((feature) => feature.properties.id),
      geometry: unionCoordinates.length
        ? { type: 'MultiPolygon', coordinates: unionCoordinates }
        : null,
    };
  });
  const places = EXAMPLE_PLACES.map((place) => ({
    real_name: place.real_name,
    kind: 'city',
    lon: place.lon,
    lat: place.lat,
    name: place.name,
  }));
  return { name: EXAMPLE_SCENARIO_NAME, countries, places };
}
