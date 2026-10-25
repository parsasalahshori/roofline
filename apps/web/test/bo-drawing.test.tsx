import type { Layout, OpeningKind } from '@roofline/shared';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { frameColorHex } from '../src/features/backoffice/drawing/colors.ts';
import { formatInches, parseInches, snapEighth } from '../src/features/backoffice/drawing/inches.ts';
import { mergeSection, moveDivider, partSizes, placeDividers, placeSections, sectionCount, setSection, splitSection } from '../src/features/backoffice/drawing/layout.ts';
import { UnitDrawing, glassRect, openingSymbol, unitViewBox } from '../src/features/backoffice/drawing/UnitDrawing.tsx';

const section = (id: string, opening: OpeningKind = 'fixed', grid = ''): Layout => ({ kind: 'section', id, opening, grid });
const unit = (layout: Layout, o: Partial<{ widthIn: number; heightIn: number; shape: 'rect' | 'arch-top' | 'circle'; gridType: 'none' | 'colonial' | 'prairie' | 'custom' }> = {}) => ({
  widthIn: 60,
  heightIn: 48,
  shape: 'rect' as const,
  gridType: 'colonial' as const,
  layout,
  ...o,
});
const ids = () => {
  let n = 0;
  return () => `n${++n}`;
};

describe('inches', () => {
  it('parses what a person types', () => {
    expect(parseInches('35')).toBe(35);
    expect(parseInches('35 1/2')).toBe(35.5);
    expect(parseInches('35-3/8')).toBe(35.375);
    expect(parseInches('1/2')).toBe(0.5);
    expect(parseInches('35.5"')).toBe(35.5);
    expect(parseInches('35 1/2 in')).toBe(35.5);
    expect(parseInches('35.06')).toBe(35);
    expect(parseInches('')).toBeNull();
    expect(parseInches('abc')).toBeNull();
    expect(parseInches('3/0')).toBeNull();
    expect(parseInches('0')).toBeNull();
  });
  it('snaps and formats to eighths', () => {
    expect(snapEighth(10.07)).toBe(10.125);
    expect(snapEighth(10.06)).toBe(10);
    expect(formatInches(35.5)).toBe('35 1/2');
    expect(formatInches(59.875)).toBe('59 7/8');
  });
});

describe('layout maths', () => {
  const three: Layout = {
    kind: 'split',
    id: 'cols',
    direction: 'columns',
    parts: [
      { size: 20, layout: section('a') },
      { size: 20, layout: section('b') },
      { size: null, layout: section('c') },
    ],
  };

  it('gives the last part what is left and places sections left to right', () => {
    expect(partSizes(three.kind === 'split' ? three.parts : [], 60)).toEqual([20, 20, 20]);
    const placed = placeSections(three, 66, 48);
    expect(placed.map((p) => [p.id, p.rect.x, p.rect.w])).toEqual([['a', 0, 20], ['b', 20, 20], ['c', 40, 26]]);
    expect(placed.every((p) => p.rect.h === 48)).toBe(true);
  });

  it('shrinks overflowing parts so the last keeps its minimum', () => {
    const sizes = partSizes([{ size: 50 }, { size: 50 }, { size: null }], 60);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(60);
    expect(sizes[2]).toBeGreaterThanOrEqual(4 - 1e-9);
  });

  it('lists the dividers with how far they may move', () => {
    const d = placeDividers(three, 60, 48);
    expect(d.map((x) => [x.index, x.pos, x.min, x.max])).toEqual([[0, 20, 4, 36], [1, 40, 24, 56]]);
  });

  it('moves a divider snapped to 1/8 and the neighbour takes the difference', () => {
    const next = moveDivider(three, 'cols', 0, 24.06, 60, 48);
    const placed = placeSections(next, 60, 48);
    expect(placed.map((p) => p.rect.w)).toEqual([24, 16, 20]);
    expect(placeDividers(next, 60, 48).map((x) => x.pos)).toEqual([24, 40]);
    const fine = moveDivider(three, 'cols', 0, 24.07, 60, 48);
    expect(placeSections(fine, 60, 48)[0]!.rect.w).toBe(24.125);
  });

  it('keeps both neighbours at least 4 in', () => {
    const left = moveDivider(three, 'cols', 0, -10, 60, 48);
    expect(placeSections(left, 60, 48)[0]!.rect.w).toBe(4);
    const right = moveDivider(three, 'cols', 1, 100, 60, 48);
    const w = placeSections(right, 60, 48).map((p) => p.rect.w);
    expect(w[2]).toBe(4);
    expect(w[0]).toBe(20);
  });

  it('the divider before the last part leaves the later ones alone', () => {
    const next = moveDivider(three, 'cols', 1, 45, 60, 48);
    expect(placeSections(next, 60, 48).map((p) => [p.rect.x, p.rect.w])).toEqual([[0, 20], [20, 25], [45, 15]]);
  });

  it('splits a section into equal parts snapped to 1/8, copying opening and grid', () => {
    const base = section('one', 'casement-left', '2x2');
    const cols = splitSection(base, 'one', 'columns', 3, 35.5, 48, ids());
    const placed = placeSections(cols, 35.5, 48);
    expect(placed.map((p) => p.rect.w)).toEqual([11.875, 11.875, 11.75]);
    expect(placed.map((p) => p.id)).toEqual(['one', 'n1', 'n2']);
    expect(placed.every((p) => p.section.opening === 'casement-left' && p.section.grid === '2x2')).toBe(true);
    expect(sectionCount(cols)).toBe(3);
    const rows = splitSection(base, 'one', 'rows', 2, 35.5, 48, ids());
    expect(placeSections(rows, 35.5, 48).map((p) => p.rect.h)).toEqual([24, 24]);
  });

  it('will not split into parts under 4 in or with a count under 2', () => {
    const base = section('one');
    expect(splitSection(base, 'one', 'columns', 1, 40, 40)).toBe(base);
    expect(splitSection(base, 'one', 'columns', 11, 40, 40)).toBe(base);
    expect(splitSection(base, 'nope', 'columns', 2, 40, 40)).toBe(base);
  });

  it('splits a section inside a split, then merges it back', () => {
    const two = splitSection(section('one'), 'one', 'columns', 2, 60, 48, ids());
    const nested = splitSection(two, 'n1', 'rows', 2, 60, 48, ids());
    expect(sectionCount(nested)).toBe(3);
    const rect = placeSections(nested, 60, 48).find((p) => p.id === 'n1')!.rect;
    expect(rect).toMatchObject({ x: 30, y: 0, w: 30, h: 24 });
    const merged = mergeSection(nested, 'n1');
    expect(sectionCount(merged)).toBe(2);
    expect(placeSections(merged, 60, 48).find((p) => p.id === 'n1')!.rect).toMatchObject({ x: 30, w: 30, h: 48 });
  });

  it('sets a section opening and grid', () => {
    const two = splitSection(section('one'), 'one', 'columns', 2, 60, 48, ids());
    const next = setSection(two, 'n1', { opening: 'slide-left', grid: '3x2' });
    expect(placeSections(next, 60, 48).map((p) => [p.section.opening, p.section.grid])).toEqual([['fixed', ''], ['slide-left', '3x2']]);
  });
});

const q = (svg: Element, sel: string) => Array.from(svg.querySelectorAll(sel));

describe('UnitDrawing structure', () => {
  const draw = (layout: Layout, o: Parameters<typeof unit>[1] = {}, props: Partial<Parameters<typeof UnitDrawing>[0]> = {}) => {
    const { container } = render(<UnitDrawing design={unit(layout, o)} label="Kitchen" {...props} />);
    return container.querySelector('svg')!;
  };

  it('is deterministic for the same design', () => {
    const layout = splitSection(section('s', 'casement-left', '2x2'), 's', 'columns', 3, 60, 48, ids());
    const a = render(<UnitDrawing design={unit(layout)} frameColor="#222" dimensions />).container.innerHTML.replace(/unit-clip-[^")]+/g, 'clip');
    const b = render(<UnitDrawing design={unit(layout)} frameColor="#222" dimensions />).container.innerHTML.replace(/unit-clip-[^")]+/g, 'clip');
    expect(a).toBe(b);
  });

  it('draws one glass per section and a mullion per divider', () => {
    const layout = splitSection(section('s'), 's', 'columns', 3, 60, 48, ids());
    const svg = draw(layout);
    expect(q(svg, '[data-role=section]')).toHaveLength(3);
    expect(q(svg, '[data-role=mullion]')).toHaveLength(2);
    expect(q(svg, '[data-role=glass]')).toHaveLength(3);
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Kitchen');
  });

  it('draws the frame by shape', () => {
    expect(draw(section('s'), { shape: 'rect' }).querySelector('[data-role=frame]')!.getAttribute('d')).not.toContain('A');
    expect(draw(section('s'), { shape: 'arch-top' }).querySelector('[data-role=frame]')!.getAttribute('d')).toContain('A');
    const circle = draw(section('s'), { shape: 'circle', widthIn: 30, heightIn: 30 });
    expect(circle.getAttribute('data-shape')).toBe('circle');
    expect(q(circle, '[data-role=frame]')[0]!.getAttribute('d')?.match(/A/g)).toHaveLength(2);
  });

  it('puts a casement symbol (dashed triangle) pointing to the hinge', () => {
    const left = draw(section('s', 'casement-left')).querySelector('[data-role=opening-symbol]')!;
    expect(left.getAttribute('data-symbol')).toBe('triangle-left');
    expect(left.getAttribute('stroke-dasharray')).toBeTruthy();
    expect(left.getAttribute('d')?.endsWith('Z')).toBe(true);
    const g = glassRect({ x: 0, y: 0, w: 60, h: 48 }, 60, 48);
    // the apex is on the hinge (left) side, middle height
    const apex = openingSymbol('casement-left', g)!.d.match(/^M([\d.]+),([\d.]+)/)!;
    expect(Number(apex[1])).toBeLessThan(g.x + g.w / 2);
    expect(Number(apex[2])).toBeCloseTo(g.y + g.h / 2);
    const rightApex = openingSymbol('casement-right', g)!.d.match(/^M([\d.]+),([\d.]+)/)!;
    expect(Number(rightApex[1])).toBeGreaterThan(g.x + g.w / 2);
  });

  it('points an awning triangle up and a hopper triangle down', () => {
    const g = glassRect({ x: 0, y: 0, w: 60, h: 48 }, 60, 48);
    const top = openingSymbol('awning', g)!.d.match(/^M([\d.]+),([\d.]+)/)!;
    const bottom = openingSymbol('hopper', g)!.d.match(/^M([\d.]+),([\d.]+)/)!;
    expect(Number(top[2])).toBeLessThan(g.y + g.h / 2);
    expect(Number(bottom[2])).toBeGreaterThan(g.y + g.h / 2);
    expect(draw(section('s', 'awning')).querySelector('[data-symbol=triangle-top]')).not.toBeNull();
    expect(draw(section('s', 'hopper')).querySelector('[data-symbol=triangle-bottom]')).not.toBeNull();
  });

  it('draws an arrow for sliders and patio door panels', () => {
    expect(draw(section('s', 'slide-left')).querySelector('[data-symbol=arrow-left]')).not.toBeNull();
    expect(draw(section('s', 'slide-right')).querySelector('[data-symbol=arrow-right]')).not.toBeNull();
    expect(draw(section('s', 'door-slide-left')).querySelector('[data-symbol=arrow-left]')).not.toBeNull();
    expect(draw(section('s', 'slide-left')).querySelector('[data-symbol=arrow-left]')!.getAttribute('stroke-dasharray')).toBeNull();
  });

  it('draws a meeting rail and an up arrow on the bottom sash of a hung window', () => {
    const svg = draw(section('s', 'hung-sash'));
    expect(q(svg, '[data-role=meeting-rail]')).toHaveLength(1);
    expect(q(svg, '[data-role=glass]')).toHaveLength(2);
    const arrow = svg.querySelector('[data-symbol=arrow-up]')!;
    const rail = svg.querySelector('[data-role=meeting-rail]')!;
    const railY = Number(rail.getAttribute('y'));
    const arrowY = Number(arrow.getAttribute('d')!.match(/^M[\d.]+,([\d.]+)/)![1]);
    expect(arrowY).toBeGreaterThan(railY);
  });

  it('draws nothing for a fixed lite or a fixed door panel', () => {
    expect(draw(section('s', 'fixed')).querySelector('[data-role=opening-symbol]')).toBeNull();
    expect(draw(section('s', 'door-fixed')).querySelector('[data-role=opening-symbol]')).toBeNull();
  });

  it('can leave the symbols out (the house photo)', () => {
    expect(draw(section('s', 'casement-left'), {}, { symbols: false }).querySelector('[data-role=opening-symbol]')).toBeNull();
  });

  it('draws grids by pattern: colonial all bars, prairie edge bars, none no bars', () => {
    const bars = (type: 'none' | 'colonial' | 'prairie' | 'custom', grid: string) => q(draw(section('s', 'fixed', grid), { gridType: type }), '[data-role=grid-bar]');
    expect(bars('colonial', '3x2')).toHaveLength(2 + 1);
    expect(bars('colonial', '4x4').filter((b) => b.getAttribute('data-axis') === 'vertical')).toHaveLength(3);
    expect(bars('prairie', '4x4')).toHaveLength(4);
    expect(bars('none', '3x2')).toHaveLength(0);
    expect(bars('colonial', '')).toHaveLength(0);
  });

  it('gives a hung sash a pattern for each sash', () => {
    const svg = draw(section('s', 'hung-sash', '3x2/2x2'));
    const grids = q(svg, '[data-role=grid]');
    expect(grids.map((g) => g.getAttribute('data-pattern'))).toEqual(['3x2', '2x2']);
  });

  it('shows dimension lines in inches with fractions only when asked', () => {
    const none = draw(section('s'));
    expect(none.querySelector('[data-role=dimensions]')).toBeNull();
    const dims = draw(section('s'), { widthIn: 35.5, heightIn: 59.5 }, { dimensions: true });
    expect(q(dims, '[data-role=dimension-label]').map((t) => t.textContent)).toEqual(['35 1/2"', '59 1/2"']);
    const vb = unitViewBox(35.5, 59.5, true);
    expect(dims.getAttribute('viewBox')).toBe(`${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    expect(vb.w).toBeGreaterThan(unitViewBox(35.5, 59.5, false).w);
  });

  it('marks the selected section and takes the frame colour', () => {
    const layout = splitSection(section('a'), 'a', 'columns', 2, 60, 48, ids());
    const svg = draw(layout, {}, { selectedSectionId: 'n1', frameColor: frameColorHex('bronze') });
    expect(q(svg, '[data-selected=true]').map((s) => s.getAttribute('data-section-id'))).toEqual(['n1']);
    expect(q(svg, '[data-role=selection]')).toHaveLength(1);
    expect(svg.querySelector('[data-role=frame]')!.getAttribute('fill')).toBe('#5b4636');
    expect(frameColorHex('nope')).toBe(frameColorHex('white'));
  });

  it('is decorative without a label', () => {
    const { container } = render(<UnitDrawing design={unit(section('s'))} />);
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });
});
