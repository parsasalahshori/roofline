// Pieces of the mask that are not roof (docs/roof-3d/area.md): Google's mask takes in what stands beside a house at
// any height, and the planes then draw it as a flat face of the roof. Two kinds are told by what they physically are:
//
// - A DECK or TERRACE is a floor: flat, at the edge of the roof, with the house standing a storey or more above it all
//   along its house side (the roof beyond it is a wall's height up, nowhere continuous with it), and with things
//   standing on it (furniture, planters, a hot tub, railings) that a roof does not carry.
// - A PERGOLA (or any slatted, see-through cover) is flat at cover height, and the height map sees through it: a share
//   of its pixels lies far under its own plane, down towards the ground.
//
// A flat or low-slope roof section is neither: it is continuous with the roof it belongs to somewhere along its edge
// (bounded by eaves at roof height), or smooth, or solid. A near-flat piece made of several faces is judged as one.
//
// Pure, deterministic, never throws. Coordinates are the crop's raster-local metres (x east, y north, so y <= 0).
import { type Plane, pixelX, pixelY, planeZ } from './planes.ts';
import { components, dilate, erode, type Grid, largestComponent, open, squaredDistance } from './raster.ts';

export type CoverParams = {
  /** Decks and terraces cut. Off by default until it is measured to help (round 4, area track). */
  enabled: boolean;
  /** Pergolas cut too (with `enabled`). Off: no pergola on the development houses to check it against. */
  pergola: boolean;
  /** Near-flat: a face under this pitch (x/12) can be a deck, a terrace or a pergola. */
  maxPitchX12: number;
  /** A piece smaller than this (square metres) is left alone, and one larger than `maxShare` of the roof. */
  minM2: number;
  maxShare: number;
  /** At least this share of the piece's edge is the roof's outline (it stands at the edge, beside the house). */
  outlineShare: number;
  /** The house's roof stands at least this much (metres) above a deck along its house side: a storey. */
  storeyM: number;
  /** ... along at least this share of the house side (the roof read 0.6 to 1.5 m beyond the piece's edge). */
  wallShare: number;
  /** The roof beyond within this (metres) of the piece's height is continuous with it: a roof section. */
  continuousM: number;
  /** A piece continuous with the roof along more than this share of its house side is roof. */
  continuousShare: number;
  /**
   * Things standing on a deck: pixels at least `standM` above its plane, at least `standShare` of it, read 0.5 m in
   * from its edge and `standAwayM` from the house (a wall's heights smear over the first metre beside it).
   */
  standM: number;
  standShare: number;
  standAwayM: number;
  /**
   * See-through: pixels (0.5 m in from its edge) at least `seeThroughM` under its plane, at least `seeThroughShare` of
   * it, scattered (in `seeThroughParts` pieces or more, none with half of them): the gaps between slats, not a ramp.
   */
  seeThroughM: number;
  seeThroughShare: number;
  seeThroughParts: number;
  /** A pergola's top stands at least this far above the ground (metres): a cover, not a sunken patio. */
  coverOverGroundM: number;
};

export const DEFAULT_COVER_PARAMS: CoverParams = {
  enabled: false,
  pergola: false,
  maxPitchX12: 2.5,
  minM2: 4,
  maxShare: 0.35,
  outlineShare: 0.25,
  storeyM: 2.0,
  wallShare: 0.6,
  continuousM: 0.6,
  continuousShare: 0.15,
  standM: 0.3,
  standShare: 0.05,
  standAwayM: 1.0,
  seeThroughM: 1.0,
  seeThroughShare: 0.15,
  seeThroughParts: 3,
  coverOverGroundM: 2.0,
};

export type CoverKind = 'deck' | 'pergola';
/** One piece judged (debug and tests): its faces, size, and the measurements behind the call. */
export type CoverPiece = {
  faces: number[];
  areaM2: number;
  outlineShare: number;
  wallShare: number;
  continuousShare: number;
  standShare: number;
  seeThroughShare: number;
  overGroundM: number | null;
  kind: CoverKind | null;
};

/** Metres beyond a piece's edge at which the roof beyond it is read. */
const BEYOND_FROM_M = 0.6;
const BEYOND_TO_M = 1.5;
/** Metres in from a piece's edge that its own surface is read (the heights are smeared at its edge). */
const INSIDE_M = 0.5;

function median(v: number[]): number {
  if (v.length === 0) return Number.NaN;
  const a = v.slice().sort((p, q) => p - q);
  const n = a.length;
  return n % 2 === 1 ? a[(n - 1) / 2]! : (a[n / 2 - 1]! + a[n / 2]!) / 2;
}

/**
 * The near-flat pieces of a roof (adjoining near-flat faces at one height joined into one), each measured and judged.
 * `hag`: height above the ground per pixel (null when the ground is not known: no pergola is then called).
 */
export function judgeCovers(
  g: Grid,
  s: number,
  dsm: Float32Array,
  roof: Uint8Array,
  labels: Int32Array,
  planes: readonly Plane[],
  hag: Float32Array | null,
  prm: CoverParams,
): CoverPiece[] {
  const n = g.w * g.h;
  const flat = planes.map((p) => Math.hypot(p.a, p.b) * 12 < prm.maxPitchX12);
  const roofPx = roof.reduce((t, v) => t + v, 0);
  if (roofPx === 0 || !flat.some((f) => f)) return [];
  // Near-flat faces' heights, for joining adjoining ones at one height.
  const zOf = planes.map(() => [] as number[]);
  for (let i = 0; i < n; i++) {
    const k = labels[i]!;
    if (k >= 0 && flat[k] && Number.isFinite(dsm[i]!)) zOf[k]!.push(dsm[i]!);
  }
  const zMed = zOf.map((v) => median(v));
  // Union-find over near-flat faces that touch and lie within continuousM of each other.
  const parent = planes.map((_, k) => k);
  const find = (k: number): number => {
    while (parent[k] !== k) k = parent[k] = parent[parent[k]!]!;
    return k;
  };
  for (let i = 0; i < n; i++) {
    const k = labels[i]!;
    if (k < 0 || !flat[k]) continue;
    const c = i % g.w;
    for (const j of [c + 1 < g.w ? i + 1 : -1, i + g.w < n ? i + g.w : -1]) {
      if (j < 0) continue;
      const l = labels[j]!;
      if (l < 0 || l === k || !flat[l]) continue;
      if (Math.abs(zMed[k]! - zMed[l]!) <= prm.continuousM) parent[find(k)] = find(l);
    }
  }
  const groups = new Map<number, number[]>();
  planes.forEach((_, k) => {
    if (!flat[k] || zOf[k]!.length === 0) return;
    const r = find(k);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(k);
  });
  const out: CoverPiece[] = [];
  const inset = Math.max(1, Math.round(INSIDE_M / s));
  for (const members of groups.values()) {
    const inPiece = (i: number) => labels[i]! >= 0 && members.includes(labels[i]!);
    let px = 0;
    for (let i = 0; i < n; i++) if (inPiece(i)) px++;
    const areaM2 = px * s * s;
    if (areaM2 < prm.minM2 || px > prm.maxShare * roofPx) continue;
    // Its edge: piece pixels with a 4-neighbour off it; on the outline when that neighbour is off the roof.
    let edge = 0;
    let onOutline = 0;
    for (let i = 0; i < n; i++) {
      if (!inPiece(i)) continue;
      const c = i % g.w;
      const r = (i - c) / g.w;
      let off = false;
      let out0 = false;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const cc = c + dc;
        const rr = r + dr;
        const j = rr * g.w + cc;
        if (cc < 0 || rr < 0 || cc >= g.w || rr >= g.h || roof[j] !== 1) {
          off = true;
          out0 = true;
        } else if (!inPiece(j)) off = true;
      }
      if (off) edge++;
      if (out0) onOutline++;
    }
    const outlineShare = edge > 0 ? onOutline / edge : 0;
    // Its own surface: one plane through its pixels 0.5 m in from its edge (the members' planes are within continuousM).
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (inPiece(i)) mask[i] = 1;
    const core = erode(g, mask, inset);
    // The house beside it: other roof; things standing on it are read away from it.
    const house2 = squaredDistance(g, (i) => roof[i] === 1 && mask[i] !== 1);
    const away2 = (prm.standAwayM / s) ** 2;
    const own = members.length === 1 ? planes[members[0]!]! : null;
    const zPiece = median(members.flatMap((k) => zOf[k]!));
    const surface = (i: number) => (own !== null ? planeZ(own, pixelX(g, s, i), pixelY(g, s, i)) : zPiece);
    let corePx = 0;
    let awayPx = 0;
    let stand = 0;
    const seen = new Uint8Array(n);
    let see = 0;
    const over: number[] = [];
    for (let i = 0; i < n; i++) {
      if (core[i] !== 1 || !Number.isFinite(dsm[i]!)) continue;
      corePx++;
      const d = dsm[i]! - surface(i);
      if (house2[i]! >= away2) {
        awayPx++;
        if (d >= prm.standM) stand++;
      }
      if (d <= -prm.seeThroughM) {
        see++;
        seen[i] = 1;
      }
      if (hag !== null && Number.isFinite(hag[i]!)) over.push(hag[i]!);
    }
    const standShare = awayPx > 0 ? stand / awayPx : 0;
    // The see-through pixels count only when scattered (gaps between slats), not one block (a ramp, a hole).
    let seeThroughShare = corePx > 0 ? see / corePx : 0;
    if (see > 0) {
      const { sizes } = components(g, (i) => seen[i] === 1);
      const parts = sizes.filter((z, l) => l > 0 && z > 0);
      if (parts.length < prm.seeThroughParts || Math.max(...parts) >= 0.5 * see) seeThroughShare = 0;
    }
    // The pergola's height over the ground: the upper part of its pixels (the rest may be the ground seen through it).
    const overGroundM = over.length > 0 ? over.sort((a, b) => a - b)[Math.floor(0.75 * (over.length - 1))]! : null;
    // The roof beyond its edge (0.6 to 1.5 m away, other roof): how far above the piece it stands.
    const d2 = squaredDistance(g, (i) => mask[i] === 1);
    const lo = (BEYOND_FROM_M / s) ** 2;
    const hi = (BEYOND_TO_M / s) ** 2;
    let beyond = 0;
    let wall = 0;
    let cont = 0;
    for (let i = 0; i < n; i++) {
      if (roof[i] !== 1 || mask[i] === 1 || d2[i]! < lo || d2[i]! > hi || !Number.isFinite(dsm[i]!)) continue;
      beyond++;
      const up = dsm[i]! - zPiece;
      if (up >= prm.storeyM) wall++;
      else if (Math.abs(up) <= prm.continuousM) cont++;
    }
    const wallShare = beyond > 0 ? wall / beyond : 0;
    const continuousShare = beyond > 0 ? cont / beyond : 0;
    let kind: CoverKind | null = null;
    if (outlineShare >= prm.outlineShare) {
      if (beyond > 0 && wallShare >= prm.wallShare && continuousShare <= prm.continuousShare && standShare >= prm.standShare) kind = 'deck';
      else if (prm.pergola && seeThroughShare >= prm.seeThroughShare && overGroundM !== null && overGroundM >= prm.coverOverGroundM && continuousShare <= prm.continuousShare)
        kind = 'pergola';
    }
    out.push({ faces: members.slice().sort((a, b) => a - b), areaM2, outlineShare, wallShare, continuousShare, standShare, seeThroughShare, overGroundM, kind });
  }
  return out;
}

/**
 * The pixels to take out of the roof: every piece judged a deck, a terrace or a pergola (judgeCovers), grown by a pixel
 * so the smeared edge between it and the house goes with it. Null when there is none.
 */
export function coverPixels(g: Grid, labels: Int32Array, roof: Uint8Array, pieces: readonly CoverPiece[]): Uint8Array | null {
  const faces = new Set<number>();
  for (const p of pieces) if (p.kind !== null) for (const k of p.faces) faces.add(k);
  if (faces.size === 0) return null;
  const n = g.w * g.h;
  const cut = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (labels[i]! >= 0 && faces.has(labels[i]!)) cut[i] = 1;
  const grown = dilate(g, cut, 1);
  for (let i = 0; i < n; i++) if (roof[i] !== 1) grown[i] = 0;
  // Only what stays one piece with the cut: no stray pixel of the house is taken.
  const { labels: parts } = components(g, (i) => grown[i] === 1);
  const keep = new Set<number>();
  for (let i = 0; i < n; i++) if (cut[i] === 1 && parts[i]! > 0) keep.add(parts[i]!);
  for (let i = 0; i < n; i++) if (grown[i] === 1 && !keep.has(parts[i]!)) grown[i] = 0;
  return grown;
}

/** Pieces of roof left hanging on the house by a neck narrower than this (metres) where a cover was cut go with it. */
const NECK_M = 1.0;

/**
 * The roof with the cut taken out, and with what the cut leaves hanging off the house (a piece joined to the main body
 * by a neck under NECK_M wide, next to the cut: the rest of a terrace) taken out with it.
 */
export function cutCovers(g: Grid, s: number, roof: Uint8Array, cut: Uint8Array): Uint8Array {
  const n = g.w * g.h;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = roof[i] === 1 && cut[i] !== 1 ? 1 : 0;
  const r = Math.max(1, Math.round(NECK_M / 2 / s));
  const body = dilate(g, largestComponent(g, open(g, out, r)), r);
  const near = dilate(g, cut, r + 1);
  const { labels } = components(g, (i) => out[i] === 1 && body[i] !== 1);
  const drop = new Set<number>();
  for (let i = 0; i < n; i++) if (labels[i]! > 0 && near[i] === 1) drop.add(labels[i]!);
  for (let i = 0; i < n; i++) if (labels[i]! > 0 && drop.has(labels[i]!)) out[i] = 0;
  return out;
}
