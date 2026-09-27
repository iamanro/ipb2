/**
 * The text and graphic amplifiers a unit placed on a map may carry, stored
 * in its `properties` under `key`. One table for the IPB server's validation,
 * the map's milsymbol rendering and the unit dialog, so the three never drift.
 * Pure (no DOM): the server imports it.
 */
export const REINFORCED_VALUES = ['', '(+)', '(-)', '(±)'];

export const UNIT_AMPLIFIERS = [
  {
    key: 'designation',
    field: 'T',
    option: 'uniqueDesignation',
    label: 'Unique designation',
    maxLength: 40,
  },
  {
    key: 'higher_formation',
    field: 'M',
    option: 'higherFormation',
    label: 'Higher formation',
    maxLength: 40,
  },
  {
    key: 'reinforced',
    field: 'F',
    option: 'reinforcedReduced',
    label: 'Reinforced / reduced',
    values: REINFORCED_VALUES,
  },
  {
    key: 'additional',
    field: 'H',
    option: 'additionalInformation',
    label: 'Additional information',
    maxLength: 80,
  },
  {
    key: 'staff_comments',
    field: 'G',
    option: 'staffComments',
    label: 'Staff comments',
    maxLength: 80,
  },
  { key: 'dtg', field: 'W', option: 'dtg', label: 'Date-time group', maxLength: 20 },
  {
    key: 'direction',
    field: 'Q',
    option: 'direction',
    label: 'Direction of movement',
    degrees: true,
  },
];

/** How an ORBAT unit's affiliation is shown on the map: as the ORBAT has it, or forced. */
export const ORBAT_AFFILIATIONS = ['orbat', 'hostile', 'friendly', 'neutral', 'unknown'];

function amplifierProblem(spec, value) {
  if (value === undefined || value === null) return null;
  if (spec.degrees) {
    return Number.isInteger(value) && value >= 0 && value <= 359
      ? null
      : `properties.${spec.key} must be whole degrees from 0 to 359.`;
  }
  if (typeof value !== 'string') return `properties.${spec.key} must be text.`;
  if (spec.values) {
    return spec.values.includes(value)
      ? null
      : `properties.${spec.key} must be one of: ${spec.values.filter(Boolean).join(', ')}.`;
  }
  return value.length <= spec.maxLength
    ? null
    : `properties.${spec.key} must be at most ${spec.maxLength} characters.`;
}

function idProblem(properties, key) {
  const value = properties[key];
  if (value === undefined || value === null) return null;
  return Number.isInteger(value) && value > 0 ? null : `properties.${key} must be an integer id.`;
}

/**
 * The first reason `properties` of a unit can't be stored, or null. Checks
 * the amplifiers and the ORBAT link (`orbat_id`, `orbat_unit_id`,
 * `orbat_affiliation`); other keys are the caller's business.
 */
export function unitPropertiesProblem(properties) {
  for (const spec of UNIT_AMPLIFIERS) {
    const problem = amplifierProblem(spec, properties[spec.key]);
    if (problem) return problem;
  }
  const problem = idProblem(properties, 'orbat_id') ?? idProblem(properties, 'orbat_unit_id');
  if (problem) return problem;
  const affiliation = properties.orbat_affiliation;
  if (
    affiliation !== undefined &&
    affiliation !== null &&
    !ORBAT_AFFILIATIONS.includes(affiliation)
  ) {
    return `properties.orbat_affiliation must be one of: ${ORBAT_AFFILIATIONS.join(', ')}.`;
  }
  return null;
}

/** milsymbol options for a unit's set amplifiers (empty text and unset direction left out). */
export function unitSymbolOptions(properties) {
  const options = {};
  for (const spec of UNIT_AMPLIFIERS) {
    const value = properties?.[spec.key];
    if (value === undefined || value === null || value === '') continue;
    options[spec.option] = value;
  }
  return options;
}
