// Roof primitives: where the free-form plane search has cut a simple roof shape into junk, the shape itself.
//
// The gable (fitGables). A height map bows some slopes (usually the shaded one: steep by the ridge, shallow by the
// eave, sagging up to most of a metre under the true plane) and the plane search then cuts that one slope into strips,
// level pockets and odd corners, which topology draws as hips, valleys and eaves the roof does not have. The slope
// across the ridge is usually clean. A gable's two slopes share the ridge, and on most houses the run and the eave
// height: so from a clean slope, its ridge (where the heights leave its plane downward on the far side, along a level
// line) and the far side's own eave (where the roof ends, and how high), the far slope is known without trusting the
// heights between its ridge and its eave. When the far side is the clean side's mirror in run and eave height, its
// faces that lie in the strip under that plane (within the sag a bowed slope shows, never above it: a dormer stands
// above its slope and stays) become one face on the plane through the ridge and the far eave.
import type { Grid, Mask } from './raster.ts';
import { compact, dissolve, type Faces, interiorFit, pixelX, pixelY, type Plane, planeAngleDeg, type PlaneParams, splitParts } from './planes.ts';

export type PrimitiveParams = {
  /** Off: the faces stand as the plane search left them. */
  enabled: boolean;
  /** A slope vouches for the one across its ridge when at least this big (square metres)... */
  minCleanM2: number;
  /** ...between these pitches (x/12)... */
  minPitchX12: number;
  maxPitchX12: number;
  /** ...and this share of its interior lies on its plane (planes.ts interiorFit). */
  cleanShare: number;
  /** Columns across the ridge are this wide, metres (never under two pixels). */
  binM: number;
  /** The heights have left the clean slope's plane when this far under it (metres) and staying under for crestHoldM. */
  crestDropM: number;
  crestHoldM: number;
  /** A metre past the crest the far side is lower than the ridge by between these (metres): a slope, not a level roof or a wall. */
  farDropMinM: number;
  farDropMaxM: number;
  /**
   * The crest is a ridge where it runs level: within this of one line (metres), for at least minRidgeM. A stretch of up
   * to ridgeGapM without it (a chimney, a dormer's ridge running in, another roof joining) does not end the ridge.
   */
  ridgeLevelM: number;
  minRidgeM: number;
  ridgeGapM: number;
  /**
   * A column's eave height: the line through its heights between these distances inside the roof's edge (metres), read
   * at the edge. (At the edge itself a height map blurs the roof into the yard; the line is the slope's own.)
   */
  anchorInnerM: number;
  anchorOuterM: number;
  /** A column is a mirror when its two runs agree within runTolM or runTolShare of the clean one, and its eave heights within eaveTolM. */
  runTolM: number;
  runTolShare: number;
  eaveTolM: number;
  /** Mirror columns: at least minRidgeM of them, and this share of the columns where the clean slope runs from ridge to eave. */
  mirrorShare: number;
  /**
   * The far slope's pitch: 'chord' from the ridge's height and the far eave's (rise over run, whatever the heights do
   * between), 'mirror' the clean slope's own. A chord further than pitchTolX12 from the clean pitch is no mirror.
   */
  pitch: 'chord' | 'mirror';
  pitchTolX12: number;
  /** Heights of the far slope lie between sagM under its plane and aboveM over it, metres. */
  sagM: number;
  aboveM: number;
  /** A far-side face becomes part of the slope when this share of its pixels is in the strip, between those heights. */
  absorbShare: number;
  /** ...and the faces taken must hold this share of the strip. */
  coverShare: number;
  /** One far face already within this angle (degrees) of the slope's plane is left as it is. */
  fineDeg: number;
  /**
   * A face along a fitted ridge that both slopes explain (absorbShare of it within pocketM of the ridge line and under
   * the two planes within the sag) and that lies on both sides of the line (pocketSideShare of it on each) is a blunt
   * ridge top in the height map, not a face: it is dissolved into the slopes.
   */
  pocketM: number;
  pocketSideShare: number;
};

export const DEFAULT_PRIMITIVE_PARAMS: PrimitiveParams = {
  enabled: false,
  minCleanM2: 8,
  minPitchX12: 3,
  maxPitchX12: 14,
  cleanShare: 0.8,
  binM: 0.2,
  crestDropM: 0.12,
  crestHoldM: 0.6,
  farDropMinM: 0.2,
  farDropMaxM: 1.6,
  ridgeLevelM: 0.35,
  minRidgeM: 2.5,
  ridgeGapM: 2.5,
  anchorInnerM: 0.4,
  anchorOuterM: 1.6,
  runTolM: 0.75,
  runTolShare: 0.15,
  eaveTolM: 0.35,
  mirrorShare: 0.5,
  pitch: 'chord',
  pitchTolX12: 2,
  sagM: 1,
  aboveM: 0.3,
  absorbShare: 0.7,
  coverShare: 0.5,
  fineDeg: 4,
  pocketM: 1.5,
  pocketSideShare: 0.15,
};

/** One fitted gable slope: the clean face it was mirrored from (label before the fit), the faces it replaced, its pitch. */
export type FittedGable = { from: number; absorbed: number; ridgeM: number; pitchX12: number; areaM2: number };

function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/**
 * Gable slopes fitted from the slope across their ridge (see the head of this file). `planes` are the faces' refitted
 * planes (as `faces.planes`, index for index). Returns the faces with each fitted slope one face on its plane, the
 * planes so fitted (`locked`: a later refit on the heights must leave them, the heights there are what is wrong), and
 * what was fitted. With nothing to fit the faces come back as they were given.
 */
export function fitGables(
  g: Grid,
  s: number,
  dsm: Float32Array,
  roof: Mask,
  faces: Faces,
  planes: readonly Plane[],
  prm: PrimitiveParams,
  planePrm: PlaneParams,
  tree: Mask | null = null,
  debug?: (msg: string) => void,
): { faces: Faces; locked: Set<Plane>; fitted: FittedGable[] } {
  const locked = new Set<Plane>();
  const fitted: FittedGable[] = [];
  const n = planes.length;
  if (!prm.enabled || n < 2) return { faces, locked, fitted };
  const labels = faces.labels.slice();
  const outPlanes = [...faces.planes];
  const area = new Array<number>(n).fill(0);
  for (let i = 0; i < labels.length; i++) if (labels[i]! >= 0) area[labels[i]!]!++;
  const order = [...Array(n).keys()].sort((a, b) => area[b]! - area[a]! || a - b);
  const gone = new Set<number>();
  const made = new Set<number>();
  const pockets = new Set<number>();
  const binM = Math.max(prm.binM, 2 * s);
  const gapBins = Math.round(prm.ridgeGapM / binM);

  for (const f of order) {
    if (gone.has(f) || made.has(f) || area[f]! * s * s < prm.minCleanM2) continue;
    const P = planes[f]!;
    const slope = Math.hypot(P.a, P.b);
    if (slope * 12 < prm.minPitchX12 || slope * 12 > prm.maxPitchX12) continue;
    const fit = interiorFit(g, s, dsm, labels, f, P, planePrm);
    if (fit === null || fit.share < prm.cleanShare) continue;
    // Slope coordinates: t up the clean slope, w level along it.
    const gx = P.a / slope;
    const gy = P.b / slope;
    const ex = -gy;
    const ey = gx;
    let wLo = Infinity;
    let wHi = -Infinity;
    for (let i = 0; i < labels.length; i++) {
      if (roof[i] !== 1) continue;
      const w = pixelX(g, s, i) * ex + pixelY(g, s, i) * ey;
      if (w < wLo) wLo = w;
      if (w > wHi) wHi = w;
    }
    const nb = Math.floor((wHi - wLo) / binM) + 1;
    const tTop = new Float64Array(nb).fill(-Infinity);
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== f) continue;
      const x = pixelX(g, s, i);
      const y = pixelY(g, s, i);
      const b = Math.floor((x * ex + y * ey - wLo) / binM);
      const t = x * gx + y * gy;
      if (t > tTop[b]!) tTop[b] = t;
    }
    const at = (w: number, t: number): number => {
      const c = Math.floor((w * ex + t * gx) / s);
      const r = Math.floor(-(w * ey + t * gy) / s);
      return c < 0 || r < 0 || c >= g.w || r >= g.h ? -1 : r * g.w + c;
    };
    const onRoof = (i: number) => i >= 0 && roof[i] === 1 && Number.isFinite(dsm[i]!);
    const wOf = (b: number) => wLo + (b + 0.5) * binM;
    const zF = (t: number) => slope * t + P.c;
    // 1. The crest above the clean face, column by column: where the heights leave its plane downward and stay under
    //    it, with a slope (not a level roof, not a wall's drop) a metre on.
    const crest = new Float64Array(nb).fill(Number.NaN);
    const hold = Math.max(1, Math.round(prm.crestHoldM / s));
    for (let b = 0; b < nb; b++) {
      if (!Number.isFinite(tTop[b]!)) continue;
      const w = wOf(b);
      let under = 0;
      for (let k = 0; ; k++) {
        const t = tTop[b]! - 0.6 + k * s;
        if (t > tTop[b]! + 1.2 + prm.crestHoldM) break;
        const i = at(w, t);
        if (!onRoof(i)) break;
        if (dsm[i]! - zF(t) < -prm.crestDropM) {
          under++;
          if (under >= hold) {
            const tc = t - (under - 1) * s;
            const j = at(w, tc + 1);
            const drop = onRoof(j) ? zF(tc) - dsm[j]! : Number.NaN;
            if (drop >= prm.farDropMinM && drop <= prm.farDropMaxM) crest[b] = tc;
            break;
          }
        } else under = 0;
      }
    }
    const found = [...crest].filter(Number.isFinite);
    if (found.length * binM < prm.minRidgeM) continue;
    let tr = median(found);
    tr = median(found.filter((t) => Math.abs(t - tr) <= prm.ridgeLevelM));
    if (!Number.isFinite(tr)) continue;
    // The longest run of columns whose crest is on that level line (a gap of up to ridgeGapM does not end it).
    let b0 = -1;
    let b1 = -1;
    for (let b = 0; b < nb; ) {
      if (!(Math.abs(crest[b]! - tr) <= prm.ridgeLevelM)) {
        b++;
        continue;
      }
      let end = b;
      for (let q = b + 1, miss = 0; q < nb && miss <= gapBins; q++) {
        if (Math.abs(crest[q]! - tr) <= prm.ridgeLevelM) {
          end = q;
          miss = 0;
        } else miss++;
      }
      if (b1 < 0 || end - b > b1 - b0) {
        b0 = b;
        b1 = end;
      }
      b = end + 1;
    }
    if (b0 < 0 || (b1 - b0 + 1) * binM < prm.minRidgeM) continue;
    const zR = zF(tr);
    // 2. Each ridge column walked down both sides to the roof's edge: its run, its eave height, and (the clean side)
    //    whether the clean face holds it from ridge to eave.
    const walk = (b: number, dir: 1 | -1) => {
      const w = wOf(b);
      const zs: number[] = [];
      let mine = 0;
      let counted = 0;
      for (let k = 0; k * s < 40; k++) {
        const i = at(w, tr + dir * k * s);
        if (i < 0 || roof[i] !== 1) break;
        zs.push(dsm[i]!);
      }
      const run = zs.length * s;
      // The eave's height: the least-squares line through the heights of the slope's last stretch, read at the edge.
      let m = 0;
      let sd = 0;
      let sz = 0;
      let sdd = 0;
      let sdz = 0;
      for (let k = 0; k < zs.length; k++) {
        const d = (k + 0.5) * s;
        if (d >= run - prm.anchorOuterM && d <= run - prm.anchorInnerM && Number.isFinite(zs[k]!)) {
          m++;
          sd += d;
          sz += zs[k]!;
          sdd += d * d;
          sdz += d * zs[k]!;
        }
        if (d >= 0.4 && d <= run - 0.4) {
          counted++;
          if (labels[at(w, tr + dir * k * s)] === f) mine++;
        }
      }
      const det = m * sdd - sd * sd;
      const fall = m >= 3 && det > 1e-9 ? (m * sdz - sd * sz) / det : Number.NaN;
      const eave = Number.isFinite(fall) ? (sz - fall * sd) / m + fall * run : Number.NaN;
      return { run, eave, direct: counted > 0 && mine >= 0.85 * counted };
    };
    let direct = 0;
    const mirrors: { run: number; eave: number }[] = [];
    for (let b = b0; b <= b1; b++) {
      const near = walk(b, -1);
      if (!near.direct || near.run < 1.5) continue;
      direct++;
      const far = walk(b, 1);
      if (Math.abs(far.run - near.run) > Math.max(prm.runTolM, prm.runTolShare * near.run)) continue;
      if (!(Math.abs(far.eave - near.eave) <= prm.eaveTolM)) continue;
      mirrors.push(far);
    }
    if (mirrors.length * binM < prm.minRidgeM || mirrors.length < prm.mirrorShare * direct) {
      debug?.(`gable from face ${f}: ridge ${((b1 - b0 + 1) * binM).toFixed(1)} m, no mirror (${mirrors.length} of ${direct} columns)`);
      continue;
    }
    const chord = median(mirrors.map((m) => (zR - m.eave) / m.run));
    if (!(Math.abs(chord - slope) * 12 <= prm.pitchTolX12)) {
      debug?.(`gable from face ${f}: far chord ${(chord * 12).toFixed(1)}/12 against ${(slope * 12).toFixed(1)}/12, no mirror`);
      continue;
    }
    const p2 = prm.pitch === 'chord' ? chord : slope;
    // 3. The ridge followed past the clean face's ends for as long as the heights keep it: at the ridge's height on the
    //    line, a slope down the far side.
    const ridgeAt = (b: number): boolean => {
      const w = wOf(b);
      let top = -Infinity;
      for (let t = tr - 0.3; t <= tr + 0.3 + 1e-9; t += s) {
        const i = at(w, t);
        if (onRoof(i) && dsm[i]! > top) top = dsm[i]!;
      }
      if (!(top >= zR - 0.35 && top <= zR + 0.2)) return false;
      const j = at(w, tr + 1);
      return onRoof(j) && zR - dsm[j]! >= prm.farDropMinM && zR - dsm[j]! <= prm.farDropMaxM;
    };
    let e0 = b0;
    let e1 = b1;
    for (let b = b0 - 1, miss = 0; b >= 0 && miss <= gapBins; b--) {
      if (ridgeAt(b)) {
        e0 = b;
        miss = 0;
      } else miss++;
    }
    for (let b = b1 + 1, miss = 0; b < nb && miss <= gapBins; b++) {
      if (ridgeAt(b)) {
        e1 = b;
        miss = 0;
      } else miss++;
    }
    const farRun = new Float64Array(nb);
    for (let b = e0; b <= e1; b++) farRun[b] = walk(b, 1).run;
    // 4. The far side's faces in the strip between ridge and eave, under the slope's plane within the sag.
    const inStrip = new Array<number>(n).fill(0);
    // Per face: pixels by the ridge line under both slopes' planes, on the far side and on the clean side of it.
    const byRidgeFar = new Array<number>(n).fill(0);
    const byRidgeNear = new Array<number>(n).fill(0);
    let strip = 0;
    for (let i = 0; i < labels.length; i++) {
      const k = labels[i]!;
      if (k < 0 || k === f || roof[i] !== 1) continue;
      const x = pixelX(g, s, i);
      const y = pixelY(g, s, i);
      const b = Math.floor((x * ex + y * ey - wLo) / binM);
      if (b < e0 || b > e1) continue;
      const tp = x * gx + y * gy - tr;
      if (Math.abs(tp) <= prm.pocketM) {
        const r = dsm[i]! - (zR - (tp >= 0 ? p2 : slope) * Math.abs(tp));
        if (r >= -prm.sagM && r <= prm.aboveM) (tp >= 0 ? byRidgeFar : byRidgeNear)[k]!++;
      }
      if (tp < -0.3 || tp > farRun[b]! + 0.3) continue;
      strip++;
      const r = dsm[i]! - (zR - p2 * tp);
      if (r >= -prm.sagM && r <= prm.aboveM) inStrip[k]!++;
    }
    const take: number[] = [];
    let covered = 0;
    for (let k = 0; k < n; k++) {
      if (k === f || gone.has(k) || made.has(k) || area[k] === 0) continue;
      if (inStrip[k]! >= prm.absorbShare * area[k]!) {
        take.push(k);
        covered += inStrip[k]!;
      }
    }
    const M: Plane = { a: -p2 * gx, b: -p2 * gy, c: zR + p2 * tr };
    if (take.length === 0 || covered < prm.coverShare * strip) {
      debug?.(`gable from face ${f}: far strip ${(strip * s * s).toFixed(1)} m2, faces under the slope cover ${(covered * s * s).toFixed(1)} m2, not fitted`);
      continue;
    }
    if (take.length === 1 && planeAngleDeg(planes[take[0]!]!, M) <= prm.fineDeg) continue;
    const target = take[0]!;
    const set = new Set(take);
    let px = 0;
    for (let i = 0; i < labels.length; i++) {
      if (set.has(labels[i]!)) {
        labels[i] = target;
        px++;
      }
    }
    for (const k of take) if (k !== target) gone.add(k);
    for (let k = 0; k < n; k++) {
      if (k === f || set.has(k) || gone.has(k) || made.has(k) || area[k] === 0) continue;
      const side = prm.pocketSideShare * area[k]!;
      if (byRidgeFar[k]! + byRidgeNear[k]! >= prm.absorbShare * area[k]! && byRidgeFar[k]! >= side && byRidgeNear[k]! >= side) {
        pockets.add(k);
        debug?.(`gable from face ${f}: face ${k} (${(area[k]! * s * s).toFixed(1)} m2) is the ridge's blunt top, dissolved`);
      }
    }
    made.add(target);
    area[target] = px;
    outPlanes[target] = M;
    locked.add(M);
    fitted.push({ from: f, absorbed: take.length, ridgeM: (e1 - e0 + 1) * binM, pitchX12: p2 * 12, areaM2: px * s * s });
    debug?.(
      `gable from face ${f} (${(slope * 12).toFixed(1)}/12): ridge ${((e1 - e0 + 1) * binM).toFixed(1)} m, ${mirrors.length} mirror columns of ${direct}, far slope ${(p2 * 12).toFixed(1)}/12 (chord ${(chord * 12).toFixed(1)}), faces ${take.join(',')} -> one face of ${(px * s * s).toFixed(1)} m2`,
    );
  }
  if (fitted.length === 0) return { faces, locked, fitted };
  for (const k of made) pockets.delete(k);
  for (const k of gone) pockets.delete(k);
  // Pockets flood from the faces round them (the fitted slopes among them, on their fitted planes); the labels are
  // not renumbered before that, so `pockets` still names them.
  const merged: Faces = { labels, planes: outPlanes };
  if (pockets.size === 0) return { faces: splitParts(g, compact(labels, outPlanes)), locked, fitted };
  return { faces: dissolve(g, s, dsm, roof, merged, pockets, tree), locked, fitted };
}
