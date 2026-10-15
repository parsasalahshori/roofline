import * as pcNamespace from 'polygon-clipping';
import type { LngLat } from '@roofline/shared';
import { lngLatToUtm, type UtmZone } from '@roofline/shared/roof-reconstruct';

/*
 * The benchmark's plane geometry, in metres (UTM of the house's zone, x east, y north). Pure and deterministic.
 * Polygon clipping is the `polygon-clipping` package (MIT); when it cannot finish on a degenerate input, the overlap
 * is measured by sampling a grid instead (iouGrid), so a score is never missing because of a numerical corner.
 */

type Clipper = {
  intersection: (a: MultiPoly, ...b: MultiPoly[]) => MultiPoly;
  union: (a: MultiPoly, ...b: MultiPoly[]) => MultiPoly;
};
const clip = ((pcNamespace as unknown as { default?: Clipper }).default ?? (pcNamespace as unknown as Clipper)) as Clipper;

export type Pt = [number, number];
/** A closed ring (first point repeated last), as polygon-clipping wants it. */
export type RingXY = Pt[];
/** Outer ring first, then holes. */
export type PolyXY = RingXY[];
export type MultiPoly = PolyXY[];

/** The UTM zone a point is in (the zone Google's layers for it use). */
export function zoneOfLngLat(lng: number, lat: number): UtmZone {
  return { zone: Math.min(60, Math.max(1, Math.floor((lng + 180) / 6) + 1)), south: lat < 0 };
}

export function ringToXY(zone: UtmZone, ring: readonly (readonly number[])[]): RingXY {
  const pts: RingXY = ring.map((p) => {
    const u = lngLatToUtm(zone, p[0]!, p[1]!);
    return [u.easting, u.northing];
  });
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (a !== undefined && b !== undefined && (a[0] !== b[0] || a[1] !== b[1])) pts.push([a[0], a[1]]);
  return pts;
}

/** A GeoJSON Polygon or MultiPolygon (lng/lat) in metres. */
export function geoJsonToXY(zone: UtmZone, g: { type: string; coordinates: unknown }): MultiPoly {
  const polys = g.type === 'Polygon' ? [g.coordinates as number[][][]] : g.type === 'MultiPolygon' ? (g.coordinates as number[][][][]) : [];
  return polys.map((p) => p.map((r) => ringToXY(zone, r)));
}

export function ringArea(ring: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i + 1 < ring.length; i++) a += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
  return a / 2;
}

/** Area of a multipolygon: every outer ring less its holes. */
export function area(mp: MultiPoly): number {
  let t = 0;
  for (const poly of mp) {
    poly.forEach((r, k) => {
      const a = Math.abs(ringArea(r));
      t += k === 0 ? a : -a;
    });
  }
  return t;
}

/** Intersection over union of two multipolygons; the grid estimate when clipping throws. Null when both are empty. */
export function iou(a: MultiPoly, b: MultiPoly): number | null {
  const areaA = area(a);
  const areaB = area(b);
  if (!(areaA > 0) && !(areaB > 0)) return null;
  try {
    const inter = area(clip.intersection(a, b));
    const union = areaA + areaB - inter;
    return union > 0 ? Math.max(0, Math.min(1, inter / union)) : null;
  } catch {
    return iouGrid(a, b, 0.1);
  }
}

/** Area of the overlap of two multipolygons (0 when clipping throws and the grid finds none). */
export function overlapArea(a: MultiPoly, b: MultiPoly): number {
  try {
    return area(clip.intersection(a, b));
  } catch {
    const g = iouGrid(a, b, 0.1);
    if (g === null) return 0;
    const sum = area(a) + area(b);
    return (g * sum) / (1 + g);
  }
}

function inMulti(x: number, y: number, mp: MultiPoly): boolean {
  for (const poly of mp) {
    let inside = false;
    poly.forEach((r, k) => {
      let hit = false;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i]!;
        const [xj, yj] = r[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
      }
      if (k === 0) inside = hit;
      else if (hit) inside = false;
    });
    if (inside) return true;
  }
  return false;
}

function boundsOf(mp: MultiPoly): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const poly of mp) for (const r of poly) for (const [x, y] of r) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

/** Intersection over union by sampling a grid of `step` metres (cell centres). The independent check of iou(). */
export function iouGrid(a: MultiPoly, b: MultiPoly, step: number): number | null {
  const ba = boundsOf(a);
  const bb = boundsOf(b);
  const x0 = Math.min(ba.x0, bb.x0);
  const y0 = Math.min(ba.y0, bb.y0);
  const x1 = Math.max(ba.x1, bb.x1);
  const y1 = Math.max(ba.y1, bb.y1);
  if (!(x1 > x0) || !(y1 > y0)) return null;
  let inter = 0;
  let union = 0;
  for (let y = y0 + step / 2; y < y1; y += step) {
    for (let x = x0 + step / 2; x < x1; x += step) {
      const ia = inMulti(x, y, a);
      const ib = inMulti(x, y, b);
      if (ia && ib) inter++;
      if (ia || ib) union++;
    }
  }
  return union > 0 ? inter / union : null;
}

/** Every boundary ring of a multipolygon (outer rings and holes). */
export function boundaries(mp: MultiPoly): RingXY[] {
  return mp.flatMap((poly) => poly);
}

/** Points along rings every `step` metres (vertices included), in ring order. */
export function sampleRings(rings: readonly RingXY[], step: number): Pt[] {
  const out: Pt[] = [];
  for (const r of rings) {
    for (let i = 0; i + 1 < r.length; i++) {
      const [ax, ay] = r[i]!;
      const [bx, by] = r[i + 1]!;
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
  }
  return out;
}

function distToSegments(p: Pt, segs: Float64Array): number {
  let best = Infinity;
  for (let i = 0; i < segs.length; i += 4) {
    const ax = segs[i]!;
    const ay = segs[i + 1]!;
    const dx = segs[i + 2]! - ax;
    const dy = segs[i + 3]! - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
    const d = Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy);
    if (d < best) best = d;
  }
  return best;
}

function segmentsOf(rings: readonly RingXY[]): Float64Array {
  const list: number[] = [];
  for (const r of rings) for (let i = 0; i + 1 < r.length; i++) list.push(r[i]![0], r[i]![1], r[i + 1]![0], r[i + 1]![1]);
  return Float64Array.from(list);
}

/** Distances (metres) from points sampled along the rings of `from` to the boundary of `to`. */
export function boundaryDistances(from: MultiPoly, to: MultiPoly, step = 0.2): number[] {
  const segs = segmentsOf(boundaries(to));
  if (segs.length === 0) return [];
  return sampleRings(boundaries(from), step).map((p) => distToSegments(p, segs));
}

/** Distances (metres) from each point to the nearest boundary (outer rings and holes) of `to`; empty when `to` has none. */
export function distancesToBoundary(points: readonly Pt[], to: MultiPoly): number[] {
  const segs = segmentsOf(boundaries(to));
  if (segs.length === 0) return [];
  return points.map((p) => distToSegments(p, segs));
}

/** The p-th percentile (0..1) of values by linear interpolation; NaN for none. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const x = (s.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(x);
  const hi = Math.ceil(x);
  return s[lo]! + (s[hi]! - s[lo]!) * (x - lo);
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((t, v) => t + v, 0) / values.length;
}

export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

/**
 * How far two outlines' boundaries are apart: the mean of the two directed mean distances (average symmetric surface
 * distance) and the Hausdorff 95th percentile (the larger of the two directed 95th percentiles), metres.
 */
export function boundaryDistance(a: MultiPoly, b: MultiPoly, step = 0.2): { mean: number; hd95: number } {
  const ab = boundaryDistances(a, b, step);
  const ba = boundaryDistances(b, a, step);
  return { mean: (mean(ab) + mean(ba)) / 2, hd95: Math.max(percentile(ab, 0.95), percentile(ba, 0.95)) };
}

/**
 * Rectilinearity of an outline: the share of its length whose direction is within `tolDeg` of one of the two axes of
 * the best-fitting rectangular frame (the angle, mod 90 degrees, found by scanning every half degree). 1 for a
 * rectangle or any rectilinear outline, near 0.2 for a circle.
 */
export function rectilinearity(ring: readonly Pt[], tolDeg = 5): { share: number; axisDeg: number } {
  const edges: { len: number; deg: number }[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    edges.push({ len, deg: (((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI) % 90 + 90) % 90 });
  }
  const total = edges.reduce((t, e) => t + e.len, 0);
  if (!(total > 0)) return { share: 0, axisDeg: 0 };
  let best = -1;
  let bestAxis = 0;
  for (let axis = 0; axis < 90; axis += 0.5) {
    let within = 0;
    for (const e of edges) {
      const d = Math.abs(e.deg - axis);
      if (Math.min(d, 90 - d) <= tolDeg) within += e.len;
    }
    // Strictly greater: the smallest axis wins a tie, so the answer never depends on scan noise.
    if (within > best + 1e-9) {
      best = within;
      bestAxis = axis;
    }
  }
  return { share: best / total, axisDeg: bestAxis };
}

/** Whether a point (lng, lat) lies inside a ring of [lng, lat]. */
export function lngLatInRing(p: LngLat, ring: readonly LngLat[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Python-style rounding (half to even), so scores match the earlier scorer exactly. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** Pixels of a ring (pixel coordinates, y down) by even-odd scanline at the pixel centres. */
export function rasterize(ring: readonly [number, number][], w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const n = ring.length;
  for (let r = 0; r < h; r++) {
    const y = r + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const [x1, y1] = ring[i]!;
      const [x2, y2] = ring[(i + 1) % n]!;
      if (y1 > y !== y2 > y) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const c1 = Math.min(w - 1, Math.ceil(xs[k + 1]! - 0.5) - 1);
      for (let c = c0; c <= c1; c++) out[r * w + c] = 1;
    }
  }
  return out;
}

/** Convex hull (counter-clockwise, no repeated end point) of points, by Andrew's monotone chain. */
export function convexHull(points: readonly Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** The multipolygon moved by (dx, dy) metres. */
export function translate(mp: MultiPoly, dx: number, dy: number): MultiPoly {
  return mp.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x + dx, y + dy] as Pt)));
}

/**
 * The translation of `b` (within maxShiftM on each axis) that overlaps `a` best, by intersection over union: a 0.5 m
 * grid over the whole square, then a 0.1 m grid round the best cell. Deterministic (ties: the first found, scanning
 * x then y from the most negative). EagleView reports sit about 1 m east and 0.5 m south of Google's imagery (median
 * shift 1.46 m over 54 houses), a frame offset, not an outline error: scoring after this translation measures shape.
 */
export function bestTranslation(a: MultiPoly, b: MultiPoly, maxShiftM = 3): { dx: number; dy: number; iou: number } {
  let best = { dx: 0, dy: 0, iou: iou(a, b) ?? 0 };
  const scan = (cx: number, cy: number, half: number, step: number) => {
    const n = Math.round(half / step);
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        const dx = Math.round((cx + i * step) * 100) / 100;
        const dy = Math.round((cy + j * step) * 100) / 100;
        if (Math.abs(dx) > maxShiftM || Math.abs(dy) > maxShiftM) continue;
        const v = iou(a, translate(b, dx, dy)) ?? 0;
        if (v > best.iou + 1e-12) best = { dx, dy, iou: v };
      }
    }
  };
  scan(0, 0, maxShiftM, 0.5);
  scan(best.dx, best.dy, 0.4, 0.1);
  return best;
}
