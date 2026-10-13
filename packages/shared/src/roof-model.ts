// Roof model: a building footprint broken into roof facets and lines (ridge, hip, valley, eave, rake), the
// "Measure roof" drawing. Pure TypeScript, deterministic, never throws (a footprint with no area is null).
//
// How it works (all in local metres, in a frame turned to the building's dominant direction):
// 1. The ring is projected, simplified (Douglas-Peucker, 0.5 m) and, when nearly rectilinear, snapped to a
//    polygon with only horizontal and vertical edges.
// 2. The roof is the upper envelope of "tents", one per maximal rectangle inside that polygon. A tent is the
//    lowest of its rectangle's side planes (45 degrees in plan, all at the same pitch). With all four sides this
//    envelope is exactly the hip roof (the straight skeleton of an orthogonal polygon). A long rectangle
//    (length/width > 1.3) whose end sticks out of the building (its end and both sides next to it on the outline)
//    drops that end's plane, so the end becomes a gable and its edges rakes.
// 3. Each plane's facet is its rectangle's region where it is the lowest side and no other tent is higher, cut out
//    as convex pieces and glued back into rings. Lines are the edges between facets (ridge where opposite planes
//    meet, hip on a convex crease, valley on a concave one) and the outline edges (eave when level, rake when
//    sloped).
// 4. Anything else (a footprint that is not nearly rectilinear, or a result that does not cover it) is one
//    gable on the bounding rectangle, clipped to the footprint.
import { instantEstimate, perimeterFt, pitchFactor, polygonAreaSqFt, type InstantEstimate, type InstantInput, type LngLat, type Outline, type Ring } from './roof.ts';

export type RoofLineKind = 'ridge' | 'hip' | 'valley' | 'eave' | 'rake';
export interface RoofFacet {
  /** 'A', 'B', ... largest first. */
  id: string;
  /** [lng, lat] closed ring. */
  ring: [number, number][];
  planSqFt: number;
  /** Sloped area. */
  areaSqFt: number;
  /** '5/12'. */
  pitch: string;
  /** [lng, lat], a point inside the facet. */
  labelAt: [number, number];
}
export interface RoofLine {
  kind: RoofLineKind;
  coords: [[number, number], [number, number]];
  /** True (sloped) length in feet. */
  lengthFt: number;
}
export interface RoofModel {
  facets: RoofFacet[];
  lines: RoofLine[];
  /** [lng, lat] closed ring: the (cleaned) footprint the roof covers. */
  outline: [number, number][];
  pitch: string;
  totals: {
    squares: number;
    slopedSqFt: number;
    planSqFt: number;
    facetCount: number;
    wastePct: number;
    ridgeFt: number;
    hipFt: number;
    valleyFt: number;
    eaveFt: number;
    rakeFt: number;
  };
}

export const ROOF_PITCHES_X12 = [4, 5, 6, 7] as const;
export const DEFAULT_ROOF_PITCH_X12 = 5;

/** A pitch from 4/12 to 7/12 chosen from an id (FNV-1a), the same every time; 5/12 when there is no id. */
export function seededPitchX12(id: string | null | undefined): number {
  if (id === null || id === undefined || id.length === 0) return DEFAULT_ROOF_PITCH_X12;
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ROOF_PITCHES_X12[h % ROOF_PITCHES_X12.length]!;
}

export function pitchLabel(pitchX12: number): string {
  const p = Number.isFinite(pitchX12) && pitchX12 > 0 ? pitchX12 : 0;
  return `${Math.round(p * 10) / 10}/12`;
}

// ---------------------------------------------------------------------------------------------------------
// Small geometry kit (metres).

type V = { x: number; y: number };
type Poly = V[];
/** Height at unit slope: dx * x + dy * y - c (d is the up-slope direction). */
type Plane = { dx: number; dy: number; c: number };
type Tent = { poly: Poly; planes: Plane[]; box: Box };
type Box = { x0: number; y0: number; x1: number; y1: number };

const EARTH_RADIUS_M = 6371008.8;
const FT_PER_M = 3.280839895;
const EPS = 1e-7;
const WELD = 1e-3;
const MIN_PIECE_M2 = 1e-6;

const SIMPLIFY_M = 0.5;
/** Edges shorter than this are noise: dropped before snapping. */
const TINY_EDGE_M = 1.0;
/** Off-axis edges up to this long (a cut corner) are squared off; a longer one means "not rectilinear". */
const CUT_CORNER_M = 2.5;
const AXIS_TOLERANCE_DEG = 20;
/** A snapped side shorter than this is a jog: removed. */
const MIN_RUN_M = 0.8;
/** The snapped footprint may differ from the simplified one by this share of its area. */
const MAX_SNAP_AREA_CHANGE = 0.06;
const GABLE_RATIO = 1.3;
const MAX_CORNERS = 64;
const MAX_RECTS = 40;

function cross3(o: V, a: V, b: V): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function signedArea(p: Poly): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!;
    const b = p[(i + 1) % p.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function centroid(p: Poly): V {
  const a = signedArea(p);
  if (Math.abs(a) < 1e-12) {
    const s = p.reduce((acc, q) => ({ x: acc.x + q.x, y: acc.y + q.y }), { x: 0, y: 0 });
    return { x: s.x / p.length, y: s.y / p.length };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i]!;
    const r = p[(i + 1) % p.length]!;
    const f = q.x * r.y - r.x * q.y;
    cx += (q.x + r.x) * f;
    cy += (q.y + r.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

function boxOf(p: Poly): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of p) {
    x0 = Math.min(x0, q.x);
    y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x);
    y1 = Math.max(y1, q.y);
  }
  return { x0, y0, x1, y1 };
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS;
}

function pointInPolygon(p: V, poly: Poly): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Drops repeated and collinear corners. */
function tidy(p: Poly, tol = 1e-9): Poly {
  let out = p.filter((q, i) => {
    const r = p[(i + 1) % p.length]!;
    return Math.hypot(q.x - r.x, q.y - r.y) > tol;
  });
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length]!;
      const b = out[i]!;
      const c = out[(i + 1) % out.length]!;
      const len = Math.hypot(c.x - a.x, c.y - a.y) || 1;
      if (Math.abs(cross3(a, b, c)) / len < 1e-6) {
        out = out.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** The part of a convex polygon where a * x + b * y >= k ((a, b) a unit vector). */
function clipHalf(poly: Poly, a: number, b: number, k: number): Poly {
  const out: Poly = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % n]!;
    const fp = a * p.x + b * p.y - k;
    const fq = a * q.x + b * q.y - k;
    if (fp >= -EPS) out.push(p);
    if ((fp > EPS && fq < -EPS) || (fp < -EPS && fq > EPS)) {
      const t = fp / (fp - fq);
      out.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
    }
  }
  const clean = out.filter((q, i) => {
    const r = out[(i + 1) % out.length]!;
    return Math.hypot(q.x - r.x, q.y - r.y) > 1e-9;
  });
  if (clean.length < 3 || Math.abs(signedArea(clean)) < MIN_PIECE_M2) return [];
  return clean;
}

/** The part of a convex polygon where plane s is at least plane p (strictly above when `strict`, for equal planes). */
function clipAbove(poly: Poly, s: Plane, p: Plane, strict: boolean): Poly {
  const a = s.dx - p.dx;
  const b = s.dy - p.dy;
  const k = s.c - p.c;
  const n = Math.hypot(a, b);
  if (n < 1e-9) {
    // Parallel planes: one is above the other everywhere. s >= p  <=>  s.c <= p.c.
    const above = strict ? s.c < p.c - 1e-6 : s.c <= p.c + 1e-6;
    return above ? poly : [];
  }
  return clipHalf(poly, a / n, b / n, k / n);
}

/** Convex pieces minus one convex polygon (CCW). */
function subtract(pieces: Poly[], d: Poly): Poly[] {
  const db = boxOf(d);
  const out: Poly[] = [];
  for (const c of pieces) {
    if (!boxesOverlap(boxOf(c), db)) {
      out.push(c);
      continue;
    }
    let rest = c;
    for (let i = 0; i < d.length && rest.length > 0; i++) {
      const p = d[i]!;
      const q = d[(i + 1) % d.length]!;
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len < 1e-12) continue;
      // Inside of edge p->q (CCW) is to its left: (-dy, dx) . x >= (-dy, dx) . p
      const a = -(q.y - p.y) / len;
      const b = (q.x - p.x) / len;
      const k = a * p.x + b * p.y;
      const outside = clipHalf(rest, -a, -b, -k);
      if (outside.length > 0) out.push(outside);
      rest = clipHalf(rest, a, b, k);
    }
  }
  return out;
}

function height(p: Plane, q: V): number {
  return p.dx * q.x + p.dy * q.y - p.c;
}

function planeKey(p: Plane): string {
  return `${Math.round(p.dx * 1000)},${Math.round(p.dy * 1000)},${Math.round(p.c * 1e4)}`;
}

// ---------------------------------------------------------------------------------------------------------
// Footprint clean-up.

function dpOpen(pts: V[], tol: number): V[] {
  if (pts.length <= 2) return pts;
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  let best = -1;
  let at = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const d = len < 1e-12 ? Math.hypot(p.x - a.x, p.y - a.y) : Math.abs(cross3(a, b, p)) / len;
    if (d > best) {
      best = d;
      at = i;
    }
  }
  if (best <= tol) return [a, b];
  const left = dpOpen(pts.slice(0, at + 1), tol);
  const right = dpOpen(pts.slice(at), tol);
  return [...left.slice(0, -1), ...right];
}

function simplifyRing(ring: Poly, tol: number): Poly {
  if (ring.length <= 4) return ring;
  let far = 0;
  let best = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i]!.x - ring[0]!.x, ring[i]!.y - ring[0]!.y);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = dpOpen(ring.slice(0, far + 1), tol);
  const b = dpOpen([...ring.slice(far), ring[0]!], tol);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : ring;
}

/** The building's main direction (radians, 0..pi/2): the length-weighted mean of edge angles modulo 90 degrees. */
function dominantAngle(p: Poly): number {
  let s = 0;
  let c = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!;
    const b = p[(i + 1) % p.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const t = Math.atan2(b.y - a.y, b.x - a.x);
    s += len * Math.sin(4 * t);
    c += len * Math.cos(4 * t);
  }
  return Math.atan2(s, c) / 4;
}

function rotate(p: Poly, theta: number): Poly {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return p.map((q) => ({ x: q.x * c + q.y * s, y: -q.x * s + q.y * c }));
}

function segmentsTouch(a: V, b: V, c: V, d: V): boolean {
  const o1 = cross3(a, b, c);
  const o2 = cross3(a, b, d);
  const o3 = cross3(c, d, a);
  const o4 = cross3(c, d, b);
  if (((o1 > 1e-9 && o2 < -1e-9) || (o1 < -1e-9 && o2 > 1e-9)) && ((o3 > 1e-9 && o4 < -1e-9) || (o3 < -1e-9 && o4 > 1e-9))) return true;
  const on = (p: V, q: V, r: V, o: number) =>
    Math.abs(o) <= 1e-9 && Math.min(p.x, q.x) - 1e-9 <= r.x && r.x <= Math.max(p.x, q.x) + 1e-9 && Math.min(p.y, q.y) - 1e-9 <= r.y && r.y <= Math.max(p.y, q.y) + 1e-9;
  return on(a, b, c, o1) || on(a, b, d, o2) || on(c, d, a, o3) || on(c, d, b, o4);
}

function isSimple(p: Poly): boolean {
  const n = p.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsTouch(p[i]!, p[(i + 1) % n]!, p[j]!, p[(j + 1) % n]!)) return false;
    }
  }
  return true;
}

type Run = { axis: 'H' | 'V'; sum: number; w: number };

/**
 * The footprint (already turned so its main direction is the x axis) snapped to horizontal and vertical sides,
 * or null when it is not nearly rectilinear.
 */
function snapOrthogonal(p: Poly): Poly | null {
  const sinTol = Math.sin((AXIS_TOLERANCE_DEG * Math.PI) / 180);
  const runs: Run[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!;
    const b = p[(i + 1) % p.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < TINY_EDGE_M) continue;
    const ux = Math.abs(b.x - a.x) / len;
    const uy = Math.abs(b.y - a.y) / len;
    let axis: 'H' | 'V' | null = null;
    if (uy <= sinTol) axis = 'H';
    else if (ux <= sinTol) axis = 'V';
    if (axis === null) {
      if (len <= CUT_CORNER_M) continue;
      return null;
    }
    const coord = axis === 'H' ? (a.y + b.y) / 2 : (a.x + b.x) / 2;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.axis === axis) {
      last.sum += coord * len;
      last.w += len;
    } else {
      runs.push({ axis, sum: coord * len, w: len });
    }
  }
  if (runs.length > 1 && runs[0]!.axis === runs[runs.length - 1]!.axis) {
    const last = runs.pop()!;
    runs[0]!.sum += last.sum;
    runs[0]!.w += last.w;
  }
  const coord = (r: Run) => r.sum / r.w;
  for (let guard = 0; guard < 200; guard++) {
    if (runs.length < 4 || runs.length % 2 !== 0) return null;
    let shortest = -1;
    let shortestLen = MIN_RUN_M;
    for (let k = 0; k < runs.length; k++) {
      const prev = runs[(k + runs.length - 1) % runs.length]!;
      const next = runs[(k + 1) % runs.length]!;
      const len = Math.abs(coord(next) - coord(prev));
      if (len < shortestLen) {
        shortestLen = len;
        shortest = k;
      }
    }
    if (shortest < 0) break;
    if (runs.length === 4) return null;
    const n = runs.length;
    const pi = (shortest + n - 1) % n;
    const ni = (shortest + 1) % n;
    const prev = runs[pi]!;
    const next = runs[ni]!;
    prev.sum += next.sum;
    prev.w += next.w;
    const drop = new Set([shortest, ni]);
    const kept = runs.filter((_, k) => !drop.has(k));
    runs.length = 0;
    runs.push(...kept);
  }
  if (runs.length < 4 || runs.length % 2 !== 0) return null;
  const out: Poly = [];
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k]!;
    const s = runs[(k + 1) % runs.length]!;
    if (r.axis === s.axis) return null;
    out.push(r.axis === 'H' ? { x: coord(s), y: coord(r) } : { x: coord(r), y: coord(s) });
  }
  let poly = tidy(out);
  if (poly.length < 4) return null;
  if (signedArea(poly) < 0) poly = poly.reverse();
  if (!isSimple(poly)) return null;
  const before = Math.abs(signedArea(p));
  const after = signedArea(poly);
  if (!(before > 0) || Math.abs(after - before) / before > MAX_SNAP_AREA_CHANGE) return null;
  return poly;
}

// ---------------------------------------------------------------------------------------------------------
// Tents from maximal rectangles.

function uniqueSorted(values: number[]): number[] {
  const s = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (out.length === 0 || v - out[out.length - 1]! > 1e-6) out.push(v);
  return out;
}

function rectPoly(b: Box): Poly {
  return [
    { x: b.x0, y: b.y0 },
    { x: b.x1, y: b.y0 },
    { x: b.x1, y: b.y1 },
    { x: b.x0, y: b.y1 },
  ];
}

/** Every rectangle inside an orthogonal polygon that cannot grow in any direction. Null when there are too many. */
function maximalRectangles(poly: Poly): Box[] | null {
  const xs = uniqueSorted(poly.map((q) => q.x));
  const ys = uniqueSorted(poly.map((q) => q.y));
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx < 1 || ny < 1) return null;
  // pre[i][j]: count of inside cells in [0, i) x [0, j).
  const pre: number[][] = Array.from({ length: nx + 1 }, () => new Array<number>(ny + 1).fill(0));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const inside = pointInPolygon({ x: (xs[i]! + xs[i + 1]!) / 2, y: (ys[j]! + ys[j + 1]!) / 2 }, poly) ? 1 : 0;
      pre[i + 1]![j + 1] = inside + pre[i]![j + 1]! + pre[i + 1]![j]! - pre[i]![j]!;
    }
  }
  const full = (i0: number, i1: number, j0: number, j1: number): boolean => {
    if (i0 < 0 || j0 < 0 || i1 > nx || j1 > ny) return false;
    const cells = pre[i1]![j1]! - pre[i0]![j1]! - pre[i1]![j0]! + pre[i0]![j0]!;
    return cells === (i1 - i0) * (j1 - j0);
  };
  const out: Box[] = [];
  for (let i0 = 0; i0 < nx; i0++) {
    for (let i1 = i0 + 1; i1 <= nx; i1++) {
      for (let j0 = 0; j0 < ny; j0++) {
        for (let j1 = j0 + 1; j1 <= ny; j1++) {
          if (!full(i0, i1, j0, j1)) break;
          if (full(i0 - 1, i1, j0, j1) || full(i0, i1 + 1, j0, j1) || full(i0, i1, j0 - 1, j1) || full(i0, i1, j0, j1 + 1)) continue;
          out.push({ x0: xs[i0]!, x1: xs[i1]!, y0: ys[j0]!, y1: ys[j1]! });
          if (out.length > MAX_RECTS) return null;
        }
      }
    }
  }
  return out;
}

/** Whether every sample point along a segment, nudged outward by `off`, lies outside the polygon. */
function outsideAlong(poly: Poly, a: V, b: V, off: V): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(2, Math.ceil(len / 0.25));
  for (let k = 0; k <= steps; k++) {
    // Stay a little inside the segment's ends, so a corner of the polygon does not count.
    const t = 0.02 + (0.96 * k) / steps;
    const q = { x: a.x + t * (b.x - a.x) + off.x, y: a.y + t * (b.y - a.y) + off.y };
    if (pointInPolygon(q, poly)) return false;
  }
  return true;
}

/** The tent over a rectangle: its four side planes, less the end planes of an end that becomes a gable. */
function tentFor(r: Box, poly: Poly): Tent {
  const bottom: Plane = { dx: 0, dy: 1, c: r.y0 };
  const top: Plane = { dx: 0, dy: -1, c: -r.y1 };
  const left: Plane = { dx: 1, dy: 0, c: r.x0 };
  const right: Plane = { dx: -1, dy: 0, c: -r.x1 };
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const planes: Plane[] = [bottom, top, left, right];
  const off = 0.05;
  // An end is free when its edge and both sides next to it, as deep as its hip triangle (half the width), are on
  // the outline: dropping its plane then only turns that hip into a gable end.
  if (w / h > GABLE_RATIO) {
    const d = h / 2;
    const leftFree =
      outsideAlong(poly, { x: r.x0, y: r.y0 }, { x: r.x0, y: r.y1 }, { x: -off, y: 0 }) &&
      outsideAlong(poly, { x: r.x0, y: r.y0 }, { x: r.x0 + d, y: r.y0 }, { x: 0, y: -off }) &&
      outsideAlong(poly, { x: r.x0, y: r.y1 }, { x: r.x0 + d, y: r.y1 }, { x: 0, y: off });
    const rightFree =
      outsideAlong(poly, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: off, y: 0 }) &&
      outsideAlong(poly, { x: r.x1 - d, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: 0, y: -off }) &&
      outsideAlong(poly, { x: r.x1 - d, y: r.y1 }, { x: r.x1, y: r.y1 }, { x: 0, y: off });
    return { poly: rectPoly(r), box: r, planes: planes.filter((p) => !((p === left && leftFree) || (p === right && rightFree))) };
  }
  if (h / w > GABLE_RATIO) {
    const d = w / 2;
    const bottomFree =
      outsideAlong(poly, { x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: 0, y: -off }) &&
      outsideAlong(poly, { x: r.x0, y: r.y0 }, { x: r.x0, y: r.y0 + d }, { x: -off, y: 0 }) &&
      outsideAlong(poly, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y0 + d }, { x: off, y: 0 });
    const topFree =
      outsideAlong(poly, { x: r.x0, y: r.y1 }, { x: r.x1, y: r.y1 }, { x: 0, y: off }) &&
      outsideAlong(poly, { x: r.x0, y: r.y1 - d }, { x: r.x0, y: r.y1 }, { x: -off, y: 0 }) &&
      outsideAlong(poly, { x: r.x1, y: r.y1 - d }, { x: r.x1, y: r.y1 }, { x: off, y: 0 });
    return { poly: rectPoly(r), box: r, planes: planes.filter((p) => !((p === bottom && bottomFree) || (p === top && topFree))) };
  }
  return { poly: rectPoly(r), box: r, planes };
}

/** The convex pieces where tent k's plane i is the roof: lowest of its own planes, and no other tent above it. */
function tentPieces(tents: Tent[], k: number, i: number): Poly[] {
  const t = tents[k]!;
  const pl = t.planes[i]!;
  let c: Poly = t.poly;
  for (let l = 0; l < t.planes.length && c.length > 0; l++) if (l !== i) c = clipAbove(c, t.planes[l]!, pl, false);
  if (c.length === 0) return [];
  let pieces: Poly[] = [c];
  for (let j = 0; j < tents.length && pieces.length > 0; j++) {
    if (j === k) continue;
    const other = tents[j]!;
    if (!boxesOverlap(other.box, t.box)) continue;
    // Where tent j is at least as high (ties go to the earlier tent).
    let d: Poly = other.poly;
    for (const s of other.planes) {
      d = clipAbove(d, s, pl, j > k);
      if (d.length === 0) break;
    }
    if (d.length === 0) continue;
    pieces = subtract(pieces, d);
  }
  return pieces;
}

// ---------------------------------------------------------------------------------------------------------
// Pieces to facets and lines.

type LocalFacet = { plane: Plane; ring: Poly; areaM2: number; label: V };
type LocalLine = { kind: RoofLineKind; a: V; b: V; lengthM: number; facets: number[] };
type LocalRoof = { facets: LocalFacet[]; lines: LocalLine[]; outline: Poly };

class Welder {
  readonly pts: V[] = [];
  private readonly grid = new Map<string, number[]>();
  id(p: V): number {
    const gx = Math.floor(p.x / WELD);
    const gy = Math.floor(p.y / WELD);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of this.grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          const q = this.pts[id]!;
          if (Math.abs(q.x - p.x) <= WELD && Math.abs(q.y - p.y) <= WELD) return id;
        }
      }
    }
    const id = this.pts.length;
    this.pts.push({ x: p.x, y: p.y });
    const key = `${gx},${gy}`;
    const list = this.grid.get(key);
    if (list) list.push(id);
    else this.grid.set(key, [id]);
    return id;
  }
}

/** Facets (one per connected region of a plane) and the lines between them, from each plane's convex pieces. */
function assemble(groups: { plane: Plane; pieces: Poly[] }[], pitch: number): LocalRoof | null {
  const w = new Welder();
  const pieceIds = groups.map((g) => g.pieces.map((p) => p.map((q) => w.id(q))));
  const pts = w.pts;
  // Split every edge at every corner lying on it, so neighbouring pieces share whole edges.
  const splitEdge = (a: number, b: number): number[] => {
    const pa = pts[a]!;
    const pb = pts[b]!;
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) return [a];
    const len = Math.sqrt(len2);
    const minx = Math.min(pa.x, pb.x) - WELD;
    const maxx = Math.max(pa.x, pb.x) + WELD;
    const miny = Math.min(pa.y, pb.y) - WELD;
    const maxy = Math.max(pa.y, pb.y) + WELD;
    const on: { id: number; t: number }[] = [];
    for (let id = 0; id < pts.length; id++) {
      if (id === a || id === b) continue;
      const q = pts[id]!;
      if (q.x < minx || q.x > maxx || q.y < miny || q.y > maxy) continue;
      const t = ((q.x - pa.x) * dx + (q.y - pa.y) * dy) / len2;
      if (t <= 1e-9 || t >= 1 - 1e-9) continue;
      const dist = Math.abs((q.x - pa.x) * dy - (q.y - pa.y) * dx) / len;
      if (dist <= WELD * 2) on.push({ id, t });
    }
    on.sort((u, v) => u.t - v.t);
    return [a, ...on.map((o) => o.id)];
  };

  type Loop = { group: number; ids: number[] };
  const loops: Loop[] = [];
  groups.forEach((_, gi) => {
    const count = new Map<string, number>();
    for (const ids of pieceIds[gi]!) {
      for (let k = 0; k < ids.length; k++) {
        const a = ids[k]!;
        const b = ids[(k + 1) % ids.length]!;
        if (a === b) continue;
        const chain = [...splitEdge(a, b), b];
        for (let m = 0; m + 1 < chain.length; m++) {
          const key = `${chain[m]}>${chain[m + 1]}`;
          count.set(key, (count.get(key) ?? 0) + 1);
        }
      }
    }
    const remaining: [number, number][] = [];
    for (const [key, n] of count) {
      const [a, b] = key.split('>').map(Number) as [number, number];
      const back = count.get(`${b}>${a}`) ?? 0;
      for (let m = 0; m < n - back; m++) remaining.push([a, b]);
    }
    const out = new Map<number, [number, number][]>();
    for (const e of remaining) {
      const list = out.get(e[0]);
      if (list) list.push(e);
      else out.set(e[0], [e]);
    }
    const used = new Set<[number, number]>();
    for (const start of remaining) {
      if (used.has(start)) continue;
      const ids: number[] = [];
      let e: [number, number] | undefined = start;
      let guard = 0;
      while (e !== undefined && !used.has(e) && guard++ < 100000) {
        used.add(e);
        ids.push(e[0]);
        if (e[1] === start[0]) break;
        e = (out.get(e[1]) ?? []).find((x) => !used.has(x));
      }
      if (ids.length >= 3) loops.push({ group: gi, ids });
    }
  });

  // Facets: counter-clockwise loops with area; each piece goes to the loop holding its centre.
  const facets: LocalFacet[] = [];
  const facetLoops: number[][] = [];
  const outer = loops.filter((l) => signedArea(l.ids.map((id) => pts[id]!)) > 1e-4);
  for (let gi = 0; gi < groups.length; gi++) {
    const mine = outer.filter((l) => l.group === gi);
    if (mine.length === 0) continue;
    const rings = mine.map((l) => l.ids.map((id) => pts[id]!));
    const area = new Array<number>(mine.length).fill(0);
    const best = new Array<{ a: number; c: V } | null>(mine.length).fill(null);
    for (const piece of groups[gi]!.pieces) {
      const a = Math.abs(signedArea(piece));
      const c = centroid(piece);
      let at = rings.findIndex((r) => pointInPolygon(c, r));
      if (at < 0) at = 0;
      area[at]! += a;
      if (best[at] === null || best[at]!.a < a) best[at] = { a, c };
    }
    mine.forEach((l, k) => {
      if (area[k]! < 0.01) return;
      const ring = rings[k]!;
      const mid = centroid(ring);
      const label = pointInPolygon(mid, ring) ? mid : best[k]?.c ?? mid;
      facets.push({ plane: groups[gi]!.plane, ring, areaM2: area[k]!, label });
      facetLoops.push(l.ids);
    });
  }
  if (facets.length === 0) return null;

  // Lines: each facet edge either meets another facet's edge going the other way, or is on the outline.
  const owner = new Map<string, number>();
  facetLoops.forEach((ids, f) => {
    for (let k = 0; k < ids.length; k++) owner.set(`${ids[k]}>${ids[(k + 1) % ids.length]}`, f);
  });
  const m = pitch / 12;
  const raw: LocalLine[] = [];
  const outlineEdges: [number, number][] = [];
  facetLoops.forEach((ids, f) => {
    const pf = facets[f]!.plane;
    for (let k = 0; k < ids.length; k++) {
      const ia = ids[k]!;
      const ib = ids[(k + 1) % ids.length]!;
      const a = pts[ia]!;
      const b = pts[ib]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-6) continue;
      const lengthM = Math.hypot(len, m * (height(pf, a) - height(pf, b)));
      const g = owner.get(`${ib}>${ia}`);
      if (g === undefined) {
        outlineEdges.push([ia, ib]);
        const along = Math.abs(((b.x - a.x) * pf.dx + (b.y - a.y) * pf.dy) / len);
        raw.push({ kind: along < 0.5 ? 'eave' : 'rake', a, b, lengthM, facets: [f] });
        continue;
      }
      if (g < f) continue;
      const pg = facets[g]!.plane;
      const dot = pf.dx * pg.dx + pf.dy * pg.dy;
      if (dot > 0.99) continue; // parallel planes at different heights: a step, not a line
      let kind: RoofLineKind;
      if (dot < -0.99) kind = 'ridge';
      else {
        // Nudge into facet f (left of a->b): a convex crease (hip) has f's plane below g's there.
        const q = { x: (a.x + b.x) / 2 - ((b.y - a.y) / len) * 0.01, y: (a.y + b.y) / 2 + ((b.x - a.x) / len) * 0.01 };
        kind = height(pf, q) < height(pg, q) ? 'hip' : 'valley';
      }
      raw.push({ kind, a, b, lengthM, facets: [f, g] });
    }
  });

  // Join straight runs of the same kind between the same facets.
  const groupsOf = new Map<string, LocalLine[]>();
  for (const l of raw) {
    const key = `${l.kind}|${[...l.facets].sort((x, y) => x - y).join(',')}`;
    const list = groupsOf.get(key);
    if (list) list.push(l);
    else groupsOf.set(key, [l]);
  }
  const lines: LocalLine[] = [];
  const same = (p: V, q: V) => Math.abs(p.x - q.x) <= WELD * 4 && Math.abs(p.y - q.y) <= WELD * 4;
  for (const list of groupsOf.values()) {
    const segs = list.map((l) => ({ ...l }));
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          const s = segs[i]!;
          const t = segs[j]!;
          let a: V | null = null;
          let b: V | null = null;
          if (same(s.b, t.a)) [a, b] = [s.a, t.b];
          else if (same(t.b, s.a)) [a, b] = [t.a, s.b];
          else if (same(s.a, t.a)) [a, b] = [s.b, t.b];
          else if (same(s.b, t.b)) [a, b] = [s.a, t.a];
          if (a === null || b === null) continue;
          const d1 = { x: s.b.x - s.a.x, y: s.b.y - s.a.y };
          const d2 = { x: t.b.x - t.a.x, y: t.b.y - t.a.y };
          const crossN = Math.abs(d1.x * d2.y - d1.y * d2.x) / (Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y));
          if (crossN > 1e-3) continue;
          segs[i] = { ...s, a, b, lengthM: s.lengthM + t.lengthM };
          segs.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
    lines.push(...segs);
  }

  // The outline: the outer loop of all facet edges that face no other facet.
  const outlineLoop = chainLongest(outlineEdges).map((id) => pts[id]!);
  return { facets, lines, outline: tidy(outlineLoop, 1e-6) };
}

function chainLongest(edges: [number, number][]): number[] {
  const out = new Map<number, [number, number][]>();
  for (const e of edges) {
    const list = out.get(e[0]);
    if (list) list.push(e);
    else out.set(e[0], [e]);
  }
  const used = new Set<[number, number]>();
  let best: number[] = [];
  for (const start of edges) {
    if (used.has(start)) continue;
    const ids: number[] = [];
    let e: [number, number] | undefined = start;
    let guard = 0;
    while (e !== undefined && !used.has(e) && guard++ < 100000) {
      used.add(e);
      ids.push(e[0]);
      if (e[1] === start[0]) break;
      e = (out.get(e[1]) ?? []).find((x) => !used.has(x));
    }
    if (ids.length > best.length) best = ids;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------
// Roof builders (local frame).

function hipGableRoof(poly: Poly, pitch: number): LocalRoof | null {
  if (poly.length > MAX_CORNERS) return null;
  const rects = maximalRectangles(poly);
  if (rects === null || rects.length === 0) return null;
  const tents = rects.map((r) => tentFor(r, poly));
  const byKey = new Map<string, { plane: Plane; pieces: Poly[] }>();
  tents.forEach((t, k) => {
    t.planes.forEach((pl, i) => {
      const pieces = tentPieces(tents, k, i);
      if (pieces.length === 0) return;
      const key = planeKey(pl);
      const g = byKey.get(key);
      if (g) g.pieces.push(...pieces);
      else byKey.set(key, { plane: pl, pieces });
    });
  });
  const roof = assemble([...byKey.values()], pitch);
  if (roof === null) return null;
  const covered = roof.facets.reduce((s, f) => s + f.areaM2, 0);
  const area = signedArea(poly);
  if (Math.abs(covered - area) / area > 0.01) return null;
  return roof;
}

function triangulate(poly: Poly): Poly[] | null {
  const idx = poly.map((_, i) => i);
  const tris: Poly[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 100000) {
    let done = false;
    for (let i = 0; i < idx.length; i++) {
      const a = poly[idx[(i + idx.length - 1) % idx.length]!]!;
      const b = poly[idx[i]!]!;
      const c = poly[idx[(i + 1) % idx.length]!]!;
      const cr = cross3(a, b, c);
      if (Math.abs(cr) < 1e-10) {
        idx.splice(i, 1);
        done = true;
        break;
      }
      if (cr < 0) continue;
      let blocked = false;
      for (const j of idx) {
        const p = poly[j]!;
        if (p === a || p === b || p === c) continue;
        if (cross3(a, b, p) >= 0 && cross3(b, c, p) >= 0 && cross3(c, a, p) >= 0) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      tris.push([a, b, c]);
      idx.splice(i, 1);
      done = true;
      break;
    }
    if (!done) return null;
  }
  if (idx.length === 3) {
    const t = idx.map((i) => poly[i]!);
    if (Math.abs(signedArea(t)) > 1e-12) tris.push(t);
  }
  return tris;
}

function convexHull(points: Poly): Poly {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower: Poly = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross3(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Poly = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross3(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** One gable along the long side of the bounding rectangle, clipped to the footprint. */
function gableFallback(poly: Poly, pitch: number): LocalRoof | null {
  const b = boxOf(poly);
  const alongX = b.x1 - b.x0 >= b.y1 - b.y0;
  const p1: Plane = alongX ? { dx: 0, dy: 1, c: b.y0 } : { dx: 1, dy: 0, c: b.x0 };
  const p2: Plane = alongX ? { dx: 0, dy: -1, c: -b.y1 } : { dx: -1, dy: 0, c: -b.x1 };
  const tris = triangulate(poly) ?? [convexHull(poly)];
  const g1: Poly[] = [];
  const g2: Poly[] = [];
  for (const t of tris) {
    const ccw = signedArea(t) < 0 ? [...t].reverse() : t;
    const a = clipAbove(ccw, p2, p1, false);
    const c = clipAbove(ccw, p1, p2, false);
    if (a.length > 0) g1.push(a);
    if (c.length > 0) g2.push(c);
  }
  return assemble(
    [
      { plane: p1, pieces: g1 },
      { plane: p2, pieces: g2 },
    ],
    pitch,
  );
}

// ---------------------------------------------------------------------------------------------------------
// Public API.

type Frame = { lng0: number; lat0: number; cos: number; theta: number };

function cleanLngLat(ring: Ring): LngLat[] {
  const out: LngLat[] = [];
  for (const p of ring ?? []) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 1 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) out.pop();
  return out;
}

const K = (Math.PI / 180) * EARTH_RADIUS_M;

function toLngLat(f: Frame, q: V): [number, number] {
  const c = Math.cos(f.theta);
  const s = Math.sin(f.theta);
  const x = q.x * c - q.y * s;
  const y = q.x * s + q.y * c;
  return [f.lng0 + x / (K * f.cos), f.lat0 + y / K];
}

function closedRing(f: Frame, p: Poly): [number, number][] {
  const ring = p.map((q) => toLngLat(f, q));
  if (ring.length > 0) ring.push([ring[0]![0], ring[0]![1]]);
  return ring;
}

type RingRoof = { frame: Frame; roof: LocalRoof; footSqFt: number; perimFt: number };

function roofForRing(ring: Ring, pitch: number): RingRoof | null {
  const pts = cleanLngLat(ring);
  if (pts.length < 3) return null;
  let lng0 = 0;
  let lat0 = 0;
  for (const [lng, lat] of pts) {
    lng0 += lng;
    lat0 += lat;
  }
  lng0 /= pts.length;
  lat0 /= pts.length;
  const cos = Math.cos((lat0 * Math.PI) / 180);
  let local: Poly = pts.map(([lng, lat]) => ({ x: (lng - lng0) * K * cos, y: (lat - lat0) * K }));
  if (signedArea(local) < 0) local = local.reverse();
  local = tidy(local);
  if (local.length < 3 || Math.abs(signedArea(local)) < 0.5) return null;
  let simple = tidy(simplifyRing(local, SIMPLIFY_M));
  if (simple.length < 3 || signedArea(simple) <= 0) simple = local;
  const theta = dominantAngle(simple);
  const frame: Frame = { lng0, lat0, cos, theta };
  const turned = rotate(simple, theta);

  let roof: LocalRoof | null = null;
  try {
    const ortho = snapOrthogonal(turned);
    if (ortho !== null) roof = hipGableRoof(ortho, pitch);
  } catch {
    roof = null;
  }
  if (roof === null) {
    try {
      roof = gableFallback(isSimple(turned) ? turned : convexHull(turned), pitch);
    } catch {
      roof = null;
    }
  }
  if (roof === null || roof.facets.length === 0) return null;
  return { frame, roof, footSqFt: polygonAreaSqFt(ring), perimFt: perimeterFt(ring) };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function facetId(i: number): string {
  const letter = String.fromCharCode(65 + (i % 26));
  return i < 26 ? letter : `${letter}${Math.floor(i / 26) + 1}`;
}

/**
 * The roof over an outline's rings at a pitch (x/12). Facet plan areas include the overhang (footprint plus
 * perimeter times overhang, shared out by each facet's outline edges) so the totals match `instantEstimate`.
 * Null when no ring has an area. Never throws.
 */
export function buildRoofModel(outline: Outline | Ring, opts: { pitchX12: number; overhangFt?: number }): RoofModel | null {
  try {
    const rings: Ring[] = isSingleRing(outline) ? [outline] : (outline as Outline);
    const pitch = Number.isFinite(opts.pitchX12) && opts.pitchX12 > 0 ? opts.pitchX12 : 0;
    const overhang = Number.isFinite(opts.overhangFt) && (opts.overhangFt ?? 0) > 0 ? opts.overhangFt! : 0;
    const factor = pitchFactor(pitch);
    const label = pitchLabel(pitch);
    const facets: (Omit<RoofFacet, 'id'> & { sort: number })[] = [];
    const lines: RoofLine[] = [];
    let bestOutline: [number, number][] = [];
    let bestArea = -1;
    for (const ring of rings) {
      const built = roofForRing(ring, pitch);
      if (built === null) continue;
      const { frame, roof } = built;
      const facetArea = roof.facets.reduce((s, f) => s + f.areaM2, 0);
      const edgeOf = new Array<number>(roof.facets.length).fill(0);
      let edgeTotal = 0;
      for (const l of roof.lines) {
        if (l.facets.length !== 1) continue;
        const plan = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
        edgeOf[l.facets[0]!]! += plan;
        edgeTotal += plan;
      }
      roof.facets.forEach((f, i) => {
        const foot = facetArea > 0 ? (f.areaM2 / facetArea) * built.footSqFt : 0;
        const edge = edgeTotal > 0 ? (edgeOf[i]! / edgeTotal) * built.perimFt : 0;
        const plan = foot + edge * overhang;
        facets.push({
          sort: plan,
          ring: closedRing(frame, tidy(f.ring, 1e-6)),
          planSqFt: round1(plan),
          areaSqFt: round1(plan * factor),
          pitch: label,
          labelAt: toLngLat(frame, f.label),
        });
      });
      for (const l of roof.lines) {
        lines.push({ kind: l.kind, coords: [toLngLat(frame, l.a), toLngLat(frame, l.b)], lengthFt: round1(l.lengthM * FT_PER_M) });
      }
      if (built.footSqFt > bestArea) {
        bestArea = built.footSqFt;
        bestOutline = closedRing(frame, roof.outline);
      }
    }
    if (facets.length === 0) return null;
    facets.sort((a, b) => b.sort - a.sort);
    const sum = (k: RoofLineKind) => round1(lines.filter((l) => l.kind === k).reduce((s, l) => s + l.lengthFt, 0));
    const planSqFt = facets.reduce((s, f) => s + f.sort, 0);
    const slopedSqFt = planSqFt * factor;
    const totals = {
      squares: round1(slopedSqFt / 100),
      slopedSqFt: round1(slopedSqFt),
      planSqFt: round1(planSqFt),
      facetCount: facets.length,
      wastePct: 10,
      ridgeFt: sum('ridge'),
      hipFt: sum('hip'),
      valleyFt: sum('valley'),
      eaveFt: sum('eave'),
      rakeFt: sum('rake'),
    };
    totals.wastePct = wasteFor(totals.hipFt, totals.rakeFt, totals.valleyFt, facets.length);
    return {
      facets: facets.map((f, i) => ({ id: facetId(i), ring: f.ring, planSqFt: f.planSqFt, areaSqFt: f.areaSqFt, pitch: f.pitch, labelAt: f.labelAt })),
      lines,
      outline: bestOutline,
      pitch: label,
      totals,
    };
  } catch {
    return null;
  }
}

/** 10% for a gable-dominant roof; 12-15% for a hip-heavy one (more cuts), more with valleys and facets. */
function wasteFor(hipFt: number, rakeFt: number, valleyFt: number, facetCount: number): number {
  if (hipFt <= rakeFt) return 10;
  let w = 12;
  if (valleyFt > 0) w += 1;
  if (facetCount > 6) w += 1;
  if (facetCount > 10) w += 1;
  return Math.min(15, w);
}

function isSingleRing(x: Outline | Ring): x is Ring {
  const first = (x as unknown[])[0];
  return Array.isArray(first) && typeof first[0] === 'number';
}

/**
 * The instant estimate and the roof drawn for it, consistent with each other: areas are the estimate's (footprint
 * plus overhang, times the pitch factor); ridge, valley and edges (eaves plus rakes) are the roof's lines. A valley
 * length given in the input (above 0) is kept as entered.
 */
export function measureRoof(i: InstantInput): { estimate: InstantEstimate; roof: RoofModel | null } {
  const base = instantEstimate(i);
  const roof = buildRoofModel(i.outline ?? [], { pitchX12: base.pitchX12, overhangFt: i.overhangFt });
  if (roof === null) return { estimate: base, roof: null };
  roof.totals.planSqFt = base.planSqFt;
  roof.totals.slopedSqFt = base.surfaceSqFt;
  roof.totals.squares = base.squares;
  const given = typeof i.valleyFt === 'number' && Number.isFinite(i.valleyFt) && i.valleyFt > 0;
  return {
    estimate: {
      ...base,
      ridgeFt: roof.totals.ridgeFt,
      valleyFt: given ? base.valleyFt : roof.totals.valleyFt,
      edgeFt: round1(roof.totals.eaveFt + roof.totals.rakeFt),
    },
    roof,
  };
}
