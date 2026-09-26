/**
 * Classic NATO line-and-block wire diagram: layout is pure (no DOM, easy to
 * unit-test), rendering builds one `<svg>` from a layout result.
 *
 * A tree node here is `{ id, children }` plus whatever payload the caller
 * needs (the renderer expects a `unit`); `children` must already reflect
 * collapse state — a collapsed unit is passed in with `children: []`.
 */

import { createSymbol, PAPER_OPTIONS } from '../../../src/symbols/symbol.js';

export const DEFAULT_LAYOUT_OPTIONS = {
  hGap: 28, // gap between sibling subtrees, fan layout
  vGap: 46, // gap between a parent row and its children row, fan layout
  stackGap: 10, // gap between stacked (all-leaf) children
  stackIndent: 40, // horizontal offset from the parent's connector to the stacked column
  rootGap: 56, // gap between top-level roots
};

function boxOf(unit, measure) {
  const measured = measure(unit);
  const width = measured.width;
  const height = measured.height;
  const anchorTop = measured.anchorTop || { x: width / 2, y: 0 };
  const anchorBottom = measured.anchorBottom || { x: width / 2, y: height };
  return { width, height, anchorTop, anchorBottom };
}

function leafLayout(unit, depth, measure) {
  const box = boxOf(unit, measure);
  return {
    rootId: unit.id,
    box: { x: 0, y: 0, width: box.width, height: box.height },
    anchorTop: box.anchorTop,
    anchorBottom: box.anchorBottom,
    subtreeWidth: box.width,
    subtreeHeight: box.height,
    nodes: [
      {
        id: unit.id,
        x: 0,
        y: 0,
        width: box.width,
        height: box.height,
        anchorX: box.anchorBottom.x,
        unit,
        depth,
        hasChildren: false,
      },
    ],
    edges: [],
  };
}

function shift(layout, dx, dy) {
  return {
    ...layout,
    box: { ...layout.box, x: layout.box.x + dx, y: layout.box.y + dy },
    anchorTop: { x: layout.anchorTop.x + dx, y: layout.anchorTop.y + dy },
    anchorBottom: { x: layout.anchorBottom.x + dx, y: layout.anchorBottom.y + dy },
    nodes: layout.nodes.map((node) => ({ ...node, x: node.x + dx, y: node.y + dy })),
    edges: layout.edges.map((edge) => ({
      ...edge,
      points: edge.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    })),
  };
}

/** All children of `unit` are leaves: pack them in a vertical column with a spine instead of spreading them out. */
function isStackable(children) {
  return (
    children.length > 0 && children.every((child) => !child.children || child.children.length === 0)
  );
}

function layoutFan(unit, box, children, depth, measure, opts) {
  const childLayouts = children.map((child) => layoutNode(child, depth + 1, measure, opts));
  const totalChildrenWidth =
    childLayouts.reduce((sum, layout) => sum + layout.subtreeWidth, 0) +
    opts.hGap * (childLayouts.length - 1);
  const subtreeWidth = Math.max(box.width, totalChildrenWidth);
  const childrenOffsetX = Math.max(0, (subtreeWidth - totalChildrenWidth) / 2);
  const parentX = Math.max(0, (subtreeWidth - box.width) / 2);
  const childRowY = box.height + opts.vGap;

  const nodes = [
    {
      id: unit.id,
      x: parentX,
      y: 0,
      width: box.width,
      height: box.height,
      anchorX: box.anchorBottom.x,
      unit,
      depth,
      hasChildren: true,
    },
  ];
  const edges = [];
  const parentAnchor = { x: parentX + box.anchorBottom.x, y: box.anchorBottom.y };
  let cx = childrenOffsetX;
  let subtreeHeight = box.height;
  for (const child of childLayouts) {
    const placed = shift(child, cx, childRowY);
    nodes.push(...placed.nodes);
    edges.push(...placed.edges);
    const childAnchor = { x: cx + child.anchorTop.x, y: childRowY + child.anchorTop.y };
    const midY = (parentAnchor.y + childAnchor.y) / 2;
    edges.push({
      id: `${unit.id}->${placed.rootId}`,
      parentId: unit.id,
      childId: placed.rootId,
      points: [
        parentAnchor,
        { x: parentAnchor.x, y: midY },
        { x: childAnchor.x, y: midY },
        childAnchor,
      ],
    });
    cx += child.subtreeWidth + opts.hGap;
    subtreeHeight = Math.max(subtreeHeight, childRowY + child.subtreeHeight);
  }
  return {
    rootId: unit.id,
    box: { x: parentX, y: 0, width: box.width, height: box.height },
    anchorTop: { x: parentX + box.anchorTop.x, y: box.anchorTop.y },
    anchorBottom: parentAnchor,
    subtreeWidth,
    subtreeHeight,
    nodes,
    edges,
  };
}

function layoutStack(unit, box, children, depth, measure, opts) {
  const childLayouts = children.map((child) => layoutNode(child, depth + 1, measure, opts));
  const maxChildWidth = Math.max(...childLayouts.map((layout) => layout.subtreeWidth));
  const columnWidth = opts.stackIndent + maxChildWidth;
  const subtreeWidth = Math.max(box.width, columnWidth);

  const nodes = [
    {
      id: unit.id,
      x: 0,
      y: 0,
      width: box.width,
      height: box.height,
      anchorX: box.anchorBottom.x,
      unit,
      depth,
      hasChildren: true,
    },
  ];
  const edges = [];
  const parentAnchor = { x: box.anchorBottom.x, y: box.anchorBottom.y };
  const spineX = Math.min(parentAnchor.x, opts.stackIndent);
  let cy = box.height + opts.vGap;
  for (const child of childLayouts) {
    const placed = shift(child, opts.stackIndent, cy);
    nodes.push(...placed.nodes);
    edges.push(...placed.edges);
    const childAnchor = { x: opts.stackIndent + child.anchorTop.x, y: cy + child.anchorTop.y };
    edges.push({
      id: `${unit.id}->${placed.rootId}`,
      parentId: unit.id,
      childId: placed.rootId,
      points: [
        parentAnchor,
        { x: spineX, y: parentAnchor.y },
        { x: spineX, y: childAnchor.y },
        childAnchor,
      ],
    });
    cy += child.subtreeHeight + opts.stackGap;
  }
  const subtreeHeight = cy - opts.stackGap;
  return {
    rootId: unit.id,
    box: { x: 0, y: 0, width: box.width, height: box.height },
    anchorTop: { x: box.anchorTop.x, y: box.anchorTop.y },
    anchorBottom: parentAnchor,
    subtreeWidth,
    subtreeHeight,
    nodes,
    edges,
  };
}

function layoutNode(unit, depth, measure, opts) {
  const children = unit.children || [];
  if (children.length === 0) return leafLayout(unit, depth, measure);
  const box = boxOf(unit, measure);
  return isStackable(children)
    ? layoutStack(unit, box, children, depth, measure, opts)
    : layoutFan(unit, box, children, depth, measure, opts);
}

/**
 * Lay out a forest of unit trees. `measure(unit)` returns
 * `{ width, height, anchorTop?, anchorBottom? }` in the unit's own box
 * coordinates (anchors default to top/bottom box centre). Pure: no DOM.
 */
export function layoutTree(roots, measure, options = {}) {
  const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
  const nodes = [];
  const edges = [];
  let x = 0;
  let height = 0;
  for (const root of roots) {
    const layout = layoutNode(root, 0, measure, opts);
    const placed = shift(layout, x, 0);
    nodes.push(...placed.nodes);
    edges.push(...placed.edges);
    x += layout.subtreeWidth + opts.rootGap;
    height = Math.max(height, layout.subtreeHeight);
  }
  const width = roots.length ? x - opts.rootGap : 0;
  return { width, height, nodes, edges };
}

// --- Rendering --------------------------------------------------------------

const CAPTION_GAP = 4;
const CAPTION_LINE_HEIGHT = 13;
const CAPTION_CHAR_WIDTH = 6.1;

function estimateTextWidth(text) {
  return Math.max(1, text.length) * CAPTION_CHAR_WIDTH;
}

/**
 * milsymbol's own option defaults are only applied for an *absent* key: a
 * key present with `value: undefined` reaches its internal text measuring
 * and throws. So each field is included only when the unit actually sets it.
 */
function amplifierOptions(unit, size) {
  const options = { size };
  if (unit.designation) options.uniqueDesignation = unit.designation;
  if (unit.higherFormation) options.higherFormation = unit.higherFormation;
  if (unit.reinforced) options.reinforcedReduced = unit.reinforced;
  if (unit.additional) options.additionalInformation = unit.additional;
  return options;
}

/**
 * Measure a unit's box for `layoutTree`: the symbol plus a caption line for
 * `unit.name`. A connector ends on the top of the symbol (above the echelon
 * marker, as in a printed wire diagram) at the frame's centre line, and
 * leaves from the bottom of the box, under the caption, so no line crosses
 * the unit's text.
 */
export function measureUnit(unit, { size = 40 } = {}) {
  const symbol = createSymbol(unit.sidc, amplifierOptions(unit, size));
  const symSize = symbol.getSize();
  const anchor = symbol.getOctagonAnchor();
  const caption = (unit.name || '').trim();
  const captionWidth = caption ? estimateTextWidth(caption) : 0;
  const width = Math.max(symSize.width, captionWidth);
  const symbolOffsetX = (width - symSize.width) / 2;
  const height = symSize.height + (caption ? CAPTION_GAP + CAPTION_LINE_HEIGHT : 0);
  return {
    width,
    height,
    symbol,
    symSize,
    symbolOffsetX,
    anchorTop: { x: symbolOffsetX + anchor.x, y: 0 },
    anchorBottom: { x: symbolOffsetX + anchor.x, y: height + CAPTION_GAP },
  };
}

function pathFor(points) {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ');
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

/**
 * Build a standalone `<svg>` for `layout` (from `layoutTree` with
 * `measureUnit`). `selectedId` highlights a node; `onToggleCollapse(id)`, if
 * given, adds a collapse toggle on nodes with children; `standalone` inlines
 * dark-on-white colours for export/print instead of the console theme's
 * `currentColor`.
 */
export function renderChart(
  layout,
  { selectedId, collapsedIds, onSelectUnit, onToggleCollapse, standalone = false } = {},
) {
  const padding = 24;
  // Edge and caption colours are set as explicit SVG paint attributes (not just CSS classes) so
  // the chart still reads correctly with no external stylesheet — required for standalone export.
  const inkColor = standalone ? '#10181b' : 'currentColor';
  const lineColor = standalone ? '#5b737b' : 'var(--line-dark, currentColor)';
  const svg = svgEl('svg', {
    xmlns: SVG_NS,
    class: 'orbat-chart-svg',
    width: layout.width + padding * 2,
    height: layout.height + padding * 2,
    viewBox: `${-padding} ${-padding} ${layout.width + padding * 2} ${layout.height + padding * 2}`,
  });
  if (standalone) {
    svg.style.background = '#ffffff';
    svg.style.color = inkColor;
    // Without the app stylesheet, captions need their face and size inline.
    svg.setAttribute('font-family', "'IBM Plex Sans', Arial, sans-serif");
    svg.setAttribute('font-size', '11');
    svg.setAttribute('font-weight', '500');
  }

  const edgesLayer = svgEl('g', {
    class: 'chart-edges',
    fill: 'none',
    stroke: lineColor,
    'stroke-width': '1.5',
  });
  for (const edge of layout.edges) {
    edgesLayer.append(
      svgEl('path', {
        class: 'chart-edge',
        d: pathFor(edge.points),
        'data-parent': edge.parentId,
        'data-child': edge.childId,
      }),
    );
  }
  svg.append(edgesLayer);

  const nodesLayer = svgEl('g', { class: 'chart-nodes' });
  for (const node of layout.nodes) {
    const unit = node.unit;
    const group = svgEl('g', {
      class: `chart-node${unit.id === selectedId ? ' selected' : ''}`,
      transform: `translate(${node.x},${node.y})`,
      'data-unit-id': unit.id,
      tabindex: '0',
      role: 'button',
      'aria-label': `${unit.designation || unit.name || 'Unit'}${unit.id === selectedId ? ', selected' : ''}`,
    });

    const symbol = createSymbol(unit.sidc, amplifierOptions(unit, 40));
    if (standalone) symbol.setOptions({ ...PAPER_OPTIONS, infoColor: inkColor });
    const symSize = symbol.getSize();
    const symbolOffsetX = (node.width - symSize.width) / 2;
    // asDOM() returns a self-contained <svg> with its own viewBox; nest it
    // rather than copy its children so the internal coordinate space stays intact.
    const symbolEl = symbol.asDOM();
    symbolEl.setAttribute('x', symbolOffsetX);
    symbolEl.setAttribute('y', 0);
    symbolEl.classList.add('chart-symbol');
    group.append(symbolEl);

    const name = (unit.name || '').trim();
    if (name) {
      const text = svgEl('text', {
        class: 'chart-caption',
        x: node.width / 2,
        y: symSize.height + CAPTION_GAP + CAPTION_LINE_HEIGHT * 0.8,
        'text-anchor': 'middle',
        fill: inkColor,
      });
      text.textContent = name;
      group.append(text);
    }

    if (node.hasChildren && onToggleCollapse) {
      const collapsed = collapsedIds?.has(unit.id);
      const toggle = svgEl('g', {
        class: 'chart-toggle',
        transform: `translate(${node.anchorX},${node.height + CAPTION_GAP + 9})`,
        tabindex: '-1',
        'aria-hidden': 'true',
      });
      toggle.append(svgEl('circle', { r: 7 }));
      const label = svgEl('text', { 'text-anchor': 'middle', y: 3 });
      label.textContent = collapsed ? '+' : '−';
      toggle.append(label);
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        onToggleCollapse(unit.id);
      });
      group.append(toggle);
    }

    if (onSelectUnit) {
      group.addEventListener('click', () => onSelectUnit(unit.id));
      group.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelectUnit(unit.id);
        }
      });
    }
    nodesLayer.append(group);
  }
  svg.append(nodesLayer);
  return svg;
}

/** A standalone SVG document string for file export: dark ink on white, named font, no `currentColor`. */
export function exportSvgString(layout, options = {}) {
  const svg = renderChart(layout, {
    ...options,
    onSelectUnit: undefined,
    onToggleCollapse: undefined,
    standalone: true,
  });
  svg.setAttribute('xmlns', SVG_NS);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${svg.outerHTML}`;
}
