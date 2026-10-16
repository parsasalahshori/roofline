import jpeg from 'jpeg-js';
import { CAMERA_HEIGHT_M, type Camera, project, type Vec, wallsOf } from '../../src/estimator/windows-geometry.ts';
import { mainWall, type Quad } from '../../src/estimator/windows-lineup.ts';

/*
 * Synthetic street photos of a house front (no Google imagery in the repo): a pinhole camera looks at a front wall
 * drawn as flat shapes, back to front: sky and street, the roof band, the wall (textured like brick or siding), and
 * what is on or in front of it (a garage door with panel lines, windows with heads, porch posts and a beam). The
 * outline's wall is 16 m north of the camera; `realOffsetM` moves the house in the photo further back than the outline
 * says, the way a Street View camera placed a few metres off (or a footprint drawn too close) does on live houses.
 */

export const W = 640;
export const H = 640;
export const TRUE: Camera = { pos: [0, 0], heightM: CAMERA_HEIGHT_M, heading: 4, pitch: 4, fov: 60, widthPx: W, heightPx: H };
export const EAVE = 3.0;
/** A 14 m by 9 m house, front wall 16 m north of the camera (the outline). */
export const RING: Vec[] = [
  [-7, 16],
  [7, 16],
  [7, 25],
  [-7, 25],
];
export const WALL = mainWall(wallsOf(RING), [0, 0])!;

export type Scene = {
  /** The house in the photo sits this much further back than the outline (m). */
  realOffsetM?: number;
  /** The house in the photo is this much wider each side than the outline (m). */
  realWidenM?: number;
  eaveM?: number;
  /** A garage door on the wall: from x0 to x1 (m east of the wall's middle), heightM tall, with `panels` panel lines. */
  garage?: { x0: number; x1: number; heightM: number; panels: number };
  /** Windows on the wall: x0..x1 (m), sill and head (m above the ground); each has a dark head line. */
  windows?: { x0: number; x1: number; sill: number; head: number }[];
  /** Porch posts `depthM` in front of the wall at these x (m), up to a beam at `beamM`. */
  porch?: { depthM: number; posts: number[]; beamM: number };
  /** No roof band: the wall's top meets a sky as bright as it (no eave edge). */
  noRoof?: boolean;
  /** A low wall (garden wall or fence) from x0 to x1, `heightM` tall, `depthM` in front of the house. */
  fence?: { x0: number; x1: number; heightM: number; depthM: number };
  /** How rough the wall is (brick or siding): grey levels either way. Default 18. */
  texture?: number;
  seed?: number;
};

/** Seeded noise in -1..1. */
export function noise(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

export function inside(p: Vec, q: readonly Vec[]): boolean {
  let hit = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i]!;
    const [xj, yj] = q[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

export function render(paint: (x: number, y: number) => number): Uint8Array {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = Math.max(0, Math.min(255, Math.round(paint(x, y))));
    const i = (y * W + x) * 4;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ width: W, height: H, data }, 90).data);
}

/** A rectangle on a vertical plane `depth` m north of the camera, x0..x1 east, z0..z1 up, in the photo (BL, BR, TR, TL). */
export function rectAt(cam: Camera, depth: number, x0: number, x1: number, z0: number, z1: number): Quad {
  const p = (x: number, z: number) => project(cam, [x, depth, z])!;
  return [p(x0, z0), p(x1, z0), p(x1, z1), p(x0, z1)];
}

/** The photo of a scene, as JPEG bytes, and the house's true corners in it. */
export function scene(s: Scene = {}, cam: Camera = TRUE): { bytes: Uint8Array; wall: Quad } {
  const depth = 16 + (s.realOffsetM ?? 0);
  const widen = s.realWidenM ?? 0;
  const eave = s.eaveM ?? EAVE;
  const wall = rectAt(cam, depth, -7 - widen, 7 + widen, 0, eave);
  const roof = rectAt(cam, depth, -7.4 - widen, 7.4 + widen, eave, eave + 2.2);
  const n = noise(s.seed ?? 7);
  type Layer = { q: Quad; paint: (x: number, y: number) => number };
  const layers: Layer[] = [];
  if (s.noRoof !== true) layers.push({ q: roof, paint: () => 55 + 20 * n() });
  const tex = s.texture ?? 18;
  layers.push({ q: wall, paint: () => 190 + tex * n() });
  if (s.garage !== undefined) {
    const g = s.garage;
    const q = rectAt(cam, depth, g.x0, g.x1, 0, g.heightM);
    const top = q[3][1];
    const bottom = q[0][1];
    const lines = Array.from({ length: g.panels }, (_, k) => top + ((k + 1) * (bottom - top)) / (g.panels + 1));
    layers.push({ q, paint: (_x, y) => (lines.some((ly) => Math.abs(y - ly) < 1.5) ? 120 : 238 + 6 * n()) });
  }
  for (const w of s.windows ?? []) {
    layers.push({ q: rectAt(cam, depth, w.x0 - 0.12, w.x1 + 0.12, w.sill - 0.08, w.head + 0.25), paint: () => 80 + 10 * n() });
    layers.push({ q: rectAt(cam, depth, w.x0, w.x1, w.sill, w.head), paint: () => 120 + 15 * n() });
  }
  if (s.fence !== undefined) {
    const f = s.fence;
    layers.push({ q: rectAt(cam, depth - f.depthM, f.x0, f.x1, 0, f.heightM), paint: () => 95 + 25 * n() });
  }
  if (s.porch !== undefined) {
    const p = s.porch;
    const d = depth - p.depthM;
    for (const x of p.posts) layers.push({ q: rectAt(cam, d, x - 0.1, x + 0.1, 0, p.beamM), paint: () => 245 + 5 * n() });
    const xs = p.posts;
    layers.push({ q: rectAt(cam, d, Math.min(...xs) - 0.2, Math.max(...xs) + 0.2, p.beamM, p.beamM + 0.3), paint: () => 240 + 5 * n() });
  }
  const bytes = render((x, y) => {
    const pt: Vec = [x + 0.5, y + 0.5];
    for (let i = layers.length - 1; i >= 0; i--) if (inside(pt, layers[i]!.q)) return layers[i]!.paint(x, y);
    if (s.noRoof === true && y < wall[3][1]) return 195 + 25 * n();
    return (y > H * 0.6 ? 120 : 150) + 20 * n();
  });
  return { bytes, wall };
}
