// Sun and moon light data for planning: twilight, rise/set and moon
// illumination. Pure and offline: low-precision Meeus ("Astronomical
// Algorithms", 2nd ed., ch. 25 and 47) positions, events found by scanning
// the altitude curve and bisecting each crossing. Good to about a minute for
// the sun and a few minutes for the moon, which is what light tables need.

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J2000 = 2451545;

const sin = (deg) => Math.sin(deg * RAD);
const cos = (deg) => Math.cos(deg * RAD);

function julianDay(ms) {
  return ms / DAY_MS + 2440587.5;
}

/** Julian centuries since J2000 (UT used for TT; ΔT ~ 70 s is negligible here). */
function centuries(ms) {
  return (julianDay(ms) - J2000) / 36525;
}

function toEquatorial(lambda, beta, epsilon) {
  const ra = Math.atan2(
    sin(lambda) * cos(epsilon) - Math.tan(beta * RAD) * sin(epsilon),
    cos(lambda),
  );
  const dec = Math.asin(sin(beta) * cos(epsilon) + cos(beta) * sin(epsilon) * sin(lambda));
  return { ra: ra / RAD, dec: dec / RAD };
}

/** Altitude (degrees) of an equatorial position for an observer. */
function altitude(ms, lat, lon, { ra, dec }) {
  const days = julianDay(ms) - J2000;
  const sidereal = 280.46061837 + 360.98564736629 * days + lon;
  const hourAngle = sidereal - ra;
  return Math.asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(hourAngle)) / RAD;
}

/** Apparent solar position and distance (AU), Meeus ch. 25. */
function sunPosition(ms) {
  const t = centuries(ms);
  const l0 = 280.46646 + 36000.76983 * t;
  const m = 357.52911 + 35999.05029 * t;
  const centre =
    (1.914602 - 0.004817 * t) * sin(m) +
    (0.019993 - 0.000101 * t) * sin(2 * m) +
    0.000289 * sin(3 * m);
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + centre - 0.00569 - 0.00478 * sin(omega);
  const epsilon = 23.439291 - 0.0130042 * t + 0.00256 * cos(omega);
  const distance = 1.000140612 - 0.016708617 * cos(m) - 0.000139589 * cos(2 * m);
  return { ...toEquatorial(lambda, 0, epsilon), lambda, distance };
}

// Meeus table 47.A/47.B, largest terms: [D, M, M', F, coefficient].
const MOON_LONGITUDE = [
  [0, 0, 1, 0, 6288774],
  [2, 0, -1, 0, 1274027],
  [2, 0, 0, 0, 658314],
  [0, 0, 2, 0, 213618],
  [0, 1, 0, 0, -185116],
  [0, 0, 0, 2, -114332],
  [2, 0, -2, 0, 58793],
  [2, -1, -1, 0, 57066],
  [2, 0, 1, 0, 53322],
  [2, -1, 0, 0, 45758],
  [0, 1, -1, 0, -40923],
  [1, 0, 0, 0, -34720],
  [0, 1, 1, 0, -30383],
  [2, 0, 0, -2, 15327],
  [0, 0, 1, 2, -12528],
  [0, 0, 1, -2, 10980],
  [4, 0, -1, 0, 10675],
  [0, 0, 3, 0, 10034],
  [4, 0, -2, 0, 8548],
  [2, 1, -1, 0, -7888],
  [2, 1, 0, 0, -6766],
  [1, 0, -1, 0, -5163],
  [1, 1, 0, 0, 4987],
  [2, -1, 1, 0, 4036],
  [2, 0, 2, 0, 3994],
];
const MOON_DISTANCE = [
  [0, 0, 1, 0, -20905355],
  [2, 0, -1, 0, -3699111],
  [2, 0, 0, 0, -2955968],
  [0, 0, 2, 0, -569925],
  [0, 1, 0, 0, 48888],
  [0, 0, 0, 2, -3149],
  [2, 0, -2, 0, 246158],
  [2, -1, -1, 0, -152138],
  [2, 0, 1, 0, -170733],
  [2, -1, 0, 0, -204586],
  [0, 1, -1, 0, -129620],
  [1, 0, 0, 0, 108743],
  [0, 1, 1, 0, 104755],
  [2, 0, 0, -2, 10321],
  [0, 0, 1, -2, 79661],
  [4, 0, -1, 0, -34782],
  [4, 0, -2, 0, 30824],
];
const MOON_LATITUDE = [
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216],
  [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200],
];

/** Geocentric lunar position, distance (km) and horizontal parallax, Meeus ch. 47. */
function moonPosition(ms) {
  const t = centuries(ms);
  const lp = 218.3164477 + 481267.88123421 * t;
  const d = 297.8501921 + 445267.1114034 * t;
  const m = 357.5291092 + 35999.0502909 * t;
  const mp = 134.9633964 + 477198.8675055 * t;
  const f = 93.272095 + 483202.0175233 * t;
  const e = 1 - 0.002516 * t;
  const series = (terms, fn) =>
    terms.reduce((sum, [cd, cm, cmp, cf, coefficient]) => {
      const eccentricity = Math.abs(cm) === 1 ? e : cm === 0 ? 1 : e * e;
      return sum + coefficient * eccentricity * fn(cd * d + cm * m + cmp * mp + cf * f);
    }, 0);
  const a1 = 119.75 + 131.849 * t;
  const a2 = 53.09 + 479264.29 * t;
  const a3 = 313.45 + 481266.484 * t;
  const sumL = series(MOON_LONGITUDE, sin) + 3958 * sin(a1) + 1962 * sin(lp - f) + 318 * sin(a2);
  const sumB =
    series(MOON_LATITUDE, sin) -
    2235 * sin(lp) +
    382 * sin(a3) +
    175 * sin(a1 - f) +
    175 * sin(a1 + f) +
    127 * sin(lp - mp) -
    115 * sin(lp + mp);
  const distance = 385000.56 + series(MOON_DISTANCE, cos) / 1000;
  const lambda = lp + sumL / 1e6;
  const beta = sumB / 1e6;
  const epsilon = 23.439291 - 0.0130042 * t;
  return {
    ...toEquatorial(lambda, beta, epsilon),
    lambda,
    distance,
    parallax: Math.asin(6378.14 / distance) / RAD,
  };
}

/**
 * Illuminated fraction of the moon (0–1) and whether it is waxing, from the
 * sun–moon elongation (Meeus ch. 48).
 */
function moonIllumination(ms) {
  const sun = sunPosition(ms);
  const moon = moonPosition(ms);
  const elongation = Math.acos(
    sin(sun.dec) * sin(moon.dec) + cos(sun.dec) * cos(moon.dec) * cos(sun.ra - moon.ra),
  );
  const sunKm = sun.distance * 149597870.7;
  const phaseAngle = Math.atan2(
    sunKm * Math.sin(elongation),
    moon.distance - sunKm * Math.cos(elongation),
  );
  return {
    fraction: (1 + Math.cos(phaseAngle)) / 2,
    waxing: (((moon.lambda - sun.lambda) % 360) + 360) % 360 < 180,
  };
}

/** Altitude thresholds (degrees) the sun crosses at each light event. */
const SUN_EVENTS = [
  ['bmnt', 'eent', -12], // nautical twilight
  ['bmct', 'eect', -6], // civil twilight
  ['sunrise', 'sunset', -0.8333], // upper limb on the horizon, with refraction
];
const SCAN_STEP_MS = 10 * 60000;

/**
 * First rising and setting crossing of `threshold(ms)` by `altitudeAt(ms)`
 * within [start, start + 24 h), each refined to about a second, or null.
 */
function crossings(start, altitudeAt, threshold) {
  const found = { rise: null, set: null };
  const excess = (ms) => altitudeAt(ms) - threshold(ms);
  let previousMs = start;
  let previous = excess(start);
  for (let ms = start + SCAN_STEP_MS; ms <= start + DAY_MS; ms += SCAN_STEP_MS) {
    const current = excess(ms);
    if (previous < 0 !== current < 0) {
      let low = previousMs;
      let high = ms;
      while (high - low > 1000) {
        const middle = (low + high) / 2;
        if (excess(middle) < 0 === previous < 0) low = middle;
        else high = middle;
      }
      const key = previous < 0 ? 'rise' : 'set';
      found[key] ??= Math.round((low + high) / 2);
    }
    previousMs = ms;
    previous = current;
  }
  return found;
}

/**
 * Light data for the 24 hours starting at `startMs` (normally local midnight)
 * at lat/lon: `{ bmnt, bmct, sunrise, sunset, eect, eent, moonrise, moonset }`
 * as epoch ms (null when the event does not happen that day), plus
 * `illumination` (0–1) and `waxing` at noon (`startMs` + 12 h), the same
 * convention as the US Naval Observatory's tables, so the two can be compared.
 */
export function lightData(lat, lon, startMs) {
  const result = {};
  const sunAltitude = (ms) => altitude(ms, lat, lon, sunPosition(ms));
  for (const [morning, evening, threshold] of SUN_EVENTS) {
    const { rise, set } = crossings(startMs, sunAltitude, () => threshold);
    result[morning] = rise;
    result[evening] = set;
  }
  // The moon's rise altitude depends on its parallax (distance), Meeus ch. 15.
  const moonAt = (ms) => moonPosition(ms);
  const { rise, set } = crossings(
    startMs,
    (ms) => altitude(ms, lat, lon, moonAt(ms)),
    (ms) => 0.7275 * moonAt(ms).parallax - 0.5667,
  );
  result.moonrise = rise;
  result.moonset = set;
  const { fraction, waxing } = moonIllumination(startMs + DAY_MS / 2);
  return { ...result, illumination: fraction, waxing };
}
