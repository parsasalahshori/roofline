// Google Solar building insights, as the estimator uses them: roof planes and their pitch, the roof's dominant
// pitch, and (when no building footprint is found) an outline made from the roof planes. Pure: no I/O, never throws.
import { outlineProblem, polygonAreaSqFt } from './roof-geometry.ts';
import type { LngLat, Ring } from './roof.ts';
import type { RoofPlane } from './roof-model.ts';

/** One roof segment of a building, as Google Solar measured it. */
export type SolarSegment = {
  /** Angle from the ground, degrees (0 flat, 90 vertical). */
  pitchDeg: number;
  /** Compass direction the segment faces, degrees (0 north, 90 east; 0 for flat segments). */
  azimuthDeg: number;
  /** Sloped area. */
  areaM2: number;
  /** Plan (ground) area. */
  groundAreaM2: number;
  /** [lng, lat], near the segment's middle. */
  center: LngLat;
  /** The segment's bounding box, [lng, lat] corners; null when Google left it out. */
  box: { sw: LngLat; ne: LngLat } | null;
};

/** The building Google Solar found nearest a point: its box, imagery facts and roof segments. */
export type SolarBuilding = {
  center: LngLat | null;
  box: { sw: LngLat; ne: LngLat } | null;
  /** HIGH, MEDIUM, LOW or BASE (Google's words); null when not given. */
  imageryQuality: string | null;
  /** YYYY-MM-DD, approximate. */
  imageryDate: string | null;
  segments: SolarSegment[];
};

/**
 * What a measurement keeps of one Solar lookup, so measuring the same home again within SOLAR_CACHE_DAYS does not
 * ask (and pay) again. `building` is null when Google has no building there.
 */
export type SolarSnapshot = { fetchedAt: string; at: LngLat; building: SolarBuilding | null };

/**
 * Where a measurement's pitch came from: Google Solar's roof segments, the estimator's default, the person who changed
 * it, or the roof reconstructed in 3D from Google Solar's height map ('solar-3d': each face its own measured pitch).
 */
export const PITCH_SOURCES = ['solar', 'default', 'manual', 'solar-3d'] as const;
export type PitchSource = (typeof PITCH_SOURCES)[number];

/** How long a home's Solar answer is reused. */
export const SOLAR_CACHE_DAYS = 30;
/** A cached answer is for the home only when it was asked about a point this close to the home's point. */
export const SOLAR_CACHE_NEAR_M = 3;

/** Segments with less plan area than this (about 21 sq ft) are noise: a chimney, a vent, a dormer cheek. */
const MIN_SEGMENT_GROUND_M2 = 2;
/** Segments steeper than this are walls or mistakes, not roof. */
const MAX_SEGMENT_PITCH_DEG = 60;
/** Below this (x/12) a segment counts as flat. */
const FLAT_X12 = 2;
const SQ_FT_PER_SQ_M = 10.7639104167;
const EARTH_RADIUS_M = 6371008.8;
const K = (Math.PI / 180) * EARTH_RADIUS_M;

/** A pitch in degrees as whole x/12 (33.7 degrees is 8/12), 0 to 24. Non-finite is 0. */
export function pitchX12FromDegrees(deg: number): number {
  if (!Number.isFinite(deg) || deg <= 0) return 0;
  const x = 12 * Math.tan((Math.min(deg, 89) * Math.PI) / 180);
  return Math.max(0, Math.min(24, Math.round(x)));
}

function finitePoint(p: unknown): p is LngLat {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

/** The segments worth using: real roof (not tiny, not a wall), with finite numbers. */
export function usableSegments(building: SolarBuilding | null | undefined): SolarSegment[] {
  if (building === null || building === undefined || !Array.isArray(building.segments)) return [];
  return building.segments.filter(
    (s) =>
      Number.isFinite(s.pitchDeg) &&
      s.pitchDeg >= 0 &&
      s.pitchDeg <= MAX_SEGMENT_PITCH_DEG &&
      Number.isFinite(s.azimuthDeg) &&
      Number.isFinite(s.groundAreaM2) &&
      s.groundAreaM2 >= MIN_SEGMENT_GROUND_M2 &&
      finitePoint(s.center),
  );
}

/** The building's usable segments as roof planes (pitch in whole x/12, plan area in sq ft). */
export function roofPlanesOf(building: SolarBuilding | null | undefined): RoofPlane[] {
  return usableSegments(building).map((s) => ({
    pitchX12: pitchX12FromDegrees(s.pitchDeg),
    azimuthDeg: Math.round(s.azimuthDeg * 10) / 10,
    center: [s.center[0], s.center[1]],
    areaSqFt: Math.round(s.groundAreaM2 * SQ_FT_PER_SQ_M * 10) / 10,
  }));
}

/**
 * The roof's pitch: the area-weighted median of its planes' pitches (the pitch the most roof is at or around).
 * Flat planes are left out unless they are most of the roof (a flat roof). Null with no planes.
 */
export function dominantPitchX12(planes: readonly RoofPlane[]): number | null {
  const usable = planes.filter((p) => Number.isFinite(p.pitchX12) && Number.isFinite(p.areaSqFt) && p.areaSqFt > 0);
  const total = usable.reduce((s, p) => s + p.areaSqFt, 0);
  if (total <= 0) return null;
  const sloped = usable.filter((p) => p.pitchX12 >= FLAT_X12);
  const slopedArea = sloped.reduce((s, p) => s + p.areaSqFt, 0);
  const pool = slopedArea >= total / 2 ? sloped : usable;
  const poolArea = pool.reduce((s, p) => s + p.areaSqFt, 0);
  const sorted = [...pool].sort((a, b) => a.pitchX12 - b.pitchX12 || b.areaSqFt - a.areaSqFt);
  let running = 0;
  for (const p of sorted) {
    running += p.areaSqFt;
    if (running >= poolArea / 2) return p.pitchX12;
  }
  return sorted[sorted.length - 1]?.pitchX12 ?? null;
}

/** Metres between two [lng, lat] points (equirectangular: fine at building scale). */
export function metresApart(a: LngLat, b: LngLat): number {
  const cos = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * K * cos, (b[1] - a[1]) * K);
}

/** Metres from a point to the building's box (0 inside it); Infinity when the building has no box. */
export function metresToBuilding(building: SolarBuilding, point: LngLat): number {
  const box = building.box;
  if (box === null || !finitePoint(box.sw) || !finitePoint(box.ne)) {
    return building.center !== null && finitePoint(building.center) ? metresApart(building.center, point) : Infinity;
  }
  const lng = Math.min(Math.max(point[0], box.sw[0]), box.ne[0]);
  const lat = Math.min(Math.max(point[1], box.sw[1]), box.ne[1]);
  return metresApart([lng, lat], point);
}

type V = { x: number; y: number };

function ringContains(p: V, poly: V[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distanceToRing(p: V, poly: V[]): number {
  if (ringContains(p, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/**
 * The planes over a building outline: those centred inside the ring or within `toleranceM` of it. Google's building
 * may be a neighbour's (it answers the nearest within about 50 m): then no plane is over the ring and none is kept.
 */
export function planesOverRing(planes: readonly RoofPlane[], ring: Ring, toleranceM = 2): RoofPlane[] {
  if (ring.length < 3) return [];
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const lng0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cos = Math.cos((lat0 * Math.PI) / 180);
  const local = (p: LngLat): V => ({ x: (p[0] - lng0) * K * cos, y: (p[1] - lat0) * K });
  const poly = ring.map(local);
  return planes.filter((p) => distanceToRing(local(p.center), poly) <= toleranceM);
}

// ---------------------------------------------------------------------------------------------------------
// An outline from the roof segments: each segment as a rectangle turned the way it faces, the rectangles merged on
// a fine grid (gaps between neighbouring segments closed), and the merged shape's edge traced and simplified.

/** Grid cell, metres. */
const CELL_M = 0.25;
/** Gaps narrower than about twice this (in cells) between segments are closed. */
const CLOSE_CELLS = 2;
/** The grid never grows beyond this many cells a side (a very large building gets coarser cells). */
const MAX_CELLS = 480;
const SIMPLIFY_M = 0.35;
/** Segments facing within this many degrees of the main segment's axes are squared to them. */
const SNAP_AXIS_DEG = 35;
/** An outline smaller than this is not a house (sq ft). */
const MIN_OUTLINE_SQFT = 150;

type Frame = { lng0: number; lat0: number; cos: number; ux: V; uy: V };

function fromFrame(f: Frame, q: V): LngLat {
  const x = q.x * f.ux.x + q.y * f.uy.x;
  const y = q.x * f.ux.y + q.y * f.uy.y;
  return [f.lng0 + x / (K * f.cos), f.lat0 + y / K];
}

/**
 * A segment's footprint: the rectangle facing its azimuth that fills its bounding box (solved from the box's two
 * sides; near 45 degrees, from the box and the segment's plan area). The box itself when nothing sensible solves.
 */
function segmentRect(s: SolarSegment, lng0: number, lat0: number, cos: number, azimuthDeg: number = s.azimuthDeg): V[] | null {
  if (s.box === null || !finitePoint(s.box.sw) || !finitePoint(s.box.ne)) return null;
  const x0 = (s.box.sw[0] - lng0) * K * cos;
  const y0 = (s.box.sw[1] - lat0) * K;
  const x1 = (s.box.ne[0] - lng0) * K * cos;
  const y1 = (s.box.ne[1] - lat0) * K;
  const bx = x1 - x0;
  const by = y1 - y0;
  if (!(bx > 0.2 && by > 0.2)) return null;
  const box: V[] = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  const phi = (azimuthDeg * Math.PI) / 180;
  const sn = Math.abs(Math.sin(phi));
  const cs = Math.abs(Math.cos(phi));
  let a: number;
  let b: number;
  const det = sn * sn - cs * cs;
  if (Math.abs(det) > 0.35) {
    // bx = a*sn + b*cs and by = a*cs + b*sn, with a along the slope and b along the eave.
    a = (bx * sn - by * cs) / det;
    b = (by * sn - bx * cs) / det;
  } else {
    const sum = (bx + by) / (sn + cs);
    const area = Number.isFinite(s.groundAreaM2) && s.groundAreaM2 > 0 ? s.groundAreaM2 : (sum * sum) / 4;
    const disc = Math.max(0, sum * sum - 4 * area);
    a = (sum - Math.sqrt(disc)) / 2;
    b = sum - a;
  }
  if (!(a > 0.3 && b > 0.3) || !Number.isFinite(a) || !Number.isFinite(b)) return box;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const d = { x: Math.sin(phi), y: Math.cos(phi) };
  const e = { x: Math.cos(phi), y: -Math.sin(phi) };
  const corner = (sa: number, sb: number): V => ({ x: cx + (d.x * a * sa + e.x * b * sb) / 2, y: cy + (d.y * a * sa + e.y * b * sb) / 2 });
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
}

function convexContains(poly: V[], p: V): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(c) < 1e-12) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function dpOpen(pts: V[], tol: number): V[] {
  if (pts.length <= 2) return pts;
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  let far = -1;
  let farD = 0;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const d = len > 0 ? Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len : Math.hypot(p.x - a.x, p.y - a.y);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  if (far < 0 || farD <= tol) return [a, b];
  const left = dpOpen(pts.slice(0, far + 1), tol);
  const right = dpOpen(pts.slice(far), tol);
  return [...left.slice(0, -1), ...right];
}

/** Douglas-Peucker on a closed ring, split at its two most distant corners. */
function simplifyClosed(ring: V[], tol: number): V[] {
  if (ring.length <= 4) return ring;
  let far = 0;
  let farD = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i]!.x - ring[0]!.x, ring[i]!.y - ring[0]!.y);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = dpOpen(ring.slice(0, far + 1), tol);
  const b = dpOpen([...ring.slice(far), ring[0]!], tol);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : ring;
}

/**
 * An outline for the building from its roof segments, for when no building footprint is found. Null when the
 * segments have no boxes, or the merged shape is not a sensible house outline. Rings are open, [lng, lat].
 */
export function outlineFromSolar(building: SolarBuilding | null | undefined): Ring | null {
  try {
    const segments = usableSegments(building).filter((s) => s.box !== null);
    if (segments.length === 0) return null;
    const lat0 = segments.reduce((s, x) => s + x.center[1], 0) / segments.length;
    const lng0 = segments.reduce((s, x) => s + x.center[0], 0) / segments.length;
    const cos = Math.cos((lat0 * Math.PI) / 180);
    // The grid follows the biggest segment's direction, so the main walls run along it.
    const main = segments.reduce((best, s) => (s.groundAreaM2 > best.groundAreaM2 ? s : best));
    const mainDeg = main.pitchDeg < 5 ? 0 : main.azimuthDeg;
    // A hip or dormer facing within SNAP_AXIS_DEG of the house's axes sits on the house's rectangle: square it to
    // them, so the merged outline keeps straight walls (a wing really turned further keeps its own direction).
    const rects = segments
      .map((s) => {
        const off = ((((s.azimuthDeg - mainDeg) % 90) + 135) % 90) - 45;
        const snapped = s.pitchDeg < 5 || Math.abs(off) <= SNAP_AXIS_DEG ? s.azimuthDeg - off : s.azimuthDeg;
        return segmentRect(s, lng0, lat0, cos, s.pitchDeg < 5 ? mainDeg : snapped);
      })
      .filter((r): r is V[] => r !== null);
    if (rects.length === 0) return null;
    const phi = (mainDeg * Math.PI) / 180;
    const ux = { x: Math.cos(phi), y: -Math.sin(phi) };
    const uy = { x: Math.sin(phi), y: Math.cos(phi) };
    const frame: Frame = { lng0, lat0, cos, ux, uy };
    const turned = rects.map((r) => r.map((p) => ({ x: p.x * ux.x + p.y * ux.y, y: p.x * uy.x + p.y * uy.y })));

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of turned) {
      for (const p of r) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    const pad = CLOSE_CELLS + 2;
    const cell = Math.max(CELL_M, Math.max(maxX - minX, maxY - minY) / (MAX_CELLS - 2 * pad));
    const w = Math.ceil((maxX - minX) / cell) + 2 * pad;
    const h = Math.ceil((maxY - minY) / cell) + 2 * pad;
    const ox = minX - pad * cell;
    const oy = minY - pad * cell;
    let grid: Uint8Array = new Uint8Array(w * h);
    const boxes = turned.map((r) => ({
      r,
      x0: Math.floor((Math.min(...r.map((p) => p.x)) - ox) / cell),
      x1: Math.ceil((Math.max(...r.map((p) => p.x)) - ox) / cell),
      y0: Math.floor((Math.min(...r.map((p) => p.y)) - oy) / cell),
      y1: Math.ceil((Math.max(...r.map((p) => p.y)) - oy) / cell),
    }));
    for (const b of boxes) {
      for (let j = Math.max(0, b.y0); j < Math.min(h, b.y1); j++) {
        for (let i = Math.max(0, b.x0); i < Math.min(w, b.x1); i++) {
          if (convexContains(b.r, { x: ox + (i + 0.5) * cell, y: oy + (j + 0.5) * cell })) grid[j * w + i] = 1;
        }
      }
    }

    // Close small gaps: grow by CLOSE_CELLS, then shrink back.
    const morph = (src: Uint8Array, grow: boolean): Uint8Array => {
      const out = new Uint8Array(w * h);
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          let hit = !grow;
          for (let dj = -CLOSE_CELLS; dj <= CLOSE_CELLS && hit !== grow; dj++) {
            for (let di = -CLOSE_CELLS; di <= CLOSE_CELLS; di++) {
              const x = i + di;
              const y = j + dj;
              const v = x >= 0 && y >= 0 && x < w && y < h ? src[y * w + x]! : 0;
              if (grow ? v === 1 : v === 0) {
                hit = grow;
                break;
              }
            }
          }
          out[j * w + i] = hit ? 1 : 0;
        }
      }
      return out;
    };
    grid = morph(morph(grid, true), false);

    // Keep the largest connected shape, with its holes filled.
    const label = new Int32Array(w * h).fill(-1);
    let best = -1;
    let bestSize = 0;
    let next = 0;
    const stack: number[] = [];
    for (let k = 0; k < w * h; k++) {
      if (grid[k] !== 1 || label[k] !== -1) continue;
      let size = 0;
      label[k] = next;
      stack.push(k);
      while (stack.length > 0) {
        const c = stack.pop()!;
        size++;
        const ci = c % w;
        const cj = (c - ci) / w;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const x = ci + di;
          const y = cj + dj;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const n = y * w + x;
          if (grid[n] === 1 && label[n] === -1) {
            label[n] = next;
            stack.push(n);
          }
        }
      }
      if (size > bestSize) {
        bestSize = size;
        best = next;
      }
      next++;
    }
    if (best < 0) return null;
    const shape = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) if (label[k] === best) shape[k] = 1;
    // Holes: empty cells the outside cannot reach.
    const outside = new Uint8Array(w * h);
    for (let i = 0; i < w; i++) stack.push(i, (h - 1) * w + i);
    for (let j = 0; j < h; j++) stack.push(j * w, j * w + w - 1);
    while (stack.length > 0) {
      const c = stack.pop()!;
      if (outside[c] === 1 || shape[c] === 1) continue;
      outside[c] = 1;
      const ci = c % w;
      const cj = (c - ci) / w;
      if (ci > 0) stack.push(c - 1);
      if (ci < w - 1) stack.push(c + 1);
      if (cj > 0) stack.push(c - w);
      if (cj < h - 1) stack.push(c + w);
    }
    for (let k = 0; k < w * h; k++) if (outside[k] === 0) shape[k] = 1;
    // Two cells touching only at a corner would make the edge cross itself there: fill one of the gaps.
    for (let changed = true; changed; ) {
      changed = false;
      for (let j = 0; j + 1 < h; j++) {
        for (let i = 0; i + 1 < w; i++) {
          const a = shape[j * w + i]!;
          const b = shape[j * w + i + 1]!;
          const c = shape[(j + 1) * w + i]!;
          const d = shape[(j + 1) * w + i + 1]!;
          if (a === 1 && d === 1 && b === 0 && c === 0) {
            shape[j * w + i + 1] = 1;
            changed = true;
          } else if (b === 1 && c === 1 && a === 0 && d === 0) {
            shape[j * w + i] = 1;
            changed = true;
          }
        }
      }
    }

    // Trace the shape's edge: each filled cell's side next to an empty cell, as a counter-clockwise edge.
    const filled = (i: number, j: number) => i >= 0 && j >= 0 && i < w && j < h && shape[j * w + i] === 1;
    const vkey = (i: number, j: number) => j * (w + 1) + i;
    const out = new Map<number, number>();
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (!filled(i, j)) continue;
        if (!filled(i, j - 1)) out.set(vkey(i, j), vkey(i + 1, j));
        if (!filled(i + 1, j)) out.set(vkey(i + 1, j), vkey(i + 1, j + 1));
        if (!filled(i, j + 1)) out.set(vkey(i + 1, j + 1), vkey(i, j + 1));
        if (!filled(i - 1, j)) out.set(vkey(i, j + 1), vkey(i, j));
      }
    }
    let longest: V[] = [];
    const seen = new Set<number>();
    for (const start of out.keys()) {
      if (seen.has(start)) continue;
      const loop: V[] = [];
      let at: number | undefined = start;
      let guard = 0;
      while (at !== undefined && !seen.has(at) && guard++ < 1_000_000) {
        seen.add(at);
        const i = at % (w + 1);
        const j = (at - i) / (w + 1);
        loop.push({ x: ox + i * cell, y: oy + j * cell });
        at = out.get(at);
      }
      if (loop.length > longest.length) longest = loop;
    }
    if (longest.length < 4) return null;
    const simple = simplifyClosed(longest, Math.max(SIMPLIFY_M, cell * 1.2));
    if (simple.length < 3) return null;
    const ring: Ring = simple.map((q) => fromFrame(frame, q));
    const area = polygonAreaSqFt(ring);
    if (area < MIN_OUTLINE_SQFT || outlineProblem(ring) !== null) return null;
    return ring;
  } catch {
    return null;
  }
}

/** A cached Solar answer still good for a home at `point` at `now`. */
export function solarSnapshotFresh(snapshot: SolarSnapshot | null | undefined, point: LngLat, now: Date): boolean {
  if (snapshot === null || snapshot === undefined || !finitePoint(snapshot.at)) return false;
  const at = Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(at) || now.getTime() - at > SOLAR_CACHE_DAYS * 86_400_000 || at > now.getTime() + 60_000) return false;
  return metresApart(snapshot.at, point) <= SOLAR_CACHE_NEAR_M;
}
