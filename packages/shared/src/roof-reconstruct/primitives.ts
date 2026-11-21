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
import { adjacency, compact, dissolve, type Faces, interiorFit, pixelX, pixelY, type Plane, type PlaneParams, planeZ, splitParts } from './planes.ts';

export type PrimitiveParams = {
  /** Off: the faces stand as the plane search left them. */
  enabled: boolean;
  /** The gable fit (fitGables) and the stacked-strip merge (mergeStacks), each switchable when `enabled`. */
  gables: boolean;
  stacks: boolean;
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
  /** A ridge ending within this of the roof's end (metres) runs to it: a height map rounds a gable's end off. */
  ridgeEndM: number;
  /**
   * A column's eave height: the line through its heights between these distances inside the roof's edge (metres), read
   * at the edge. (At the edge itself a height map blurs the roof into the yard; the line is the slope's own.)
   */
  anchorInnerM: number;
  anchorOuterM: number;
  /**
   * A column is a mirror when the far side's chord (the ridge's height less its eave's, over its run from ridge to
   * eave) is within chordTolX12 (x/12) of the clean slope's pitch, and the shorter of the two runs is at least runRatio
   * of the longer. The chord, not the run or the eave height on their own: where the roof's edge falls in a mask moves
   * both, along the slope's own line. (The clean side's chord is its plane's pitch: its eave is not read off the heights.)
   */
  chordTolX12: number;
  runRatio: number;
  /** Where the far slope ends short of the roof's edge, at a drop onto a lower roof: see fitGables' walk. */
  farStepM: number;
  stepWindowM: number;
  stepFromShare: number;
  /** Mirror columns: at least minRidgeM of them, and this share of the columns where the clean slope runs from ridge to eave. */
  mirrorShare: number;
  /**
   * The far slope's pitch: 'mirror', the clean slope's own (a gable's two slopes share their pitch, and the clean one
   * is a plane fitted on good heights); 'chord', from the ridge's height and the far eave's (rise over run, whatever
   * the heights do between: on real height maps it reads a little low, the map rounds the ridge off). A chord further
   * than pitchTolX12 from the clean pitch is no mirror either way.
   */
  pitch: 'chord' | 'mirror';
  pitchTolX12: number;
  /**
   * The ridge's height: 'plane', the clean slope's plane read on the ridge line; 'heights', the height map's own top
   * within crestReachM of the line (a little low where the map rounds the ridge off). `stackCrest` is the same choice
   * for a stack's crest, where the plane is the upper strip's: itself fitted too steep on a bowed slope, so high.
   */
  crest: 'heights' | 'plane';
  stackCrest: 'heights' | 'plane';
  crestReachM: number;
  /** Heights of the far slope lie between sagM under its plane and aboveM over it, metres. */
  sagM: number;
  aboveM: number;
  /**
   * A far-side face becomes part of the slope when this share of its pixels is in the strip, between those heights, and
   * at most absorbAboveShare of them stand above the plane (a dormer's faces rise out of their slope; a bowed slope's
   * strips and pockets do not).
   */
  absorbShare: number;
  absorbAboveShare: number;
  /** ...and the faces taken must hold this share of the strip (of what in it does not stand above the slope's plane). */
  coverShare: number;
  /**
   * A far face within fineX12 (x/12) of the slope's pitch and fineFacingDeg of its facing is already right; when such
   * faces hold fineShare of what would be taken, the far side is left as it is.
   */
  fineX12: number;
  fineFacingDeg: number;
  fineShare: number;
  /**
   * A face along a fitted ridge that both slopes explain (absorbShare of it within pocketM of the ridge line and under
   * the two planes within the sag), that lies on both sides of the line (pocketSideShare of it on each) and is close to
   * level (under pocketFlatX12: a clipped gable's small hip is not) is a blunt ridge top in the height map, not a face:
   * it is dissolved into the slopes.
   */
  pocketM: number;
  pocketSideShare: number;
  pocketFlatX12: number;
  /**
   * Stacked strips (mergeStacks): an upper face steeper than the lower one by at least stackSteeperX12 (x/12), facing
   * within stackFacingDeg of it (a lower face under stackFlatX12 has no facing to speak of), sharing stackSharedM of
   * boundary along which their planes are within stackGapM in height (no wall between them).
   */
  stackSteeperX12: number;
  stackFacingDeg: number;
  stackFlatX12: number;
  stackSharedM: number;
  stackGapM: number;
  /** The upper face sits over the lower one along at least stackMinM, in stackOverShare of its own columns... */
  stackMinM: number;
  stackOverShare: number;
  /** ...and comes down to the roof's edge itself in at most stackEdgeShare of them (a face that does is a slope of its own). */
  stackEdgeShare: number;
  /** Of the stacked columns, this share has a crest above (a ridge or hip) and this share the lower face down to the roof's edge. */
  stackCrestShare: number;
  stackEaveShare: number;
  /** The two faces' heights lie under the chord plane within the sag (and not above it) on this share of their pixels. */
  stackFitShare: number;
  /**
   * The roof's own pitch (the area-weighted median over its other pitched faces) is the witness: the strips are one
   * bowed slope only when the chord comes within stackChordTolX12 of it and the upper strip is at least
   * stackUpperOffX12 steeper than it. An upper face at the roof's pitch over a shallower one is a real roof over a
   * porch or a low-slope addition, whose eave a report counts.
   */
  stackChordTolX12: number;
  stackUpperOffX12: number;
};

export const DEFAULT_PRIMITIVE_PARAMS: PrimitiveParams = {
  enabled: true,
  gables: true,
  stacks: true,
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
  ridgeEndM: 1.5,
  anchorInnerM: 0.4,
  anchorOuterM: 1.6,
  chordTolX12: 1,
  runRatio: 0.7,
  farStepM: 0.35,
  stepWindowM: 0.5,
  stepFromShare: 0.4,
  mirrorShare: 0.5,
  pitch: 'mirror',
  pitchTolX12: 2,
  crest: 'plane',
  stackCrest: 'heights',
  crestReachM: 0.4,
  sagM: 1,
  aboveM: 0.3,
  absorbShare: 0.7,
  absorbAboveShare: 0.15,
  coverShare: 0.5,
  fineX12: 1,
  fineFacingDeg: 15,
  fineShare: 0.6,
  pocketM: 1.5,
  pocketSideShare: 0.15,
  pocketFlatX12: 3,
  stackSteeperX12: 1,
  stackFacingDeg: 25,
  stackFlatX12: 2,
  stackSharedM: 1.5,
  stackGapM: 0.25,
  stackMinM: 2,
  stackOverShare: 0.6,
  stackEdgeShare: 0.2,
  stackCrestShare: 0.6,
  stackEaveShare: 0.6,
  stackFitShare: 0.9,
  stackChordTolX12: 1,
  stackUpperOffX12: 1,
};

/** One merged stack: the upper and lower faces' pitches, the chord's, the merged face's area. */
export type MergedStack = { upperX12: number; lowerX12: number; pitchX12: number; areaM2: number };

/** How a face's plane was fitted when not on its own heights: a gable's slope from across its ridge, or a stack's chord. */
export type FittedKind = 'gable' | 'stack';

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
): { faces: Faces; locked: Map<Plane, FittedKind>; fitted: FittedGable[] } {
  const locked = new Map<Plane, FittedKind>();
  const fitted: FittedGable[] = [];
  const n = planes.length;
  if (!prm.enabled || !prm.gables || n < 2) return { faces, locked, fitted };
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
    // Where the far side's heights just past the crest (0.3 to 1 m on: clear of the rounding) meet the clean plane, as
    // a line down the column: the apex itself, not the point past it where the rounded heights were seen to leave.
    const apexAt = (w: number, tc: number): number => {
      let m = 0;
      let st = 0;
      let sz = 0;
      let stt = 0;
      let stz = 0;
      for (let t = tc + 0.3; t <= tc + 1 + 1e-9; t += s) {
        const i = at(w, t);
        if (!onRoof(i)) break;
        m++;
        st += t;
        sz += dsm[i]!;
        stt += t * t;
        stz += t * dsm[i]!;
      }
      const det = m * stt - st * st;
      if (m < 4 || det <= 1e-9) return tc;
      const fall = (m * stz - st * sz) / det;
      if (!(fall < -0.1)) return tc;
      const t0 = ((sz - fall * st) / m - P.c) / (slope - fall);
      return Math.abs(t0 - tc) <= 0.5 ? t0 : tc;
    };
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
            if (drop >= prm.farDropMinM && drop <= prm.farDropMaxM) crest[b] = apexAt(w, tc);
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
    // The ridge's height: the clean plane's on the line, or the heights' own top by it (median over the columns).
    const tops: number[] = [];
    for (let b = b0; b <= b1; b++) {
      if (!(Math.abs(crest[b]! - tr) <= prm.ridgeLevelM)) continue;
      let top = -Infinity;
      for (let t = tr - prm.crestReachM; t <= tr + prm.crestReachM + 1e-9; t += s) {
        const i = at(wOf(b), t);
        if (onRoof(i) && dsm[i]! > top) top = dsm[i]!;
      }
      if (Number.isFinite(top)) tops.push(top);
    }
    const zR = prm.crest === 'plane' || tops.length === 0 ? zF(tr) : Math.min(zF(tr), median(tops));
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
      // The far slope ends at the roof's edge, or sooner at a drop onto a lower roof (its eave over a porch roof): past
      // the first stepFromShare of the way down, the heights falling over stepWindowM by farStepM more than the clean
      // slope would.
      if (dir === 1) {
        const win = Math.max(2, Math.round(prm.stepWindowM / s));
        let worst = prm.farStepM;
        let cut = -1;
        for (let k = Math.ceil((prm.stepFromShare * zs.length * s) / s); k + win < zs.length; k++) {
          const excess = zs[k]! - zs[k + win]! - slope * win * s;
          // A drop off something standing on the slope (a chimney, a dish, a lump in the heights) is no eave: the roof
          // before a real one is on the slope's plane, not above it.
          if (zs[k]! > zR - slope * k * s + prm.aboveM) continue;
          if (excess > worst) {
            worst = excess;
            cut = k;
          } else if (cut >= 0 && k > cut + win) break;
        }
        if (cut >= 0) zs.length = cut + (win >> 1);
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
      if (Math.min(far.run, near.run) < prm.runRatio * Math.max(far.run, near.run)) continue;
      if (!(Math.abs((zR - far.eave) / far.run - slope) * 12 <= prm.chordTolX12)) continue;
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
    // A ridge that stops just short of the roof's end runs to it (a height map rounds a gable's end off).
    const endBins = Math.round(prm.ridgeEndM / binM);
    for (const dir of [-1, 1] as const) {
      let last = dir < 0 ? e0 : e1;
      for (let b = last + dir, k = 0; b >= 0 && b < nb && k <= endBins; b += dir, k++) {
        const i = at(wOf(b), tr);
        if (i < 0 || roof[i] !== 1) {
          if (dir < 0) e0 = last;
          else e1 = last;
          break;
        }
        last = b;
      }
    }
    const farRun = new Float64Array(nb);
    for (let b = e0; b <= e1; b++) farRun[b] = walk(b, 1).run;
    // 4. The far side's faces in the strip between ridge and eave, under the slope's plane within the sag.
    const inStrip = new Array<number>(n).fill(0);
    // Per face: pixels by the ridge line under both slopes' planes, on the far side and on the clean side of it.
    const byRidgeFar = new Array<number>(n).fill(0);
    const byRidgeNear = new Array<number>(n).fill(0);
    const aboveStrip = new Array<number>(n).fill(0);
    const belowStrip = new Array<number>(n).fill(0);
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
        const r = dsm[i]! - (tp >= 0 ? zR - p2 * tp : zF(tr + tp));
        if (r >= -prm.sagM && r <= prm.aboveM) (tp >= 0 ? byRidgeFar : byRidgeNear)[k]!++;
      }
      if (tp < -0.3 || tp > farRun[b]! + 0.3) continue;
      strip++;
      const r = dsm[i]! - (zR - p2 * tp);
      if (r >= -prm.sagM && r <= prm.aboveM) inStrip[k]!++;
      else if (r > prm.aboveM) aboveStrip[k]!++;
      else belowStrip[k]!++;
    }
    if (debug !== undefined) {
      for (let k = 0; k < n; k++) {
        const all = inStrip[k]! + aboveStrip[k]! + belowStrip[k]!;
        if (all >= 0.3 * area[k]! && area[k]! > 0) debug(`gable from face ${f}: face ${k} (${(area[k]! * s * s).toFixed(1)} m2, ${(Math.hypot(planes[k]!.a, planes[k]!.b) * 12).toFixed(1)}/12): ${((100 * inStrip[k]!) / area[k]!).toFixed(0)}% under the slope, ${((100 * aboveStrip[k]!) / area[k]!).toFixed(0)}% above, ${((100 * belowStrip[k]!) / area[k]!).toFixed(0)}% far below`);
      }
    }
    const take: number[] = [];
    let covered = 0;
    for (let k = 0; k < n; k++) {
      if (k === f || gone.has(k) || made.has(k) || area[k] === 0) continue;
      if (inStrip[k]! >= prm.absorbShare * area[k]! && aboveStrip[k]! <= prm.absorbAboveShare * area[k]!) {
        take.push(k);
        covered += inStrip[k]!;
      }
    }
    const M: Plane = { a: -p2 * gx, b: -p2 * gy, c: zR + p2 * tr };
    // The slope's part of the strip: what does not stand above its plane (another roof joining it there, a dormer).
    const slopePx = strip - aboveStrip.reduce((t, v) => t + v, 0);
    if (take.length === 0 || covered < prm.coverShare * slopePx) {
      debug?.(`gable from face ${f}: far strip ${(strip * s * s).toFixed(1)} m2 (${(slopePx * s * s).toFixed(1)} m2 not above the slope), faces under the slope cover ${(covered * s * s).toFixed(1)} m2, not fitted`);
      continue;
    }
    // A far side already (mostly) at the slope's pitch and facing is left as it is: one clean face, or the pieces another
    // roof cuts one slope into. The fit is for a slope the heights have bent, not a second opinion on a sound one.
    const fine = (k: number): boolean => {
      const q = planes[k]!;
      const sq = Math.hypot(q.a, q.b);
      if (Math.abs(sq - p2) * 12 > prm.fineX12 || sq < 1e-6) return false;
      return (q.a * M.a + q.b * M.b) / (sq * p2) >= Math.cos((prm.fineFacingDeg * Math.PI) / 180);
    };
    const takenPx = take.reduce((t, k) => t + area[k]!, 0);
    const finePx = take.reduce((t, k) => t + (fine(k) ? area[k]! : 0), 0);
    if (finePx >= prm.fineShare * takenPx) continue;
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
      if (Math.hypot(planes[k]!.a, planes[k]!.b) * 12 >= prm.pocketFlatX12) continue;
      if (byRidgeFar[k]! + byRidgeNear[k]! >= prm.absorbShare * area[k]! && byRidgeFar[k]! >= side && byRidgeNear[k]! >= side) {
        pockets.add(k);
        debug?.(`gable from face ${f}: face ${k} (${(area[k]! * s * s).toFixed(1)} m2) is the ridge's blunt top, dissolved`);
      }
    }
    made.add(target);
    area[target] = px;
    outPlanes[target] = M;
    locked.set(M, 'gable');
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

/**
 * Stacked strips of one slope merged (the lighter primitive). A height map that bows a slope (steep by the ridge,
 * shallow by the eave) makes the plane search cut it along a level line into an upper, steeper face and a lower,
 * shallower one facing the same way, and topology draws the upper one's "eave" across the middle of the slope. Told by
 * structure, not size: the upper face lies over the lower one (and nowhere comes down to the roof's edge itself: a face
 * that does is a slope in its own right, with a shed dormer or a porch roof set into it), no wall stands between them,
 * a crest (ridge or hip) is above the upper face and the roof's edge below the lower one, and both lie under the plane
 * through the crest and the eave within the sag a bowed slope shows, never above it. The two become one face on that
 * chord plane, which is locked (a refit on the bowed heights would bend it back). `planes` are the faces' current
 * planes (refitted, locked ones as fitted); `locked` gains the chord planes.
 */
export function mergeStacks(
  g: Grid,
  s: number,
  dsm: Float32Array,
  roof: Mask,
  faces: Faces,
  planes: readonly Plane[],
  locked: Map<Plane, FittedKind>,
  prm: PrimitiveParams,
  debug?: (msg: string) => void,
): { faces: Faces; merged: MergedStack[] } {
  const merged: MergedStack[] = [];
  const n = planes.length;
  if (!prm.enabled || !prm.stacks || n < 2) return { faces, merged };
  const labels = faces.labels.slice();
  const outPlanes = [...faces.planes];
  // Each face's plane now, and the plane its top was fitted on (a merged face's chord is no guide to where its crest is).
  const cur = [...planes];
  const topPlane = [...planes];
  const binM = Math.max(prm.binM, 2 * s);
  const hold = Math.max(1, Math.round(prm.crestHoldM / s));
  const onRoof = (i: number) => i >= 0 && roof[i] === 1 && Number.isFinite(dsm[i]!);
  const refused = new Set<string>();

  const tryPair = (U: number, L: number, area: readonly number[]): { plane: Plane; pitch: number } | string => {
    const PU = cur[U]!;
    const PL = cur[L]!;
    const sU = Math.hypot(PU.a, PU.b);
    const sL = Math.hypot(PL.a, PL.b);
    // The roof's own pitch: the area-weighted median over the other pitched faces.
    const others = cur
      .map((q, k) => ({ p: Math.hypot(q.a, q.b), a: area[k]! }))
      .filter((o, k) => k !== U && k !== L && o.a > 0 && o.p * 12 >= prm.stackFlatX12)
      .sort((x, y) => x.p - y.p);
    const half = others.reduce((t, o) => t + o.a, 0) / 2;
    let dom = Number.NaN;
    for (let k = 0, acc = 0; k < others.length; k++) {
      acc += others[k]!.a;
      if (acc >= half) {
        dom = others[k]!.p;
        break;
      }
    }
    if (!Number.isFinite(dom)) return 'no other pitched face to witness the pitch';
    if ((sU - dom) * 12 < prm.stackUpperOffX12) return `upper face at the roof's pitch (${(dom * 12).toFixed(1)}/12)`;
    // Slope coordinates along the larger face's fall when it has one worth the name, else the upper face's.
    const base = area[L]! >= area[U]! && sL * 12 >= prm.minPitchX12 ? PL : PU;
    const sb = Math.hypot(base.a, base.b);
    const gx = base.a / sb;
    const gy = base.b / sb;
    const ex = -gy;
    const ey = gx;
    let wLo = Infinity;
    let wHi = -Infinity;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== U && labels[i] !== L) continue;
      const w = pixelX(g, s, i) * ex + pixelY(g, s, i) * ey;
      if (w < wLo) wLo = w;
      if (w > wHi) wHi = w;
    }
    const nb = Math.floor((wHi - wLo) / binM) + 1;
    const topU = new Float64Array(nb).fill(-Infinity);
    const botU = new Float64Array(nb).fill(Infinity);
    const topL = new Float64Array(nb).fill(-Infinity);
    const botL = new Float64Array(nb).fill(Infinity);
    let gapSum: number[] = [];
    for (let i = 0; i < labels.length; i++) {
      const k = labels[i]!;
      if (k !== U && k !== L) continue;
      const x = pixelX(g, s, i);
      const y = pixelY(g, s, i);
      const b = Math.floor((x * ex + y * ey - wLo) / binM);
      const t = x * gx + y * gy;
      if (k === U) {
        if (t > topU[b]!) topU[b] = t;
        if (t < botU[b]!) botU[b] = t;
        const c = i % g.w;
        if ((c > 0 && labels[i - 1] === L) || (c < g.w - 1 && labels[i + 1] === L) || (i >= g.w && labels[i - g.w] === L) || (i + g.w < labels.length && labels[i + g.w] === L)) {
          gapSum.push(Math.abs(planeZ(PU, x, y) - planeZ(PL, x, y)));
        }
      } else {
        if (t > topL[b]!) topL[b] = t;
        if (t < botL[b]!) botL[b] = t;
      }
    }
    if (gapSum.length === 0 || median(gapSum) > prm.stackGapM) return `planes ${median(gapSum).toFixed(2)} m apart at the boundary`;
    gapSum = [];
    const at = (w: number, t: number): number => {
      const c = Math.floor((w * ex + t * gx) / s);
      const r = Math.floor(-(w * ey + t * gy) / s);
      return c < 0 || r < 0 || c >= g.w || r >= g.h ? -1 : r * g.w + c;
    };
    const TP = topPlane[U]!;
    const sT = TP.a * gx + TP.b * gy;
    const zTop = (w: number, t: number) => planeZ(TP, w * ex + t * gx, w * ey + t * gy);
    let nU = 0;
    let stacked = 0;
    let toEdge = 0;
    let crests = 0;
    let eaves = 0;
    const chords: { p: number; t: number; z: number }[] = [];
    for (let b = 0; b < nb; b++) {
      if (!Number.isFinite(topU[b]!)) continue;
      nU++;
      const w = wLo + (b + 0.5) * binM;
      const over = Number.isFinite(topL[b]!) && topU[b]! > topL[b]! + 0.3 && botU[b]! > botL[b]! + 0.3;
      // Down from the upper face's top to the roof's edge: whose pixels, and the eave's height (the line through the
      // last stretch of heights, read at the edge).
      let k = 0;
      let mineU = 0;
      let mineL = 0;
      let other = 0;
      const zs: number[] = [];
      for (; k * s < 60; k++) {
        const i = at(w, topU[b]! - k * s);
        if (i < 0 || roof[i] !== 1) break;
        zs.push(dsm[i]!);
        if (labels[i] === U) mineU++;
        else if (labels[i] === L) mineL++;
        else other++;
      }
      const run = zs.length * s;
      if (!over) {
        // The upper face on its own down to the edge: a slope in its own right there.
        if (mineL === 0 && other * s <= 0.4 && run >= 1) toEdge++;
        continue;
      }
      stacked++;
      // The crest above the upper face: where the heights leave the plane its top was fitted on, downward, and stay under.
      let tc = Number.NaN;
      for (let q = 0, under = 0; ; q++) {
        const t = topU[b]! - 0.6 + q * s;
        if (t > topU[b]! + 1.2 + prm.crestHoldM) break;
        const i = at(w, t);
        if (!onRoof(i)) break;
        if (dsm[i]! - zTop(w, t) < -prm.crestDropM) {
          under++;
          if (under >= hold) {
            tc = t - (under - 1) * s;
            break;
          }
        } else under = 0;
      }
      if (Number.isFinite(tc)) crests++;
      const direct = other * s <= 0.4 && mineL * s >= 0.6;
      if (direct) eaves++;
      if (!Number.isFinite(tc) || !direct) continue;
      let m = 0;
      let sd = 0;
      let sz = 0;
      let sdd = 0;
      let sdz = 0;
      for (let q = 0; q < zs.length; q++) {
        const d = (q + 0.5) * s;
        if (d >= run - prm.anchorOuterM && d <= run - prm.anchorInnerM && Number.isFinite(zs[q]!)) {
          m++;
          sd += d;
          sz += zs[q]!;
          sdd += d * d;
          sdz += d * zs[q]!;
        }
      }
      const det = m * sdd - sd * sd;
      if (m < 3 || det <= 1e-9) continue;
      const fall = (m * sdz - sd * sz) / det;
      const eave = (sz - fall * sd) / m + fall * run;
      const tEdge = topU[b]! - run;
      let zc = zTop(w, tc);
      if (prm.stackCrest === 'heights') {
        let top = -Infinity;
        for (let t = tc - prm.crestReachM; t <= tc + prm.crestReachM + 1e-9; t += s) {
          const i = at(w, t);
          if (onRoof(i) && dsm[i]! > top) top = dsm[i]!;
        }
        if (Number.isFinite(top)) zc = Math.min(zc, top);
      }
      if (tc - tEdge > 1) chords.push({ p: (zc - eave) / (tc - tEdge), t: tc, z: zc });
    }
    if (stacked * binM < prm.stackMinM || stacked < prm.stackOverShare * nU) return `upper face over the lower one in ${stacked} of its ${nU} columns`;
    if (toEdge > prm.stackEdgeShare * nU) return `upper face runs to the roof's edge itself in ${toEdge} of ${nU} columns`;
    if (crests < prm.stackCrestShare * stacked) return `a crest above ${crests} of ${stacked} columns`;
    if (eaves < prm.stackEaveShare * stacked || chords.length < 3) return `the lower face down to the edge in ${eaves} of ${stacked} columns`;
    const p = median(chords.map((c) => c.p));
    if (!(p > 0) || p > sU + 0.5 / 12 || p < Math.min(sL, sT) - 0.5 / 12) return `chord ${(p * 12).toFixed(1)}/12 not between ${(sL * 12).toFixed(1)} and ${(sU * 12).toFixed(1)}`;
    if (Math.abs(p - dom) * 12 > prm.stackChordTolX12) return `chord ${(p * 12).toFixed(1)}/12 against the roof's ${(dom * 12).toFixed(1)}/12`;
    const c0 = median(chords.map((c) => c.z - p * c.t));
    let inside = 0;
    let total = 0;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== U && labels[i] !== L) continue;
      total++;
      const r = dsm[i]! - (c0 + p * (pixelX(g, s, i) * gx + pixelY(g, s, i) * gy));
      if (r >= -prm.sagM && r <= prm.aboveM) inside++;
    }
    if (inside < prm.stackFitShare * total) return `${((100 * inside) / total).toFixed(0)}% under the chord plane`;
    return { plane: { a: p * gx, b: p * gy, c: c0 }, pitch: p };
  };

  for (let round = 0; round < 40; round++) {
    const adj = adjacency(g, labels, n);
    const pairs: { U: number; L: number; cracks: number }[] = [];
    for (const [key, cracks] of adj.shared) {
      if (cracks * s < prm.stackSharedM) continue;
      const a = Math.floor(key / 100000);
      const b = key % 100000;
      const sa = Math.hypot(cur[a]!.a, cur[a]!.b);
      const sb = Math.hypot(cur[b]!.a, cur[b]!.b);
      const [U, L, sU, sL] = sa >= sb ? [a, b, sa, sb] : [b, a, sb, sa];
      if (sU * 12 < prm.minPitchX12 || sU * 12 > prm.maxPitchX12 || (sU - sL) * 12 < prm.stackSteeperX12) continue;
      if (sL * 12 >= prm.stackFlatX12) {
        const cos = (cur[U]!.a * cur[L]!.a + cur[U]!.b * cur[L]!.b) / (sU * sL);
        if (cos < Math.cos((prm.stackFacingDeg * Math.PI) / 180)) continue;
      }
      if (refused.has(`${U}/${L}/${adj.area[U]}/${adj.area[L]}`)) continue;
      pairs.push({ U, L, cracks });
    }
    pairs.sort((x, y) => y.cracks - x.cracks || x.U - y.U || x.L - y.L);
    let done = false;
    for (const { U, L } of pairs) {
      const got = tryPair(U, L, adj.area);
      const sU = Math.hypot(cur[U]!.a, cur[U]!.b) * 12;
      const sL = Math.hypot(cur[L]!.a, cur[L]!.b) * 12;
      if (typeof got === 'string') {
        refused.add(`${U}/${L}/${adj.area[U]}/${adj.area[L]}`);
        debug?.(`stack ${U} (${sU.toFixed(1)}/12, ${(adj.area[U]! * s * s).toFixed(1)} m2) over ${L} (${sL.toFixed(1)}/12, ${(adj.area[L]! * s * s).toFixed(1)} m2): no (${got})`);
        continue;
      }
      for (let i = 0; i < labels.length; i++) if (labels[i] === L) labels[i] = U;
      cur[U] = got.plane;
      outPlanes[U] = got.plane;
      locked.set(got.plane, 'stack');
      const areaM2 = (adj.area[U]! + adj.area[L]!) * s * s;
      merged.push({ upperX12: sU, lowerX12: sL, pitchX12: got.pitch * 12, areaM2 });
      debug?.(`stack ${U} (${sU.toFixed(1)}/12) over ${L} (${sL.toFixed(1)}/12): one face of ${areaM2.toFixed(1)} m2 at ${(got.pitch * 12).toFixed(1)}/12`);
      done = true;
      break;
    }
    if (!done) break;
  }
  if (merged.length === 0) return { faces, merged };
  return { faces: splitParts(g, compact(labels, outPlanes)), merged };
}
