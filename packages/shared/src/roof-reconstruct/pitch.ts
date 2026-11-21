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
  fittedVote: false,
  stackChord: true,
};

/**
 * A face as the pooling sees it: its reading of the pitch (x/12: its own plane's) and its plan area (square metres).
 * `fitted`: the plane is a copy of another face's (a mirrored gable slope), not a reading (PitchParams.fittedVote).
 */
export type PitchFace = { pitchX12: number; areaM2: number; fitted?: boolean };
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
  const out = faces.map((f) => f.pitchX12);
  const groups: PitchGroup[] = [];
  if (prm.pool) {
    const usable = (f: PitchFace) => Number.isFinite(f.pitchX12) && f.areaM2 > 0 && f.pitchX12 >= prm.minPitchX12;
    let free = faces.map((_, k) => k).filter((k) => usable(faces[k]!));
    let total = 0;
    for (const k of free) total += faces[k]!.areaM2;
    /** How far face k's own reading may be from a group's pitch c and still be a reading of it. */
    const tol = (c: number, k: number) => Math.min(prm.tolX12 * Math.min(prm.smallTolX, Math.max(1, Math.sqrt(prm.refM2 / faces[k]!.areaM2))), prm.capShare * c);
    const within = (c: number, among: readonly number[]) => among.filter((k) => Math.abs(faces[k]!.pitchX12 - c) <= tol(c, k));
    const areaOf = (m: readonly number[]) => m.reduce((t, k) => t + faces[k]!.areaM2, 0);
    // A face that is a reading: every face, but a fitted one when fittedVote is off.
    const reads = (k: number) => prm.fittedVote || faces[k]!.fitted !== true;
    const readArea = (m: readonly number[]) => m.reduce((t, k) => t + (reads(k) ? faces[k]!.areaM2 : 0), 0);
    // A group's pitch: the median of its readings (of all its faces when none of them is a reading).
    const centre = (m: readonly number[]) => {
      const own = m.filter(reads);
      return weightedMedian((own.length > 0 ? own : m).map((k) => ({ v: faces[k]!.pitchX12, w: faces[k]!.areaM2 })));
    };
    while (free.length >= prm.minFaces) {
      // The pitch (one of the readings) with the most roof read within tolerance of it. With no reading left, as before.
      const anyReads = free.some(reads);
      let best: number[] = [];
      let bestArea = 0;
      for (const k of free) {
        if (anyReads && !reads(k)) continue;
        const m = within(faces[k]!.pitchX12, free);
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
      const area = areaOf(best);
      if (best.length < prm.minFaces || area < prm.minShare * total) break;
      const c = centre(best);
      for (const k of best) out[k] = c;
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
  return { pitchX12: out, areaPitchX12: prm.offsetArea ? out : pooled, groups };
}
