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
   * average (twice its area over its perimeter, metres): the report's smallest face, and no thin strip.
   */
  shapeFaceM2: number;
  shapeFaceWidthM: number;
  /** A fitted face must have a sound polygon (corner to corner along its creases), not one drawn from its pixels. */
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
  shapeFaceWidthM: 0.9,
  shapeSound: true,
  shapeCheck: true,
  ridgeCrestSlope: 0.15,
  ridgeModelSlope: 0.08,
  ridgeMinM: 1,
  ridgeRunGapM: 0.4,
  ridgeSideGainM: 0.02,
  hipEdgeM: 2,
  hipBandInM: 0.6,
  hipBandOutM: 1.8,
  hipAlongShare: 0.35,
};

export type ShapeKind = 'ridge-roof' | 'hip-end';

/** One fitted shape: what it is, a point on it (its ridge's middle, its eave's), its pitch, its footprint's plan area. */
export type FittedShape = { kind: ShapeKind; at: XY; pitchX12: number; areaM2: number; faces: number };

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
  lim: { tinyFaceM2: number; maxPitchX12: number },
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
  };
  const found: ShapeProposal[] = [...(prm.ridgeRoofs ? findRidgeRoofs(scene, prm, debug) : []), ...(prm.hipEnds ? findHipEnds(scene, prm, debug) : [])];
  if (found.length === 0) return null;
  const name = (p: ShapeProposal) => `${p.kind} at ${p.at.x.toFixed(1)},${p.at.y.toFixed(1)}`;

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
    return f.fromPixels || w.area < lim.tinyFaceM2 || w.width < prm.shapeFaceWidthM;
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
      for (const a of applied) debug?.(`shape: ${name(a.shape)}: fitted, ${a.planes.length} faces at ${a.shape.pitchX12.toFixed(1)}/12 over ${a.shape.areaM2.toFixed(1)} m2`);
      return { faces: next, planes: built.planes, pieces: built.topo, fitted: applied.map((a) => ({ kind: a.shape.kind, at: a.shape.at, pitchX12: a.shape.pitchX12, areaM2: a.shape.areaM2, faces: a.planes.length })) };
    }
    unlock();
    const out = new Set(bad.map((a) => a.shape));
    shapes = applied.map((a) => a.shape).filter((sh) => !out.has(sh));
  }
  return null;
}
