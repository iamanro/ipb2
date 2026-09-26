/**
 * WEG range rings (C8): turn the reference database's free-text "range"
 * properties into `{ system, kind, min_m, max_m, raw }` entries a map can
 * draw as rings.
 *
 * The source data names a property "range" for all sorts of things: a gun's
 * firing distance, a missile's engagement envelope, a sight's usable
 * distance, but also a vehicle's fuel range, a radio's transmission range, a
 * radar's detection range, and a turret's mechanical traverse "range" of
 * motion in degrees. Only the first group is a weapon range; the rest is
 * excluded in two passes:
 *
 * 1. By property name (`EXCLUDE_NAME`): frequency/spectral specs; mechanical
 *    motion (traverse, elevation, azimuth, scan, bearing); vehicle mobility
 *    (cruising, ferry, patrol, fuel, payload, road, "automotive", generic
 *    "operational"); radio/comms/datalink/jamming/control, including model
 *    numbers like "R-173 Range"; sensor capability (detection, acquisition,
 *    tracking, surveillance, radar, sonar, camera, rangefinder, homing); and
 *    measurement precision or environment (accuracy, CEP, temperature).
 * 2. By section: an entire subtree rooted at a section named (after
 *    trimming) "Communications" or "Performance", or starting with
 *    "Automotive", "Propulsion" or "Radar", is skipped outright. Those roots
 *    hold a card's mobility, comms and sensor specs, where a bare "Range" or
 *    "Maximum Range" property (no qualifying word to catch by name) is a
 *    vehicle or radio range, not a weapon range. Exact names, not prefixes,
 *    are used for "Communications"/"Performance" because some cards spell a
 *    real weapon envelope as e.g. "Performance QW-1" (a MANPADS variant).
 *
 * What is left is deliberately permissive: "Combat Range", "Self-Destruct
 * Range", "Grenade Range" and similar are kept as `kind: 'other'` rather
 * than guessed away, since they are plausibly a weapon's own reach.
 */

const EXCLUDE_NAME = [
  // mechanical / angular motion, not distance
  /\btraverse\b/i,
  /\belevation\b/i,
  /\bazimuth\b/i,
  /\bscan(?:ning)?\b/i,
  /\bsector\b/i,
  /\bbearing\b/i,
  // vehicle / platform range, not a weapon's
  /\bcruis/i,
  /\bferry\b/i,
  /\bpatrol\b/i,
  /\bmission\b/i,
  /\btravel\b/i,
  /\bfuel\b/i,
  /\bpayload\b/i,
  /\bsnorkel/i,
  /\bsubmerged\b/i,
  /\bsurfaced\b/i,
  /\bamphibious\b/i,
  /\bendurance\b/i,
  /\broad\b/i,
  /\bautomotive\b/i,
  /\boperational\b/i,
  // radio / comms / data links / jamming / remote control
  /\bradio\b/i,
  /\bcommunicat/i,
  /\btelemetry\b/i,
  /data\s*link/i,
  /\bjam(?:ming|mer)?\b/i,
  /\bcontrol\b/i,
  /\bsatellite\b/i,
  /\btransmi(?:t|ssion)/i,
  /\breceiv/i,
  /\buhf\b/i,
  /\bvhf\b/i,
  /\bhf\b/i,
  /\bantenna/i,
  /\bwireless\b/i,
  /\bwire\b/i,
  /^r-\d/i, // radio model numbers, e.g. "R-173 Range", "R-168-25VE Range"
  // sensor / detection capability, not the weapon's own reach
  /\bfrequency\b/i,
  /\bfreq\b/i,
  /\bdetection\b/i,
  /\bacquisition\b/i,
  /\btracking\b/i,
  /\bsurveillance\b/i,
  /\bradar\b/i,
  /\bsonar\b/i,
  /\bcamera\b/i,
  /\bsensor\b/i,
  /\bresolution\b/i,
  /\brecognition\b/i,
  /\bidentification\b/i,
  /range\s*finder/i,
  /\brangefinder/i,
  /\bhoming\b/i,
  // measurement precision / environment, not distance capability
  /\baccuracy\b/i,
  /\bdynamic\b/i,
  /\bcep\b/i,
  /\btemperature\b/i,
  /\binstrument(?:ed)?\b/i,
];

const ROOT_PREFIX_EXCLUDE = /^(?:automotive|propulsion|radar)\b/i;
const ROOT_EXACT_EXCLUDE = new Set(['communications', 'communication', 'performance']);

/** True for a top-level section whose whole subtree is never a weapon range. */
function isExcludedRoot(name) {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return ROOT_PREFIX_EXCLUDE.test(normalized) || ROOT_EXACT_EXCLUDE.has(normalized);
}

const UNIT_METERS = { m: 1, km: 1000 };

const SKIP_VALUES = /^(?:ina|n\/?a|unk(?:nown)?|tbd|-+)$/i;

/**
 * A range or single number with its unit resolved to metres. `null` when the
 * text is not a distance: blank, "INA"/"N/A", or missing a recognizable unit
 * (only "m"/"km" are supported, matching the contract).
 */
function parseDistance(rawValue, rawUnits) {
  let text = String(rawValue ?? '').trim();
  if (!text || SKIP_VALUES.test(text)) return null;

  // Thousands separators: a comma immediately before a digit, e.g. "2,000".
  text = text.replace(/,(?=\d)/g, '');

  // A unit embedded in the value ("200-1,800m", "40 m") wins over the units
  // column, since it is specific to that exact figure and sometimes repeats
  // or overrides a column that describes a different property on the row.
  let unit = null;
  const embedded = /^(.*\d)\s*(km|m)$/i.exec(text);
  if (embedded) {
    text = embedded[1].trim();
    unit = embedded[2].toLowerCase();
  } else {
    const column = String(rawUnits ?? '')
      .trim()
      .toLowerCase();
    if (column === 'm' || column === 'km') unit = column;
  }
  if (!unit) return null;

  const range = /^(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)$/i.exec(text);
  if (range) {
    const a = Number(range[1]) * UNIT_METERS[unit];
    const b = Number(range[2]) * UNIT_METERS[unit];
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const single = /^(\d+(?:\.\d+)?)$/.exec(text);
  if (single) return { single: Number(single[1]) * UNIT_METERS[unit] };
  return null;
}

const SIGHT = /sight/i;
const EFFECTIVE = /effective|engagement/i;
const MINIMUM = /\bmin(?:imum)?\b/i;
const MAXIMUM = /\bmax(?:imum)?\b/i;

function classifyKind(name) {
  if (SIGHT.test(name)) return 'sight';
  if (EFFECTIVE.test(name)) return 'effective';
  if (MINIMUM.test(name)) return 'minimum';
  if (MAXIMUM.test(name)) return 'maximum';
  return 'other';
}

/**
 * Pure: `{ sectionPath, name, value, units }` rows to C8 entries. Filters by
 * name (`/range/i` plus the exclude list above), parses the value, and
 * dedupes identical results (the same figure sometimes repeats verbatim
 * across sibling ammunition options in the source data).
 */
export function parseRanges(rows) {
  const seen = new Set();
  const entries = [];
  for (const row of rows ?? []) {
    const name = row?.name;
    if (typeof name !== 'string' || !/range/i.test(name)) continue;
    if (EXCLUDE_NAME.some((pattern) => pattern.test(name))) continue;
    const parsed = parseDistance(row.value, row.units);
    if (!parsed) continue;

    const kind = classifyKind(name);
    let min_m = null;
    let max_m = null;
    if ('single' in parsed) {
      // A lone figure is the envelope's minimum only when the name says so
      // ("Minimum Range"); otherwise it is the outer reach ("Maximum Range",
      // "Effective Range", "Range, Day Sight", or a bare "Range").
      if (MINIMUM.test(name)) min_m = parsed.single;
      else max_m = parsed.single;
    } else {
      min_m = parsed.min;
      max_m = parsed.max;
    }

    const raw = row.units ? `${row.value} ${row.units}`.trim() : String(row.value).trim();
    const entry = { system: row.sectionPath ?? '', kind, min_m, max_m, raw };
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

/**
 * Flatten a card's section tree (as returned by `db.js`'s `showCard`) into
 * `{ sectionPath, name, value, units }` rows, ready for `parseRanges`.
 * `System` is dropped from a path once a more specific ancestor exists (it
 * is the source data's generic label for "this subsystem's own specs"); the
 * card's own root-level "System" section keeps its name, since nothing more
 * specific exists there. Whole subtrees under an excluded root (see the
 * module doc comment) are skipped entirely.
 */
function flattenSections(sections, ancestorPath, rows) {
  for (const section of sections) {
    if (ancestorPath.length === 0 && isExcludedRoot(section.name)) continue;
    const generic = section.name === 'System' && ancestorPath.length > 0;
    const path = generic ? ancestorPath : [...ancestorPath, section.name];
    for (const property of section.properties) {
      rows.push({
        sectionPath: path.join(' › '),
        name: property.name,
        value: property.value,
        units: property.units,
      });
    }
    flattenSections(section.sections, path, rows);
  }
}

/** C8 entries for one card, or `null` if `showCard` found nothing. */
export function cardRanges(showCard, database, identifier) {
  const card = showCard(database, identifier);
  if (!card) return null;
  const rows = [];
  flattenSections(card.sections, [], rows);
  return parseRanges(rows);
}
