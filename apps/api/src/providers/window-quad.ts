/*
 * The four corners of a window from a segmentation mask (SAM 2's, see window-segmenter.ts), as pure maths on a binary mask: no model, no
 * network. A window's mask is rarely a clean rectangle: a lamp or a curtain bites a notch out of a side, the edge is ragged, the sill
 * sticks out below, a pane's reflection leaves holes. So the corners are not taken from the contour's own corners: the OUTER contour's pixels
 * are sorted into the four sides by which way they face (left, right, top, bottom, each within 35 degrees of its axis: a photo of a
 * window is taken upright), a straight line is fitted to each side by RANSAC (a notch or a spike is a few outliers, not the line), and
 * the corners are where neighbouring lines cross. Holes inside the mask do not matter (only the outer contour is used).
 *
 * The answer carries how good the fit is: `fill` (the share of the quad the mask covers), `coverage` (the share of the mask inside the quad),
 * `residual` (how far the contour is from the lines, as a share of the window's size) and `support` (the share of the quad's perimeter
 * that the contour actually lies along: a side hidden behind a curtain has little), folded into one `quality` between 0 and 1.
 */

export type Pt = { x: number; y: number };
export type Corners = [Pt, Pt, Pt, Pt];

export type QuadFit = {
  /** TL, TR, BR, BL in the mask's pixels (the pixel grid's own coordinates: a pixel's top-left corner is (x, y)). */
  corners: Corners;
  /** 0..1: fill * coverage * a penalty for the contour's roughness * (0.5 + half the least supported side's share). */
  quality: number;
  fill: number;
  coverage: number;
  /** Root-mean-square distance of the contour's pixels from their lines, as a share of the square root of the quad's area. */
  residual: number;
  /** The least supported side: the share of its length that has contour pixels along it (0..1). */
  support: number;
  /** The quad's area, pixels. */
  area: number;
};

/** How far from an axis a boundary pixel's outward normal may be and still belong to that side (degrees). */
const SIDE_TOLERANCE_DEG = 35;
/** The window of exterior pixels that gives a boundary pixel its outward normal (a radius in pixels). */
const NORMAL_RADIUS = 4;
/** A side's line may lean this far from its axis (as a slope: 0.7 is 35 degrees). */
const MAX_SLOPE = 0.7;
const RANSAC_ROUNDS = 240;
/** A side needs at least this many contour pixels, and the mask at least this share of the picture. */
const MIN_SIDE_POINTS = 12;
const MIN_AREA_SHARE = 0.004;
/** A fitted side lying within this many pixels of the picture's edge is a window that runs off the picture: it cannot be measured. */
const EDGE_MARGIN_PX = 2;
/** `residual` at which the roughness penalty reaches zero. */
const RESIDUAL_LIMIT = 0.03;

type Line = { /** `u` as a function of `v`: u = slope * v + offset. For left/right sides u is x and v is y; for top/bottom u is y and v is x. */ slope: number; offset: number };

/** A small deterministic generator, so the same mask always gives the same quad. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Marks, in `into`, every pixel 4-connected to `start` through pixels where `ok` says so; returns how many it marked (0 when `start` was already marked or not ok). */
function flood(start: number, w: number, h: number, into: Uint8Array, ok: (p: number) => boolean, stack: Int32Array): number {
  if (into[start] === 1 || !ok(start)) return 0;
  let top = 0;
  let count = 0;
  into[start] = 1;
  stack[top++] = start;
  while (top > 0) {
    const p = stack[--top]!;
    count++;
    const x = p % w;
    const neighbours = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < (h - 1) * w ? p + w : -1];
    for (const q of neighbours) {
      if (q >= 0 && into[q] === 0 && ok(q)) {
        into[q] = 1;
        stack[top++] = q;
      }
    }
  }
  return count;
}

/** The largest 4-connected group of set pixels, as a 0/1 mask; null when the mask is empty. */
function largestComponent(mask: Uint8Array, w: number, h: number): { comp: Uint8Array; area: number } | null {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const set = (p: number) => mask[p] !== 0;
  let best: { start: number; area: number } | null = null;
  for (let i = 0; i < w * h; i++) {
    const area = set(i) ? flood(i, w, h, seen, set, stack) : 0;
    if (area > 0 && (best === null || area > best.area)) best = { start: i, area };
  }
  if (best === null) return null;
  // The winner again, on its own (the pass above only says which pixels were seen)
  const comp = new Uint8Array(w * h);
  flood(best.start, w, h, comp, set, stack);
  return { comp, area: best.area };
}

/** What the component does not hold and cannot reach from the picture's edge is inside it (holes); `exterior` is the rest. */
function exteriorOf(comp: Uint8Array, w: number, h: number): Uint8Array {
  const ext = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const free = (p: number) => comp[p] === 0;
  for (let x = 0; x < w; x++) {
    flood(x, w, h, ext, free, stack);
    flood((h - 1) * w + x, w, h, ext, free, stack);
  }
  for (let y = 0; y < h; y++) {
    flood(y * w, w, h, ext, free, stack);
    flood(y * w + w - 1, w, h, ext, free, stack);
  }
  return ext;
}

type Edge = { x: number; y: number; side: 0 | 1 | 2 | 3 };

/** The component's outer boundary pixels, each with the side it faces: 0 left, 1 right, 2 top, 3 bottom (or none: a corner or a diagonal). */
function boundary(comp: Uint8Array, ext: Uint8Array, w: number, h: number): Edge[] {
  const out: Edge[] = [];
  const tol = Math.cos((SIDE_TOLERANCE_DEG * Math.PI) / 180);
  const outside = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h || ext[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (comp[y * w + x] === 0) continue;
      if (!(outside(x - 1, y) || outside(x + 1, y) || outside(x, y - 1) || outside(x, y + 1))) continue;
      // Which way is "out": the mean direction to the exterior pixels round it
      let nx = 0;
      let ny = 0;
      for (let dy = -NORMAL_RADIUS; dy <= NORMAL_RADIUS; dy++) {
        for (let dx = -NORMAL_RADIUS; dx <= NORMAL_RADIUS; dx++) {
          if (outside(x + dx, y + dy)) {
            nx += dx;
            ny += dy;
          }
        }
      }
      const len = Math.hypot(nx, ny);
      if (len < 1e-9) continue;
      nx /= len;
      ny /= len;
      let side: Edge['side'] | null = null;
      if (-nx >= tol) side = 0;
      else if (nx >= tol) side = 1;
      else if (-ny >= tol) side = 2;
      else if (ny >= tol) side = 3;
      if (side !== null) out.push({ x: x + 0.5, y: y + 0.5, side });
    }
  }
  return out;
}

/** A line through points u = slope * v + offset by RANSAC, then least squares on the inliers. Null when no line has enough support. */
function fitLine(vs: number[], us: number[], threshold: number, seed: number): { line: Line; inliers: number[] } | null {
  const n = vs.length;
  if (n < MIN_SIDE_POINTS) return null;
  const rand = rng(seed);
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const v of vs) {
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  const minSpan = (vMax - vMin) * 0.2;
  let best: Line | null = null;
  let bestCount = 0;
  for (let r = 0; r < RANSAC_ROUNDS; r++) {
    const i = Math.floor(rand() * n);
    const j = Math.floor(rand() * n);
    const dv = vs[j]! - vs[i]!;
    if (Math.abs(dv) < minSpan) continue;
    const slope = (us[j]! - us[i]!) / dv;
    if (Math.abs(slope) > MAX_SLOPE) continue;
    const offset = us[i]! - slope * vs[i]!;
    let count = 0;
    for (let k = 0; k < n; k++) if (Math.abs(us[k]! - (slope * vs[k]! + offset)) <= threshold) count++;
    if (count > bestCount) {
      bestCount = count;
      best = { slope, offset };
    }
  }
  if (best === null || bestCount < MIN_SIDE_POINTS) return null;
  let line = best;
  let inliers: number[] = [];
  for (let pass = 0; pass < 3; pass++) {
    inliers = [];
    for (let k = 0; k < n; k++) if (Math.abs(us[k]! - (line.slope * vs[k]! + line.offset)) <= threshold) inliers.push(k);
    if (inliers.length < MIN_SIDE_POINTS) return null;
    let sv = 0;
    let su = 0;
    for (const k of inliers) {
      sv += vs[k]!;
      su += us[k]!;
    }
    const mv = sv / inliers.length;
    const mu = su / inliers.length;
    let cvv = 0;
    let cvu = 0;
    for (const k of inliers) {
      cvv += (vs[k]! - mv) ** 2;
      cvu += (vs[k]! - mv) * (us[k]! - mu);
    }
    if (cvv < 1e-9) return null;
    const slope = cvu / cvv;
    line = { slope, offset: mu - slope * mv };
  }
  return Math.abs(line.slope) > MAX_SLOPE ? null : { line, inliers };
}

/** Where a left/right line (x = a y + b) and a top/bottom line (y = c x + d) cross. */
function cross(vertical: Line, horizontal: Line): Pt | null {
  const den = 1 - vertical.slope * horizontal.slope;
  if (Math.abs(den) < 1e-6) return null;
  const x = (vertical.slope * horizontal.offset + vertical.offset) / den;
  return { x, y: horizontal.slope * x + horizontal.offset };
}

const area2 = (q: Pt[]): number => {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % q.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s;
};

/** A quad that is convex and wound clockwise on the screen (TL, TR, BR, BL with y down). */
function isConvexClockwise(q: Corners): boolean {
  if (area2(q) <= 0) return false;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0) return false;
  }
  return true;
}

/** How many of the `filled` pixels (a 0/1 picture) lie inside a convex quad (pixel centres). */
function countInside(filled: Uint8Array, w: number, h: number, q: Corners): number {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of q) {
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  let total = 0;
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y++) {
    const cy = y + 0.5;
    let xa = Infinity;
    let xb = -Infinity;
    for (let i = 0; i < 4; i++) {
      const a = q[i]!;
      const b = q[(i + 1) % 4]!;
      if ((a.y <= cy && b.y > cy) || (b.y <= cy && a.y > cy)) {
        const x = a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x);
        xa = Math.min(xa, x);
        xb = Math.max(xb, x);
      }
    }
    if (xa > xb) continue;
    for (let x = Math.max(0, Math.ceil(xa - 0.5)); x <= Math.min(w - 1, Math.floor(xb - 0.5)); x++) total += filled[y * w + x]!;
  }
  return total;
}

/**
 * The window's four corners from a binary mask (`w` x `h`, row-major, nonzero = window), or null when there is no believable
 * quadrilateral in it: nothing there, a side the contour does not run along, a window cut off by the picture's edge, a shape that is not convex.
 */
export function fitWindowQuad(mask: Uint8Array, w: number, h: number, seed = 20261022): QuadFit | null {
  if (mask.length !== w * h || w < 8 || h < 8) return null;
  const found = largestComponent(mask, w, h);
  if (found === null || found.area < MIN_AREA_SHARE * w * h) return null;
  const ext = exteriorOf(found.comp, w, h);
  // The component and the holes in it: what the window covers, glass included
  const filled = new Uint8Array(w * h);
  let filledArea = 0;
  for (let i = 0; i < w * h; i++) {
    if (ext[i] === 0) {
      filled[i] = 1;
      filledArea++;
    }
  }
  const edges = boundary(found.comp, ext, w, h);
  const threshold = Math.max(1.5, 0.004 * Math.max(w, h));
  const lines: { line: Line; inliers: number[]; vs: number[]; us: number[] }[] = [];
  for (const side of [0, 1, 2, 3] as const) {
    const mine = edges.filter((e) => e.side === side);
    // Left and right are lines x(y); top and bottom are lines y(x)
    const vertical = side < 2;
    const vs = mine.map((e) => (vertical ? e.y : e.x));
    const us = mine.map((e) => (vertical ? e.x : e.y));
    const fit = fitLine(vs, us, threshold, seed + side);
    if (fit === null) return null;
    lines.push({ ...fit, vs, us });
  }
  const [left, right, top, bottom] = lines as [(typeof lines)[number], (typeof lines)[number], (typeof lines)[number], (typeof lines)[number]];
  const tl = cross(left.line, top.line);
  const tr = cross(right.line, top.line);
  const br = cross(right.line, bottom.line);
  const bl = cross(left.line, bottom.line);
  if (tl === null || tr === null || br === null || bl === null) return null;
  const corners: Corners = [tl, tr, br, bl];
  if (!isConvexClockwise(corners)) return null;
  const quadArea = area2(corners) / 2;
  if (quadArea < MIN_AREA_SHARE * w * h) return null;
  // A side on the picture's own edge: the window runs off the picture
  const near = (p: Pt) => p.x < EDGE_MARGIN_PX || p.y < EDGE_MARGIN_PX || p.x > w - EDGE_MARGIN_PX || p.y > h - EDGE_MARGIN_PX;
  const sideAt = (l: (typeof lines)[number], vertical: boolean) => {
    const vMid = (Math.min(...l.vs) + Math.max(...l.vs)) / 2;
    const u = l.line.slope * vMid + l.line.offset;
    return vertical ? { x: u, y: vMid } : { x: vMid, y: u };
  };
  if (near(sideAt(left, true)) || near(sideAt(right, true)) || near(sideAt(top, false)) || near(sideAt(bottom, false))) return null;

  const inside = countInside(filled, w, h, corners);
  const fill = Math.min(1, inside / quadArea);
  const coverage = filledArea > 0 ? Math.min(1, inside / filledArea) : 0;
  // How rough the contour is round its lines, and how much of each side it runs along
  let sq = 0;
  let count = 0;
  for (const l of lines) {
    for (const k of l.inliers) {
      const d = (l.us[k]! - (l.line.slope * l.vs[k]! + l.line.offset)) / Math.hypot(1, l.line.slope);
      sq += d * d;
      count++;
    }
  }
  const residual = Math.sqrt(sq / Math.max(count, 1)) / Math.sqrt(quadArea);
  const sideLength = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const lengths = [sideLength(tl, bl), sideLength(tr, br), sideLength(tl, tr), sideLength(bl, br)];
  const support = Math.min(...lines.map((l, i) => Math.min(1, l.inliers.length / Math.max(lengths[i]!, 1))));
  const quality = fill * coverage * Math.max(0, 1 - residual / RESIDUAL_LIMIT) * (0.5 + 0.5 * support);
  return { corners, quality, fill, coverage, residual, support, area: quadArea };
}

/** A binary mask drawn from a convex polygon (pixel centres inside it), for tests and the script. */
export function polygonMask(w: number, h: number, poly: Pt[]): Uint8Array {
  const out = new Uint8Array(w * h);
  const q = poly as Corners;
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5;
    let xa = Infinity;
    let xb = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = q[i]!;
      const b = q[(i + 1) % poly.length]!;
      if ((a.y <= cy && b.y > cy) || (b.y <= cy && a.y > cy)) {
        const x = a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x);
        xa = Math.min(xa, x);
        xb = Math.max(xb, x);
      }
    }
    for (let x = Math.max(0, Math.ceil(xa - 0.5)); x <= Math.min(w - 1, Math.floor(xb - 0.5)); x++) out[y * w + x] = 1;
  }
  return out;
}
