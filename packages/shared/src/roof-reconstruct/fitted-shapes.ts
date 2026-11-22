// Small roof shapes fitted to the height map as shapes (model fitting), where the plane search fits planes bottom-up
// and never finds a face a couple of metres across: the height map blurs it into its neighbours.
//
// Each shape has its own finder and its own switch:
// - ridge-roofs.ts (ShapeParams.ridgeRoofs): a small roof with a ridge of its own, a gable over an entry or a
//   bump-out, a dormer, a short wing, from the crest the blur leaves standing;
// - hip-ends.ts (ShapeParams.hipEnds): the face that drains to an eave of the outline where the faces have none, a hip
//   end merged into the two long slopes (the roof reads as a gable there), from the heights beside the eave.
// A finder proposes; this file disposes. Every proposed shape comes with its evidence: over its footprint it explains
// the heights better than the faces that are there now, by a margin (nothing is invented on a smooth slope, and a
// face the roof already has gains nothing). The footprint's pixels then become faces on the shape's planes (locked: a
// refit on the blurred heights would bend them back; marked `fitted`), topology draws the creases where the planes
// meet, and a shape whose faces topology cannot draw well (under the smallest face size, a thin strip, optionally a
// polygon drawn from pixels), or that spoils a face beside it, is taken out again.
import type { XY } from './geom.ts';
import { findHipEnds } from './hip-ends.ts';
import { compact, dissolve, type Faces, pixelX, pixelY, type Plane, planeZ, splitParts } from './planes.ts';
import type { Grid, Mask } from './raster.ts';
import { findRidgeRoofs } from './ridge-roofs.ts';
import type { Topology } from './topology.ts';

export type ShapeParams = {
  /**
   * Small roofs with a ridge of their own (ridge-roofs.ts). Off: none is fitted. OFF BY DEFAULT: on the benchmark its
   * line medians moved by two or three houses crossing them (dev 18.0 -> 16.2, held-out 20.2 -> 23.6) while the
   * per-line table barely moved, and the held-out area gate failed (2.39 -> 3.01 %).
   */
  ridgeRoofs: boolean;
  /**
   * Faces draining to an eave of the outline that the faces lack: hip ends (hip-ends.ts). OFF BY DEFAULT: at the
   * report's smallest face sizes (shapeFaceM2, shapeFaceWidthM) it fits nothing on the benchmark's EagleView dev houses
   * (an end face that small is a thin strip by those sizes); with thin faces let in, the six it fits there are all
   * EagleView's.
   */
  hipEnds: boolean;
  /**
   * The evidence for any shape: over at least shapeMinM2 of footprint (square metres) the heights are closer to the
   * shape than to the faces' planes by shapeGainM on average (metres; each distance counted up to 1 m).
   */
  shapeMinM2: number;
  shapeGainM: number;
  /** A slope of a shape runs out for as long as the heights lie within this of its plane (metres). */
  shapeTolM: number;
  /**
   * The height map rounds a crest or an eave off: within shapeRoundM of it the heights may lie up to shapeRoundDropM
   * under the shape's plane.
   */
  shapeRoundM: number;
  shapeRoundDropM: number;
  /** A shape's pitch lies between these (x/12; never over the plane search's own limit). */
  shapeMinX12: number;
  shapeMaxX12: number;
  /** A slope runs out at most this far (metres). */
  shapeMaxRunM: number;
  /** The shape stands at least this high (metres): its pitch times its slopes' median run. */
  shapeReliefM: number;
  /**
   * A fitted face stays when the polygon topology draws for it is at least this big (square metres) and this wide on
   * average (twice its area over its perimeter, metres): the report's smallest face, and (when shapeFaceWidthM is set)
   * no thin strip. shapeFaceWidthM is 0 by default: a dormer's or a hip end's real faces are under 0.9 m wide by that
   * measure (EagleView's own faces are, 122 times in 390 on dev), and a fitted face is marked `fitted` for the checks
   * that count thin faces.
   */
  shapeFaceM2: number;
  shapeFaceWidthM: number;
  /**
   * A face beside a shape that topology drew well before and draws under this width (metres) with the shape in, or
   * from its pixels, or under the smallest face size, is spoiled by it: the shape is taken out. (That face is no
   * fitted face: the checks count it as it is.)
   */
  shapeSpoilWidthM: number;
  /**
   * A fitted face must have a sound polygon (corner to corner along its creases), not one drawn from its pixels. Off by
   * default for ridge roofs drawn on their planes ('planes' footprint): on the dev houses it took out four of the shapes
   * EagleView confirms and none it does not.
   */
  shapeSound: boolean;
  /** False (a study switch): every shape with its evidence stays, whatever topology draws of it. */
  shapeCheck: boolean;
  /**
   * Ridge roofs. A crest: the heights fall away from the pixel on both sides, across the ridge's direction, at
   * ridgeCrestSlope or more (rise over run, measured 0.6 and 1 m out), where the faces' own planes fall away on both
   * sides at less than ridgeModelSlope (no ridge of theirs within half a metre). A ridge: crest pixels in line for at
   * least ridgeMinM (metres), gaps up to ridgeRunGapM bridged.
   */
  ridgeCrestSlope: number;
  ridgeModelSlope: number;
  ridgeMinM: number;
  ridgeRunGapM: number;
  /** A slope of a ridge roof the faces already explain as well (its gain under this, metres) keeps its faces. */
  ridgeSideGainM: number;
  /**
   * The tent's pitch: its own least-squares pitch, or one of the roof's (the faces beside the crest, the roof's largest
   * pitch groups), whichever explains the heights round the crest best (a small roof's slopes are short, and the
   * rounded crest and valleys pull a least-squares pitch low). False: the least-squares pitch alone.
   */
  ridgePitchPrior: boolean;
  /**
   * The footprint. 'planes': each slope out to a straight eave (as far as the heights carried it in most columns) and
   * in to where the tent's plane goes under the faces' own (the valley, a plane meeting a plane), connected to the
   * ridge. 'walk': column by column as far as the heights followed the slope (the first version).
   */
  ridgeFootprint: 'planes' | 'walk';
  /**
   * A ridge roof is two slopes standing on the roof: its crest stands at least this far (metres, median along the
   * ridge) above the plane of the face its new slopes are cut from. 0: not checked. A crest that is a ridge the roof
   * already has, drawn a little off, stands on that face's own plane.
   */
  shapeCrestM: number;
  /** A new slope within this many degrees of a face beside it, and within 0.1 m of its plane, is that face (degrees; 0: not checked). */
  shapeCoplanarDeg: number;
  /**
   * Google's height map smooths a small roof like a Gaussian of this sigma (metres; measured 0.3-0.4 m on the dev
   * houses): a tent is fitted and judged in that blurred form across its ridge (its crest reads rounded and low by
   * about 0.8 sigma times its pitch). 0 (the default: on the dev houses 0.2 and 0.35 fitted no more shapes and fewer
   * of EagleView's): the sharp tent, its first half metre left out of the fit.
   */
  shapeBlurM: number;
  /**
   * A shape is placed only when it explains the heights THROUGH the height map's smoothing: the faces as they stand and
   * the faces with the shape in, each rendered as a surface round the shape and smoothed like the height map (a
   * Gaussian of judgeSmoothM metres; measured 0.30-0.40 m for faces this small), and over the shape's footprint the
   * smoothed shape must leave the heights closer than the smoothed faces it replaces, by judgeGainM or more of RMS
   * (metres; about the height map's noise). An attenuated real gable matches its smoothed model closely; a crease
   * invented on a smooth slope gains nothing. (The faces' common test, refine.ts judgeChange, is measured on every
   * shape for the record, FittedShape.judge, with its numbers judgeLossM, judgePerPx, judgeMedM: its gain floor was
   * set for faces the plane search finds on their own heights, and a small attenuated feature cannot reach it.)
   */
  shapeJudge: boolean;
  judgeSmoothM: number;
  judgeGainM: number;
  judgeLossM: number;
  judgePerPx: number;
  judgeMedM: number;
  /**
   * Hip ends. An eave: an outline edge at least hipEdgeM long (metres) beside which (hipBandInM to hipBandOutM in from
   * it) the heights climb away from the edge on one plane, level along the edge within hipAlongShare of the climb.
   */
  hipEdgeM: number;
  hipBandInM: number;
  hipBandOutM: number;
  hipAlongShare: number;
};

export const DEFAULT_SHAPE_PARAMS: ShapeParams = {
  ridgeRoofs: false,
  hipEnds: false,
  shapeMinM2: 2.5,
  shapeGainM: 0.08,
  shapeTolM: 0.2,
  shapeRoundM: 0.5,
  shapeRoundDropM: 0.45,
  shapeMinX12: 3,
  shapeMaxX12: 16,
  shapeMaxRunM: 8,
  shapeReliefM: 0.25,
  shapeFaceM2: 2.35,
  shapeFaceWidthM: 0,
  shapeSpoilWidthM: 0.9,
  shapeSound: false,
  shapeCheck: true,
  ridgeCrestSlope: 0.15,
  ridgeModelSlope: 0.08,
  ridgeMinM: 1,
  ridgeRunGapM: 0.4,
  ridgeSideGainM: 0.02,
  ridgePitchPrior: true,
  ridgeFootprint: 'planes',
  shapeCrestM: 0.12,
  shapeCoplanarDeg: 8,
  shapeBlurM: 0,
  shapeJudge: true,
  judgeSmoothM: 0.35,
  judgeGainM: 0.03,
  judgeLossM: 0.1,
  judgePerPx: 0.0115,
  judgeMedM: 0.15,
  hipEdgeM: 2,
  hipBandInM: 0.6,
  hipBandOutM: 1.8,
  hipAlongShare: 0.35,
};

export type ShapeKind = 'ridge-roof' | 'hip-end';

/**
 * The common acceptance test's numbers for a shape (refine.ts judgeChange): the robust residual's drop per pixel of its
 * smallest new face (m2), the median distance of that face's pixels from the planes they had (metres), the verdict.
 */
export type ShapeJudge = {
  gainPerPx: number;
  medianM: number;
  accept: boolean;
  /** Through the smoothing (ShapeParams.shapeJudge): RMS of the heights over the footprint against the smoothed faces before and with the shape (metres). */
  rmsBefore: number;
  rmsAfter: number;
};

/** One fitted shape: what it is, a point on it (its ridge's middle, its eave's), its pitch, its footprint's plan area. */
export type FittedShape = { kind: ShapeKind; at: XY; pitchX12: number; areaM2: number; faces: number; judge?: ShapeJudge };

/**
 * A shape's proposal judged as refine.ts judgeChange judges a change that adds faces (its arithmetic, mirrored here:
 * that file is the reference), with `refit: false`: on the pixels the shape's new faces take, the Cauchy loss (scale
 * lossM) of the heights on the planes they had against their new planes; gain per pixel of the smallest new face; the
 * median |residual| of that face's pixels on their old planes.
 */
export function judgeShape(scene: Pick<ShapeScene, 'g' | 's' | 'dsm' | 'tree' | 'model'>, sides: readonly { px: Int32Array; plane: Plane }[], prm: Pick<ShapeParams, 'judgeLossM' | 'judgePerPx' | 'judgeMedM' | 'judgeSmoothM'>): ShapeJudge {
  const { g, s, dsm, tree, model } = scene;
  const c = prm.judgeLossM;
  const rho = (r: number) => 0.5 * c * c * Math.log1p((r / c) * (r / c));
  let costB = 0;
  let costA = 0;
  let minPx = Infinity;
  let minRes: number[] = [];
  for (const side of sides) {
    const res: number[] = [];
    for (const i of side.px) {
      const z = dsm[i]!;
      if (!Number.isFinite(z) || !Number.isFinite(model[i]!) || tree?.[i] === 1) continue;
      const rb = z - model[i]!;
      const ra = z - planeZ(side.plane, pixelX(g, s, i), pixelY(g, s, i));
      costB += rho(rb);
      costA += rho(ra);
      res.push(Math.abs(rb));
    }
    if (res.length > 0 && res.length < minPx) {
      minPx = res.length;
      minRes = res;
    }
  }
  const smooth = smoothedFit(scene, sides, prm.judgeSmoothM);
  if (!Number.isFinite(minPx)) return { gainPerPx: 0, medianM: 0, accept: false, ...smooth };
  const gainPerPx = (costB - costA) / minPx;
  const medianM = median(minRes);
  return { gainPerPx, medianM, accept: gainPerPx >= prm.judgePerPx && medianM >= prm.judgeMedM, ...smooth };
}

/**
 * The heights over a shape's footprint against the faces as they stand and against the faces with the shape in, both
 * smoothed like the height map (Gaussian, `sigma` metres): their RMS residuals. The surfaces are rendered on a patch
 * round the footprint (3 sigma of margin): each pixel on its face's plane (the shape's plane on its footprint), smoothed
 * among the roof's own pixels (the height map does not pull a roof's edge down into the yard: the higher surface
 * bleeds over the lower one).
 */
function smoothedFit(scene: Pick<ShapeScene, 'g' | 's' | 'dsm' | 'tree' | 'model'>, sides: readonly { px: Int32Array; plane: Plane }[], sigma: number): { rmsBefore: number; rmsAfter: number } {
  const { g, s, dsm, tree, model } = scene;
  let c0 = Infinity;
  let r0 = Infinity;
  let c1 = -Infinity;
  let r1 = -Infinity;
  for (const side of sides) {
    for (const i of side.px) {
      const c = i % g.w;
      const r = (i - c) / g.w;
      c0 = Math.min(c0, c);
      c1 = Math.max(c1, c);
      r0 = Math.min(r0, r);
      r1 = Math.max(r1, r);
    }
  }
  if (!Number.isFinite(c0)) return { rmsBefore: Number.NaN, rmsAfter: Number.NaN };
  const rad = sigma > 0 ? Math.ceil((3 * sigma) / s) : 0;
  c0 = Math.max(0, c0 - rad);
  r0 = Math.max(0, r0 - rad);
  c1 = Math.min(g.w - 1, c1 + rad);
  r1 = Math.min(g.h - 1, r1 + rad);
  const w = c1 - c0 + 1;
  const h = r1 - r0 + 1;
  const before = new Float64Array(w * h);
  const valid = new Float64Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = (r + r0) * g.w + c + c0;
      if (Number.isFinite(model[i]!)) {
        before[r * w + c] = model[i]!;
        valid[r * w + c] = 1;
      }
    }
  }
  const after = before.slice();
  const foot = new Uint8Array(w * h);
  for (const side of sides) {
    for (const i of side.px) {
      const c = (i % g.w) - c0;
      const r = Math.floor(i / g.w) - r0;
      after[r * w + c] = planeZ(side.plane, pixelX(g, s, i), pixelY(g, s, i));
      valid[r * w + c] = 1;
      foot[r * w + c] = 1;
    }
  }
  // Separable Gaussian, normalised by the valid pixels it reaches.
  const kernel: number[] = [];
  for (let k = -rad; k <= rad; k++) kernel.push(sigma > 0 ? Math.exp(-((k * s) ** 2) / (2 * sigma * sigma)) : 1);
  const blur = (src: Float64Array, wt: Float64Array): Float64Array => {
    const tmpV = new Float64Array(w * h);
    const tmpW = new Float64Array(w * h);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        let sv = 0;
        let sw = 0;
        for (let k = -rad; k <= rad; k++) {
          const cc = c + k;
          if (cc < 0 || cc >= w) continue;
          const kw = kernel[k + rad]! * wt[r * w + cc]!;
          sv += kw * src[r * w + cc]!;
          sw += kw;
        }
        tmpV[r * w + c] = sv;
        tmpW[r * w + c] = sw;
      }
    }
    const out = new Float64Array(w * h);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        let sv = 0;
        let sw = 0;
        for (let k = -rad; k <= rad; k++) {
          const rr = r + k;
          if (rr < 0 || rr >= h) continue;
          sv += kernel[k + rad]! * tmpV[rr * w + c]!;
          sw += kernel[k + rad]! * tmpW[rr * w + c]!;
        }
        out[r * w + c] = sw > 0 ? sv / sw : Number.NaN;
      }
    }
    return out;
  };
  const sb = blur(before, valid);
  const sa = blur(after, valid);
  let eb = 0;
  let ea = 0;
  let n = 0;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (foot[r * w + c] !== 1) continue;
      const i = (r + r0) * g.w + c + c0;
      const z = dsm[i]!;
      if (!Number.isFinite(z) || tree?.[i] === 1 || !Number.isFinite(sb[r * w + c]!) || !Number.isFinite(sa[r * w + c]!)) continue;
      eb += (z - sb[r * w + c]!) ** 2;
      ea += (z - sa[r * w + c]!) ** 2;
      n++;
    }
  }
  return n > 0 ? { rmsBefore: Math.sqrt(eb / n), rmsAfter: Math.sqrt(ea / n) } : { rmsBefore: Number.NaN, rmsAfter: Number.NaN };
}

/** A shape as its finder proposes it: its faces-to-be (pixels and plane, with what each gains), and its evidence. */
export type ShapeProposal = {
  kind: ShapeKind;
  at: XY;
  pitchX12: number;
  sides: { px: Int32Array; plane: Plane; gain: number }[];
  /** Mean gain over the whole footprint (metres) and the footprint's plan area (square metres). */
  gain: number;
  areaM2: number;
};

/** What a finder works on: the crop, the settled faces, and the faces' own surface pixel by pixel. */
export type ShapeScene = {
  g: Grid;
  s: number;
  dsm: Float32Array;
  roof: Mask;
  tree: Mask | null;
  outline: readonly XY[];
  labels: Int32Array;
  planes: readonly Plane[];
  /** Pixels per face. */
  area: readonly number[];
  /** The faces' planes read at each pixel (NaN off the faces). */
  model: Float32Array;
  /**
   * The pixel at a point (crop metres), -1 off the grid; whether a pixel is roof with a height, no crown over it, and
   * not on a face fitted as a primitive already.
   */
  index: (x: number, y: number) => number;
  usable: (i: number) => boolean;
  maxX12: number;
  /** The plane search's inlier tolerance (metres): a face's plane is refitted on its pixels within it. */
  tolM: number;
};

export function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/** A polygon's area and mean width (twice its area over its perimeter). */
function ringWidth(ring: readonly XY[]): { area: number; width: number } {
  let a = 0;
  let per = 0;
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k]!;
    const q = ring[(k + 1) % ring.length]!;
    a += p.x * q.y - q.x * p.y;
    per += Math.hypot(q.x - p.x, q.y - p.y);
  }
  const area = Math.abs(a) / 2;
  return { area, width: per > 0 ? (2 * area) / per : 0 };
}

export type ShapeInput = {
  g: Grid;
  s: number;
  dsm: Float32Array;
  roof: Mask;
  tree: Mask | null;
  outline: readonly XY[];
  faces: Faces;
  /** The faces' refitted planes (index for index), and the topology drawn from them. */
  planes: readonly Plane[];
  topo: Topology;
  /**
   * Whether a plane was fitted as a primitive already (a gable's bowed slope): the heights under it are what is wrong
   * there, so they are no evidence for a shape, and no shape takes its pixels.
   */
  fixed: (p: Plane) => boolean;
};

/**
 * The shapes fitted on the settled faces (see the head of this file). `lock` marks planes as fitted (and unmarks them:
 * a refit must leave a fitted plane as it is); `build` refits and draws the topology of a set of faces, with the walls
 * typed once for their length (`settled`) or piece by piece, as they are drawn in the end: a shape is judged on the
 * latter. Returns null when nothing is fitted, else the faces with the shapes in, their planes and their topology
 * (walls piece by piece) as `build` gave them, and what was fitted.
 */
export function fitShapes(
  inp: ShapeInput,
  prm: ShapeParams,
  lim: { tinyFaceM2: number; maxPitchX12: number; tolM: number },
  lock: (planes: readonly Plane[], kind: ShapeKind | null) => void,
  build: (f: Faces, settled: boolean) => { planes: Plane[]; topo: Topology },
  debug?: (msg: string) => void,
): { faces: Faces; planes: Plane[]; pieces: Topology; fitted: FittedShape[] } | null {
  if (!prm.ridgeRoofs && !prm.hipEnds) return null;
  const { g, s, dsm, roof, tree, outline, faces, planes, topo } = inp;
  const n = g.w * g.h;
  const labels = faces.labels;
  const model = new Float32Array(n).fill(Number.NaN);
  const area = new Array<number>(planes.length).fill(0);
  for (let i = 0; i < n; i++) {
    const k = labels[i]!;
    if (k < 0) continue;
    area[k]!++;
    model[i] = planeZ(planes[k]!, pixelX(g, s, i), pixelY(g, s, i));
  }
  const fixedFace = planes.map((p) => inp.fixed(p));
  const scene: ShapeScene = {
    g,
    s,
    dsm,
    roof,
    tree,
    outline,
    labels,
    planes,
    area,
    model,
    index: (x, y) => {
      const c = Math.floor(x / s);
      const r = Math.floor(-y / s);
      return c < 0 || r < 0 || c >= g.w || r >= g.h ? -1 : r * g.w + c;
    },
    usable: (i) => i >= 0 && roof[i] === 1 && Number.isFinite(dsm[i]!) && (tree === null || tree[i] !== 1) && !(labels[i]! >= 0 && fixedFace[labels[i]!]),
    maxX12: Math.min(prm.shapeMaxX12, lim.maxPitchX12),
    tolM: lim.tolM,
  };
  const name = (p: ShapeProposal) => `${p.kind} at ${p.at.x.toFixed(1)},${p.at.y.toFixed(1)}`;
  // Every proposal judged by the faces' common acceptance test (judgeShape); with shapeJudge on, one that fails it goes.
  const judged = new Map<ShapeProposal, ShapeJudge>();
  const found: ShapeProposal[] = [];
  for (const sh of [...(prm.ridgeRoofs ? findRidgeRoofs(scene, prm, debug) : []), ...(prm.hipEnds ? findHipEnds(scene, prm, debug) : [])]) {
    const j = judgeShape(scene, sh.sides, prm);
    judged.set(sh, j);
    if (prm.shapeJudge && !(j.rmsBefore - j.rmsAfter >= prm.judgeGainM)) {
      debug?.(`shape: ${name(sh)}: not placed (through the smoothing it leaves the heights ${j.rmsAfter.toFixed(3)} m RMS off against ${j.rmsBefore.toFixed(3)} m without it)`);
      continue;
    }
    found.push(sh);
  }
  if (found.length === 0) return null;

  // The faces: the strongest evidence first; a pixel is one shape's.
  found.sort((a, b) => b.gain * b.areaM2 - a.gain * a.areaM2);
  type Applied = { shape: ShapeProposal; planes: Plane[] };
  const apply = (shapes: readonly ShapeProposal[]): { faces: Faces; applied: Applied[] } => {
    const lab = labels.slice();
    const all: Plane[] = [...planes];
    const taken = new Uint8Array(n);
    const touched = new Set<number>();
    const applied: Applied[] = [];
    for (const sh of shapes) {
      // A shape most of whose footprint an earlier one has taken is the same roof found twice.
      let free = 0;
      let total = 0;
      for (const side of sh.sides) {
        total += side.px.length;
        for (const i of side.px) if (taken[i] === 0) free++;
      }
      if (free < 0.7 * total) continue;
      const mine: Plane[] = [];
      for (const side of sh.sides) {
        const id = all.length;
        all.push(side.plane);
        mine.push(side.plane);
        for (const i of side.px) {
          if (taken[i] === 1) continue;
          taken[i] = 1;
          touched.add(lab[i]!);
          lab[i] = id;
        }
      }
      if (mine.length > 0) applied.push({ shape: sh, planes: mine });
    }
    if (applied.length === 0) return { faces, applied };
    // What is left of the faces the shapes were cut from: a scrap under the smallest face size goes to the faces
    // round it, and so does a fitted face's stray piece.
    const split = splitParts(g, compact(lab, all));
    const size = new Array<number>(split.planes.length).fill(0);
    for (let i = 0; i < n; i++) if (split.labels[i]! >= 0) size[split.labels[i]!]!++;
    const fittedSet = new Set(applied.flatMap((a) => a.planes));
    const touchedPlanes = new Set([...touched].map((k) => planes[k]!));
    const largest = new Map<Plane, number>();
    split.planes.forEach((p, k) => {
      if (fittedSet.has(p) && (largest.get(p) === undefined || size[k]! > size[largest.get(p)!]!)) largest.set(p, k);
    });
    const gone = new Set<number>();
    split.planes.forEach((p, k) => {
      if (fittedSet.has(p) ? largest.get(p) !== k : touchedPlanes.has(p) && size[k]! * s * s < lim.tinyFaceM2) gone.add(k);
    });
    return { faces: gone.size === 0 || gone.size >= split.planes.length ? split : dissolve(g, s, dsm, roof, split, gone, tree), applied };
  };
  // Faces topology already drew badly (walls typed once for their length, as the faces were settled, or piece by
  // piece, as they are drawn in the end) are no evidence against a shape.
  const poor = (f: Topology['faces'][number]): boolean => {
    const w = ringWidth(f.ring);
    return f.fromPixels || w.area < lim.tinyFaceM2 || w.width < prm.shapeSpoilWidthM;
  };
  const badBefore = new Set<Plane>();
  const noteBad = (before: Topology) =>
    before.faces.forEach((f, k) => {
      if (poor(f)) badBefore.add(planes[k]!);
    });
  noteBad(topo);
  // The faces as they stand, walls piece by piece: drawn only when a face comes out badly beside a shape.
  let piecesBefore = false;
  let shapes = found;
  for (let round = 0; round < 3 && shapes.length > 0; round++) {
    const { faces: next, applied } = apply(shapes);
    if (applied.length === 0) return null;
    for (const a of applied) lock(a.planes, a.shape.kind);
    const unlock = () => applied.forEach((a) => lock(a.planes, null));
    const built = build(next, false);
    const facesOf = new Map<Plane, number[]>();
    next.planes.forEach((p, k) => facesOf.set(p, [...(facesOf.get(p) ?? []), k]));
    const fittedSet = new Set(applied.flatMap((a) => a.planes));
    // Faces beside a shape that came out badly, though they were drawn well before.
    const spoiled = new Set<number>();
    const findSpoiled = () => {
      spoiled.clear();
      built.topo.faces.forEach((f, k) => {
        const p = next.planes[k]!;
        if (!fittedSet.has(p) && !badBefore.has(p) && poor(f)) spoiled.add(k);
      });
    };
    findSpoiled();
    if (spoiled.size > 0 && !piecesBefore) {
      piecesBefore = true;
      noteBad(build({ labels, planes: [...planes] }, false).topo);
      findSpoiled();
    }
    const beside = (ks: readonly number[]): boolean => built.topo.lines.some((l) => l.faces.some((f) => ks.includes(f)) && l.faces.some((f) => spoiled.has(f)));
    const bad: Applied[] = [];
    for (const a of prm.shapeCheck ? applied : []) {
      const ks = a.planes.flatMap((p) => facesOf.get(p) ?? []);
      let why = '';
      if (ks.length < a.planes.length) why = 'a face of it was lost';
      for (const k of ks) {
        const f = built.topo.faces[k]!;
        const w = ringWidth(f.ring);
        if (f.fromPixels && prm.shapeSound) why = 'a face of it has no sound polygon';
        else if (w.area < prm.shapeFaceM2) why = `a face of it comes to ${w.area.toFixed(1)} m2`;
        else if (w.width < prm.shapeFaceWidthM) why = `a face of it is ${w.width.toFixed(2)} m wide`;
      }
      if (why === '' && spoiled.size > 0 && beside(ks)) why = 'it spoils a face beside it';
      if (why !== '') {
        bad.push(a);
        debug?.(`shape: ${name(a.shape)}: taken out (${why})`);
      }
    }
    if (bad.length === 0 && spoiled.size > 0 && prm.shapeCheck) {
      // A spoiled face beside none of them: no telling which shape did it.
      unlock();
      debug?.('shape: all taken out (a face elsewhere came out worse)');
      return null;
    }
    if (bad.length === 0) {
      for (const a of applied) {
        const j = judged.get(a.shape)!;
        debug?.(`shape: ${name(a.shape)}: fitted, ${a.planes.length} faces at ${a.shape.pitchX12.toFixed(1)}/12 over ${a.shape.areaM2.toFixed(1)} m2 (smoothed RMS ${j.rmsBefore.toFixed(3)} -> ${j.rmsAfter.toFixed(3)} m; common test ${j.accept ? 'passes' : 'fails'}: ${j.gainPerPx.toFixed(4)} m2 a pixel, ${j.medianM.toFixed(2)} m off)`);
      }
      return { faces: next, planes: built.planes, pieces: built.topo, fitted: applied.map((a) => ({ kind: a.shape.kind, at: a.shape.at, pitchX12: a.shape.pitchX12, areaM2: a.shape.areaM2, faces: a.planes.length, judge: judged.get(a.shape)! })) };
    }
    unlock();
    const out = new Set(bad.map((a) => a.shape));
    shapes = applied.map((a) => a.shape).filter((sh) => !out.has(sh));
  }
  return null;
}
