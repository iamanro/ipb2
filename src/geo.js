// Pure coordinate parsing and formatting helpers. No DOM, no OpenLayers.
// The mgrs package's ESM build (its "module" entry, which the bundler resolves)
// exposes named exports.
import { forward, toPoint } from 'mgrs';

const MGRS_BAND_LETTERS = 'CDEFGHJKLMNPQRSTUVWX';
const MGRS_100K_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const MGRS_PATTERN = new RegExp(
  `^(\\d{1,2})([${MGRS_BAND_LETTERS}])([${MGRS_100K_LETTERS}]{2})(\\d{2,10})$`,
);
const UTM_PATTERN = /^(\d{1,2})\s*([A-Za-z])\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/;
const DMS_TOKEN_PATTERN =
  /(-?\d{1,3}(?:\.\d+)?)\s*[°ºd]\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′m]\s*(?:(\d{1,2}(?:\.\d+)?)\s*["″s]?\s*)?)?([NSEWnsew])/g;
const DD_PATTERN =
  /^\s*([+-]?\d+(?:\.\d+)?)\s*([NSEWnsew])?\s*[,\s]+\s*([+-]?\d+(?:\.\d+)?)\s*([NSEWnsew])?\s*$/;

// WGS84 ellipsoid constants, shared by the standalone UTM inverse below.
const WGS84_A = 6378137;
const WGS84_ECC_SQUARED = 0.00669438;
const UTM_SCALE_FACTOR = 0.9996;
const UTM_FALSE_EASTING = 500000;
const UTM_FALSE_NORTHING = 10000000;

function radToDeg(rad) {
  return (180 * rad) / Math.PI;
}

function isValidLatLon(lat, lon) {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  );
}

// -- MGRS -------------------------------------------------------------------

function parseMgrs(text) {
  const compact = text.replace(/\s+/g, '').toUpperCase();
  const match = MGRS_PATTERN.exec(compact);
  if (!match) return null;
  const digits = match[4];
  if (digits.length % 2 !== 0) return null;
  try {
    const [lon, lat] = toPoint(compact);
    if (!isValidLatLon(lat, lon)) return null;
    return { lon, lat, format: 'mgrs' };
  } catch {
    return null;
  }
}

// -- UTM ----------------------------------------------------------------

function hemisphereFromLetter(letter) {
  const upper = letter.toUpperCase();
  if (upper === 'N') return 'N';
  if (upper === 'S') return 'S';
  if (!MGRS_BAND_LETTERS.includes(upper)) return null;
  return upper < 'N' ? 'S' : 'N';
}

/** Standard Snyder transverse Mercator inverse, WGS84 ellipsoid. */
function utmToLonLat(zoneNumber, hemisphere, easting, northing) {
  const a = WGS84_A;
  const eccSquared = WGS84_ECC_SQUARED;
  const e1 = (1 - Math.sqrt(1 - eccSquared)) / (1 + Math.sqrt(1 - eccSquared));
  const x = easting - UTM_FALSE_EASTING;
  const y = hemisphere === 'S' ? northing - UTM_FALSE_NORTHING : northing;
  const originLon = (zoneNumber - 1) * 6 - 180 + 3;
  const eccPrimeSquared = eccSquared / (1 - eccSquared);

  const m = y / UTM_SCALE_FACTOR;
  const mu =
    m /
    (a * (1 - eccSquared / 4 - (3 * eccSquared * eccSquared) / 64 - (5 * eccSquared ** 3) / 256));

  const phi1 =
    mu +
    ((3 * e1) / 2) * Math.sin(2 * mu) -
    ((27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);

  const n1 = a / Math.sqrt(1 - eccSquared * Math.sin(phi1) ** 2);
  const t1 = Math.tan(phi1) ** 2;
  const c1 = eccPrimeSquared * Math.cos(phi1) ** 2;
  const r1 = (a * (1 - eccSquared)) / Math.pow(1 - eccSquared * Math.sin(phi1) ** 2, 1.5);
  const d = x / (n1 * UTM_SCALE_FACTOR);

  const lat =
    phi1 -
    ((n1 * Math.tan(phi1)) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * eccPrimeSquared) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * eccPrimeSquared - 3 * c1 * c1) * d ** 6) /
          720);

  const lonOffset =
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * eccPrimeSquared + 24 * t1 * t1) * d ** 5) / 120) /
    Math.cos(phi1);

  return { lat: radToDeg(lat), lon: originLon + radToDeg(lonOffset) };
}

function parseUtm(text) {
  const match = UTM_PATTERN.exec(text.trim());
  if (!match) return null;
  const zoneNumber = Number.parseInt(match[1], 10);
  const hemisphere = hemisphereFromLetter(match[2]);
  if (!hemisphere || zoneNumber < 1 || zoneNumber > 60) return null;
  const easting = Number.parseFloat(match[3]);
  const northing = Number.parseFloat(match[4]);
  const { lat, lon } = utmToLonLat(zoneNumber, hemisphere, easting, northing);
  if (!isValidLatLon(lat, lon)) return null;
  return { lon, lat, format: 'utm' };
}

// -- DMS ----------------------------------------------------------------

function dmsTokenToDecimal(deg, min, sec, hemisphere) {
  const magnitude =
    Math.abs(Number.parseFloat(deg)) +
    (min ? Number.parseFloat(min) / 60 : 0) +
    (sec ? Number.parseFloat(sec) / 3600 : 0);
  const negative = /[SW]/i.test(hemisphere);
  return negative ? -magnitude : magnitude;
}

function parseDms(text) {
  const tokens = [...text.matchAll(DMS_TOKEN_PATTERN)];
  if (tokens.length !== 2) return null;
  let lat = null;
  let lon = null;
  for (const [, deg, min, sec, hemisphere] of tokens) {
    const value = dmsTokenToDecimal(deg, min, sec, hemisphere);
    if (/[NS]/i.test(hemisphere)) {
      lat = value;
    } else {
      lon = value;
    }
  }
  if (lat === null || lon === null || !isValidLatLon(lat, lon)) return null;
  return { lon, lat, format: 'dms' };
}

// -- Decimal degrees ------------------------------------------------------

function applyHemisphere(value, hemisphere) {
  if (!hemisphere) return value;
  return /[SW]/i.test(hemisphere) ? -Math.abs(value) : Math.abs(value);
}

function parseDecimal(text) {
  const match = DD_PATTERN.exec(text.trim());
  if (!match) return null;
  const [, rawA, hemA, rawB, hemB] = match;
  const a = Number.parseFloat(rawA);
  const b = Number.parseFloat(rawB);

  let lat;
  let lon;
  if (hemA || hemB) {
    const aIsLat = hemA ? /[NS]/i.test(hemA) : !/[NS]/i.test(hemB);
    if (aIsLat) {
      lat = applyHemisphere(a, hemA);
      lon = applyHemisphere(b, hemB);
    } else {
      lon = applyHemisphere(a, hemA);
      lat = applyHemisphere(b, hemB);
    }
  } else if (Math.abs(a) <= 90) {
    lat = a;
    lon = b;
  } else if (Math.abs(b) <= 90) {
    lat = b;
    lon = a;
  } else {
    return null;
  }

  if (!isValidLatLon(lat, lon)) return null;
  return { lon, lat, format: 'dd' };
}

// -- Public API -----------------------------------------------------------

/**
 * Parse a coordinate string in decimal degrees, DMS, MGRS, or UTM notation.
 * Returns `{ lon, lat, format }` or `null` when nothing parses.
 */
export function parseCoordinate(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return parseMgrs(trimmed) || parseUtm(trimmed) || parseDms(trimmed) || parseDecimal(trimmed);
}

/** Format a point as an MGRS grid reference at the given digit precision (1-5). */
export function formatMgrs(lon, lat, precision = 5) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return '—';
  try {
    return forward([lon, lat], precision);
  } catch {
    return '—';
  }
}

/** Format a point as signed decimal degrees, e.g. "49.70123 N  17.50421 E". */
export function formatDecimal(lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return '—';
  const latHemisphere = lat < 0 ? 'S' : 'N';
  const lonHemisphere = lon < 0 ? 'W' : 'E';
  return `${Math.abs(lat).toFixed(5)} ${latHemisphere}  ${Math.abs(lon).toFixed(5)} ${lonHemisphere}`;
}

/** Format a distance in metres, switching to kilometres above 10 km. */
export function formatMetres(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute < 10000) return `${Math.round(value)} m`;
  return `${(value / 1000).toFixed(1)} km`;
}

/** Format an area in square kilometres, switching to square metres below 1 km2. */
export function formatArea(squareKm) {
  if (squareKm === null || squareKm === undefined || !Number.isFinite(squareKm)) return '—';
  if (squareKm < 1) return `${Math.round(squareKm * 1e6)} m²`;
  return `${squareKm.toFixed(squareKm < 100 ? 1 : 0)} km²`;
}
