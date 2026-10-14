// The ground round a roof, from the height map: a plane (a lot can slope) under the pixels next to the roof that are
// on no roof, not green and not rough. What the mask calls roof but lies on that ground (a patio, a drive, a car) is
// not roof; and the share of the roof's edge that tree crowns stand over (roof the height map cannot see).
import { fitPlane, type Plane } from './planes.ts';
import { type Grid, type Mask, squaredDistance } from './raster.ts';

/** The ground is fitted to pixels this far from the roof, metres. */
const BAND_FROM_M = 1;
const BAND_TO_M = 8;
/** Fewest ground pixels for a plane. */
const MIN_GROUND_PX = 200;
/** A pixel whose second difference of height is over this (metres) is rough: a crown, a fence, a car's edge. */
const ROUGH_M = 0.15;
/** Each round keeps the ground pixels at most this far above the median residual of those kept, metres. */
const ENVELOPE_M = 0.3;
const ROUNDS = 6;

/**
 * The ground round a roof as a plane, in the grid's metres (x east from the left edge, y north from the top edge):
 * fitted to the pixels BAND_FROM_M to BAND_TO_M from the roof (`roof`) that are on no roof (`anyRoof`), not green and
 * not rough, keeping the lower part of them each round (a lower envelope: shrubs, fences and cars stand on the
 * ground). Only the window round the roof is looked at. Null with too few such pixels.
 */
export function groundPlane(
  g: Grid,
  s: number,
  dsm: Float32Array,
  roof: (i: number) => boolean,
  anyRoof: Mask,
  green: Mask | null,
  window: { c0: number; r0: number; c1: number; r1: number },
): Plane | null {
  const pad = Math.ceil(BAND_TO_M / s) + 1;
  const c0 = Math.max(1, window.c0 - pad);
  const r0 = Math.max(1, window.r0 - pad);
  const c1 = Math.min(g.w - 2, window.c1 + pad);
  const r1 = Math.min(g.h - 2, window.r1 + pad);
  if (c1 <= c0 || r1 <= r0) return null;
  const sub = { w: c1 - c0 + 1, h: r1 - r0 + 1 };
  const at = (k: number) => (Math.floor(k / sub.w) + r0) * g.w + (k % sub.w) + c0;
  const d2 = squaredDistance(sub, (k) => roof(at(k)));
  const lo2 = (BAND_FROM_M / s) ** 2;
  const hi2 = (BAND_TO_M / s) ** 2;
  const idx: number[] = [];
  for (let k = 0; k < d2.length; k++) {
    if (d2[k]! < lo2 || d2[k]! > hi2) continue;
    const i = at(k);
    const z = dsm[i]!;
    if (anyRoof[i] !== 0 || green?.[i] === 1 || !Number.isFinite(z)) continue;
    const lap = Math.abs(4 * z - dsm[i - 1]! - dsm[i + 1]! - dsm[i - g.w]! - dsm[i + g.w]!);
    if (!(lap < ROUGH_M)) continue;
    idx.push(i);
  }
  if (idx.length < MIN_GROUND_PX) return null;
  let kept = idx;
  let plane: Plane | null = null;
  for (let round = 0; round < ROUNDS; round++) {
    plane = fitPlane(g, s, dsm, kept);
    if (plane === null) return null;
    const p = plane;
    const res = (i: number) => dsm[i]! - (p.a * ((i % g.w) + 0.5) * s - p.b * (Math.floor(i / g.w) + 0.5) * s + p.c);
    const sorted = kept.map(res).sort((a, b) => a - b);
    const cut = sorted[Math.floor(sorted.length / 2)]! + ENVELOPE_M;
    const next = idx.filter((i) => res(i) < cut);
    if (next.length < MIN_GROUND_PX) break;
    kept = next;
  }
  return plane;
}

/** A plane in a crop's metres, from one in the whole grid's (the crop's top-left pixel at column c0, row r0). */
export function planeInCrop(p: Plane, s: number, c0: number, r0: number): Plane {
  return { a: p.a, b: p.b, c: p.c + p.a * c0 * s - p.b * r0 * s };
}

/** Height of each pixel above a ground plane (NaN where the height map has none), on a grid. */
export function heightAboveGround(g: Grid, s: number, dsm: Float32Array, ground: Plane): Float32Array {
  const out = new Float32Array(g.w * g.h);
  for (let i = 0; i < out.length; i++) {
    const x = ((i % g.w) + 0.5) * s;
    const y = -(Math.floor(i / g.w) + 0.5) * s;
    out[i] = dsm[i]! - (ground.a * x + ground.b * y + ground.c);
  }
  return out;
}
