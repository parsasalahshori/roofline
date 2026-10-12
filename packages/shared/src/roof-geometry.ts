// Pure roof geometry: local equirectangular projection, shoelace area, edge perimeter,
// pitch factor, minimum-area rotated rectangle, and outline sanity checks.
import type { LngLat, Ring } from './roof.ts';

const EARTH_RADIUS_M = 6371008.8;
const FT_PER_M = 3.280839895;
const TOO_LARGE_SQFT = 200000;

type Pt = { x: number; y: number };

// Drops non-finite points, consecutive duplicates and a repeated closing point.
function cleanRing(ring: Ring): LngLat[] {
  const out: LngLat[] = [];
  for (const p of ring) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 1 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) {
    out.pop();
  }
  return out;
}

// Projects a ring to local feet at its mean latitude and longitude.
function project(ring: Ring): Pt[] {
  const pts = cleanRing(ring);
  if (pts.length === 0) return [];
  let lng0 = 0;
  let lat0 = 0;
  for (const [lng, lat] of pts) {
    lng0 += lng;
    lat0 += lat;
  }
  lng0 /= pts.length;
  lat0 /= pts.length;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  return pts.map(([lng, lat]) => ({
    x: (lng - lng0) * (Math.PI / 180) * cosLat * EARTH_RADIUS_M * FT_PER_M,
    y: (lat - lat0) * (Math.PI / 180) * EARTH_RADIUS_M * FT_PER_M,
  }));
}

export function polygonAreaSqFt(ring: Ring): number {
  const p = project(ring);
  if (p.length < 3) return 0;
  let twice = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!;
    const b = p[(i + 1) % p.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

export function perimeterFt(ring: Ring): number {
  const p = project(ring);
  if (p.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!;
    const b = p[(i + 1) % p.length]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

export function pitchFactor(pitchX12: number): number {
  return Math.sqrt(1 + (pitchX12 / 12) ** 2);
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

// Monotone chain convex hull, counter-clockwise, without collinear points.
function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function minRotatedRectangle(ring: Ring): { longFt: number; shortFt: number } {
  const hull = convexHull(project(ring));
  if (hull.length < 2) return { longFt: 0, shortFt: 0 };
  if (hull.length === 2) {
    return { longFt: Math.hypot(hull[1]!.x - hull[0]!.x, hull[1]!.y - hull[0]!.y), shortFt: 0 };
  }
  // The minimum-area enclosing rectangle has one side flush with a hull edge.
  let best: { area: number; longFt: number; shortFt: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const theta = Math.atan2(b.y - a.y, b.x - a.x);
    const c = Math.cos(-theta);
    const s = Math.sin(-theta);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of hull) {
      const rx = p.x * c - p.y * s;
      const ry = p.x * s + p.y * c;
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
    }
    const w = maxX - minX;
    const h = maxY - minY;
    const area = w * h;
    if (!best || area < best.area) {
      best = { area, longFt: Math.max(w, h), shortFt: Math.min(w, h) };
    }
  }
  return { longFt: best!.longFt, shortFt: best!.shortFt };
}

function orient(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function properlyCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

export function outlineProblem(ring: Ring): 'too_few_corners' | 'self_intersecting' | 'too_large' | null {
  const corners = cleanRing(ring);
  if (corners.length < 3) return 'too_few_corners';
  const p = project(ring);
  const n = p.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Adjacent edges share an endpoint, including the first and last edge.
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (properlyCross(p[i]!, p[(i + 1) % n]!, p[j]!, p[(j + 1) % n]!)) return 'self_intersecting';
    }
  }
  if (polygonAreaSqFt(ring) > TOO_LARGE_SQFT) return 'too_large';
  return null;
}
