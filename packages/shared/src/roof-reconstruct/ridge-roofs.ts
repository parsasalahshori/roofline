// Small roofs with a ridge of their own that the faces do not have (a gable over an entry or a bump-out, a dormer, a
// short wing): fitted as a shape, where the plane search fits planes bottom-up.
//
// A height map blurs a roof a few metres across into the slope round it. The plane search then finds no plane on its
// two small slopes, or finds them and the cleanup takes them for junk by the roof's edge, and the main slope is drawn
// straight through: the small roof's ridge and its two valleys are missing. What survives the blur is the crest: a
// level line from which the heights fall away on both sides. Model fitting, from that line:
//
// 1. Crests. Along each of the roof's two directions (its faces' own), the pixels from which the heights fall on both
//    sides across that direction while the faces' planes there do not (the faces have no ridge within half a metre):
//    a crest the faces lack, where such pixels line up level for a metre or more.
// 2. The tent. A level ridge on the crest and one pitch for both slopes (three numbers: where the ridge is, how high,
//    how steep), least squares on the heights each side of the crest, walked out column by column for as long as the
//    heights stay on the slope: to the valley where the main slope takes over, or to the roof's edge.
// 3. The evidence. The tent is kept only where it explains the heights clearly better than the faces that are there
//    now: over its footprint the mean distance from the heights to the tent is smaller than to the faces' planes by a
//    margin. A smooth slope has no crest, and a ridge the faces already have gains nothing: neither is touched.
// 4. The faces. The footprint's pixels each side of the ridge become a face on the tent's plane there (locked: a refit
//    on the blurred heights would flatten it; marked `fitted`). Topology then draws the ridge and the valleys where
//    the planes meet. A fitted roof whose faces topology cannot draw (a polygon from pixels, under the smallest face
//    size, or a thin strip), or that spoils a face beside it, is taken out again.
import type { XY } from './geom.ts';
import { mainAxis } from './outline.ts';
import { compact, dissolve, type Faces, pixelX, pixelY, type Plane, planeZ, splitParts } from './planes.ts';
import type { Grid, Mask } from './raster.ts';
import type { Topology } from './topology.ts';

export type RidgeRoofParams = {
  /** Off: no small ridge roof is fitted (the faces stand as the plane search and the cleanup left them). */
  ridgeRoofs: boolean;
  /**
   * A crest: the heights fall away from the pixel on both sides, across the ridge's direction, at this slope or more
   * (rise over run, measured 0.6 and 1 m out)...
   */
  ridgeCrestSlope: number;
  /** ...where the faces' own planes fall away on both sides at less than this (no ridge of theirs within half a metre). */
  ridgeModelSlope: number;
  /** A ridge: crest pixels in line for at least this long (metres), gaps up to ridgeRunGapM bridged. */
  ridgeMinM: number;
  ridgeRunGapM: number;
  /** A slope of the tent runs out from the ridge for as long as the heights lie within this of its plane (metres). */
  ridgeTolM: number;
  /** The height map rounds a ridge off: within ridgeRoundM of it the heights may lie up to ridgeRoundDropM under the tent. */
  ridgeRoundM: number;
  ridgeRoundDropM: number;
  /** The tent's pitch lies between these (x/12; never over the plane search's own limit). */
  ridgeMinX12: number;
  ridgeMaxX12: number;
  /** Each slope runs out at most this far from the ridge (metres). */
  ridgeMaxRunM: number;
  /** The ridge stands at least this far above where its slopes end (metres): pitch times the slopes' median run. */
  ridgeReliefM: number;
  /**
   * The evidence: over at least ridgeMinM2 of footprint (square metres) the heights are closer to the tent than to the
   * faces' planes by ridgeGainM on average (metres; each distance counted up to 1 m).
   */
  ridgeMinM2: number;
  ridgeGainM: number;
  /** A slope the faces already explain as well as the tent (its gain under this, metres) keeps its faces. */
  ridgeSideGainM: number;
  /**
   * A fitted face stays when the polygon topology draws for it is at least this big (square metres) and this wide on
   * average (twice its area over its perimeter, metres): the report's smallest face, and no thin strip.
   */
  ridgeFaceM2: number;
  ridgeFaceWidthM: number;
  /** False (a study switch): every fitted roof stays, whatever topology draws of it. */
  ridgeCheck: boolean;
};

export const DEFAULT_RIDGE_ROOF_PARAMS: RidgeRoofParams = {
  ridgeRoofs: true,
  ridgeCrestSlope: 0.15,
  ridgeModelSlope: 0.08,
  ridgeMinM: 1,
  ridgeRunGapM: 0.4,
  ridgeTolM: 0.2,
  ridgeRoundM: 0.5,
  ridgeRoundDropM: 0.45,
  ridgeMinX12: 3,
  ridgeMaxX12: 16,
  ridgeMaxRunM: 8,
  ridgeReliefM: 0.25,
  ridgeMinM2: 2.5,
  ridgeGainM: 0.08,
  ridgeSideGainM: 0.02,
  ridgeFaceM2: 2.35,
  ridgeFaceWidthM: 0.9,
  ridgeCheck: true,
};

/** One fitted ridge roof: its ridge's middle (crop metres) and length, its pitch, its footprint's plan area. */
export type RidgeRoof = { at: XY; ridgeM: number; pitchX12: number; areaM2: number };

type Frame = { ex: number; ey: number; dx: number; dy: number };
type Tent = {
  fr: Frame;
  u0: number;
  zr: number;
  q: number;
  /** Columns along the ridge from v0, one per pixel size: how far each slope runs out (metres; -1: no column). */
  v0: number;
  runL: Float32Array;
  runR: Float32Array;
  /** Per column and slope: whether the slope ended where the heights rose above its plane (the valley: another roof takes over). */
  roseL: Uint8Array;
  roseR: Uint8Array;
  /** Whether the ridge ended, at its low-v and high-v end, where the roof beyond stands above it (it runs into a higher slope). */
  roseLo: boolean;
  roseHi: boolean;
  ridgeM: number;
};
type Shape = { tent: Tent; left: Int32Array; right: Int32Array; gain: number; gainL: number; gainR: number; info: RidgeRoof };

/** The tent's footprint runs on past where a slope was seen to end at a valley by at most this (metres), and past the ridge's end into a higher slope by this. */
const PAST_VALLEY_M = 0.8;
const PAST_END_M = 3;
/** A slope or a ridge that ends within this (metres) of its face's edge (the roof's, or the next face) runs to it. */
const EDGE_M = 0.8;

function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/** A polygon's mean width: twice its area over its perimeter. */
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

/**
 * The roof's two directions (radians, 0 to pi): the area-weighted mean of its pitched faces' slope directions, mod 90
 * degrees (a small roof's ridge runs up the slope it stands on, or along it), and that turned a quarter. With no
 * pitched face, the outline's own.
 */
function roofDirections(planes: readonly Plane[], area: readonly number[], outline: readonly XY[]): number[] {
  let cs = 0;
  let sn = 0;
  for (let k = 0; k < planes.length; k++) {
    const p = planes[k]!;
    const slope = Math.hypot(p.a, p.b);
    if (slope * 12 < 2 || area[k]! === 0) continue;
    const phi = Math.atan2(p.b, p.a);
    cs += area[k]! * Math.cos(4 * phi);
    sn += area[k]! * Math.sin(4 * phi);
  }
  const axis = cs === 0 && sn === 0 ? mainAxis(outline) : (((Math.atan2(sn, cs) / 4) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
  return [axis, axis + Math.PI / 2];
}

export type RidgeRoofInput = {
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
};

/**
 * Small ridge roofs fitted where the heights show a crest the faces lack (see the head of this file). `build` refits
 * and draws the topology of a set of faces (the caller's own, with `lock` already holding the fitted planes: a refit
 * must leave them), with the walls typed once for their length (`settled`) or piece by piece, as they are drawn in the
 * end: a fitted roof is judged on the latter. Returns null when nothing is fitted, else the faces with the fitted roofs
 * in, their planes as `build` gave them, the fitted planes, and what was fitted.
 */
export function fitRidgeRoofs(
  inp: RidgeRoofInput,
  prm: RidgeRoofParams,
  lim: { tinyFaceM2: number; maxPitchX12: number },
  lock: (planes: readonly Plane[], on: boolean) => void,
  build: (f: Faces, settled: boolean) => { planes: Plane[]; topo: Topology },
  debug?: (msg: string) => void,
): { faces: Faces; planes: Plane[]; fitted: RidgeRoof[]; fittedPlanes: Plane[] } | null {
  if (!prm.ridgeRoofs) return null;
  const { g, s, dsm, roof, tree, outline, faces, planes, topo } = inp;
  const n = g.w * g.h;
  const labels = faces.labels;
  const nF = planes.length;
  const usable = (i: number) => i >= 0 && roof[i] === 1 && Number.isFinite(dsm[i]!) && (tree === null || tree[i] !== 1);
  // The faces' own surface, pixel by pixel.
  const model = new Float32Array(n).fill(Number.NaN);
  const area = new Array<number>(nF).fill(0);
  for (let i = 0; i < n; i++) {
    const k = labels[i]!;
    if (k < 0) continue;
    area[k]!++;
    model[i] = planeZ(planes[k]!, pixelX(g, s, i), pixelY(g, s, i));
  }
  const index = (x: number, y: number): number => {
    const c = Math.floor(x / s);
    const r = Math.floor(-y / s);
    return c < 0 || r < 0 || c >= g.w || r >= g.h ? -1 : r * g.w + c;
  };
  const zAt = (x: number, y: number): number => {
    const i = index(x, y);
    return usable(i) ? dsm[i]! : Number.NaN;
  };
  const mAt = (x: number, y: number): number => {
    const i = index(x, y);
    return i >= 0 ? model[i]! : Number.NaN;
  };
  const maxX12 = Math.min(prm.ridgeMaxX12, lim.maxPitchX12);

  // 1. Crests the faces lack, direction by direction, and the tents fitted on them.
  const found: Shape[] = [];
  for (const phi of roofDirections(planes, area, outline)) {
    const fr: Frame = { dx: Math.cos(phi), dy: Math.sin(phi), ex: -Math.sin(phi), ey: Math.cos(phi) };
    // The crop's extent in the frame (u across the ridge, v along it), in cells of one pixel size.
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const [x, y] of [
      [0, 0],
      [g.w * s, 0],
      [0, -g.h * s],
      [g.w * s, -g.h * s],
    ] as const) {
      const u = x * fr.ex + y * fr.ey;
      const v = x * fr.dx + y * fr.dy;
      uMin = Math.min(uMin, u);
      uMax = Math.max(uMax, u);
      vMin = Math.min(vMin, v);
      vMax = Math.max(vMax, v);
    }
    const nu = Math.round((uMax - uMin) / s) + 3;
    const nv = Math.round((vMax - vMin) / s) + 3;
    const cells = new Uint8Array(nu * nv);
    const side = (at: (x: number, y: number) => number, x: number, y: number, z0: number, sg: number): number => {
      let best = -Infinity;
      for (const t of [0.6, 1]) {
        const z = at(x + sg * t * fr.ex, y + sg * t * fr.ey);
        if (Number.isFinite(z)) best = Math.max(best, (z0 - z) / t);
      }
      return best;
    };
    let crests = 0;
    for (let i = 0; i < n; i++) {
      if (!usable(i) || labels[i]! < 0) continue;
      const x = pixelX(g, s, i);
      const y = pixelY(g, s, i);
      const z0 = dsm[i]!;
      if (!(side(zAt, x, y, z0, -1) >= prm.ridgeCrestSlope && side(zAt, x, y, z0, 1) >= prm.ridgeCrestSlope)) continue;
      // The top across the ridge's direction (the height map rounds it: a band a few pixels wide).
      let top = true;
      for (const dt of [0.2, 0.4]) {
        if (zAt(x - dt * fr.ex, y - dt * fr.ey) > z0 + 0.02 || zAt(x + dt * fr.ex, y + dt * fr.ey) > z0 + 0.02) top = false;
      }
      if (!top) continue;
      // The faces' own planes: a ridge of theirs within half a metre explains the crest.
      let explained = false;
      for (const shift of [-0.5, -0.25, 0, 0.25, 0.5]) {
        const mx = x + shift * fr.ex;
        const my = y + shift * fr.ey;
        const m0 = mAt(mx, my);
        if (!Number.isFinite(m0)) continue;
        if (side(mAt, mx, my, m0, -1) >= prm.ridgeModelSlope && side(mAt, mx, my, m0, 1) >= prm.ridgeModelSlope) {
          explained = true;
          break;
        }
      }
      if (explained) continue;
      const ub = Math.round((x * fr.ex + y * fr.ey - uMin) / s) + 1;
      const vb = Math.round((x * fr.dx + y * fr.dy - vMin) / s) + 1;
      cells[ub * nv + vb] = 1;
      crests++;
    }
    if (crests === 0) continue;
    // Runs of crest cells along the ridge's direction (a row and the rows either side of it: the frame is turned).
    const gap = Math.max(1, Math.round(prm.ridgeRunGapM / s));
    const runs: { ub: number; a: number; b: number; score: number }[] = [];
    for (let ub = 1; ub < nu - 1; ub++) {
      for (let vb = 0; vb < nv; ) {
        const has = (q: number) => cells[(ub - 1) * nv + q] === 1 || cells[ub * nv + q] === 1 || cells[(ub + 1) * nv + q] === 1;
        if (!has(vb)) {
          vb++;
          continue;
        }
        let end = vb;
        let own = 0;
        let any = 0;
        for (let q = vb, miss = 0; q < nv && miss <= gap; q++) {
          if (has(q)) {
            end = q;
            miss = 0;
            any++;
            if (cells[ub * nv + q] === 1) own++;
          } else miss++;
        }
        if ((end - vb + 1) * s >= prm.ridgeMinM && any >= 0.6 * (end - vb + 1)) runs.push({ ub, a: vb, b: end, score: own + any });
        vb = end + 1;
      }
    }
    runs.sort((p, q) => q.score - p.score || p.ub - q.ub || p.a - q.a);
    const kept: typeof runs = [];
    const near = Math.round(0.6 / s);
    for (const r of runs) {
      if (kept.length >= 16) break;
      const dup = kept.some((k) => Math.abs(k.ub - r.ub) <= near && Math.min(k.b, r.b) - Math.max(k.a, r.a) >= 0.5 * (r.b - r.a));
      if (!dup) kept.push(r);
    }
    for (const r of kept) {
      const u0 = (r.ub - 1) * s + uMin;
      const va = (r.a - 1) * s + vMin;
      const vb = (r.b - 1) * s + vMin;
      const tent = fitTent(fr, u0, va, vb);
      const where = `ridge at ${(u0 * fr.ex + ((va + vb) / 2) * fr.dx).toFixed(1)},${(u0 * fr.ey + ((va + vb) / 2) * fr.dy).toFixed(1)} (${(vb - va).toFixed(1)} m of crest)`;
      if (typeof tent === 'string') {
        debug?.(`ridge roof: ${where}: no tent (${tent})`);
        continue;
      }
      const shape = footprint(tent);
      if (typeof shape === 'string') {
        debug?.(`ridge roof: ${where}: ${(tent.q * 12).toFixed(1)}/12, not kept (${shape})`);
        continue;
      }
      debug?.(`ridge roof: ${where}: ${(tent.q * 12).toFixed(1)}/12, ridge ${tent.ridgeM.toFixed(1)} m, footprint ${shape.info.areaM2.toFixed(1)} m2, gain ${shape.gain.toFixed(2)} m (left ${shape.gainL.toFixed(2)}, right ${shape.gainR.toFixed(2)})`);
      found.push(shape);
    }
  }
  if (found.length === 0) return null;

  // 2. The tent on a crest: see the head of this file.
  function fitTent(fr: Frame, uStart: number, va: number, vb: number): Tent | string {
    const at = (u: number, v: number) => index(u * fr.ex + v * fr.dx, u * fr.ey + v * fr.dy);
    let u0 = uStart;
    // Start: the ridge's height from the crest's top, the pitch from the heights 0.4 and 1 m out.
    const tops: number[] = [];
    const slopes: number[] = [];
    for (let v = va; v <= vb + 1e-9; v += s) {
      let top = -Infinity;
      for (let du = -0.2; du <= 0.2 + 1e-9; du += s) {
        const i = at(u0 + du, v);
        if (usable(i) && dsm[i]! > top) top = dsm[i]!;
      }
      if (Number.isFinite(top)) tops.push(top);
      for (const sg of [-1, 1]) {
        const i = at(u0 + sg * 0.4, v);
        const j = at(u0 + sg * 1, v);
        if (usable(i) && usable(j)) slopes.push((dsm[i]! - dsm[j]!) / 0.6);
      }
    }
    let zr = median(tops);
    let q = median(slopes);
    if (!Number.isFinite(zr) || !(q > 0)) return 'no heights beside the crest';
    q = Math.min(Math.max(q, prm.ridgeMinX12 / 12), maxX12 / 12);
    // How far a slope runs out from the ridge in one column: for as long as the heights stay on its plane.
    let rose = false;
    const walk = (v: number, sg: number, take?: (t: number, z: number) => void): number => {
      let last = 0;
      let bad = 0;
      rose = false;
      for (let k = 1; k * s <= prm.ridgeMaxRunM; k++) {
        const t = k * s;
        const i = at(u0 + sg * t, v);
        if (!usable(i)) break;
        const dev = dsm[i]! - (zr - q * t);
        const ok = t < prm.ridgeRoundM ? dev <= prm.ridgeTolM && dev >= -prm.ridgeRoundDropM : Math.abs(dev) <= prm.ridgeTolM;
        if (ok) {
          last = t;
          bad = 0;
          if (t >= prm.ridgeRoundM) take?.(t, dsm[i]!);
        } else if (++bad >= 3) {
          rose = dev > 0;
          break;
        }
      }
      // A slope that ends within reach of its face's edge (the roof's edge, or the next face: a lower roof under its
      // eave) runs to it: the height map rounds an eave off, and the band left between would be nobody's.
      if (!rose && last > 0) {
        const own = labels[at(u0 + sg * last, v)]!;
        for (let k = Math.round(last / s) + 1; k * s <= last + EDGE_M + 1e-9; k++) {
          const i = at(u0 + sg * k * s, v);
          if (i < 0 || roof[i] !== 1 || labels[i] !== own) {
            last = (k - 1) * s;
            break;
          }
        }
      }
      return last;
    };
    for (let it = 0; it < 3; it++) {
      // Two lines of one slope against the distance from the ridge, one each side: least squares.
      const sum = [0, 1].map(() => ({ n: 0, t: 0, z: 0, tt: 0, tz: 0 }));
      for (let v = va; v <= vb + 1e-9; v += s) {
        for (const sg of [-1, 1]) {
          const a = sum[sg < 0 ? 0 : 1]!;
          walk(v, sg, (t, z) => {
            a.n++;
            a.t += t;
            a.z += z;
            a.tt += t * t;
            a.tz += t * z;
          });
        }
      }
      const [L, R] = sum as [(typeof sum)[0], (typeof sum)[0]];
      if (L.n < 10 || R.n < 10) return `a slope on one side only (${L.n} and ${R.n} heights)`;
      const den = L.tt - (L.t * L.t) / L.n + (R.tt - (R.t * R.t) / R.n);
      if (!(den > 1e-9)) return 'slopes too short';
      const q1 = -(L.tz - (L.t * L.z) / L.n + (R.tz - (R.t * R.z) / R.n)) / den;
      if (!(q1 * 12 >= prm.ridgeMinX12 && q1 * 12 <= maxX12)) return `pitch ${(q1 * 12).toFixed(1)}/12`;
      const A = (L.z + q1 * L.t) / L.n;
      const B = (R.z + q1 * R.t) / R.n;
      u0 += (B - A) / (2 * q1);
      zr = (A + B) / 2;
      q = q1;
      if (Math.abs(u0 - uStart) > 0.6) return `the ridge ${Math.abs(u0 - uStart).toFixed(1)} m from the crest`;
    }
    // The columns: the crest's own, and on past its ends for as long as the ridge is there (its top at the ridge's
    // height, a slope each side), to the roof's edge or to where the roof behind rises above it.
    type Col = { l: number; r: number; roseL: boolean; roseR: boolean };
    const column = (v: number): Col | null => {
      let top = -Infinity;
      for (let du = -0.2; du <= 0.2 + 1e-9; du += s) {
        const i = at(u0 + du, v);
        if (usable(i) && dsm[i]! > top) top = dsm[i]!;
      }
      if (!(top >= zr - prm.ridgeRoundDropM && top <= zr + prm.ridgeTolM)) return null;
      const l = walk(v, -1);
      const roseL = rose;
      const r = walk(v, 1);
      return l >= prm.ridgeRoundM && r >= prm.ridgeRoundM ? { l, r, roseL, roseR: rose } : null;
    };
    const cols = new Map<number, Col>();
    const k1 = Math.round((vb - va) / s);
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k <= k1; k++) {
      const c = column(va + k * s);
      if (c === null) continue;
      cols.set(k, c);
      lo = Math.min(lo, k);
      hi = Math.max(hi, k);
    }
    if (cols.size === 0) return 'no slope each side of the crest';
    const stopAfter = Math.max(1, Math.round(0.3 / s));
    for (const dir of [-1, 1]) {
      const from = dir < 0 ? lo : hi;
      for (let k = from + dir, miss = 0; miss <= stopAfter && Math.abs(k - from) * s <= 20; k += dir) {
        const c = column(va + k * s);
        if (c === null) miss++;
        else {
          cols.set(k, c);
          if (dir < 0) lo = k;
          else hi = k;
          miss = 0;
        }
      }
    }
    // Past an end: the ridge runs into a higher slope when the roof on its line stands above it within a few metres.
    const risesPast = (end: number, dir: number): boolean => {
      for (let k = end + dir; Math.abs(k - end) * s <= PAST_END_M; k += dir) {
        let top = -Infinity;
        for (let du = -0.2; du <= 0.2 + 1e-9; du += s) {
          const i = at(u0 + du, va + k * s);
          if (i < 0 || roof[i] !== 1) return false;
          if (usable(i) && dsm[i]! > top) top = dsm[i]!;
        }
        if (top > zr + prm.ridgeTolM) return true;
      }
      return false;
    };
    const roseLo = risesPast(lo, -1);
    const roseHi = risesPast(hi, 1);
    // A ridge that ends within reach of its face's edge (the roof's edge, or the next face: a lower roof in front of a
    // gable's end) runs to it, rounded off like an eave; and so do its slopes there, as wide as they are just behind
    // (the height map rounds the gable's end off from its eaves inward).
    for (const dir of [-1, 1]) {
      if (dir < 0 ? roseLo : roseHi) continue;
      const end = dir < 0 ? lo : hi;
      const own = labels[at(u0, va + end * s)]!;
      for (let k = end + dir; Math.abs(k - end) * s <= EDGE_M + 1e-9; k += dir) {
        const i = at(u0, va + k * s);
        if (i < 0 || roof[i] !== 1 || labels[i] !== own) {
          const wide: Col = { l: 0, r: 0, roseL: false, roseR: false };
          for (let q = end; Math.abs(q - end) * s <= 1.5; q -= dir) {
            const c = cols.get(q);
            if (c === undefined) continue;
            if (c.l > wide.l) [wide.l, wide.roseL] = [c.l, c.roseL];
            if (c.r > wide.r) [wide.r, wide.roseR] = [c.r, c.roseR];
          }
          for (let q = end - dir * Math.round(0.6 / s); q !== k; q += dir) {
            const c = cols.get(q);
            cols.set(q, c === undefined ? wide : { l: Math.max(c.l, wide.l), r: Math.max(c.r, wide.r), roseL: c.l >= wide.l ? c.roseL : wide.roseL, roseR: c.r >= wide.r ? c.roseR : wide.roseR });
          }
          if (dir < 0) lo = k + 1;
          else hi = k - 1;
          break;
        }
      }
    }
    const runL = new Float32Array(hi - lo + 1).fill(-1);
    const runR = new Float32Array(hi - lo + 1).fill(-1);
    const roseL = new Uint8Array(hi - lo + 1);
    const roseR = new Uint8Array(hi - lo + 1);
    for (const [k, c] of cols) {
      if (k < lo || k > hi) continue;
      runL[k - lo] = c.l;
      runR[k - lo] = c.r;
      roseL[k - lo] = c.roseL ? 1 : 0;
      roseR[k - lo] = c.roseR ? 1 : 0;
    }
    // A column or two without the ridge (a vent, a lump in the heights) between columns with it takes theirs.
    for (const run of [runL, runR]) {
      for (let k = 1; k < run.length - 1; k++) {
        if (run[k]! >= 0) continue;
        let nxt = k + 1;
        while (nxt < run.length && run[nxt]! < 0) nxt++;
        if (nxt < run.length && nxt - k <= stopAfter && run[k - 1]! >= 0) run[k] = Math.min(run[k - 1]!, run[nxt]!);
      }
    }
    if (cols.size * s < prm.ridgeMinM) return `the ridge holds for ${(cols.size * s).toFixed(1)} m`;
    const reach = median([...cols.values()].flatMap((c) => [c.l, c.r]));
    if (q * reach < prm.ridgeReliefM) return `the ridge ${(q * reach).toFixed(2)} m above its slopes' ends`;
    return { fr, u0, zr, q, v0: va + lo * s, runL, runR, roseL, roseR, roseLo, roseHi, ridgeM: (hi - lo + 1) * s };
  }

  // 3. The footprint and the evidence.
  function footprint(t: Tent): Shape | string {
    const { fr, u0, zr, q } = t;
    const left: number[] = [];
    const right: number[] = [];
    const sums = [
      { n: 0, gain: 0 },
      { n: 0, gain: 0 },
    ];
    const last = t.runL.length - 1;
    const past = Math.round(PAST_END_M / s);
    for (let i = 0; i < n; i++) {
      if (!usable(i) || labels[i]! < 0) continue;
      const x = pixelX(g, s, i);
      const y = pixelY(g, s, i);
      const k = Math.round((x * fr.dx + y * fr.dy - t.v0) / s);
      if (k < -past || k > last + past) continue;
      const u = x * fr.ex + y * fr.ey - u0;
      const d = Math.abs(u);
      const tentZ = zr - q * d;
      const eT = Math.min(1, Math.abs(dsm[i]! - tentZ));
      const eM = Math.min(1, Math.abs(dsm[i]! - model[i]!));
      let inside = false;
      if (k >= 0 && k <= last) {
        const run = u < 0 ? t.runL[k]! : t.runR[k]!;
        if (run < 0) continue;
        // The tent's where it lies at least as close to the heights as the faces' planes do (by the ridge the height
        // map is rounded off under both); and on past where its slope was seen to end at a valley, to where the
        // tent's plane goes under the faces' own (the valley itself: the height map rounds that off too).
        if (d <= run + s / 2) inside = d < prm.ridgeRoundM || tentZ >= model[i]! || eT <= eM + 0.02;
        else inside = (u < 0 ? t.roseL[k]! : t.roseR[k]!) === 1 && d <= run + PAST_VALLEY_M && tentZ >= model[i]!;
      } else {
        // Past an end where the ridge runs into a higher slope: the tip between the two valleys, as the planes have it.
        const end = k < 0 ? 0 : last;
        if (!(k < 0 ? t.roseLo : t.roseHi)) continue;
        const run = u < 0 ? t.runL[end]! : t.runR[end]!;
        inside = run >= 0 && d <= run + s / 2 && tentZ >= model[i]!;
      }
      if (!inside) continue;
      (u < 0 ? left : right).push(i);
      const a = sums[u < 0 ? 0 : 1]!;
      a.n++;
      a.gain += eM - eT;
    }
    const [L, R] = sums as [(typeof sums)[0], (typeof sums)[0]];
    const px = L.n + R.n;
    if (px * s * s < prm.ridgeMinM2) return `footprint ${(px * s * s).toFixed(1)} m2`;
    if (Math.min(L.n, R.n) < 0.2 * px) return `one slope holds ${((100 * Math.min(L.n, R.n)) / px).toFixed(0)}% of the footprint`;
    const gain = (L.gain + R.gain) / px;
    if (gain < prm.ridgeGainM) return `the faces explain the heights nearly as well (gain ${gain.toFixed(2)} m over ${(px * s * s).toFixed(1)} m2)`;
    const vm = t.v0 + (t.runL.length * s) / 2;
    return {
      tent: t,
      left: Int32Array.from(left),
      right: Int32Array.from(right),
      gain,
      gainL: L.gain / L.n,
      gainR: R.gain / R.n,
      info: { at: { x: u0 * fr.ex + vm * fr.dx, y: u0 * fr.ey + vm * fr.dy }, ridgeM: t.ridgeM, pitchX12: q * 12, areaM2: px * s * s },
    };
  }

  // 4. The faces: the strongest evidence first; a pixel is one roof's.
  found.sort((a, b) => b.gain * b.info.areaM2 - a.gain * a.info.areaM2);
  type Applied = { shape: Shape; planes: Plane[] };
  const apply = (shapes: readonly Shape[]): { faces: Faces; applied: Applied[] } => {
    const lab = labels.slice();
    const all: Plane[] = [...planes];
    const taken = new Uint8Array(n);
    const touched = new Set<number>();
    const applied: Applied[] = [];
    for (const sh of shapes) {
      const { fr, u0, zr, q } = sh.tent;
      const mine: Plane[] = [];
      const sides: [Int32Array, number, Plane][] = [
        [sh.left, sh.gainL, { a: q * fr.ex, b: q * fr.ey, c: zr - q * u0 }],
        [sh.right, sh.gainR, { a: -q * fr.ex, b: -q * fr.ey, c: zr + q * u0 }],
      ];
      // A roof most of whose footprint an earlier one has taken is the same roof seen along the other direction.
      const free = (px: Int32Array) => px.reduce((t, i) => t + (taken[i] === 0 ? 1 : 0), 0);
      if (free(sh.left) + free(sh.right) < 0.7 * (sh.left.length + sh.right.length)) continue;
      for (const [px, sideGain, plane] of sides) {
        if (sideGain < prm.ridgeSideGainM) continue;
        const id = all.length;
        all.push(plane);
        mine.push(plane);
        for (const i of px) {
          if (taken[i] === 1) continue;
          taken[i] = 1;
          touched.add(lab[i]!);
          lab[i] = id;
        }
      }
      if (mine.length > 0) applied.push({ shape: sh, planes: mine });
    }
    if (applied.length === 0) return { faces, applied };
    // What is left of the faces the roofs were cut from: a scrap under the smallest face size goes to the faces
    // round it, and so does a fitted slope's stray piece.
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
  // piece, as they are drawn in the end) are no evidence against a fitted roof.
  const badBefore = new Set<Plane>();
  for (const before of [topo, build({ labels, planes: [...planes] }, false).topo]) {
    before.faces.forEach((f, k) => {
      const w = ringWidth(f.ring);
      if (f.fromPixels || w.area < lim.tinyFaceM2 || w.width < prm.ridgeFaceWidthM) badBefore.add(planes[k]!);
    });
  }
  let shapes = found;
  for (let round = 0; round < 3 && shapes.length > 0; round++) {
    const { faces: next, applied } = apply(shapes);
    if (applied.length === 0) return null;
    const fittedPlanes = applied.flatMap((a) => a.planes);
    lock(fittedPlanes, true);
    const built = build(next, false);
    const facesOf = new Map<Plane, number[]>();
    next.planes.forEach((p, k) => facesOf.set(p, [...(facesOf.get(p) ?? []), k]));
    const fittedSet = new Set(fittedPlanes);
    // Faces beside a fitted roof that came out badly, though they were drawn well before.
    const spoiled = new Set<number>();
    built.topo.faces.forEach((f, k) => {
      const p = next.planes[k]!;
      if (fittedSet.has(p) || badBefore.has(p)) return;
      const w = ringWidth(f.ring);
      if (f.fromPixels || w.area < lim.tinyFaceM2 || w.width < prm.ridgeFaceWidthM) spoiled.add(k);
    });
    const beside = (ks: readonly number[]): boolean => built.topo.lines.some((l) => l.faces.some((f) => ks.includes(f)) && l.faces.some((f) => spoiled.has(f)));
    const bad: Applied[] = [];
    for (const a of prm.ridgeCheck ? applied : []) {
      const ks = a.planes.flatMap((p) => facesOf.get(p) ?? []);
      let why = '';
      if (ks.length < a.planes.length) why = 'a slope of it was lost';
      for (const k of ks) {
        const f = built.topo.faces[k]!;
        const w = ringWidth(f.ring);
        if (f.fromPixels) why = 'a face of it has no sound polygon';
        else if (w.area < prm.ridgeFaceM2) why = `a face of it comes to ${w.area.toFixed(1)} m2`;
        else if (w.width < prm.ridgeFaceWidthM) why = `a face of it is ${w.width.toFixed(2)} m wide`;
      }
      if (why === '' && spoiled.size > 0 && beside(ks)) why = 'it spoils a face beside it';
      if (why !== '') {
        bad.push(a);
        debug?.(`ridge roof at ${a.shape.info.at.x.toFixed(1)},${a.shape.info.at.y.toFixed(1)}: taken out (${why})`);
      }
    }
    if (bad.length === 0 && spoiled.size > 0 && prm.ridgeCheck) {
      // A spoiled face beside none of them: no telling which roof did it.
      lock(fittedPlanes, false);
      debug?.('ridge roofs: all taken out (a face elsewhere came out worse)');
      return null;
    }
    if (bad.length === 0) {
      for (const a of applied) debug?.(`ridge roof at ${a.shape.info.at.x.toFixed(1)},${a.shape.info.at.y.toFixed(1)}: fitted, ${a.planes.length} faces at ${a.shape.info.pitchX12.toFixed(1)}/12 over ${a.shape.info.areaM2.toFixed(1)} m2`);
      return { faces: next, planes: built.planes, fitted: applied.map((a) => a.shape.info), fittedPlanes };
    }
    lock(fittedPlanes, false);
    const out = new Set(bad.map((a) => a.shape));
    shapes = applied.map((a) => a.shape).filter((sh) => !out.has(sh));
  }
  return null;
}
