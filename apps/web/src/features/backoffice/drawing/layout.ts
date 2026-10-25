// Pure maths for a unit's Layout: where each section and divider sits (in inches inside the outer frame), how a section
// is split, and how a divider moves (snapped to 1/8 in). The drawing, the editor's hit areas and the tests all use this.
import type { Layout, Section } from '@roofline/shared';
import { snapEighth } from './inches.ts';

/** The smallest a part of a split may be, inches (a sash narrower than this cannot be built). */
export const MIN_PART_IN = 6;

export type Rect = { x: number; y: number; w: number; h: number };
export type Direction = 'columns' | 'rows';
type SplitLayout = Extract<Layout, { kind: 'split' }>;

/** Where one section sits. */
export type PlacedSection = { id: string; section: Section; rect: Rect };

/** A divider between part `index` and part `index + 1` of a split. `pos` is its place along the split (x for columns, y for rows). */
export type PlacedDivider = {
  splitId: string;
  index: number;
  direction: Direction;
  /** Position along the axis, inches from the unit's left (columns) or top (rows). */
  pos: number;
  /** The least and most it may move to, keeping both neighbours at MIN_PART_IN. */
  min: number;
  max: number;
  /** The line the divider runs along (full extent of the split on the other axis). */
  rect: Rect;
};

/** The size of each part of a split along its axis; the last part takes what is left. Leading parts shrink if they overflow. */
export function partSizes(parts: readonly { size: number | null }[], total: number, min = MIN_PART_IN): number[] {
  const n = parts.length;
  if (n === 0) return [];
  if (n === 1) return [total];
  const lead = parts.slice(0, n - 1).map((p) => p.size ?? total / n);
  const sum = lead.reduce((a, b) => a + b, 0);
  const room = Math.max(total - min, 0);
  const scale = sum > room && sum > 0 ? room / sum : 1;
  const sized = lead.map((s) => s * scale);
  return [...sized, total - sized.reduce((a, b) => a + b, 0)];
}

const axisOf = (d: Direction, r: Rect) => (d === 'columns' ? { start: r.x, len: r.w } : { start: r.y, len: r.h });

function partRects(split: SplitLayout, rect: Rect): Rect[] {
  const { start, len } = axisOf(split.direction, rect);
  const sizes = partSizes(split.parts, len);
  let at = start;
  return sizes.map((size) => {
    const part: Rect = split.direction === 'columns' ? { x: at, y: rect.y, w: size, h: rect.h } : { x: rect.x, y: at, w: rect.w, h: size };
    at += size;
    return part;
  });
}

/** Every section with its rectangle, left to right and top to bottom. */
export function placeSections(layout: Layout, widthIn: number, heightIn: number): PlacedSection[] {
  const out: PlacedSection[] = [];
  const walk = (l: Layout, rect: Rect) => {
    if (l.kind === 'section') {
      out.push({ id: l.id, section: l, rect });
      return;
    }
    const rects = partRects(l, rect);
    l.parts.forEach((p, i) => walk(p.layout, rects[i]!));
  };
  walk(layout, { x: 0, y: 0, w: widthIn, h: heightIn });
  return out;
}

/** Every divider (between two parts of a split), with how far it may move. */
export function placeDividers(layout: Layout, widthIn: number, heightIn: number): PlacedDivider[] {
  const out: PlacedDivider[] = [];
  const walk = (l: Layout, rect: Rect) => {
    if (l.kind === 'section') return;
    const rects = partRects(l, rect);
    for (let i = 0; i < rects.length - 1; i++) {
      const a = rects[i]!;
      const b = rects[i + 1]!;
      const cols = l.direction === 'columns';
      out.push({
        splitId: l.id,
        index: i,
        direction: l.direction,
        pos: cols ? b.x : b.y,
        min: (cols ? a.x : a.y) + MIN_PART_IN,
        max: (cols ? b.x + b.w : b.y + b.h) - MIN_PART_IN,
        rect: cols ? { x: b.x, y: rect.y, w: 0, h: rect.h } : { x: rect.x, y: b.y, w: rect.w, h: 0 },
      });
    }
    l.parts.forEach((p, i) => walk(p.layout, rects[i]!));
  };
  walk(layout, { x: 0, y: 0, w: widthIn, h: heightIn });
  return out;
}

export const listSections = (layout: Layout): Section[] => (layout.kind === 'section' ? [layout] : layout.parts.flatMap((p) => listSections(p.layout)));
export const sectionCount = (layout: Layout): number => listSections(layout).length;

function mapLayout(layout: Layout, fn: (l: Layout) => Layout | null): Layout {
  const replaced = fn(layout);
  if (replaced !== null) return replaced;
  if (layout.kind === 'section') return layout;
  return { ...layout, parts: layout.parts.map((p) => ({ ...p, layout: mapLayout(p.layout, fn) })) };
}

/** Change one section's opening or grid. */
export function setSection(layout: Layout, id: string, patch: Partial<Pick<Section, 'opening' | 'grid'>>): Layout {
  return mapLayout(layout, (l) => (l.kind === 'section' && l.id === id ? { ...l, ...patch } : null));
}

let counter = 0;
/** A fresh id for a section or split. */
export function newLayoutId(): string {
  counter += 1;
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `s-${random}-${counter}`;
}

/**
 * Split a section into `count` equal parts, left to right ('columns') or top to bottom ('rows'). The first part keeps the
 * section; the others copy its opening and grid. Sizes are snapped to 1/8 in; the last part takes what is left.
 * Returns the layout unchanged when the section is missing, `count` is under 2, or the parts would be under MIN_PART_IN.
 */
export function splitSection(layout: Layout, sectionId: string, direction: Direction, count: number, widthIn: number, heightIn: number, makeId: () => string = newLayoutId): Layout {
  const placed = placeSections(layout, widthIn, heightIn).find((p) => p.id === sectionId);
  const n = Math.floor(count);
  if (!placed || n < 2) return layout;
  const total = direction === 'columns' ? placed.rect.w : placed.rect.h;
  const share = snapEighth(total / n);
  if (share < MIN_PART_IN) return layout;
  return mapLayout(layout, (l) => {
    if (l.kind !== 'section' || l.id !== sectionId) return null;
    const parts = Array.from({ length: n }, (_, i) => ({
      size: i === n - 1 ? null : share,
      layout: i === 0 ? l : ({ kind: 'section', id: makeId(), opening: l.opening, grid: l.grid } satisfies Section),
    }));
    return { kind: 'split', id: makeId(), direction, parts };
  });
}

/** Undo a split: the split holding this section becomes this one section (its opening and grid kept). */
export function mergeSection(layout: Layout, sectionId: string): Layout {
  const merge = (l: Layout): Layout | null => {
    if (l.kind === 'section') return null;
    const direct = l.parts.some((p) => p.layout.kind === 'section' && p.layout.id === sectionId);
    if (direct) return l.parts.map((p) => p.layout).find((x) => x.kind === 'section' && x.id === sectionId)!;
    return null;
  };
  return mapLayout(layout, merge);
}

/**
 * Move a divider to `pos` (inches along its axis): snapped to 1/8 and kept MIN_PART_IN from both neighbours. The part
 * before it grows or shrinks; the part after it takes the difference, so the dividers beyond stay where they were.
 */
export function moveDivider(layout: Layout, splitId: string, index: number, pos: number, widthIn: number, heightIn: number): Layout {
  const divider = placeDividers(layout, widthIn, heightIn).find((d) => d.splitId === splitId && d.index === index);
  if (!divider) return layout;
  const target = Math.min(Math.max(snapEighth(pos), Math.ceil(divider.min * 8) / 8), Math.floor(divider.max * 8) / 8);
  if (target === divider.pos) return layout;
  const delta = target - divider.pos;
  return mapLayout(layout, (l) => {
    if (l.kind !== 'split' || l.id !== splitId) return null;
    const rect = findSplitRect(layout, splitId, widthIn, heightIn);
    if (!rect) return null;
    const sizes = partSizes(l.parts, axisOf(l.direction, rect).len);
    const parts = l.parts.map((p, i) => {
      if (i === index) return { ...p, size: snapEighth(sizes[i]! + delta) };
      // The part right after takes the difference unless it is the last (which takes what is left anyway)
      if (i === index + 1 && i !== l.parts.length - 1) return { ...p, size: snapEighth(sizes[i]! - delta) };
      // Every other leading part keeps its resolved size so a null in the middle cannot drift
      return i < l.parts.length - 1 ? { ...p, size: snapEighth(sizes[i]!) } : { ...p, size: null };
    });
    return { ...l, parts };
  });
}

function findSplitRect(layout: Layout, splitId: string, widthIn: number, heightIn: number): Rect | null {
  let found: Rect | null = null;
  const walk = (l: Layout, rect: Rect) => {
    if (l.kind === 'section' || found) return;
    if (l.id === splitId) {
      found = rect;
      return;
    }
    const rects = partRects(l, rect);
    l.parts.forEach((p, i) => walk(p.layout, rects[i]!));
  };
  walk(layout, { x: 0, y: 0, w: widthIn, h: heightIn });
  return found;
}
