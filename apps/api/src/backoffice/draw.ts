import { layoutSections, sashPatterns, patternLites, sizeText, type OpeningKind, type PlacedSection, type WindowDesign } from '@roofline/shared';
import { COLOR, FONT } from './pdf-kit.ts';

/*
 * A drawn unit as vector lines, from its layout: the frame (a rectangle, an arch top or a circle), the sections, the
 * Tommy-style opening symbols seen from outside (hinge triangles, slide arrows, the meeting rail of a hung window), grids,
 * and the dimensions. No images: every line is a PDF path, so it prints sharp at any size.
 */

export type Box = { x: number; y: number; w: number; h: number };

const DASH = 3;

function arrow(d: PDFKit.PDFDocument, x1: number, y1: number, x2: number, y2: number, head: number): void {
  d.moveTo(x1, y1).lineTo(x2, y2).stroke();
  const a = Math.atan2(y2 - y1, x2 - x1);
  const spread = 0.45;
  d.moveTo(x2, y2).lineTo(x2 - head * Math.cos(a - spread), y2 - head * Math.sin(a - spread)).stroke();
  d.moveTo(x2, y2).lineTo(x2 - head * Math.cos(a + spread), y2 - head * Math.sin(a + spread)).stroke();
}

/** The symbol for how a section opens, drawn inside rectangle (x, y, w, h) in points. */
function openingSymbol(d: PDFKit.PDFDocument, opening: OpeningKind, x: number, y: number, w: number, h: number): void {
  const midX = x + w / 2;
  const midY = y + h / 2;
  const hinge = (points: [number, number][]) => {
    d.save().lineWidth(0.6).strokeColor(COLOR.secondary).dash(DASH, { space: 2 });
    d.moveTo(points[0]![0], points[0]![1]);
    for (const [px, py] of points.slice(1)) d.lineTo(px, py);
    d.stroke().undash().restore();
  };
  d.save().lineWidth(0.9).strokeColor(COLOR.secondary);
  switch (opening) {
    case 'fixed':
    case 'door-fixed':
      d.font(FONT.regular).fontSize(Math.max(5, Math.min(9, h / 6))).fillColor(COLOR.tertiary).text('FIX', x, midY - 3, { width: w, align: 'center', lineBreak: false });
      break;
    case 'hung-sash': {
      // The meeting rail across the middle, and an arrow up on the lower sash.
      d.lineWidth(0.8).strokeColor(COLOR.ink).moveTo(x, midY - 1.2).lineTo(x + w, midY - 1.2).stroke().moveTo(x, midY + 1.2).lineTo(x + w, midY + 1.2).stroke();
      d.lineWidth(0.9).strokeColor(COLOR.secondary);
      const a = Math.min(h * 0.18, 14);
      arrow(d, midX, midY + 1 + a * 1.6, midX, midY + 1 + a * 0.3, Math.min(5, a * 0.5));
      break;
    }
    case 'slide-left':
    case 'door-slide-left': {
      const len = Math.min(w * 0.5, 40);
      arrow(d, midX + len / 2, midY, midX - len / 2, midY, 5);
      break;
    }
    case 'slide-right':
    case 'door-slide-right': {
      const len = Math.min(w * 0.5, 40);
      arrow(d, midX - len / 2, midY, midX + len / 2, midY, 5);
      break;
    }
    case 'casement-left':
      hinge([[x + w, y], [x, midY], [x + w, y + h]]);
      break;
    case 'casement-right':
      hinge([[x, y], [x + w, midY], [x, y + h]]);
      break;
    case 'awning':
      hinge([[x, y + h], [midX, y], [x + w, y + h]]);
      break;
    case 'hopper':
      hinge([[x, y], [midX, y + h], [x + w, y]]);
      break;
  }
  d.restore();
}

/** Grid lines for a pattern ("3x2": 3 lites wide, 2 high) in a rectangle. */
function gridLines(d: PDFKit.PDFDocument, pattern: string, x: number, y: number, w: number, h: number): void {
  if (patternLites(pattern) === 0) return;
  const [cols, rows] = pattern.split('x').map(Number) as [number, number];
  d.save().lineWidth(0.5).strokeColor(COLOR.tertiary);
  for (let c = 1; c < cols; c++) d.moveTo(x + (w * c) / cols, y).lineTo(x + (w * c) / cols, y + h).stroke();
  for (let r = 1; r < rows; r++) d.moveTo(x, y + (h * r) / rows).lineTo(x + w, y + (h * r) / rows).stroke();
  d.restore();
}

function shapePath(d: PDFKit.PDFDocument, shape: WindowDesign['shape'], x: number, y: number, w: number, h: number): void {
  if (shape === 'circle') d.ellipse(x + w / 2, y + h / 2, w / 2, h / 2);
  else if (shape === 'arch-top') {
    const ry = Math.min(w / 2, h * 0.5);
    d.path(`M ${x} ${y + h} L ${x} ${y + ry} A ${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} L ${x + w} ${y + h} Z`);
  } else d.rect(x, y, w, h);
}

function dimension(d: PDFKit.PDFDocument, horizontal: boolean, from: number, to: number, at: number, label: string, fontSize: number): void {
  d.save().lineWidth(0.5).strokeColor(COLOR.tertiary);
  const tick = 3;
  if (horizontal) {
    d.moveTo(from, at).lineTo(to, at).stroke().moveTo(from, at - tick).lineTo(from, at + tick).stroke().moveTo(to, at - tick).lineTo(to, at + tick).stroke();
    d.font(FONT.regular).fontSize(fontSize).fillColor(COLOR.secondary).text(label, from, at + 3, { width: to - from, align: 'center', lineBreak: false });
  } else {
    d.moveTo(at, from).lineTo(at, to).stroke().moveTo(at - tick, from).lineTo(at + tick, from).stroke().moveTo(at - tick, to).lineTo(at + tick, to).stroke();
    const cx = at - 4;
    const cy = (from + to) / 2;
    d.save().rotate(-90, { origin: [cx, cy] });
    d.font(FONT.regular).fontSize(fontSize).fillColor(COLOR.secondary).text(label, cx - (to - from) / 2, cy - fontSize - 1, { width: to - from, align: 'center', lineBreak: false });
    d.restore();
  }
  d.restore();
}

/** Room for the dimension lines round a drawing, points. */
const DIM_LEFT = 20;
const DIM_BOTTOM = 18;

/**
 * Draws the unit inside `box`, as large as fits, centered. With `dimensions` the overall width goes under the unit and the
 * height beside it (and each section's width when columns split it). Returns the rectangle the frame took, in points.
 */
export function drawUnit(d: PDFKit.PDFDocument, design: WindowDesign, box: Box, opts: { dimensions?: boolean } = {}): Box {
  const dims = opts.dimensions === true;
  const padL = dims ? DIM_LEFT : 2;
  const padB = dims ? DIM_BOTTOM : 2;
  const padT = dims ? 10 : 2;
  const availW = Math.max(10, box.w - padL - 2);
  const availH = Math.max(10, box.h - padB - padT);
  const W = Math.max(1, design.widthIn);
  const H = Math.max(1, design.heightIn);
  const scale = Math.min(availW / W, availH / H);
  const fw = W * scale;
  const fh = H * scale;
  const x = box.x + padL + (availW - fw) / 2;
  const y = box.y + padT + (availH - fh) / 2;
  const frame = Math.max(1.6, Math.min(3.4, Math.min(fw, fh) * 0.045));

  d.save();
  // Glass tint, then the frame: an outer line and an inner one a frame-width inside (a scaled copy of the shape).
  shapePath(d, design.shape, x, y, fw, fh);
  d.fillColor(COLOR.fill).fill();
  d.lineWidth(1.3).strokeColor(COLOR.ink);
  shapePath(d, design.shape, x, y, fw, fh);
  d.stroke();
  d.lineWidth(0.6).strokeColor(COLOR.secondary);
  shapePath(d, design.shape, x + frame, y + frame, Math.max(1, fw - frame * 2), Math.max(1, fh - frame * 2));
  d.stroke();

  const sections: PlacedSection[] = layoutSections(design);
  for (const s of sections) {
    const sx = x + s.rect.x * scale;
    const sy = y + s.rect.y * scale;
    const sw = s.rect.w * scale;
    const sh = s.rect.h * scale;
    const rect = design.shape === 'rect';
    if (rect && sections.length > 1) {
      d.lineWidth(0.9).strokeColor(COLOR.ink).rect(sx, sy, sw, sh).stroke();
    }
    const ix = rect ? sx + (s.rect.x === 0 ? frame : 0) : sx + frame;
    const iy = rect ? sy + (s.rect.y === 0 ? frame : 0) : sy + frame;
    const iw = Math.max(1, rect ? sw - (s.rect.x === 0 ? frame : 0) - (Math.abs(s.rect.x + s.rect.w - W) < 1e-6 ? frame : 0) : sw - frame * 2);
    const ih = Math.max(1, rect ? sh - (s.rect.y === 0 ? frame : 0) - (Math.abs(s.rect.y + s.rect.h - H) < 1e-6 ? frame : 0) : sh - frame * 2);
    if (design.gridType !== 'none') {
      const patterns = sashPatterns(s.section);
      if (s.section.opening === 'hung-sash') {
        gridLines(d, patterns[0] ?? '', ix, iy, iw, ih / 2);
        gridLines(d, patterns[1] ?? '', ix, iy + ih / 2, iw, ih / 2);
      } else gridLines(d, patterns[0] ?? '', ix, iy, iw, ih);
    }
    openingSymbol(d, s.section.opening, ix, iy, iw, ih);
  }

  if (dims) {
    dimension(d, true, x, x + fw, y + fh + 6, sizeText(design.widthIn), 7);
    dimension(d, false, y, y + fh, x - 8, sizeText(design.heightIn), 7);
    const row = sections.length > 1 && sections.every((s) => s.rect.y === 0 && s.rect.h === H);
    if (row) {
      // Each section's width, just above the frame.
      for (const s of sections) {
        d.font(FONT.regular).fontSize(6).fillColor(COLOR.tertiary).text(sizeText(s.rect.w), x + s.rect.x * scale, y - 8, { width: s.rect.w * scale, align: 'center', lineBreak: false });
      }
    }
  }
  d.restore();
  return { x, y, w: fw, h: fh };
}
