// Small plane-geometry kit for the roof reconstruction (metres, x east, y north).

export type XY = { x: number; y: number };

export function signedArea(ring: readonly XY[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function dist(a: XY, b: XY): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** The point on segment ab nearest p, and its parameter (0 at a, 1 at b). */
export function nearestOnSegment(p: XY, a: XY, b: XY): { q: XY; t: number; d: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  const q = { x: a.x + t * dx, y: a.y + t * dy };
  return { q, t, d: dist(p, q) };
}

/** Douglas-Peucker on an open polyline (keeps both ends); returns the kept indexes. */
export function simplifyIdx(pts: readonly XY[], tol: number, lo = 0, hi = pts.length - 1, out: number[] = []): number[] {
  if (lo === 0 && out.length === 0) out.push(0);
  if (hi <= lo + 1) {
    out.push(hi);
    return out;
  }
  const a = pts[lo]!;
  const b = pts[hi]!;
  const len = dist(a, b);
  let far = -1;
  let farD = -1;
  for (let i = lo + 1; i < hi; i++) {
    const p = pts[i]!;
    const d = len > 1e-12 ? Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len : dist(p, a);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  if (farD <= tol) {
    out.push(hi);
    return out;
  }
  simplifyIdx(pts, tol, lo, far, out);
  simplifyIdx(pts, tol, far, hi, out);
  return out;
}

/** Douglas-Peucker on a closed ring (split at the point farthest from the first); returns kept indexes, in order. */
export function simplifyClosedIdx(ring: readonly XY[], tol: number): number[] {
  const n = ring.length;
  if (n <= 4) return [...Array(n).keys()];
  let far = 0;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = dist(ring[i]!, ring[0]!);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const first = simplifyIdx(ring.slice(0, far + 1), tol);
  const second = simplifyIdx([...ring.slice(far), ring[0]!], tol).map((k) => (k + far) % n);
  const out = [...first.slice(0, -1), ...second.slice(0, -1)];
  return out.length >= 3 ? out : [...Array(n).keys()];
}

/** Whether segments ab and cd cross (touching at a shared end does not count). */
export function segmentsCross(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12));
}

/** Whether a ring's edges cross each other (neighbouring edges are allowed to share their corner). */
export function selfIntersects(ring: readonly XY[]): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(a, b, ring[j]!, ring[(j + 1) % n]!)) return true;
    }
  }
  return false;
}

export function pointInRing(p: XY, ring: readonly XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A line as a point on it and a unit direction. */
export type Line = { p: XY; d: XY };

/** Where two lines cross; null when they are (nearly) parallel. */
export function intersectLines(l1: Line, l2: Line): XY | null {
  const den = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / den;
  return { x: l1.p.x + t * l1.d.x, y: l1.p.y + t * l1.d.y };
}

/** Total least squares line through points (null with fewer than two distinct points). */
export function fitLine(pts: readonly XY[]): Line | null {
  if (pts.length < 2) return null;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    const x = p.x - mx;
    const y = p.y - my;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }
  if (sxx + syy < 1e-12) return null;
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: { x: mx, y: my }, d: { x: Math.cos(ang), y: Math.sin(ang) } };
}

/** Polyline length. */
export function pathLength(pts: readonly XY[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1]!, pts[i]!);
  return s;
}
