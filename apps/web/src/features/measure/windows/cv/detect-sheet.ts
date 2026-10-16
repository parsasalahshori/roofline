// Finding the measuring sheet in a photo, to a small fraction of a pixel.
// 1. js-aruco2 (vendored) finds and decodes the ArUco markers on shrunken copies of the photo (it is built for
//    video-sized frames; its 5-pixel adaptive threshold sees a 12 MP photo's big markers only as outlines).
// 2. A first homography from those rough corners predicts every marker edge at full resolution.
// 3. Each marker's four outer edges are measured: grey profiles across the edge at many points along it, the edge
//    found as the centroid of the intensity step's derivative (unbiased under symmetric blur), a trimmed total-least-
//    squares line through them; corners are the intersections of adjacent edge lines. Markers the finder missed (hidden
//    by glare, too small at the low resolution) are tried too, where the prediction falls inside the photo.
// 4. A least-squares homography from all corners (window-photo-sheet.ts) with outlier trimming; steps 3-4 run twice.
import { fitSheetHomography, type Pt, type Quad, type RgbaImage, type SheetDetection, type SheetPaper } from '@roofline/shared';
import { applyH, invert3 } from '@roofline/shared';
import { fitLine, intersect, type Gray, type Line, sample, shrinkRgba, toGray } from './gray.ts';
import { MARKER_CELLS, markerById, markerCornersIn, SHEET_DICTIONARY, sheetLayout, type SheetLayout, type SheetMarker } from './sheet-layout.ts';
import { AR, type ArucoMarker } from './vendor/js-aruco2/aruco.js';

/** Detection is refused above this RMS (pixels): the server's bound is 2.5 px, this leaves it room. */
export const DETECT_MAX_RMS_PX = 2;
/** A marker smaller than this in the photo (pixels per side, 8 cells) is too small to read reliably. */
const MIN_MARKER_PX = 22;

type Found = { marker: SheetMarker; corners: Pt[] };

function findMarkers(img: RgbaImage): { layouts: SheetLayout[]; found: Found[] } | null {
  const maxSide = Math.max(img.width, img.height);
  // Finder resolutions: about 1000 and 2000 px on the long side (plus full size for small photos).
  const factors = [...new Set([Math.max(1, Math.round(maxSide / 1000)), Math.max(1, Math.round(maxSide / 2000))])];
  const detector = new AR.Detector({ dictionaryName: SHEET_DICTIONARY, maxHammingDistance: 4 });
  const byId = new Map<number, Found>();
  const papers = new Map<SheetPaper, number>();
  for (const f of factors.sort((a, b) => a - b)) {
    const small = shrinkRgba(img, f);
    let markers: ArucoMarker[];
    try {
      markers = detector.detect(small);
    } catch {
      continue;
    }
    for (const m of markers) {
      const hit = markerById(m.id);
      if (hit === null || byId.has(m.id)) continue;
      byId.set(m.id, { marker: hit.marker, corners: m.corners.map((c) => [(c.x + 0.5) * f, (c.y + 0.5) * f] as Pt) });
      papers.set(hit.layout.paper, (papers.get(hit.layout.paper) ?? 0) + 1);
    }
  }
  if (byId.size === 0) return null;
  const paper: SheetPaper = (papers.get('letter') ?? 0) >= (papers.get('a4') ?? 0) ? 'letter' : 'a4';
  const layouts = ([0, 1] as const).map((i) => sheetLayout(paper, i)).filter((l) => [...byId.values()].some((f) => l.markers.includes(f.marker)));
  const found = [...byId.values()].filter((f) => layouts.some((l) => l.markers.includes(f.marker)));
  return { layouts, found };
}

type EdgeResult = { line: Line; contrast: number } | null;

/**
 * The outer edge of a marker side from sheet point a to b (inches), predicted through H. `outward` is the sheet
 * direction away from the marker. The search reaches `reachPx` either side of the prediction (bounded by the cell).
 */
function measureEdge(g: Gray, H: number[], a: Pt, b: Pt, outward: Pt, cellIn: number, reachPx: number): EdgeResult {
  const pa = applyH(H, a);
  const pb = applyH(H, b);
  const lenPx = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
  if (!(lenPx > 8)) return null;
  const cellPx = lenPx / MARKER_CELLS;
  const reach = Math.min(reachPx, 0.75 * cellPx);
  const half = reach + 2;
  const n = Math.max(6, Math.min(80, Math.round(lenPx / 2)));
  const pts: [number, number][] = [];
  const contrasts: number[] = [];
  const step = 0.25;
  const steps = Math.ceil(half / step);
  const prof = new Float64Array(2 * steps + 1);
  for (let k = 0; k < n; k++) {
    const t = 0.12 + (0.76 * k) / (n - 1);
    const s: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const p = applyH(H, s);
    const q = applyH(H, [s[0] + outward[0] * cellIn * 0.5, s[1] + outward[1] * cellIn * 0.5]);
    let nx = q[0] - p[0];
    let ny = q[1] - p[1];
    const nl = Math.hypot(nx, ny);
    if (!(nl > 0)) continue;
    nx /= nl;
    ny /= nl;
    // Profile along the outward normal, averaged over three positions along the edge (noise).
    let ok = true;
    for (let i = -steps; i <= steps; i++) {
      const o = i * step;
      let v = 0;
      for (const tt of [-0.75, 0, 0.75]) {
        const sv = sample(g, p[0] + nx * o - ny * tt, p[1] + ny * o + nx * tt);
        if (Number.isNaN(sv)) {
          ok = false;
          break;
        }
        v += sv;
      }
      if (!ok) break;
      prof[i + steps] = v / 3;
    }
    if (!ok) continue;
    // Derivative over 1 px; outward the marker goes black -> white, so the edge is the positive peak.
    let best = -Infinity;
    let bi = -1;
    const d = (i: number) => prof[Math.min(2 * steps, i + 4)]! - prof[Math.max(0, i - 4)]!;
    const lim = Math.round(reach / step);
    for (let i = steps - lim; i <= steps + lim; i++) {
      const v = d(i);
      if (v > best) {
        best = v;
        bi = i;
      }
    }
    if (bi < 0 || !(best > 0)) continue;
    // Centroid of the derivative lobe around the peak (where it stays above half the peak).
    let lo = bi;
    let hi = bi;
    while (lo > 2 && d(lo - 1) > 0.5 * best) lo--;
    while (hi < 2 * steps - 2 && d(hi + 1) > 0.5 * best) hi++;
    let sw = 0;
    let swx = 0;
    for (let i = lo; i <= hi; i++) {
      const w = d(i) - 0.5 * best;
      sw += w;
      swx += w * (i - steps) * step;
    }
    const off = sw > 0 ? swx / sw : (bi - steps) * step;
    const contrast = prof[2 * steps]! - prof[0]!;
    if (!(contrast > 12)) continue;
    contrasts.push(contrast);
    pts.push([p[0] + nx * off, p[1] + ny * off]);
  }
  if (pts.length < Math.max(5, 0.5 * n)) return null;
  const line = fitLine(pts, 0.25);
  if (line === null || line.n < Math.max(5, 0.4 * n) || line.spread < 0.5 * 0.76 * lenPx) return null;
  contrasts.sort((x, y) => x - y);
  return { line, contrast: contrasts[Math.floor(contrasts.length / 2)]! };
}

/** The four refined outer corners of a marker (TL, TR, BR, BL), or fewer when a side could not be measured. */
function refineMarker(g: Gray, H: number[], m: SheetMarker, reachPx: number): { corners: (Pt | null)[]; rms: number } {
  const c = markerCornersIn(m);
  const cellIn = m.size / MARKER_CELLS;
  const sides: EdgeResult[] = [
    measureEdge(g, H, c[0], c[1], [0, -1], cellIn, reachPx), // top
    measureEdge(g, H, c[1], c[2], [1, 0], cellIn, reachPx), // right
    measureEdge(g, H, c[2], c[3], [0, 1], cellIn, reachPx), // bottom
    measureEdge(g, H, c[3], c[0], [-1, 0], cellIn, reachPx), // left
  ];
  const corner = (s1: EdgeResult, s2: EdgeResult): Pt | null => (s1 === null || s2 === null ? null : intersect(s1.line, s2.line));
  const rmsList = sides.filter((s): s is NonNullable<EdgeResult> => s !== null).map((s) => s.line.rms);
  return {
    corners: [corner(sides[3]!, sides[0]!), corner(sides[0]!, sides[1]!), corner(sides[1]!, sides[2]!), corner(sides[2]!, sides[3]!)],
    rms: rmsList.length > 0 ? Math.max(...rmsList) : Infinity,
  };
}

function inside(p: Pt, w: number, h: number, pad: number): boolean {
  return p[0] >= pad && p[1] >= pad && p[0] <= w - pad && p[1] <= h - pad;
}

/** The sheet in the photo with subpixel points, or null when it is not there or too small/blurred/bent to trust. */
/** One sheet (A or B) refined to subpixel points; null when it cannot carry a plane. */
function refineSheet(img: RgbaImage, g: Gray, layout: SheetLayout, found: Found[]): { sheet: Pt[]; image: Pt[]; H: number[]; rmsPx: number } | null {
  // A first plane from the finder's rough corners (several pixels off at the shrunken resolution).
  const sheetPts: Pt[] = found.flatMap((f) => markerCornersIn(f.marker));
  const imgPts: Pt[] = found.flatMap((f) => f.corners);
  let fit = sheetPts.length >= 4 ? fitSheetHomography(sheetPts, imgPts, { inlierPx: Math.max(6, 0.004 * Math.max(img.width, img.height)) }) : null;
  if (fit === null) return null;
  let reach = Math.max(4, 0.003 * Math.max(img.width, img.height));
  let result: { sheet: Pt[]; image: Pt[] } | null = null;
  for (let pass = 0; pass < 3; pass++) {
    const H = fit.H;
    const sheet: Pt[] = [];
    const image: Pt[] = [];
    for (const m of layout.markers) {
      const cornersIn = markerCornersIn(m);
      const predicted = cornersIn.map((p) => applyH(H, p));
      if (!predicted.every((p) => inside(p, img.width, img.height, 3))) continue;
      const side = Math.hypot(predicted[1]![0] - predicted[0]![0], predicted[1]![1] - predicted[0]![1]);
      if (side < MIN_MARKER_PX) continue;
      const wasFound = found.some((f) => f.marker.id === m.id);
      const r = refineMarker(g, H, m, reach);
      // A marker the finder did not decode counts only when all four edges are clean.
      const got = r.corners.filter((p) => p !== null).length;
      if (!wasFound && (got < 4 || r.rms > 0.6)) continue;
      r.corners.forEach((p, k) => {
        if (p === null) return;
        // A corner far from its prediction is a wrong edge (glare, the sash): leave it out.
        if (Math.hypot(p[0] - predicted[k]![0], p[1] - predicted[k]![1]) > reach + 1.5) return;
        sheet.push(cornersIn[k]!);
        image.push(p);
      });
    }
    if (sheet.length < 8) break;
    const next = fitSheetHomography(sheet, image, { inlierPx: Math.max(1.5, reach / 2) });
    if (next === null) break;
    fit = next;
    result = { sheet: sheet.filter((_, i) => next.inliers[i]), image: image.filter((_, i) => next.inliers[i]) };
    reach = Math.max(1.5, Math.min(reach, 4 * next.rmsPx + 1));
  }
  if (result === null || result.sheet.length < 8 || !(fit.rmsPx <= DETECT_MAX_RMS_PX) || invert3(fit.H) === null) return null;
  return { ...result, H: fit.H, rmsPx: fit.rmsPx };
}

/**
 * The sheet (or sheets A and B) in the photo with subpixel points, or null when none is there or it is too
 * small/blurred/bent to trust. With two sheets, `sheetIndex` tells which sheet each point is on.
 */
export function detectSheetSync(img: RgbaImage): SheetDetection | null {
  const markers = findMarkers(img);
  if (markers === null) return null;
  const g = toGray(img);
  const sheets = markers.layouts
    .map((layout) => ({ layout, r: refineSheet(img, g, layout, markers.found.filter((f) => layout.markers.includes(f.marker))) }))
    .filter((x): x is { layout: SheetLayout; r: NonNullable<ReturnType<typeof refineSheet>> } => x.r !== null);
  if (sheets.length === 0) return null;
  const main = sheets[0]!;
  const l = main.layout;
  const outlineIn: Pt[] = [
    [0, 0],
    [l.widthIn, 0],
    [l.widthIn, l.heightIn],
    [0, l.heightIn],
  ];
  const outline = outlineIn.map((p) => applyH(main.r.H, p)) as Quad;
  const imagePoints = sheets.flatMap((s) => s.r.image);
  const sheetPointsIn = sheets.flatMap((s) => s.r.sheet);
  const rms = Math.sqrt(sheets.reduce((a, s) => a + s.r.rmsPx ** 2 * s.r.sheet.length, 0) / sheetPointsIn.length);
  const det: SheetDetection = { paper: l.paper, imagePoints, sheetPointsIn, rmsErrorPx: rms, outline };
  if (sheets.length === 2 || main.layout.index === 1) {
    det.sheets = sheets.length;
    det.sheetIndex = sheets.flatMap((s) => s.r.sheet.map(() => s.layout.index));
  }
  return det;
}
