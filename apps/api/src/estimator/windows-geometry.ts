import type { LngLat } from '@roofline/shared';

/*
 * The geometry behind Measure windows (pure, no I/O). Everything is in a local plan frame: metres east (x) and north
 * (y) of an origin near the house, heights in metres above the ground at the street camera. A Street View photo is a
 * pinhole camera: from the camera's spot, its heading, pitch and field of view, a pixel is a ray; the ray meets the
 * front wall (a vertical plane over a footprint edge), and the hit points give a window's width and height.
 */

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** A Street View camera sits about 2.5 m above the road. */
export const CAMERA_HEIGHT_M = 2.5;
/** Field of view limits for a facade shot, degrees. */
export const MIN_FOV = 30;
export const MAX_FOV = 90;
/** Room kept round the front wall in a shot: a share of the wall's angular width, plus degrees. */
const FOV_MARGIN_SHARE = 0.15;
const FOV_MARGIN_DEG = 6;
/** A wall is part of the front when it faces the camera within this angle (more oblique walls are the sides). */
const FRONT_MAX_ANGLE_DEG = 70;
/** Walls shorter than this are jogs in the outline, not walls. */
const MIN_WALL_M = 0.5;
/** The top of a two-storey front, metres: the pitch keeps the ground and this height in the shot. */
const FRAME_TOP_M = 7;
const MAX_PITCH = 20;
/** Sill heights: below this it is the ground floor; each floor above is this tall. */
const GROUND_FLOOR_SILL_MAX_M = 2.4;
const FLOOR_HEIGHT_M = 3;
export const METRES_TO_INCHES = 39.3701;

export type Vec = [number, number];
export type Vec3 = [number, number, number];

/** A plan frame round `origin`: [lng, lat] to metres east/north and back (equirectangular: fine at a house's size). */
export function localFrame(origin: LngLat): { toLocal(p: LngLat): Vec; toLngLat(v: Vec): LngLat } {
  const k = Math.cos(origin[1] * DEG);
  return {
    toLocal: (p) => [(p[0] - origin[0]) * DEG * EARTH_RADIUS_M * k, (p[1] - origin[1]) * DEG * EARTH_RADIUS_M],
    toLngLat: (v) => [origin[0] + v[0] / (DEG * EARTH_RADIUS_M * k), origin[1] + v[1] / (DEG * EARTH_RADIUS_M)],
  };
}

/** Compass bearing from `a` to `b`, degrees 0..360 (0 north, 90 east). */
export function bearing(a: Vec, b: Vec): number {
  return norm360(Math.atan2(b[0] - a[0], b[1] - a[1]) / DEG);
}

export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** `a - b` as a signed angle in -180..180. */
export function angleDiff(a: number, b: number): number {
  return ((((a - b + 180) % 360) + 360) % 360) - 180;
}

/** One wall: a footprint edge from `a` to `b`, its length and its outward unit normal. */
export type Wall = { index: number; a: Vec; b: Vec; lengthM: number; normal: Vec };

/** The walls of a footprint ring (open or closed, either winding); jogs under MIN_WALL_M are left out. */
export function wallsOf(ring: readonly Vec[]): Wall[] {
  const pts = ring.length > 1 && ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1] ? ring.slice(0, -1) : [...ring];
  if (pts.length < 3) return [];
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    area2 += p[0] * q[1] - q[0] * p[1];
  }
  const ccw = area2 > 0;
  const walls: Wall[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < MIN_WALL_M) continue;
    // Outward: right of the direction of travel for a counter-clockwise ring, left for a clockwise one.
    const normal: Vec = ccw ? [dy / len, -dx / len] : [-dy / len, dx / len];
    walls.push({ index: i, a, b, lengthM: len, normal });
  }
  return walls;
}

export function perimeterM(walls: readonly Wall[]): number {
  return walls.reduce((t, w) => t + w.lengthM, 0);
}

const mid = (w: Wall): Vec => [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];

/** The cosine of the angle between a wall's outward normal and the direction from it to the camera (>0: it faces it). */
function facing(w: Wall, cam: Vec): number {
  const m = mid(w);
  const dx = cam[0] - m[0];
  const dy = cam[1] - m[1];
  const d = Math.hypot(dx, dy);
  return d === 0 ? 0 : (w.normal[0] * dx + w.normal[1] * dy) / d;
}

/**
 * The front: the walls that face the camera within FRONT_MAX_ANGLE_DEG (every wall that faces it at all when none
 * does that squarely). Walls facing away are the back and sides, which a street photo cannot see.
 */
export function frontWalls(walls: readonly Wall[], cam: Vec): Wall[] {
  const square = walls.filter((w) => facing(w, cam) >= Math.cos(FRONT_MAX_ANGLE_DEG * DEG));
  return square.length > 0 ? square : walls.filter((w) => facing(w, cam) > 0);
}

/** A shot of the front: where it looks and how wide. `measure`: windows are counted on it (inside `range`, bearings). */
export type Shot = { heading: number; fov: number; pitch: number; role: 'whole' | 'part'; measure: boolean; range: [number, number] };

/**
 * Where to aim at the front from the camera: one shot that fits the whole front with margin when it fits in
 * MAX_FOV; otherwise a whole-front shot at MAX_FOV (shown, not counted on) and two tighter shots, one per half, on
 * which windows are counted (each half's windows only, so none is counted twice).
 */
export function planShots(front: readonly Wall[], cam: Vec): Shot[] {
  if (front.length === 0) return [];
  const pts = front.flatMap((w) => [w.a, w.b]);
  const centre: Vec = [pts.reduce((t, p) => t + p[0], 0) / pts.length, pts.reduce((t, p) => t + p[1], 0) / pts.length];
  const c0 = bearing(cam, centre);
  const rel = pts.map((p) => angleDiff(bearing(cam, p), c0));
  const lo = Math.min(...rel);
  const hi = Math.max(...rel);
  const span = hi - lo;
  const needed = span * (1 + FOV_MARGIN_SHARE) + FOV_MARGIN_DEG;
  const distance = Math.max(3, Math.hypot(centre[0] - cam[0], centre[1] - cam[1]));
  const pitch = pitchFor(distance);
  const at = (relDeg: number) => round1(norm360(c0 + relDeg));
  const fovOf = (deg: number) => Math.round(Math.min(MAX_FOV, Math.max(MIN_FOV, deg)));
  if (needed <= MAX_FOV) {
    return [{ heading: at((lo + hi) / 2), fov: fovOf(needed), pitch, role: 'whole', measure: true, range: [norm360(c0 + lo), norm360(c0 + hi)] }];
  }
  const m = (lo + hi) / 2;
  const half = span / 2;
  return [
    { heading: at(m), fov: MAX_FOV, pitch, role: 'whole', measure: false, range: [norm360(c0 + lo), norm360(c0 + hi)] },
    { heading: at((lo + m) / 2), fov: fovOf(half * (1 + FOV_MARGIN_SHARE) + FOV_MARGIN_DEG), pitch, role: 'part', measure: true, range: [norm360(c0 + lo), norm360(c0 + m)] },
    { heading: at((m + hi) / 2), fov: fovOf(half * (1 + FOV_MARGIN_SHARE) + FOV_MARGIN_DEG), pitch, role: 'part', measure: true, range: [norm360(c0 + m), norm360(c0 + hi)] },
  ];
}

/** Tilt up enough to keep the ground and FRAME_TOP_M of wall in view at `distance`, degrees, 0..MAX_PITCH. */
export function pitchFor(distanceM: number): number {
  const low = Math.atan2(-CAMERA_HEIGHT_M, distanceM) / DEG;
  const high = Math.atan2(FRAME_TOP_M - CAMERA_HEIGHT_M, distanceM) / DEG;
  return round1(Math.min(MAX_PITCH, Math.max(0, (low + high) / 2)));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * A pinhole camera: its plan position, height, heading, pitch (up positive), horizontal fov and image size; `roll`
 * (degrees, absent = 0) turns it about its line of sight, its right side up for positive roll (the photo's content then
 * turns clockwise). Street View's camera can sit a few degrees off level, which the wall line-up finds.
 */
export type Camera = { pos: Vec; heightM: number; heading: number; pitch: number; fov: number; widthPx: number; heightPx: number; roll?: number };

function basis(cam: Camera): { f: number; F: Vec3; U: Vec3; R: Vec3 } {
  const h = cam.heading * DEG;
  const p = cam.pitch * DEG;
  const fwd: Vec = [Math.sin(h), Math.cos(h)];
  const right: Vec = [Math.cos(h), -Math.sin(h)];
  const f = cam.widthPx / 2 / Math.tan((cam.fov * DEG) / 2);
  const F: Vec3 = [fwd[0] * Math.cos(p), fwd[1] * Math.cos(p), Math.sin(p)];
  const U: Vec3 = [-fwd[0] * Math.sin(p), -fwd[1] * Math.sin(p), Math.cos(p)];
  const R: Vec3 = [right[0], right[1], 0];
  const r = (cam.roll ?? 0) * DEG;
  if (r === 0) return { f, F, U, R };
  // Roll: the right and up axes turned about the line of sight.
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { f, F, U: [U[0] * c - R[0] * s, U[1] * c - R[1] * s, U[2] * c - R[2] * s], R: [R[0] * c + U[0] * s, R[1] * c + U[1] * s, R[2] * c + U[2] * s] };
}

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Where a point (x east, y north, z up) lands in the photo, pixels from the top-left; null behind the camera. */
export function project(cam: Camera, p: Vec3): Vec | null {
  const { f, F, U, R } = basis(cam);
  const d: Vec3 = [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.heightM];
  const zc = dot3(d, F);
  if (zc <= 1e-6) return null;
  return [cam.widthPx / 2 + (f * dot3(d, R)) / zc, cam.heightPx / 2 - (f * dot3(d, U)) / zc];
}

/** The ray through a pixel, as a world direction. */
export function rayOf(cam: Camera, px: number, py: number): Vec3 {
  const { f, F, U, R } = basis(cam);
  const u = px - cam.widthPx / 2;
  const v = py - cam.heightPx / 2;
  return [f * F[0] + u * R[0] - v * U[0], f * F[1] + u * R[1] - v * U[1], f * F[2] + u * R[2] - v * U[2]];
}

/** Where the ray through a pixel meets the nearest of `walls` (vertical planes over their edges); null if none. */
export function hitWall(cam: Camera, walls: readonly Wall[], px: number, py: number): { point: Vec3; wall: Wall; rangeM: number } | null {
  const r = rayOf(cam, px, py);
  const hx = r[0];
  const hy = r[1];
  const hn = Math.hypot(hx, hy);
  if (hn < 1e-9) return null;
  let best: { t: number; wall: Wall } | null = null;
  for (const w of walls) {
    const ex = w.b[0] - w.a[0];
    const ey = w.b[1] - w.a[1];
    const den = hx * ey - hy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const ox = w.a[0] - cam.pos[0];
    const oy = w.a[1] - cam.pos[1];
    const t = (ox * ey - oy * ex) / den;
    const s = (ox * hy - oy * hx) / den;
    if (t <= 0 || s < -0.02 || s > 1.02) continue;
    if (best === null || t < best.t) best = { t, wall: w };
  }
  if (best === null) return null;
  const point: Vec3 = [cam.pos[0] + best.t * hx, cam.pos[1] + best.t * hy, cam.heightM + best.t * r[2]];
  return { point, wall: best.wall, rangeM: best.t * hn };
}

/** A box in the photo, 0..1 of its width and height, from its top-left corner. */
export type Box = { x: number; y: number; w: number; h: number };

/** A window sized from its box: width and height in inches, sill height (m), range to it (m) and its bearing. */
export type Sized = { widthIn: number; heightIn: number; sillM: number; rangeM: number; bearing: number; floor: number; /** Unrounded. */ widthM: number; heightM: number };

/**
 * A box on the front sized with the pinhole model: the rays through its left and right edges (at mid height) meet the
 * wall at the window's two sides, and the rays through its top and bottom (at its middle column) at its head and sill.
 * Works on oblique walls (each ray meets the wall where it is). Null when a ray misses every front wall.
 */
export function sizeBox(cam: Camera, front: readonly Wall[], box: Box): Sized | null {
  const W = cam.widthPx;
  const H = cam.heightPx;
  const midY = (box.y + box.h / 2) * H;
  const midX = (box.x + box.w / 2) * W;
  const centre = hitWall(cam, front, midX, midY);
  if (centre === null) return null;
  // Every edge is measured on the wall the box's centre is on, so a box at a corner is not stretched round it.
  const on = [centre.wall];
  const left = hitWall(cam, on, box.x * W, midY);
  const right = hitWall(cam, on, (box.x + box.w) * W, midY);
  const top = hitWall(cam, on, midX, box.y * H);
  const bottom = hitWall(cam, on, midX, (box.y + box.h) * H);
  if (left === null || right === null || top === null || bottom === null) return null;
  const widthM = Math.hypot(right.point[0] - left.point[0], right.point[1] - left.point[1]);
  const heightM = top.point[2] - bottom.point[2];
  if (!(widthM > 0) || !(heightM > 0)) return null;
  const sillM = bottom.point[2];
  return {
    widthIn: Math.round(widthM * METRES_TO_INCHES),
    heightIn: Math.round(heightM * METRES_TO_INCHES),
    sillM,
    rangeM: centre.rangeM,
    bearing: bearing(cam.pos, [centre.point[0], centre.point[1]]),
    floor: floorOf(sillM),
    widthM,
    heightM,
  };
}

/** The floor a window is on, by its sill height above the ground (1 = ground floor). */
export function floorOf(sillM: number): number {
  if (sillM < GROUND_FLOOR_SILL_MAX_M) return 1;
  return 2 + Math.floor((sillM - GROUND_FLOOR_SILL_MAX_M) / FLOOR_HEIGHT_M);
}

/** The front wall's region in the photo (0..1), ground to `topM`, clipped to the frame; null when it is not in it. */
export function facadeRegion(cam: Camera, front: readonly Wall[], topM: number): Box | null {
  const pts: Vec[] = [];
  for (const w of front) {
    for (const p of [w.a, w.b]) {
      for (const z of [0, topM]) {
        const q = project(cam, [p[0], p[1], z]);
        if (q !== null) pts.push(q);
      }
    }
  }
  if (pts.length === 0) return null;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x0 = clamp(Math.min(...pts.map((p) => p[0])) / cam.widthPx);
  const x1 = clamp(Math.max(...pts.map((p) => p[0])) / cam.widthPx);
  const y0 = clamp(Math.min(...pts.map((p) => p[1])) / cam.heightPx);
  const y1 = clamp(Math.max(...pts.map((p) => p[1])) / cam.heightPx);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The range from the camera to the front along the shot's centre line (horizontal), metres; null when it misses. */
export function centreRange(cam: Camera, front: readonly Wall[]): number | null {
  return hitWall(cam, front, cam.widthPx / 2, cam.heightPx / 2)?.rangeM ?? null;
}

/** Whether `deg` lies within the bearing range [from, to] (clockwise from `from`). */
export function inRange(deg: number, range: [number, number]): boolean {
  const span = norm360(range[1] - range[0]);
  return norm360(deg - range[0]) <= span + 1e-9;
}
