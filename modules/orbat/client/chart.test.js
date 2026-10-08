import { describe, expect, it } from 'vitest';
import { layoutTree } from './chart.js';

/** Deterministic fake measure: no DOM, no milsymbol. */
function fakeMeasure(node) {
  const width = 40 + ((node.id.length * 7) % 30);
  const height = 30;
  return {
    width,
    height,
    anchorTop: { x: width / 2, y: 0 },
    anchorBottom: { x: width / 2, y: height },
  };
}

function unit(id, children = []) {
  return { id, children };
}

/** Every node's axis-aligned box, in the same absolute coordinate space `layoutTree` returns. */
function boxesOf(layout) {
  return layout.nodes.map((n) => ({
    id: n.id,
    x1: n.x,
    y1: n.y,
    x2: n.x + n.width,
    y2: n.y + n.height,
  }));
}

function overlaps(a, b) {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

function assertNoOverlaps(layout) {
  const boxes = boxesOf(layout);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      expect(overlaps(boxes[i], boxes[j]), `${boxes[i].id} overlaps ${boxes[j].id}`).toBe(false);
    }
  }
}

describe('layoutTree', () => {
  it('produces one node per unit with no overlapping boxes, wide fan-out', () => {
    const tree = unit('hq', [
      unit('coy-1', [unit('pl-1'), unit('pl-2'), unit('pl-3')]),
      unit('coy-2', [unit('pl-4'), unit('pl-5'), unit('pl-6')]),
      unit('coy-3', [unit('pl-7'), unit('pl-8'), unit('pl-9')]),
    ]);
    const layout = layoutTree([tree], fakeMeasure);
    expect(layout.nodes).toHaveLength(13);
    assertNoOverlaps(layout);
  });

  it('produces no overlapping boxes for a stacked (all-leaf-children) subtree', () => {
    const tree = unit('bn', [unit('a'), unit('b'), unit('c'), unit('d'), unit('e')]);
    const layout = layoutTree([tree], fakeMeasure);
    expect(layout.nodes).toHaveLength(6);
    assertNoOverlaps(layout);
  });

  it('produces no overlapping boxes for a mix of stacked and fan subtrees, several roots', () => {
    const treeA = unit('bde', [
      unit('bn-1', [unit('a1'), unit('a2'), unit('a3'), unit('a4')]),
      unit('bn-2', [unit('b1', [unit('b1x'), unit('b1y')]), unit('b2')]),
    ]);
    const treeB = unit('bde2', [unit('c1'), unit('c2')]);
    const layout = layoutTree([treeA, treeB], fakeMeasure);
    assertNoOverlaps(layout);
  });

  it('centres a fan parent over its children span', () => {
    // hq's children (a, b, c) each have one grandchild-with-a-child and one leaf, so they aren't
    // all-leaf themselves: hq, a, b and c all fan out — the layout this centring rule applies to.
    // a/b/c are structurally identical (symmetric), so the fan stays centred regardless of how
    // each one's own box sits within its own subtree.
    const tree = unit('hq', [
      unit('a', [unit('a1', [unit('a1a')]), unit('a2')]),
      unit('b', [unit('b1', [unit('b1a')]), unit('b2')]),
      unit('c', [unit('c1', [unit('c1a')]), unit('c2')]),
    ]);
    const layout = layoutTree([tree], fakeMeasure);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const parent = byId.get('hq');
    const children = ['a', 'b', 'c'].map((id) => byId.get(id));
    const spanLeft = Math.min(...children.map((c) => c.x));
    const spanRight = Math.max(...children.map((c) => c.x + c.width));
    const parentCenter = parent.x + parent.width / 2;
    const spanCenter = (spanLeft + spanRight) / 2;
    expect(parentCenter).toBeCloseTo(spanCenter, 5);
  });

  it('every edge starts at the parent node and ends at the child node', () => {
    const tree = unit('hq', [unit('coy-1', [unit('pl-1'), unit('pl-2')]), unit('coy-2')]);
    const layout = layoutTree([tree], fakeMeasure);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    expect(layout.edges.length).toBeGreaterThan(0);
    for (const edge of layout.edges) {
      const parent = byId.get(edge.parentId);
      const child = byId.get(edge.childId);
      const start = edge.points[0];
      const end = edge.points[edge.points.length - 1];
      // Start sits on the parent's box (its bottom edge); end sits on the child's box (its top edge).
      expect(start.x).toBeGreaterThanOrEqual(parent.x - 0.01);
      expect(start.x).toBeLessThanOrEqual(parent.x + parent.width + 0.01);
      expect(start.y).toBeGreaterThanOrEqual(parent.y - 0.01);
      expect(start.y).toBeLessThanOrEqual(parent.y + parent.height + 0.01);
      expect(end.x).toBeGreaterThanOrEqual(child.x - 0.01);
      expect(end.x).toBeLessThanOrEqual(child.x + child.width + 0.01);
      expect(end.y).toBeGreaterThanOrEqual(child.y - 0.01);
      expect(end.y).toBeLessThanOrEqual(child.y + child.height + 0.01);
    }
  });

  it('a collapsed subtree (children: []) produces no descendant nodes or edges', () => {
    const expanded = unit('hq', [
      unit('coy-1', [unit('pl-1'), unit('pl-2')]),
      unit('coy-2', [unit('pl-3')]),
    ]);
    const collapsed = unit('hq', [unit('coy-1', []), unit('coy-2', [unit('pl-3')])]);
    const layoutCollapsed = layoutTree([collapsed], fakeMeasure);
    const layoutExpanded = layoutTree([expanded], fakeMeasure);
    expect(layoutExpanded.nodes.length).toBeGreaterThan(layoutCollapsed.nodes.length);
    const ids = layoutCollapsed.nodes.map((n) => n.id);
    expect(ids).not.toContain('pl-1');
    expect(ids).not.toContain('pl-2');
    expect(ids).toContain('coy-1');
    assertNoOverlaps(layoutCollapsed);
  });

  it('lays out multiple top-level roots side by side without overlap', () => {
    const roots = [unit('r1', [unit('r1a'), unit('r1b')]), unit('r2', [unit('r2a')]), unit('r3')];
    const layout = layoutTree(roots, fakeMeasure);
    assertNoOverlaps(layout);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    expect(byId.get('r1').x).toBeLessThan(byId.get('r2').x);
    expect(byId.get('r2').x).toBeLessThan(byId.get('r3').x);
  });
});
