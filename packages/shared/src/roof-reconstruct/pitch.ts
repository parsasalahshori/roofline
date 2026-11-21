// The pitch each face reports (docs/roof-3d/pitch.md). A face's own plane is fitted on a photogrammetric height map
// that is rounded at ridges and eaves and bowed on shaded slopes: on real roofs a face of 300 sq ft reads within 0.5/12
// of the surveyed pitch three times in four, a face of 150 sq ft less than half the time. But a roof is built with one
// pitch, or two or three, and every face of one pitch is a reading of the same number. So the readings are pooled
// before anything is rounded: the pitch that holds the most roof is found first and every face within its tolerance
// reports it (the group's area-weighted median, interpolated), then the next pitch among the faces left, and so on. A face that
// stands apart (a low porch roof, a steep dormer) keeps its own reading.
//
// Planes, creases and line lengths are not touched: only a face's reported pitch and the sloped area that follows
// from it.

export type PitchParams = {
  /** Faces of one roof that agree on a pitch within the tolerance report one pitch. False: each its own plane's. */
  pool: boolean;
  /** A face of refM2 or more belongs to a pitch group when its own reading is within this of the group's, x/12. */
  tolX12: number;
  /**
   * A smaller face is measured worse and is held to its own reading less: its tolerance is tolX12 times
   * sqrt(refM2 / its area), up to smallTolX times tolX12.
   */
  refM2: number;
  smallTolX: number;
  /** No tolerance is more than this share of the group's pitch (a 3/12 porch roof is not a 4/12 roof read badly). */
  capShare: number;
  /** A group is at least this many faces and this share of the sloped roof's plan area. */
  minFaces: number;
  minShare: number;
  /** Faces under this (x/12) keep their own reading and join no group: flat and low-slope roofs. */
  minPitchX12: number;
  /**
   * Calibration of the height map, taken off every face's pitch after pooling (x/12; never more than offsetShare of
   * the pitch, so a flat face stays flat). 0 here: the engine reports what the heights say. The server sets it for
   * Google's height maps (GOOGLE_PITCH_OFFSET_X12, apps/api/src/estimator/roof-3d.ts).
   */
  offsetX12: number;
  offsetShare: number;
  /**
   * Whether the sloped area follows the calibrated pitch (true) or the pitch before the offset (false, the default).
   * Off because the benchmark's area error rises when it does: against EagleView on the held-out houses by 0.9 points
   * (2.4 to 3.3 %) and against lidar by 0.7 to 0.8 on every cohort. Our plan areas run under on those houses and the
   * steep reading was hiding about 1 % of it; the area should follow once the outline no longer runs under.
   */
  offsetArea: boolean;
  /**
   * Whether the calibration offset is taken off a face measured by lidar too (PitchFace.uncalibrated is then ignored),
   * as before round 3. False (the default): the offset is for the height map it was measured on, not the lidar's.
   */
  offsetLidar: boolean;
  /**
   * Whether a face whose plane was not fitted on its own heights (PitchFace.fitted: a gable slope mirrored from the
   * slope across its ridge, primitives.ts) counts as a reading of the roof's pitch. False (the default): it is a copy
   * of the reading it was mirrored from, so it joins that reading's group and reports the group's pitch, but neither
   * finds a group nor moves its pitch (counted, the one clean slope's reading weighed twice, with the bowed slope's
   * area on top of its own). True: as before round 3, every face a reading.
   */
  fittedVote: boolean;
  /**
   * Whether two stacked strips of one bowed slope (steep by the crest, shallow by the eave: pitch-stacks.ts) report the
   * slope's chord (its rise over its run from crest to eave) in place of their own planes' pitches. Read by the
   * reconstruction (index.ts), not by reportedPitches: the faces and lines stay as they are, only the readings change.
   */
  stackChord: boolean;
  /**
   * Two pitches a step apart in one group (5/12 and 6/12 are within every face's tolerance of 5.5). A group is cut in
   * two, at a gap in its readings, when the readings on each side are a pitch of their own: each side is read twice by
   * faces looking opposite ways (stepOpposedDeg apart or more: a height map that leans moves such faces apart, so two
   * that agree are a reading no lean explains) of stepPairM2 or more each that agree within stepPairShare of their
   * pitch, and the two sides' medians differ by stepShare of the lower one or more. A share of the pitch, not a fixed
   * step: on the benchmark the opposed pairs of one 12/12
   * roof read up to 13 % apart (11.4 and 12.9), and a whole step is 20 % at 5/12, 17 % at 6/12, 9 % at 11/12. And the
   * two are apart: no reading lies between them over stepGapShare of the lower pitch (a third of the step: a smear of
   * readings from one to the other is one pitch read badly). Needs the faces' facings (PitchFace.azimuthDeg). 0: off,
   * as before round 3.
   */
  stepShare: number;
  stepGapShare: number;
  stepPairShare: number;
  stepPairM2: number;
  stepOpposedDeg: number;
};

export const DEFAULT_PITCH_PARAMS: PitchParams = {
  pool: true,
  tolX12: 1,
  refM2: 28,
  smallTolX: 1.5,
  capShare: 0.2,
  minFaces: 2,
  minShare: 0.05,
  minPitchX12: 2,
  offsetX12: 0,
  offsetShare: 0.1,
  offsetArea: false,
  offsetLidar: false,
  fittedVote: false,
  stackChord: true,
  stepShare: 0.15,
  stepGapShare: 0.05,
  stepPairShare: 0.05,
  stepPairM2: 10,
  stepOpposedDeg: 120,
};

/**
 * A face as the pooling sees it: its reading of the pitch (x/12: its own plane's) and its plan area (square metres).
 * `fitted`: the plane is a copy of another face's (a mirrored gable slope), not a reading (PitchParams.fittedVote).
 */
export type PitchFace = {
  pitchX12: number;
  areaM2: number;
  fitted?: boolean;
  /** Downhill, compass degrees (for PitchParams.stepShare). */
  azimuthDeg?: number;
  /**
   * The reading was not taken on the calibrated height map (a face measured by lidar): the calibration offset is not
   * its to lose. Alone it reports its pitch as read. In a group it is weighed as the calibrated map would have read it
   * (its pitch plus the offset), so it neither drags the group's pitch down nor loses the offset twice, and reports the
   * group's pitch like the group's other faces.
   */
  uncalibrated?: boolean;
};
/** A pitch group: the pitch its faces report (before the calibration offset), their indices and plan area. */
export type PitchGroup = { pitchX12: number; faces: number[]; areaM2: number };

/**
 * The area-weighted median, interpolated: each value sits at the middle of its own share of the area, and the result is
 * read at half the area on the line between the two values either side. Two faces of one size give their mean, a face
 * holding most of the area gives its own value, and a small change in an area never makes the result jump.
 */
export function weightedMedian(items: readonly { v: number; w: number }[]): number {
  const sorted = items.map((it, k) => ({ ...it, k })).sort((a, b) => a.v - b.v || a.k - b.k);
  if (sorted.length === 0) return 0;
  let total = 0;
  for (const it of sorted) total += it.w;
  if (!(total > 0)) return sorted[Math.floor(sorted.length / 2)]!.v;
  let run = 0;
  let prev: { v: number; at: number } | null = null;
  for (const it of sorted) {
    const at = (run + it.w / 2) / total;
    if (at >= 0.5) return prev === null || at === prev.at ? it.v : prev.v + ((0.5 - prev.at) / (at - prev.at)) * (it.v - prev.v);
    prev = { v: it.v, at };
    run += it.w;
  }
  return sorted[sorted.length - 1]!.v;
}

/**
 * The pitch each face reports (x/12, same order as `faces`), the pitch its sloped area is worked out with (the same,
 * or the pitch before the calibration offset: `offsetArea`), and the groups found, largest first. Deterministic: ties
 * go to the earlier face.
 */
export function reportedPitches(faces: readonly PitchFace[], prm: PitchParams = DEFAULT_PITCH_PARAMS): { pitchX12: number[]; areaPitchX12: number[]; groups: PitchGroup[] } {
  // An uncalibrated reading as the calibrated map would have read it: the pitch the offset takes down to it.
  const lift = (p: number): number => {
    if (!(prm.offsetX12 > 0) || !Number.isFinite(p) || p <= 0) return p;
    return prm.offsetShare * (p + prm.offsetX12) >= prm.offsetX12 ? p + prm.offsetX12 : p / (1 - prm.offsetShare);
  };
  const own = (f: PitchFace) => f.uncalibrated === true && !prm.offsetLidar;
  const out = faces.map((f) => (own(f) ? lift(f.pitchX12) : f.pitchX12));
  const read: readonly number[] = out.slice();
  const grouped = new Set<number>();
  const groups: PitchGroup[] = [];
  if (prm.pool) {
    const usable = (k: number) => Number.isFinite(read[k]!) && faces[k]!.areaM2 > 0 && read[k]! >= prm.minPitchX12;
    let free = faces.map((_, k) => k).filter(usable);
    let total = 0;
    for (const k of free) total += faces[k]!.areaM2;
    /** How far face k's own reading may be from a group's pitch c and still be a reading of it. */
    const tol = (c: number, k: number) => Math.min(prm.tolX12 * Math.min(prm.smallTolX, Math.max(1, Math.sqrt(prm.refM2 / faces[k]!.areaM2))), prm.capShare * c);
    const within = (c: number, among: readonly number[]) => among.filter((k) => Math.abs(read[k]! - c) <= tol(c, k));
    const areaOf = (m: readonly number[]) => m.reduce((t, k) => t + faces[k]!.areaM2, 0);
    // A face that is a reading: every face, but a fitted one when fittedVote is off.
    const reads = (k: number) => prm.fittedVote || faces[k]!.fitted !== true;
    const readArea = (m: readonly number[]) => m.reduce((t, k) => t + (reads(k) ? faces[k]!.areaM2 : 0), 0);
    // A group's pitch: the median of its readings (of all its faces when none of them is a reading).
    const centre = (m: readonly number[]) => {
      const readings = m.filter(reads);
      return weightedMedian((readings.length > 0 ? readings : m).map((k) => ({ v: read[k]!, w: faces[k]!.areaM2 })));
    };
    while (free.length >= prm.minFaces) {
      // The pitch (one of the readings) with the most roof read within tolerance of it. With no reading left, as before.
      const anyReads = free.some(reads);
      let best: number[] = [];
      let bestArea = 0;
      for (const k of free) {
        if (anyReads && !reads(k)) continue;
        const m = within(read[k]!, free);
        const a = anyReads ? readArea(m) : areaOf(m);
        if (a > bestArea + 1e-9) {
          bestArea = a;
          best = m;
        }
      }
      // Settled on its own median (the faces within tolerance of the median, their median, until nothing changes).
      for (let it = 0; it < 4; it++) {
        const next = within(centre(best), free);
        if (next.length === 0 || (next.length === best.length && next.every((k, i) => k === best[i]))) break;
        best = next;
      }
      // Two pitches a step apart, each read twice by faces looking opposite ways: the side read by more roof is the
      // group, the other is left for the next round (PitchParams.stepShare).
      // (Judged on the group's readings and those just outside it: of two faces of the higher pitch, one can lie
      // within the lower pitch's tolerance and the other a hair outside.)
      let cut: number | null = null;
      if (prm.stepShare > 0 && best.length > 0) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const k of best) {
          lo = Math.min(lo, read[k]!);
          hi = Math.max(hi, read[k]!);
        }
        cut = pitchStep(faces, read, free.filter((k) => reads(k) && read[k]! >= lo * (1 - prm.stepPairShare) && read[k]! <= hi * (1 + prm.stepPairShare)), prm);
      }
      if (cut !== null) {
        const low = best.filter((k) => read[k]! < cut);
        const high = best.filter((k) => read[k]! >= cut);
        const side = readArea(low) >= readArea(high) ? low : high;
        if (side.length >= prm.minFaces && areaOf(side) >= prm.minShare * total) best = side;
      }
      const area = areaOf(best);
      if (best.length < prm.minFaces || area < prm.minShare * total) break;
      const c = centre(best);
      for (const k of best) {
        out[k] = c;
        grouped.add(k);
      }
      groups.push({ pitchX12: c, faces: best, areaM2: area });
      const taken = new Set(best);
      free = free.filter((k) => !taken.has(k));
    }
  }
  const pooled = out.slice();
  if (prm.offsetX12 > 0) {
    for (let k = 0; k < out.length; k++) {
      const p = out[k]!;
      if (Number.isFinite(p) && p > 0) out[k] = p - Math.min(prm.offsetX12, prm.offsetShare * p);
    }
  }
  // A reading not taken on the calibrated map: alone, as read; in a group, the group's pitch on its own scale. Its
  // sloped area follows the pitch it reports (keeping the pitch before the offset is for the calibrated map's faces).
  faces.forEach((f, k) => {
    if (!own(f)) return;
    if (!grouped.has(k)) out[k] = f.pitchX12;
    pooled[k] = out[k]!;
  });
  return { pitchX12: out, areaPitchX12: prm.offsetArea ? out : pooled, groups };
}

/**
 * Where a set of readings holds two pitches a step apart (PitchParams.stepShare): the middle of the widest empty gap
 * between two readings such that the readings below it and those above it are each a pitch of their own (each holds a
 * pair of faces looking opposite ways that agree), their medians differ by stepShare of the lower one or more, and
 * the gap itself is stepGapShare of it or more. Null when there is none.
 */
function pitchStep(faces: readonly PitchFace[], read: readonly number[], members: readonly number[], prm: PitchParams): number | null {
  const sorted = [...members].sort((a, b) => read[a]! - read[b]! || a - b);
  // Whether the faces hold two looking opposite ways, of stepPairM2 or more each, whose readings agree.
  const anchored = (side: readonly number[]): boolean => {
    for (let a = 0; a < side.length; a++) {
      const fa = faces[side[a]!]!;
      if (fa.azimuthDeg === undefined || fa.areaM2 < prm.stepPairM2) continue;
      for (let b = a + 1; b < side.length; b++) {
        const fb = faces[side[b]!]!;
        if (fb.azimuthDeg === undefined || fb.areaM2 < prm.stepPairM2) continue;
        const turn = Math.abs(((fa.azimuthDeg - fb.azimuthDeg + 540) % 360) - 180);
        if (turn >= prm.stepOpposedDeg && Math.abs(read[side[a]!]! - read[side[b]!]!) <= prm.stepPairShare * Math.min(read[side[a]!]!, read[side[b]!]!)) return true;
      }
    }
    return false;
  };
  const median = (side: readonly number[]) => weightedMedian(side.map((k) => ({ v: read[k]!, w: faces[k]!.areaM2 })));
  let cut: number | null = null;
  let widest = 0;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const below = read[sorted[i]!]!;
    const gap = read[sorted[i + 1]!]! - below;
    if (!(gap > widest)) continue;
    const low = sorted.slice(0, i + 1);
    const high = sorted.slice(i + 1);
    const pitch = median(low);
    if (!(pitch > 0) || gap < prm.stepGapShare * pitch || median(high) - pitch < prm.stepShare * pitch) continue;
    if (!anchored(low) || !anchored(high)) continue;
    widest = gap;
    cut = below + gap / 2;
  }
  return cut;
}
