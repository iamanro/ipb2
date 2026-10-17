// Styles for the situation (tracks, reports), scenario (fictional countries)
// and MGRS grid overlays.

import Point from 'ol/geom/Point.js';
import Style from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import Fill from 'ol/style/Fill.js';
import CircleStyle from 'ol/style/Circle.js';
import RegularShape from 'ol/style/RegularShape.js';
import TextStyle from 'ol/style/Text.js';
import { formatDtg } from '../dtg.js';
import { withStatus } from '../symbols/sidc.js';
import { unitSymbolOptions } from '../symbols/unitProperties.js';

import { milSymbolIcon, withAlpha } from './featureStyles.js';

// -- Situation overlay style (setSituation: Exercise's current tracks/reports) --

/** `destroyed`/`lost` tracks fade instead of disappearing — still on the map, marked as no longer live. */
const TRACK_FADED_OPACITY = 0.4;
const SITUATION_LABEL_FONT = '700 11px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif';

/** Report labels hide below this (OL "256px tile" resolution at zoom 12), so a busy situation doesn't bury the basemap when zoomed out. */
const REPORT_LABEL_MAX_RESOLUTION = 38.22;
const REPORT_INK = '#e6c229';

/** A track's icon: designation + DTG via milsymbol modifiers, `suspected` dashed (planned), `destroyed`/`lost` faded. */
export function situationTrackStyle(feature, symbols) {
  const track = feature.get('track');
  const opacity = track.status === 'destroyed' || track.status === 'lost' ? TRACK_FADED_OPACITY : 1;
  const sidc = track.status === 'suspected' ? withStatus(track.sidc, 'planned') : track.sidc;
  const icon = milSymbolIcon(symbols, {
    sidc,
    amplifiers: unitSymbolOptions({
      designation: track.designation,
      dtg: track.observed_at ? formatDtg(new Date(track.observed_at).getTime()) : undefined,
    }),
    opacity,
  });
  return new Style({ image: icon });
}

export const SITUATION_HISTORY_STYLE = new Style({
  stroke: new Stroke({ color: '#546e7a', width: 1.5, lineDash: [3, 4] }),
});

export const SITUATION_HISTORY_DOT_STYLE = new Style({
  image: new CircleStyle({ radius: 2.5, fill: new Fill({ color: '#546e7a' }) }),
});

/** A report marker: a rotated square, filled by credibility (1-2 solid, 3 medium, 4-6 hollow). */
export function situationReportStyle(feature, resolution) {
  const report = feature.get('report');
  const fillAlpha = report.credibility <= 2 ? 0.9 : report.credibility === 3 ? 0.45 : 0;
  const styles = [
    new Style({
      image: new RegularShape({
        points: 4,
        radius: 7,
        angle: Math.PI / 4,
        fill: new Fill({ color: withAlpha(REPORT_INK, fillAlpha) }),
        stroke: new Stroke({ color: REPORT_INK, width: 1.75 }),
      }),
    }),
  ];
  if (resolution <= REPORT_LABEL_MAX_RESOLUTION) {
    styles.push(
      new Style({
        text: new TextStyle({
          text: (report.report_type || 'report').toUpperCase(),
          font: SITUATION_LABEL_FONT,
          offsetY: -14,
          fill: new Fill({ color: '#1b1b1b' }),
          stroke: new Stroke({ color: '#ffffff', width: 3 }),
        }),
      }),
    );
  }
  return styles;
}

// -- Scenario overlay style (Exercise "Geography" fictional countries) -----

/** Great-circle distance in km; good enough for the ≤5 km name-match rule. */
function haversineKm(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Scenario places bucketed by lowercased real name, for a fast lookup before
 * the distance check. Exported so the Exercise "Geography" editor can run
 * the same match rule when a clicked real label is already
 * renamed, instead of guessing from `scenario.places` itself.
 */
export function buildScenarioNameIndex(scenario) {
  const index = new Map();
  if (!scenario) return index;
  for (const place of scenario.places) {
    const key = place.real_name.trim().toLowerCase();
    const bucket = index.get(key);
    if (bucket) bucket.push(place);
    else index.set(key, [place]);
  }
  return index;
}

/**
 * Match rule: same name (case/trim-insensitive), ≤5 km apart.
 * The name lookup narrows to a handful of candidates before any distance
 * math runs, which is what keeps this affordable per rendered label.
 */
export function matchScenarioPlace(index, name, lon, lat) {
  if (!name) return null;
  const bucket = index.get(name.trim().toLowerCase());
  if (!bucket) return null;
  return bucket.find((place) => haversineKm(lon, lat, place.lon, place.lat) <= 5) ?? null;
}

/** "Arnland" -> "A R N L A N D": crude letter-spacing, canvas text has none. */
function letterSpaced(text) {
  return text.toLocaleUpperCase().split('').join('\u2009');
}

const COUNTRY_LABEL_FONT = '700 13px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif';

/** Dark ink over the pale vector basemap, light ink over dark imagery — same pairing as MGRS/contours. */
const COUNTRY_TONE = {
  dark: {
    label: '#1b1b1b',
    halo: 'rgba(255, 255, 255, 0.92)',
    casing: 'rgba(255, 255, 255, 0.9)',
  },
  light: { label: '#ffffff', halo: 'rgba(8, 12, 16, 0.85)', casing: 'rgba(8, 12, 16, 0.85)' },
};

/**
 * A point safely inside a Polygon or MultiPolygon, for a country's label —
 * `getInteriorPoint()` only exists on `Polygon`; for a MultiPolygon (most
 * countries here, unioned from several kraje/okresy) this uses the largest
 * constituent polygon's interior point, so the label sits in the biggest
 * landmass rather than a sliver.
 */
function geometryAnchor(geometry) {
  if (geometry.getType() === 'Polygon') return geometry.getInteriorPoint().getCoordinates();
  const largest = geometry
    .getPolygons()
    .reduce(
      (best, polygon) => (!best || polygon.getArea() > best.getArea() ? polygon : best),
      null,
    );
  return largest.getInteriorPoint().getCoordinates();
}

/** EPSG:3857 resolution (m/px) → the usual 256px-tile zoom level, for style
 * functions that only get a resolution — same tile grid this map uses
 * everywhere else (`createXYZ()`'s default). */
function resolutionToZoom(resolution) {
  return Math.log2(156543.03392804097 / resolution);
}

const COUNTRY_FILL_MAX_ALPHA = 0.16;

/** Full fill at/below this zoom, fading to none by the zoom above: inside
 * one country the whole map isn't tinted once zoomed in to work in it. */
const COUNTRY_FILL_FADE_START = 8;
const COUNTRY_FILL_FADE_END = 10;

/** A country fill's alpha at `zoom`: full through 8, 0 from 10, linear between. */
function countryFillAlpha(zoom) {
  if (zoom <= COUNTRY_FILL_FADE_START) return COUNTRY_FILL_MAX_ALPHA;
  if (zoom >= COUNTRY_FILL_FADE_END) return 0;
  const t = (zoom - COUNTRY_FILL_FADE_START) / (COUNTRY_FILL_FADE_END - COUNTRY_FILL_FADE_START);
  return COUNTRY_FILL_MAX_ALPHA * (1 - t);
}

const COUNTRY_FILL_STYLE_CACHE = new Map();

/** Cached by colour + a rounded alpha (zoom moves continuously; alpha only
 * needs ~256 steps to look smooth), so panning/zooming doesn't allocate a
 * new Style/Fill every frame. */
function countryFillStyle(color, zoom) {
  const alpha = Math.round(countryFillAlpha(zoom) * 255) / 255;
  if (alpha <= 0) return null;
  const key = `${color}|${alpha}`;
  if (!COUNTRY_FILL_STYLE_CACHE.has(key)) {
    COUNTRY_FILL_STYLE_CACHE.set(
      key,
      new Style({ fill: new Fill({ color: withAlpha(color, alpha) }) }),
    );
  }
  return COUNTRY_FILL_STYLE_CACHE.get(key);
}

/** A scenario country: low-alpha fill (fading out zoomed in), a coloured
 * border on a casing, an uppercase spaced label — the border and label stay
 * at every zoom, only the fill fades. */
export function countryStyle(feature, tone, resolution) {
  const color = feature.get('color') || '#8ea2a8';
  const ink = COUNTRY_TONE[tone];
  const anchor = geometryAnchor(feature.getGeometry());
  const fill = countryFillStyle(color, resolutionToZoom(resolution));
  return [
    ...(fill ? [fill] : []),
    new Style({ stroke: new Stroke({ color: ink.casing, width: 5 }) }),
    new Style({ stroke: new Stroke({ color, width: 2.4 }) }),
    new Style({
      geometry: new Point(anchor),
      text: new TextStyle({
        text: letterSpaced(feature.get('name') || ''),
        font: COUNTRY_LABEL_FONT,
        fill: new Fill({ color: ink.label }),
        stroke: new Stroke({ color: ink.halo, width: 4 }),
        overflow: true,
      }),
    }),
  ];
}

/** Kraj/okres outline for the Exercise "Pick regions" mode; tinted by its owning country, if any. */
export function regionStyle(ownerColor) {
  return new Style({
    stroke: new Stroke({
      color: ownerColor ? withAlpha(ownerColor, 0.9) : 'rgba(159, 208, 222, 0.55)',
      width: ownerColor ? 2 : 1,
    }),
    fill: new Fill({
      color: ownerColor ? withAlpha(ownerColor, 0.22) : 'rgba(159, 208, 222, 0.05)',
    }),
  });
}

// -- MGRS grid style ------------------------------------------------------------

const MGRS_INK = '#12324a';
const MGRS_FONT = '"Cascadia Mono", "IBM Plex Mono", ui-monospace, monospace';
const MGRS_LINE_WIDTH = { zone: 2.2, square: 1.4, line: 0.8 };

/**
 * Two tones: dark ink over the pale vector basemap, and over imagery (dark
 * and busy) white lines on a dark casing so they read on fields and forest.
 */
export const MGRS_LINE_STYLE = {
  dark: {
    zone: new Style({ stroke: new Stroke({ color: MGRS_INK, width: MGRS_LINE_WIDTH.zone }) }),
    square: new Style({ stroke: new Stroke({ color: MGRS_INK, width: MGRS_LINE_WIDTH.square }) }),
    line: new Style({
      stroke: new Stroke({ color: 'rgba(18, 50, 74, 0.5)', width: MGRS_LINE_WIDTH.line }),
    }),
  },
  light: Object.fromEntries(
    Object.entries(MGRS_LINE_WIDTH).map(([rank, width]) => [
      rank,
      [
        new Style({ stroke: new Stroke({ color: 'rgba(0, 0, 0, 0.45)', width: width + 1.6 }) }),
        new Style({
          stroke: new Stroke({
            color: rank === 'line' ? 'rgba(255, 255, 255, 0.7)' : '#ffffff',
            width,
          }),
        }),
      ],
    ]),
  ),
};

const MGRS_LABEL_TEXT = {
  // Easting digits sit just above the bottom edge, northing digits just
  // right of the left edge, as on a paper map sheet's margin.
  easting: { font: `600 11px ${MGRS_FONT}`, textBaseline: 'bottom', offsetY: -4 },
  northing: { font: `600 11px ${MGRS_FONT}`, textAlign: 'left', offsetX: 5 },
  square: { font: `700 12px ${MGRS_FONT}`, boxed: true },
  zone: { font: `700 13px ${MGRS_FONT}`, boxed: true },
};

export function mgrsLabelStyle(kind, text, tone) {
  const { boxed, ...options } = MGRS_LABEL_TEXT[kind];
  // Boxed labels carry their own white background and read on any basemap.
  const light = tone === 'light' && !boxed;
  return new Style({
    text: new TextStyle({
      ...options,
      text,
      fill: new Fill({ color: light ? '#ffffff' : MGRS_INK }),
      ...(boxed
        ? {
            backgroundFill: new Fill({ color: 'rgba(255, 255, 255, 0.85)' }),
            padding: [2, 5, 2, 5],
          }
        : { stroke: new Stroke({ color: light ? 'rgba(0, 0, 0, 0.8)' : '#ffffff', width: 3 }) }),
    }),
  });
}
