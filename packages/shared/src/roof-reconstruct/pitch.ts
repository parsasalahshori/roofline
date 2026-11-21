// The pitch each face reports (docs/roof-3d/pitch.md). A face's own plane is fitted on a photogrammetric height map
// that is rounded at ridges and eaves and bowed on shaded slopes: on real roofs a face of 300 sq ft reads within 0.5/12
// of the surveyed pitch three times in four, a face of 150 sq ft less than half the time. But a roof is built with one
// pitch, or two or three, and every face of one pitch is a reading of the same number. So the readings are pooled
// before anything is rounded: the pitch that holds the most roof is found first and every face within its tolerance
// reports it (the group's area-weighted median), then the next pitch among the faces left, and so on. A face that
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
};

/** A face as the pooling sees it: its own plane's pitch (x/12) and its plan area (square metres). */
export type PitchFace = { pitchX12: number; areaM2: number };
/** A pitch group: the pitch its faces report (before the calibration offset), their indices and plan area. */
export type PitchGroup = { pitchX12: number; faces: number[]; areaM2: number };

/** The area-weighted median: the value at which half the area lies at or below (ties by the order given). */
function weightedMedian(items: readonly { v: number; w: number }[]): number {
  const sorted = items.map((it, k) => ({ ...it, k })).sort((a, b) => a.v - b.v || a.k - b.k);
  let total = 0;
  for (const it of sorted) total += it.w;
  let run = 0;
  for (const it of sorted) {
    run += it.w;
    if (run >= total / 2) return it.v;
  }
  return sorted.length > 0 ? sorted[sorted.length - 1]!.v : 0;
}

/**
 * The pitch each face reports (x/12, same order as `faces`) and the groups found, largest first. Deterministic: ties
 * go to the earlier face.
 */
export function reportedPitches(faces: readonly PitchFace[], prm: PitchParams = DEFAULT_PITCH_PARAMS): { pitchX12: number[]; groups: PitchGroup[] } {
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
    const centre = (m: readonly number[]) => weightedMedian(m.map((k) => ({ v: faces[k]!.pitchX12, w: faces[k]!.areaM2 })));
    while (free.length >= prm.minFaces) {
      // The pitch (one of the faces' own) with the most roof within tolerance of it.
      let best: number[] = [];
      let bestArea = 0;
      for (const k of free) {
        const m = within(faces[k]!.pitchX12, free);
        const a = areaOf(m);
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
  if (prm.offsetX12 > 0) {
    for (let k = 0; k < out.length; k++) {
      const p = out[k]!;
      if (Number.isFinite(p) && p > 0) out[k] = p - Math.min(prm.offsetX12, prm.offsetShare * p);
    }
  }
  return { pitchX12: out, groups };
}
