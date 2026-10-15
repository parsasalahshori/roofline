// Photo scenes for the photo hidden-edge method (outline-photo.ts): hermetic, seeded by a fixed hash.
import type { PhotoEdgeRaster } from '../../src/roof-reconstruct/outline-photo.ts';
import type { XY } from '../../src/roof-reconstruct/geom.ts';

// Hidden eaves drawn from scratch (hermetic, seeded): a rectangular house whose roof truly reaches x = 20 m, an outline
// that stops 1 m short of it on the east side (as the mask does under a crown), and a crown over that eave whose
// leaves leave gaps (sparse) or none (dense). The photo shows roof through the gaps and the yard beyond the eave.

export const ROOF_RGB = [118, 116, 124] as const;
export const YARD_RGB = [150, 122, 92] as const;
export const LEAF_RGB = [58, 112, 46] as const;

export type Scene = {
  /** Roof: x in [x0, x1], y in [y0, y1] (house frame, metres), eaves 5 m up. */
  roof: { x0: number; x1: number; y0: number; y1: number };
  /** A crown: centre, radius, and the share of its pixels that are leaves (1: dense). */
  crown?: { x: number; y: number; r: number; leaves: number };
  /** Something roof-coloured on the ground east of the roof (a concrete patio): x in [x1, x1 + patioM]. */
  patioM?: number;
  /**
   * Last word on a pixel (house-frame point `p`, pixel column and row): change its height, colour, Google's mask or
   * this roof's mask, for a scene one guard should refuse.
   */
  paint?: (p: XY, px: { z: number; col: readonly number[]; mask: number; roof: number }, c: number, r: number) => void;
};

/** A deterministic hash in [0, 1) for a pixel (the leaf pattern). */
export function hash01(c: number, r: number, seed: number): number {
  let t = (c * 73856093) ^ (r * 19349663) ^ (seed * 83492791);
  t = Math.imul(t ^ (t >>> 13), 0x5bd1e995);
  t ^= t >>> 15;
  return (t >>> 0) / 4294967296;
}

/**
 * The scene on a grid of `s` metre pixels, turned by `turnDeg` round the grid's centre (house frame to raster-local
 * metres), with the outline (house frame) turned the same way.
 */
export function render(scene: Scene, outlineHouse: readonly XY[], s: number, turnDeg = 0, seed = 3): { raster: PhotoEdgeRaster; outline: XY[] } {
  const size = 34;
  const W = Math.round(size / s);
  const H = W;
  const cx = size / 2;
  const cy = -size / 2;
  const t = (turnDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  // House frame is centred at (16, -16) before turning.
  const toLocal = (p: XY): XY => {
    const dx = p.x - 16;
    const dy = p.y + 16;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  };
  const toHouse = (p: XY): XY => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: 16 + dx * cos + dy * sin, y: -16 - dx * sin + dy * cos };
  };
  const dsm = new Float32Array(W * H);
  const rgb = new Uint8Array(W * H * 3);
  const mask = new Uint8Array(W * H);
  const roofPx = new Uint8Array(W * H);
  const { x0, x1, y0, y1 } = scene.roof;
  const outlineLocal = outlineHouse.map(toLocal);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      const p = toHouse({ x: (c + 0.5) * s, y: -(r + 0.5) * s });
      const onRoof = p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
      // A low pitch toward the outside so the heights are not all one number; the eave at 5 m.
      let z = onRoof ? 5 + 0.15 * Math.min(p.x - x0, x1 - p.x, p.y - y0, y1 - p.y) : 0;
      let col: readonly number[] = onRoof ? ROOF_RGB : YARD_RGB;
      if (!onRoof && scene.patioM !== undefined && p.x > x1 && p.x <= x1 + scene.patioM && p.y >= y0 && p.y <= y1) col = ROOF_RGB;
      const k = scene.crown;
      if (k !== undefined && Math.hypot(p.x - k.x, p.y - k.y) <= k.r && hash01(c, r, seed) < k.leaves) {
        // Leaves: green, and rough heights well above the eave.
        z = 7 + 0.4 * (hash01(r, c, seed + 1) - 0.5);
        col = LEAF_RGB;
      }
      // Google's mask: the outline we are given (the short one), as roof.
      const q = { x: (c + 0.5) * s, y: -(r + 0.5) * s };
      const px = { z, col, mask: inRing(q, outlineLocal) ? 1 : 0, roof: inRing(q, outlineLocal) ? 1 : 0 };
      scene.paint?.(p, px, c, r);
      dsm[i] = px.z;
      const n = Math.round(6 * (hash01(c + 7, r + 3, seed) - 0.5));
      rgb[3 * i] = px.col[0]! + n;
      rgb[3 * i + 1] = px.col[1]! + n;
      rgb[3 * i + 2] = px.col[2]! + n;
      mask[i] = px.mask;
      roofPx[i] = px.roof;
    }
  }
  return { raster: { width: W, height: H, pixelSizeM: s, dsm, rgb, mask, roof: roofPx }, outline: outlineLocal };
}

export function inRing(p: XY, ring: readonly XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export const ROOF = { x0: 8, x1: 20, y0: -23, y1: -9 };
/** Counter-clockwise (y north), 1 m short on the east: edge 1 is the east edge. */
export const SHORT: XY[] = [
  { x: 8, y: -23 },
  { x: 19, y: -23 },
  { x: 19, y: -9 },
  { x: 8, y: -9 },
];
export const CORRECT: XY[] = [
  { x: 8, y: -23 },
  { x: 20, y: -23 },
  { x: 20, y: -9 },
  { x: 8, y: -9 },
];

