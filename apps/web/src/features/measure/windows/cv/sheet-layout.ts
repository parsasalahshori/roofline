// The printable measuring sheet: a 3 x 4 grid of ArUco markers (dictionary ARUCO_MIP_36h12: 6 x 6 bits inside a one-cell
// black border, at least 12 bits between any two codes, so a misread is practically impossible), a ruler to check
// the printer did not scale the page, and short instructions. Letter and A4 use different marker ids, so the engine
// knows which paper it sees. Units are inches from the paper's top-left corner, portrait.
import type { Pt } from '@roofline/shared';
import { SHEET_PAPER_IN, type CalibrationSheet, type SheetPaper } from '@roofline/shared';
import { AR } from './vendor/js-aruco2/aruco.js';

export const SHEET_DICTIONARY = 'ARUCO_MIP_36h12';
/** Marker side, inches (8 cells of 15/64 in). */
export const MARKER_IN = 1.875;
export const MARKER_CELLS = 8;
const COLS = 3;
const ROWS = 4;
const MARGIN_IN = 0.5;
/** Markers fill the top 8.7 in below the margin; the ruler and the words go underneath. */
const MARKER_BAND_IN = 8.7;
/** Sheet A and sheet B (two sheets on one big window) use different markers, so the engine knows which is which. */
const FIRST_ID: Record<SheetPaper, [number, number]> = { letter: [0, 24], a4: [12, 36] };
export type SheetIndex = 0 | 1;

export type SheetMarker = { id: number; x: number; y: number; size: number; bits: string };
export type SheetLayout = { paper: SheetPaper; index: SheetIndex; widthIn: number; heightIn: number; markers: SheetMarker[] };

let codes: string[] | null = null;
/** The dictionary's codes as 36-character bit strings, row-major, '1' = white cell. */
function markerBits(id: number): string {
  if (codes === null) {
    const d = AR.DICTIONARIES[SHEET_DICTIONARY]!;
    codes = d.codeList.map((c) => (typeof c === 'number' ? c : parseInt(String(c), 16)).toString(2).padStart(d.nBits, '0'));
  }
  return codes[id]!;
}

const layouts = new Map<string, SheetLayout>();
export function sheetLayout(paper: SheetPaper, index: SheetIndex = 0): SheetLayout {
  const key = `${paper}${index}`;
  const hit = layouts.get(key);
  if (hit !== undefined) return hit;
  const { widthIn, heightIn } = SHEET_PAPER_IN[paper];
  const gapX = (widthIn - 2 * MARGIN_IN - COLS * MARKER_IN) / (COLS - 1);
  const gapY = (MARKER_BAND_IN - ROWS * MARKER_IN) / (ROWS - 1);
  const markers: SheetMarker[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const id = FIRST_ID[paper][index] + r * COLS + c;
      markers.push({ id, x: MARGIN_IN + c * (MARKER_IN + gapX), y: MARGIN_IN + r * (MARKER_IN + gapY), size: MARKER_IN, bits: markerBits(id) });
    }
  }
  const layout = { paper, index, widthIn, heightIn, markers };
  layouts.set(key, layout);
  return layout;
}

/** Which paper (and which marker) an id belongs to; null for ids not on either sheet. */
export function markerById(id: number): { layout: SheetLayout; marker: SheetMarker } | null {
  for (const paper of ['letter', 'a4'] as const) {
    for (const index of [0, 1] as const) {
      const layout = sheetLayout(paper, index);
      const marker = layout.markers.find((m) => m.id === id);
      if (marker !== undefined) return { layout, marker };
    }
  }
  return null;
}

/** A marker's outer corners on the sheet, inches: TL, TR, BR, BL (the order the detector returns them in). */
export function markerCornersIn(m: SheetMarker): [Pt, Pt, Pt, Pt] {
  return [
    [m.x, m.y],
    [m.x + m.size, m.y],
    [m.x + m.size, m.y + m.size],
    [m.x, m.y + m.size],
  ];
}

/** Whether the sheet is black at (x, y) inches: the markers only (the renderer adds the ruler and words). */
export function markerInk(layout: SheetLayout, x: number, y: number): boolean {
  for (const m of layout.markers) {
    if (x < m.x || y < m.y || x >= m.x + m.size || y >= m.y + m.size) continue;
    const cell = m.size / MARKER_CELLS;
    const i = Math.floor((y - m.y) / cell);
    const j = Math.floor((x - m.x) / cell);
    if (i === 0 || j === 0 || i === MARKER_CELLS - 1 || j === MARKER_CELLS - 1) return true;
    return m.bits[(i - 1) * (MARKER_CELLS - 2) + (j - 1)] === '0';
  }
  return false;
}

/** The ruler under the markers: inches on letter (6 in), centimetres on A4 (15 cm), with its length printed. */
export function rulerSpec(paper: SheetPaper): { x: number; y: number; lengthIn: number; ticks: { at: number; len: number }[]; label: string } {
  const y = MARGIN_IN + MARKER_BAND_IN + 0.45;
  if (paper === 'letter') {
    const ticks = Array.from({ length: 6 * 8 + 1 }, (_, i) => ({ at: i / 8, len: i % 8 === 0 ? 0.3 : i % 4 === 0 ? 0.2 : i % 2 === 0 ? 0.14 : 0.09 }));
    return { x: MARGIN_IN, y, lengthIn: 6, ticks, label: 'This ruler must measure exactly 6 in. If it does not, print again at 100% (Actual size).' };
  }
  const ticks = Array.from({ length: 15 * 10 + 1 }, (_, i) => ({ at: i / 25.4, len: i % 10 === 0 ? 0.3 : i % 5 === 0 ? 0.2 : 0.1 }));
  return { x: MARGIN_IN, y, lengthIn: 15 / 2.54, ticks, label: 'This ruler must measure exactly 15 cm. If it does not, print again at 100% (Actual size).' };
}

const fmt = (v: number) => String(Math.round(v * 10000) / 10000);

/** The printable sheet as an SVG sized in real inches (print at 100%). */
export function calibrationSheetSvg(paper: SheetPaper, index: SheetIndex = 0): CalibrationSheet {
  const layout = sheetLayout(paper, index);
  const parts: string[] = [];
  for (const m of layout.markers) {
    const cell = m.size / MARKER_CELLS;
    // One rect per run of black cells in a row keeps the file small and the edges exact.
    for (let i = 0; i < MARKER_CELLS; i++) {
      let j = 0;
      while (j < MARKER_CELLS) {
        const black = (jj: number) => markerInk(layout, m.x + (jj + 0.5) * cell, m.y + (i + 0.5) * cell);
        if (!black(j)) {
          j++;
          continue;
        }
        let k = j;
        while (k < MARKER_CELLS && black(k)) k++;
        parts.push(`<rect x="${fmt(m.x + j * cell)}" y="${fmt(m.y + i * cell)}" width="${fmt((k - j) * cell)}" height="${fmt(cell)}"/>`);
        j = k;
      }
    }
  }
  const r = rulerSpec(paper);
  const ruler = [`<rect x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.lengthIn)}" height="0.012"/>`, ...r.ticks.map((t) => `<rect x="${fmt(r.x + t.at - 0.006)}" y="${fmt(r.y)}" width="0.012" height="${fmt(t.len)}"/>`)];
  const unit = paper === 'letter' ? 'in' : 'cm';
  const numbers = r.ticks
    .filter((_, i) => (paper === 'letter' ? i % 8 === 0 : i % 10 === 0))
    .map((t, i) => `<text x="${fmt(r.x + t.at + 0.03)}" y="${fmt(r.y + 0.45)}" font-size="0.14">${i}${i === 0 ? ` ${unit}` : ''}</text>`);
  const textY = r.y + 0.8;
  const words = [
    `<text x="${fmt(MARGIN_IN)}" y="${fmt(textY)}" font-size="0.15" font-weight="bold">Window measuring sheet ${index === 0 ? 'A' : 'B'} (${paper === 'letter' ? 'US Letter' : 'A4'})${index === 1 ? ': tape it in the corner of the glass opposite sheet A' : ''}</text>`,
    `<text x="${fmt(MARGIN_IN)}" y="${fmt(textY + 0.24)}" font-size="0.13">${r.label}</text>`,
    `<text x="${fmt(MARGIN_IN)}" y="${fmt(textY + 0.44)}" font-size="0.13">Tape it flat on the glass with every square in view. Photograph the whole window with the 1x camera.</text>`,
  ];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(layout.widthIn)}in" height="${fmt(layout.heightIn)}in" viewBox="0 0 ${fmt(layout.widthIn)} ${fmt(layout.heightIn)}">` +
    `<rect width="100%" height="100%" fill="#fff"/><g fill="#000" font-family="Helvetica, Arial, sans-serif">${parts.join('')}${ruler.join('')}${numbers.join('')}${words.join('')}</g></svg>`;
  return { paper, svg, widthIn: layout.widthIn, heightIn: layout.heightIn, rulerIn: r.lengthIn };
}
