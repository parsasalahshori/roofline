import type { ScanVec3 } from '@roofline/shared';

/*
 * The reviewer's look at the refinement's 3D: the aligned COLMAP points, the triangulated window corners and the cameras, drawn as a
 * plain scatter from the front (facing the wall), from above and from the side (no 3D library); the server thins the points to a few thousand. World space is ARKit's: metres, +Y up. Seen from above the window wall runs along
 * the horizontal (x) and depth (z) is down the page, so the wall is on top and the cameras below it; seen from the side (from +x)
 * depth runs right to left and height up.
 */

export type CloudPoint = { x: number; y: number; z: number; r: number; g: number; b: number };
export type CloudView = 'front' | 'top' | 'side';
export const CLOUD_VIEWS: readonly CloudView[] = ['front', 'top', 'side'];

/** The server's points ([x, y, z, r, g, b] each) as points. */
export const cloudPoints = (rows: readonly (readonly number[])[]): CloudPoint[] =>
  rows.filter((r) => r.length >= 3 && r.slice(0, 3).every(Number.isFinite)).map((r) => ({ x: r[0]!, y: r[1]!, z: r[2]!, r: r[3] ?? 150, g: r[4] ?? 150, b: r[5] ?? 150 }));

/** A world point on the page, metres: u to the right, v down. */
export function cloudUv(view: CloudView, p: readonly [number, number, number]): [number, number] {
  if (view === 'front') return [p[0], -p[1]];
  return view === 'top' ? [p[0], p[2]] : [-p[2], -p[1]];
}

export type CloudFit = { scale: number; ox: number; oy: number };

const quantile = (sorted: number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]!;

/**
 * Where to put the scene on a `w` x `h` panel: the middle 96% of the points (a stray far point does not shrink the rest) together with
 * everything in `always` (the corners and the cameras), fitted with `pad` px of room, the same metres per pixel both ways.
 */
export function fitCloud(uv: readonly (readonly [number, number])[], always: readonly (readonly [number, number])[], w: number, h: number, pad = 18): CloudFit {
  const us = uv.map((p) => p[0]).sort((a, b) => a - b);
  const vs = uv.map((p) => p[1]).sort((a, b) => a - b);
  const xs = [...(us.length > 0 ? [quantile(us, 0.02), quantile(us, 0.98)] : []), ...always.map((p) => p[0])];
  const ys = [...(vs.length > 0 ? [quantile(vs, 0.02), quantile(vs, 0.98)] : []), ...always.map((p) => p[1])];
  if (xs.length === 0 || ys.length === 0) return { scale: 100, ox: w / 2, oy: h / 2 };
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = Math.min((w - 2 * pad) / Math.max(x1 - x0, 0.2), (h - 2 * pad) / Math.max(y1 - y0, 0.2));
  return { scale, ox: w / 2 - ((x0 + x1) / 2) * scale, oy: h / 2 - ((y0 + y1) / 2) * scale };
}

export const toPanel = (fit: CloudFit, uv: readonly [number, number]): [number, number] => [fit.ox + uv[0] * fit.scale, fit.oy + uv[1] * fit.scale];

/** A scale bar: the round length (0.1, 0.2, 0.5, 1, 2, 5 m) whose drawing is nearest to 80 px at this scale. */
export function scaleBar(scale: number): { metres: number; px: number } {
  const metres = [0.1, 0.2, 0.5, 1, 2, 5].reduce((best, m) => (Math.abs(m * scale - 80) < Math.abs(best * scale - 80) ? m : best), 1);
  return { metres, px: metres * scale };
}

export type CloudScene = { corners: readonly ScanVec3[]; cameras: { p: ScanVec3; colmap: boolean }[] };
