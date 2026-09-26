import { lookup, SIDC_FIELDS } from './symbology.js';

/** A friendly land unit, infantry, no echelon: the starting point for a new unit. */
export const DEFAULT_SIDC = '10031000001211000000';

/**
 * Split a 20-digit APP-6(D) SIDC into its fields, or return null when `text`
 * is not one. Spaces and dashes are ignored so a code copied in groups
 * (`10 0 3 10 0 0 00 121100 00 00`) still reads.
 */
export function parseSidc(text) {
  const digits = String(text ?? '').replace(/[\s-]/g, '');
  if (!/^\d{20}$/.test(digits)) return null;
  const parts = {};
  for (const { key, start, length } of SIDC_FIELDS)
    parts[key] = digits.slice(start, start + length);
  return parts;
}

/** Join fields back into a SIDC. Throws when a field has the wrong length or non-digits. */
export function formatSidc(parts) {
  return SIDC_FIELDS.map(({ key, length }) => {
    const value = String(parts[key] ?? '');
    if (value.length !== length || !/^\d+$/.test(value)) {
      throw new Error(`SIDC field ${key} must be ${length} digit(s), got "${value}".`);
    }
    return value;
  }).join('');
}

/** Replace some fields of a SIDC, keeping the rest. */
export function withFields(sidc, changes) {
  const parts = parseSidc(sidc);
  if (!parts) throw new Error(`Not a 20-digit SIDC: ${sidc}`);
  return formatSidc({ ...parts, ...changes });
}

function meaningOf(key, code, parts) {
  switch (key) {
    case 'amplifier': {
      const set = lookup.symbolSet.get(parts.symbolSet);
      if (set && !set.unit) return code === '00' ? 'None' : 'Mobility (equipment)';
      return lookup.echelon.get(code)?.name;
    }
    case 'entity':
    case 'modifier1':
    case 'modifier2':
      // Entity and modifier tables differ per symbol set; only land units are catalogued.
      if (parts.symbolSet !== '10') return undefined;
      return lookup[key].get(code)?.name;
    default:
      return lookup[key].get(code)?.name;
  }
}

/**
 * Every field of a SIDC with its digits and what they mean. `meaning` is
 * undefined for a code this catalogue does not list (another symbol set's
 * entity, or a code reserved by the standard).
 */
export function describeSidc(sidc) {
  const parts = parseSidc(sidc);
  if (!parts) return null;
  return SIDC_FIELDS.map((field) => ({
    ...field,
    code: parts[field.key],
    meaning: meaningOf(field.key, parts[field.key], parts),
  }));
}

/** Standard identity code for each affiliation category (APP-6(D) table A-I). */
const IDENTITY_BY_AFFILIATION = { unknown: '1', friendly: '3', neutral: '4', hostile: '6' };
/** The inverse: every standard identity folds into one of the four affiliation categories
 * (pending/unknown → unknown; assumed friend/friend → friendly; suspect/hostile → hostile,
 * including the exercise joker/faker identities, which play the opposing side). */
const AFFILIATION_BY_IDENTITY = {
  0: 'unknown',
  1: 'unknown',
  2: 'friendly',
  3: 'friendly',
  4: 'neutral',
  5: 'hostile',
  6: 'hostile',
};

/** Set a SIDC's standard identity to the given affiliation. */
export function withAffiliation(sidc, affiliation) {
  const code = IDENTITY_BY_AFFILIATION[affiliation];
  if (!code) throw new Error(`Unknown affiliation: ${affiliation}`);
  return withFields(sidc, { identity: code });
}

/** A SIDC's affiliation category, or null when it is not a SIDC. */
export function affiliationOf(sidc) {
  const parts = parseSidc(sidc);
  return parts ? (AFFILIATION_BY_IDENTITY[parts.identity] ?? null) : null;
}

const STATUS_BY_NAME = { present: '0', planned: '1' };

/** Set a SIDC's status: present (solid frame) or planned/anticipated (dashed frame). */
export function withStatus(sidc, status) {
  const code = STATUS_BY_NAME[status];
  if (!code) throw new Error(`Unknown status: ${status}`);
  return withFields(sidc, { status: code });
}

/** IPB study echelon name (`modules/ipb/client/view.js` ECHELONS) → APP-6(D) amplifier code. */
const AMPLIFIER_BY_ECHELON_NAME = {
  team: '11',
  squad: '12',
  section: '13',
  platoon: '14',
  company: '15',
  battalion: '16',
  regiment: '17',
  brigade: '18',
  division: '21',
  corps: '22',
  army: '23',
};

/** Set a SIDC's echelon amplifier from an IPB echelon name. */
export function withEchelon(sidc, echelonName) {
  const code = AMPLIFIER_BY_ECHELON_NAME[echelonName];
  if (!code) throw new Error(`Unknown echelon: ${echelonName}`);
  return withFields(sidc, { amplifier: code });
}

/** Hostile land unit, infantry, at `echelonName`: the threat SIDC starting point. */
export function defaultThreatSidc(echelonName) {
  return withEchelon(withAffiliation(DEFAULT_SIDC, 'hostile'), echelonName);
}
