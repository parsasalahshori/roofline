// Small roofs with a ridge of their own that the faces do not have (a gable over an entry or a bump-out, a dormer, a
// short wing), found from the crest the height map's blur leaves standing. One of the fitted shapes
// (fitted-shapes.ts, which places a shape's faces and checks what topology draws of them).
//
// A height map blurs a roof a few metres across into the slope round it. The plane search then finds no plane on its
// two small slopes, or finds them and the cleanup takes them for junk by the roof's edge, and the main slope is drawn
// straight through: the small roof's ridge and its two valleys are missing. What survives the blur is the crest: a
// level line from which the heights fall away on both sides.
//
// 1. Crests. Along each of the roof's directions (its faces' own), the pixels from which the heights fall on both
//    sides across that direction while the faces' planes there do not (the faces have no ridge within half a metre):
//    a crest the faces lack, where such pixels line up level for a metre or more.
// 2. The tent. A level ridge on the crest and one pitch for both slopes (three numbers: where the ridge is, how high,
//    how steep), least squares on the heights each side of the crest, walked out column by column for as long as the
//    heights stay on the slope: to the valley where the main slope takes over, or to the slope's own edge. The ridge
//    itself runs on past the crest's ends for as long as the heights keep it: into the higher slope behind (the tip
//    between the two valleys, as the planes have it) and out to the gable's end.
// 3. The evidence. Over its footprint the tent must explain the heights better than the faces' planes do, by a margin
//    (ShapeParams.shapeGainM). A smooth slope has no crest, and a ridge the faces already have gains nothing.
import { median, type ShapeParams, type ShapeProposal, type ShapeScene } from './fitted-shapes.ts';
import { mainAxis } from './outline.ts';
import type { XY } from './geom.ts';
import { pixelX, pixelY, type Plane } from './planes.ts';

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

/** The tent's footprint runs on past where a slope was seen to end at a valley by at most this (metres), and past the ridge's end into a higher slope by this. */
const PAST_VALLEY_M = 0.8;
const PAST_END_M = 3;
/** A slope or a ridge that ends within this (metres) of its face's edge (the roof's, or the next face) runs to it. */
const EDGE_M = 0.8;
/** Two faces' planes meet in a ridge where they are within this of each other in height (metres). */
const MEET_M = 0.25;

/**
 * The roof's directions (radians, 0 to pi): its pitched faces' slope directions mod 90 degrees, gathered by plan area
 * into at most three axes at least 15 degrees apart (a house with a wing set at an angle has two), each with its
 * quarter turn: a small roof's ridge runs up the slope it stands on, or along it. With no pitched face, the outline's.
 */
export function roofDirections(planes: readonly Plane[], area: readonly number[], outline: readonly XY[]): number[] {
  const quarter = Math.PI / 2;
  const bins = 18;
  const hist = new Array<number>(bins).fill(0);
  const dirs: { phi: number; w: number }[] = [];
  let total = 0;
  for (let k = 0; k < planes.length; k++) {
    const p = planes[k]!;
    if (Math.hypot(p.a, p.b) * 12 < 2 || area[k]! === 0) continue;
    const phi = ((Math.atan2(p.b, p.a) % quarter) + quarter) % quarter;
    dirs.push({ phi, w: area[k]! });
    hist[Math.min(bins - 1, Math.floor((phi / quarter) * bins))]! += area[k]!;
    total += area[k]!;
  }
  if (total === 0) {
    const axis = mainAxis(outline);
    return [axis, axis + quarter];
  }
  const smooth = hist.map((h, k) => h + 0.5 * (hist[(k + 1) % bins]! + hist[(k + bins - 1) % bins]!));
  const peaks = smooth
    .map((h, k) => ({ h, k }))
    .filter(({ h, k }) => h >= smooth[(k + 1) % bins]! && h > smooth[(k + bins - 1) % bins]! && h >= 0.12 * 2 * total)
    .sort((x, y) => y.h - x.h || x.k - y.k);
  const axes: number[] = [];
  for (const { k } of peaks) {
    // The axis: the weighted mean of the faces within 12 degrees of the peak (circular, mod 90 degrees).
    const centre = ((k + 0.5) / bins) * quarter;
    let cs = 0;
    let sn = 0;
    for (const d of dirs) {
      let off = Math.abs(d.phi - centre);
      off = Math.min(off, quarter - off);
      if (off > (12 * Math.PI) / 180) continue;
      cs += d.w * Math.cos(4 * d.phi);
      sn += d.w * Math.sin(4 * d.phi);
    }
    const axis = (((Math.atan2(sn, cs) / 4) % quarter) + quarter) % quarter;
    const apart = (o: number) => Math.min(Math.abs(o - axis), quarter - Math.abs(o - axis));
    if (axes.every((o) => apart(o) >= (15 * Math.PI) / 180)) axes.push(axis);
    if (axes.length === 3) break;
  }
  if (axes.length === 0) axes.push(mainAxis(outline));
  return axes.flatMap((axis) => [axis, axis + quarter]);
}

/** Ridge roofs the heights show and the faces lack, each with its evidence (see the head of this file). */
export function findRidgeRoofs(scene: ShapeScene, prm: ShapeParams, debug?: (msg: string) => void): ShapeProposal[] {
  const { g, s, dsm, roof, labels, planes, area, model, index, usable, outline, maxX12 } = scene;
  const n = g.w * g.h;
  const zAt = (x: number, y: number): number => {
    const i = index(x, y);
    return usable(i) ? dsm[i]! : Number.NaN;
  };
  const found: ShapeProposal[] = [];
  // 1. Crests the faces lack, direction by direction, and the tents fitted on them.
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
    // A ridge of the faces' own at a point: the face 0.6 m out on either side falls away from it (its plane's slope
    // across the ridge's direction at least ridgeModelSlope), and the two planes meet there (within MEET_M in height:
    // one slope of a small roof found and the other given to the main slope is a step, not a ridge).
    const ownRidge = (x: number, y: number): boolean => {
      const iL = index(x - 0.6 * fr.ex, y - 0.6 * fr.ey);
      const iR = index(x + 0.6 * fr.ex, y + 0.6 * fr.ey);
      const kL = iL >= 0 ? labels[iL]! : -1;
      const kR = iR >= 0 ? labels[iR]! : -1;
      if (kL < 0 || kR < 0 || kL === kR) return false;
      const pL = planes[kL]!;
      const pR = planes[kR]!;
      if (!(pL.a * fr.ex + pL.b * fr.ey >= prm.ridgeModelSlope && pR.a * fr.ex + pR.b * fr.ey <= -prm.ridgeModelSlope)) return false;
      return Math.abs(pL.a * x + pL.b * y + pL.c - (pR.a * x + pR.b * y + pR.c)) <= MEET_M;
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
        if (ownRidge(x + shift * fr.ex, y + shift * fr.ey)) {
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
      debug?.(`ridge roof: ${where}: ${(tent.q * 12).toFixed(1)}/12, ridge ${tent.ridgeM.toFixed(1)} m, footprint ${shape.areaM2.toFixed(1)} m2, gain ${shape.gain.toFixed(2)} m, ${shape.sides.length} slopes`);
      found.push(shape);
    }
  }

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
    q = Math.min(Math.max(q, prm.shapeMinX12 / 12), maxX12 / 12);
    // How far a slope runs out from the ridge in one column: for as long as the heights stay on its plane.
    let rose = false;
    const walk = (v: number, sg: number, take?: (t: number, z: number) => void): number => {
      let last = 0;
      let bad = 0;
      rose = false;
      for (let k = 1; k * s <= prm.shapeMaxRunM; k++) {
        const t = k * s;
        const i = at(u0 + sg * t, v);
        if (!usable(i)) break;
        const dev = dsm[i]! - (zr - q * t);
        const ok = t < prm.shapeRoundM ? dev <= prm.shapeTolM && dev >= -prm.shapeRoundDropM : Math.abs(dev) <= prm.shapeTolM;
        if (ok) {
          last = t;
          bad = 0;
          if (t >= prm.shapeRoundM) take?.(t, dsm[i]!);
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
      if (!(q1 * 12 >= prm.shapeMinX12 && q1 * 12 <= maxX12)) return `pitch ${(q1 * 12).toFixed(1)}/12`;
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
      if (!(top >= zr - prm.shapeRoundDropM && top <= zr + prm.shapeTolM)) return null;
      const l = walk(v, -1);
      const roseL = rose;
      const r = walk(v, 1);
      return l >= prm.shapeRoundM && r >= prm.shapeRoundM ? { l, r, roseL, roseR: rose } : null;
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
        if (top > zr + prm.shapeTolM) return true;
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
    if (q * reach < prm.shapeReliefM) return `the ridge ${(q * reach).toFixed(2)} m above its slopes' ends`;
    return { fr, u0, zr, q, v0: va + lo * s, runL, runR, roseL, roseR, roseLo, roseHi, ridgeM: (hi - lo + 1) * s };
  }

  // 3. The footprint and the evidence.
  function footprint(t: Tent): ShapeProposal | string {
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
      let inside: boolean;
      if (k >= 0 && k <= last) {
        const run = u < 0 ? t.runL[k]! : t.runR[k]!;
        if (run < 0) continue;
        // The tent's where it lies at least as close to the heights as the faces' planes do (by the ridge the height
        // map is rounded off under both); and on past where its slope was seen to end at a valley, to where the
        // tent's plane goes under the faces' own (the valley itself: the height map rounds that off too).
        if (d <= run + s / 2) inside = d < prm.shapeRoundM || tentZ >= model[i]! || eT <= eM + 0.02;
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
    if (px * s * s < prm.shapeMinM2) return `footprint ${(px * s * s).toFixed(1)} m2`;
    if (Math.min(L.n, R.n) < 0.2 * px) return `one slope holds ${((100 * Math.min(L.n, R.n)) / px).toFixed(0)}% of the footprint`;
    // A slope the faces already explain as well as the tent keeps its faces (the plane search found that slope of
    // the small roof and not the other); the evidence is weighed on the slopes that are new.
    const sides: ShapeProposal['sides'] = [];
    if (L.gain / L.n >= prm.ridgeSideGainM) sides.push({ px: Int32Array.from(left), plane: { a: q * fr.ex, b: q * fr.ey, c: zr - q * u0 }, gain: L.gain / L.n });
    if (R.gain / R.n >= prm.ridgeSideGainM) sides.push({ px: Int32Array.from(right), plane: { a: -q * fr.ex, b: -q * fr.ey, c: zr + q * u0 }, gain: R.gain / R.n });
    const fresh = sides.reduce((acc, side) => acc + side.px.length, 0);
    const gain = fresh > 0 ? sides.reduce((acc, side) => acc + side.gain * side.px.length, 0) / fresh : 0;
    if (gain < prm.shapeGainM || fresh * s * s < prm.shapeMinM2 / 2) return `the faces explain the heights nearly as well (gain ${gain.toFixed(2)} m over ${(fresh * s * s).toFixed(1)} m2 of new slope)`;
    const vm = t.v0 + (t.runL.length * s) / 2;
    return { kind: 'ridge-roof', at: { x: u0 * fr.ex + vm * fr.dx, y: u0 * fr.ey + vm * fr.dy }, pitchX12: q * 12, sides, gain, areaM2: fresh * s * s };
  }

  return found;
}
