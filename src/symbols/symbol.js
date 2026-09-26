import ms from 'milsymbol';

/**
 * Every symbol in this module is drawn to NATO APP-6, not milsymbol's default
 * MIL-STD-2525: the two differ in a few sector 1 modifiers and in colours.
 */
const BASE_OPTIONS = {
  standard: 'APP6',
  fontfamily: "'IBM Plex Sans Condensed', Arial, sans-serif",
};

/**
 * The standard draws echelons, HQ staffs, task-force brackets and frame
 * outlines black; on the dark console they need a light halo to be seen.
 * Paper (export, print) passes `PAPER_OPTIONS` instead.
 */
const CONSOLE_OPTIONS = {
  outlineWidth: 2,
  outlineColor: 'rgb(223,232,234)',
  infoOutlineWidth: 0,
};
export const PAPER_OPTIONS = { outlineWidth: 0 };

/**
 * A milsymbol Symbol for `sidc`. `options` are milsymbol options (size, text
 * amplifiers such as `uniqueDesignation`, `icon: false`…). Text amplifiers
 * are drawn in the current ink colour so they read on the dark console and
 * on paper.
 */
export function createSymbol(sidc, options = {}) {
  return new ms.Symbol(sidc, {
    size: 40,
    infoColor: 'currentColor',
    ...CONSOLE_OPTIONS,
    ...BASE_OPTIONS,
    ...setOptions(options),
  });
}

/**
 * `options` without its null/undefined entries. milsymbol throws while
 * laying out text amplifiers if any amplifier key is present but unset
 * (e.g. a designation with `dtg: undefined`), so callers can pass a unit's
 * fields straight through.
 */
function setOptions(options) {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined && value !== null),
  );
}

/**
 * An inline SVG element for `sidc`. `label` becomes its accessible name;
 * without one the symbol is decorative and hidden from assistive technology.
 */
export function symbolElement(sidc, options = {}, label) {
  const element = createSymbol(sidc, options).asDOM();
  element.classList.add('mil-symbol');
  if (label) {
    element.setAttribute('role', 'img');
    element.setAttribute('aria-label', label);
  } else {
    element.setAttribute('aria-hidden', 'true');
  }
  return element;
}

/** Whether milsymbol knows every part of `sidc` (entity and modifiers). */
export function isDrawable(sidc) {
  return Boolean(createSymbol(sidc).isValid());
}

/** `designation`/`dtg` become milsymbol's unique-designation and DTG text amplifiers. */
function amplifierOptions({ size, designation, dtg }) {
  return { size, uniqueDesignation: designation || undefined, dtg: dtg || undefined };
}

/** A ready-to-draw `<canvas>` for `sidc`. Browser-only (canvas 2D). */
export function symbolCanvas(sidc, { size = 40, designation, dtg } = {}) {
  return createSymbol(sidc, amplifierOptions({ size, designation, dtg })).asCanvas();
}

/** Inline SVG markup for `sidc`, same options as `symbolCanvas`. */
export function symbolSvg(sidc, { size = 40, designation, dtg } = {}) {
  return createSymbol(sidc, amplifierOptions({ size, designation, dtg })).asSVG();
}
