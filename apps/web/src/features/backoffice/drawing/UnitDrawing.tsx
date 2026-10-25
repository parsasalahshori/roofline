import type { GridType, Layout, OpeningKind, UnitShape } from '@roofline/shared';
import { useId } from 'react';
import { formatInches } from './inches.ts';
import { placeDividers, placeSections, type PlacedSection, type Rect } from './layout.ts';

export type DrawnUnit = {
  widthIn: number;
  heightIn: number;
  shape: UnitShape;
  layout: Layout;
  gridType: GridType;
};

export type UnitDrawingProps = {
  design: DrawnUnit;
  /** The frame's colour as a CSS colour (see frameColorHex). */
  frameColor?: string;
  /** Show the width and height lines (inches, 1/8 fractions). */
  dimensions?: boolean;
  /** Draw the opening symbols (dashed triangles, arrows). Off for the house photo. */
  symbols?: boolean;
  /** The glass colour; a see-through one lets the photo show behind it. */
  glass?: string;
  /** Marks one section (the editor's current choice). */
  selectedSectionId?: string | null;
  /** The drawing's accessible name; without it the drawing is decorative. */
  label?: string;
  className?: string;
};

export type ViewBox = { x: number; y: number; w: number; h: number };

// Colours come from the page (--dr-* in the back office's light and dark sets); the fallbacks are the light look.
const INK = 'var(--dr-ink, #1b2430)';
const SYMBOL = 'var(--dr-symbol, #2050e6)';
const SELECTED = 'var(--dr-select, rgba(32, 80, 230, 0.22))';
const DEFAULT_GLASS = 'var(--dr-glass, #dcebf3)';

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const archRise = (w: number, h: number) => Math.min(w / 2, h * 0.45);

/** Frame thickness, inches. */
export const frameThickness = (w: number, h: number): number => clamp(Math.min(w, h) * 0.055, 1.25, 3.5);
const mullionThickness = (f: number) => f * 0.75;
const gridBarThickness = (w: number, h: number) => clamp(Math.min(w, h) * 0.02, 0.5, 1);

/** Room around the unit for the dimension lines, inches. */
function margins(w: number, h: number, dimensions: boolean) {
  const big = Math.max(w, h);
  const fontIn = clamp(big * 0.06, 2.4, 8);
  const pad = Math.max(fontIn * 0.25, 0.6);
  return dimensions ? { pad, fontIn, right: fontIn * 2.8, bottom: fontIn * 2.6, left: pad, top: pad } : { pad, fontIn, right: pad, bottom: pad, left: pad, top: pad };
}

/** The drawing's viewBox in inches: the unit at (0,0) to (width,height) plus room for the dimension lines. Used to place editor overlays exactly on the drawing. */
export function unitViewBox(widthIn: number, heightIn: number, dimensions = false): ViewBox {
  const m = margins(widthIn, heightIn, dimensions);
  return { x: -m.left, y: -m.top, w: widthIn + m.left + m.right, h: heightIn + m.top + m.bottom };
}

/** The outline of the unit's shape inside a box. */
export function shapePath(shape: UnitShape, x: number, y: number, w: number, h: number): string {
  if (shape === 'circle') {
    return `M${x},${y + h / 2}A${w / 2},${h / 2} 0 1 1 ${x + w},${y + h / 2}A${w / 2},${h / 2} 0 1 1 ${x},${y + h / 2}Z`;
  }
  if (shape === 'arch-top') {
    const rise = archRise(w, h);
    return `M${x},${y + h}V${y + rise}A${w / 2},${rise} 0 0 1 ${x + w},${y + rise}V${y + h}Z`;
  }
  return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
}

/** "3x2" -> 3 lites wide, 2 high; '' or a bad pattern -> null. */
export function parsePattern(pattern: string): { across: number; down: number } | null {
  const m = /^([1-9])x([1-9])$/.exec(pattern);
  return m ? { across: Number(m[1]), down: Number(m[2]) } : null;
}

/** Which of the (count - 1) bars to draw: colonial draws all, prairie only the ones near the edges. */
export function barIndexes(count: number, type: GridType): number[] {
  const all = Array.from({ length: Math.max(count - 1, 0) }, (_, i) => i + 1);
  if (type === 'prairie' && count >= 4) return [1, count - 1];
  return all;
}

/** A hung window's grid is "top/bottom"; anything else uses its one pattern. */
export function sashPatterns(grid: string): { top: string; bottom: string } {
  const [top = '', bottom] = grid.split('/');
  return { top, bottom: bottom ?? top };
}

type Symbol = { symbol: string; d: string };

/** The opening symbol for a glass area, or null for a fixed one. Casement/awning/hopper: dashed triangle pointing to the hinge. Sliders: an arrow. */
export function openingSymbol(opening: OpeningKind, g: Rect): Symbol | null {
  const inset = Math.min(g.w, g.h) * 0.08;
  const x0 = g.x + inset;
  const x1 = g.x + g.w - inset;
  const y0 = g.y + inset;
  const y1 = g.y + g.h - inset;
  const cx = g.x + g.w / 2;
  const cy = g.y + g.h / 2;
  switch (opening) {
    case 'casement-left':
      return { symbol: 'triangle-left', d: `M${x0},${cy}L${x1},${y0}L${x1},${y1}Z` };
    case 'casement-right':
      return { symbol: 'triangle-right', d: `M${x1},${cy}L${x0},${y0}L${x0},${y1}Z` };
    case 'awning':
      return { symbol: 'triangle-top', d: `M${cx},${y0}L${x0},${y1}L${x1},${y1}Z` };
    case 'hopper':
      return { symbol: 'triangle-bottom', d: `M${cx},${y1}L${x0},${y0}L${x1},${y0}Z` };
    case 'slide-left':
    case 'door-slide-left':
      return { symbol: 'arrow-left', d: arrow(cx, cy, 'left', g) };
    case 'slide-right':
    case 'door-slide-right':
      return { symbol: 'arrow-right', d: arrow(cx, cy, 'right', g) };
    case 'hung-sash':
      return { symbol: 'arrow-up', d: arrow(cx, cy, 'up', g) };
    default:
      return null;
  }
}

function arrow(cx: number, cy: number, dir: 'left' | 'right' | 'up', g: Rect): string {
  const head = Math.min(g.w, g.h) * 0.1;
  if (dir === 'up') {
    const len = g.h * 0.55;
    const top = cy - len / 2;
    return `M${cx},${cy + len / 2}V${top}M${cx - head},${top + head}L${cx},${top}L${cx + head},${top + head}`;
  }
  const len = g.w * 0.55;
  const sign = dir === 'left' ? -1 : 1;
  const tip = cx + (sign * len) / 2;
  const tail = cx - (sign * len) / 2;
  return `M${tail},${cy}H${tip}M${tip - sign * head},${cy - head}L${tip},${cy}L${tip - sign * head},${cy + head}`;
}

/** The glass of a section: its rectangle less the frame on outer edges and half a mullion on inner ones. */
export function glassRect(r: Rect, unitW: number, unitH: number): Rect {
  const f = frameThickness(unitW, unitH);
  const half = mullionThickness(f) / 2;
  const eps = 0.001;
  const left = r.x < eps ? f : half;
  const top = r.y < eps ? f : half;
  const right = r.x + r.w > unitW - eps ? f : half;
  const bottom = r.y + r.h > unitH - eps ? f : half;
  return { x: r.x + left, y: r.y + top, w: Math.max(r.w - left - right, 0), h: Math.max(r.h - top - bottom, 0) };
}

function GridBars({ area, pattern, type, thickness, color }: { area: Rect; pattern: string; type: GridType; thickness: number; color: string }) {
  const lites = parsePattern(pattern);
  if (type === 'none' || lites === null) return null;
  const across = barIndexes(lites.across, type);
  const down = barIndexes(lites.down, type);
  return (
    <g data-role="grid" data-pattern={pattern} data-grid-type={type}>
      {across.map((i) => (
        <rect key={`v${i}`} data-role="grid-bar" data-axis="vertical" x={area.x + (area.w * i) / lites.across - thickness / 2} y={area.y} width={thickness} height={area.h} fill={color} stroke={INK} strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
      ))}
      {down.map((j) => (
        <rect key={`h${j}`} data-role="grid-bar" data-axis="horizontal" x={area.x} y={area.y + (area.h * j) / lites.down - thickness / 2} width={area.w} height={thickness} fill={color} stroke={INK} strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
      ))}
    </g>
  );
}

function SymbolPath({ symbol }: { symbol: Symbol }) {
  const triangle = symbol.symbol.startsWith('triangle');
  return (
    <path
      data-role="opening-symbol"
      data-symbol={symbol.symbol}
      d={symbol.d}
      fill="none"
      stroke={SYMBOL}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={triangle ? '5 4' : undefined}
      vectorEffect="non-scaling-stroke"
    />
  );
}

function SectionDrawing({ placed, unitW, unitH, gridType, frameColor, glass, symbols, selected }: { placed: PlacedSection; unitW: number; unitH: number; gridType: GridType; frameColor: string; glass: string; symbols: boolean; selected: boolean }) {
  const g = glassRect(placed.rect, unitW, unitH);
  const { opening, grid } = placed.section;
  const f = frameThickness(unitW, unitH);
  const bar = gridBarThickness(unitW, unitH);
  const common = { 'data-section-id': placed.id, 'data-opening': opening, 'data-selected': selected ? 'true' : undefined } as const;

  if (opening === 'hung-sash') {
    const rail = mullionThickness(f);
    const mid = g.y + g.h / 2;
    const top: Rect = { x: g.x, y: g.y, w: g.w, h: g.h / 2 - rail / 2 };
    const bottom: Rect = { x: g.x, y: mid + rail / 2, w: g.w, h: g.h / 2 - rail / 2 };
    const patterns = sashPatterns(grid);
    const arrowSymbol = openingSymbol('hung-sash', bottom);
    return (
      <g data-role="section" {...common}>
        <rect data-role="glass" data-sash="top" {...top} fill={glass} stroke={INK} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <rect data-role="glass" data-sash="bottom" {...bottom} fill={glass} stroke={INK} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <rect data-role="meeting-rail" x={g.x} y={mid - rail / 2} width={g.w} height={rail} fill={frameColor} stroke={INK} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <GridBars area={top} pattern={patterns.top} type={gridType} thickness={bar} color={frameColor} />
        <GridBars area={bottom} pattern={patterns.bottom} type={gridType} thickness={bar} color={frameColor} />
        {symbols && arrowSymbol ? <SymbolPath symbol={arrowSymbol} /> : null}
        {selected ? <rect data-role="selection" {...g} fill={SELECTED} /> : null}
      </g>
    );
  }

  const symbol = openingSymbol(opening, g);
  return (
    <g data-role="section" {...common}>
      <rect data-role="glass" {...g} fill={glass} stroke={INK} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <GridBars area={g} pattern={sashPatterns(grid).top} type={gridType} thickness={bar} color={frameColor} />
      {symbols && symbol ? <SymbolPath symbol={symbol} /> : null}
      {selected ? <rect data-role="selection" {...g} fill={SELECTED} /> : null}
    </g>
  );
}

function Dimensions({ w, h, m }: { w: number; h: number; m: ReturnType<typeof margins> }) {
  const gap = m.fontIn * 0.8;
  const tick = m.fontIn * 0.3;
  const yLine = h + gap;
  const xLine = w + gap;
  const stroke = { stroke: INK, strokeWidth: 1, vectorEffect: 'non-scaling-stroke' as const };
  return (
    <g data-role="dimensions" fontSize={m.fontIn} fill={INK} fontFamily="ui-monospace, Menlo, monospace" textAnchor="middle">
      <g data-role="dimension" data-axis="width">
        <line x1={0} y1={yLine} x2={w} y2={yLine} {...stroke} />
        <line x1={0} y1={yLine - tick} x2={0} y2={yLine + tick} {...stroke} />
        <line x1={w} y1={yLine - tick} x2={w} y2={yLine + tick} {...stroke} />
        <text x={w / 2} y={yLine + m.fontIn * 1.15} data-role="dimension-label">{`${formatInches(w)}"`}</text>
      </g>
      <g data-role="dimension" data-axis="height">
        <line x1={xLine} y1={0} x2={xLine} y2={h} {...stroke} />
        <line x1={xLine - tick} y1={0} x2={xLine + tick} y2={0} {...stroke} />
        <line x1={xLine - tick} y1={h} x2={xLine + tick} y2={h} {...stroke} />
        <text x={0} y={0} transform={`translate(${xLine + m.fontIn * 1.05} ${h / 2}) rotate(-90)`} data-role="dimension-label">{`${formatInches(h)}"`}</text>
      </g>
    </g>
  );
}

/**
 * One window or door drawn from its design: the frame in its shape, the sections its layout splits into, their grids and
 * Tommy-style opening symbols. Pure and deterministic: the same design always draws the same SVG. The viewBox is in
 * inches, so overlays can be placed with unitViewBox().
 */
export function UnitDrawing({ design, frameColor = '#f7f7f4', dimensions = false, symbols = true, glass, selectedSectionId = null, label, className }: UnitDrawingProps) {
  const rawId = useId();
  const clipId = `unit-clip-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const { widthIn: w, heightIn: h, shape, layout, gridType } = design;
  const f = frameThickness(w, h);
  const mull = mullionThickness(f);
  const m = margins(w, h, dimensions);
  const vb = unitViewBox(w, h, dimensions);
  const sections = placeSections(layout, w, h);
  const dividers = placeDividers(layout, w, h);
  const glassFill = glass ?? DEFAULT_GLASS;
  const inner = shapePath(shape, f, f, Math.max(w - 2 * f, 0), Math.max(h - 2 * f, 0));

  return (
    <svg
      className={className}
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      preserveAspectRatio="xMidYMid meet"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-unit-drawing=""
      data-shape={shape}
      data-width={w}
      data-height={h}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <clipPath id={clipId}>
          <path d={inner} />
        </clipPath>
      </defs>
      <path data-role="frame" d={shapePath(shape, 0, 0, w, h)} fill={frameColor} stroke={INK} strokeWidth={1.25} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <g data-role="sections" clipPath={`url(#${clipId})`}>
        <path d={inner} fill={glassFill} />
        {sections.map((placed) => (
          <SectionDrawing key={placed.id} placed={placed} unitW={w} unitH={h} gridType={gridType} frameColor={frameColor} glass={glassFill} symbols={symbols} selected={placed.id === selectedSectionId} />
        ))}
        {dividers.map((d) => (
          <rect
            key={`${d.splitId}-${d.index}`}
            data-role="mullion"
            data-direction={d.direction}
            x={d.direction === 'columns' ? d.pos - mull / 2 : d.rect.x}
            y={d.direction === 'columns' ? d.rect.y : d.pos - mull / 2}
            width={d.direction === 'columns' ? mull : d.rect.w}
            height={d.direction === 'columns' ? d.rect.h : mull}
            fill={frameColor}
            stroke={INK}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>
      <path data-role="frame-inner" d={inner} fill="none" stroke={INK} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {dimensions ? <Dimensions w={w} h={h} m={m} /> : null}
    </svg>
  );
}
