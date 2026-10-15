// Scenes for the planes hidden-edge method (outline-planes.ts), drawn from scratch: a roof given by its planes, the
// outline as Google's mask left it, a dense crown outside that outline (hiding the eave from the heights), and the
// odd patch of visible ground, another building or roof seen through the leaves. Raster-local metres (x east, y north
// from the top edge, so y <= 0); hermetic (no randomness beyond a fixed ripple).
import type { Plane } from '../../src/roof-reconstruct/planes.ts';
import type { PlanesInput } from '../../src/roof-reconstruct/outline-planes.ts';
import type { XY } from '../../src/roof-reconstruct/geom.ts';

export type PlaneScene = {
  /** Pixel size, metres. */
  s: number;
  /** Grid size, metres (square from the origin). */
  sizeM: number;
  /** The roof's planes (z = a x + b y + c, metres). */
  planes: Plane[];
  /** Whether a point is on the true roof; its height is the lowest of the planes there (a hip), its face that plane. */
  onRoof: (q: XY) => boolean;
  /** The outline as the mask left it (counter-clockwise, y north). */
  outline: XY[];
  /** A dense crown (rough, 7-8 m high) where this is true, outside the outline only. */
  crown?: (q: XY) => boolean;
  /** A crown inside the outline where this is true (crown the mask took for roof). */
  crownIn?: (q: XY) => boolean;
  /** Visible ground (height 0) where this is true: a gap in the leaves over the yard. Wins over the crown. */
  ground?: (q: XY) => boolean;
  /** The roof's own plane seen through the leaves where this is true (a sparse crown over roof). Wins over the crown. */
  roofSeen?: (q: XY) => boolean;
  /** Another building's mask part where this is true. */
  other?: (q: XY) => boolean;
};

export function inRingXY(p: XY, ring: readonly XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** The input inferHiddenEaves takes for the scene. Labels: every pixel inside the outline, by its lowest plane. */
export function planeInput(sc: PlaneScene): PlanesInput {
  const { s } = sc;
  const w = Math.round(sc.sizeM / s);
  const h = w;
  const dsm = new Float32Array(w * h);
  const labels = new Int32Array(w * h).fill(-1);
  const crown = new Uint8Array(w * h);
  const other = new Uint8Array(w * h);
  const lowest = (q: XY) => {
    let best = 0;
    for (let k = 1; k < sc.planes.length; k++) {
      const pk = sc.planes[k]!;
      const pb = sc.planes[best]!;
      if (pk.a * q.x + pk.b * q.y + pk.c < pb.a * q.x + pb.b * q.y + pb.c) best = k;
    }
    return best;
  };
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const q = { x: (c + 0.5) * s, y: -(r + 0.5) * s };
      const i = r * w + c;
      const inside = inRingXY(q, sc.outline);
      const f = lowest(q);
      const pl = sc.planes[f]!;
      let z = sc.onRoof(q) ? pl.a * q.x + pl.b * q.y + pl.c : 0;
      if ((!inside && sc.crown?.(q) === true) || (inside && sc.crownIn?.(q) === true)) {
        z = 7.5 + 0.3 * Math.sin(q.x * 7.3) * Math.cos(q.y * 6.1);
        crown[i] = 1;
      }
      if (sc.roofSeen?.(q) === true) z = pl.a * q.x + pl.b * q.y + pl.c;
      if (sc.ground?.(q) === true) z = 0;
      dsm[i] = z;
      if (inside) labels[i] = f;
      if (sc.other?.(q) === true) other[i] = 1;
    }
  }
  return { g: { w, h }, s, dsm, labels, planes: sc.planes, other: sc.other !== undefined ? other : null, crown, outline: sc.outline };
}

/** Axis-aligned box test. */
export const box = (x0: number, y0: number, x1: number, y1: number) => (q: XY) => q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1;
/** Disc test. */
export const disc = (cx: number, cy: number, r: number) => (q: XY) => Math.hypot(q.x - cx, q.y - cy) <= r;
/** A fixed pseudo-random number in [0, 1) per pixel (the pattern of gaps in the leaves). */
export function pixelHash(x: number, y: number, s: number): number {
  let h = (Math.imul(Math.floor(x / s), 73856093) ^ Math.imul(Math.floor(-y / s), 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
