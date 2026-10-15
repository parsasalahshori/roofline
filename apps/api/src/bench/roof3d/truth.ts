import { z } from 'zod';
import type { Roof3d } from '@roofline/shared';
import { type MultiPoly, boundaryDistance, geoJsonToXY, iou, mean, overlapArea, ringToXY, roundHalfEven, zoneOfLngLat } from './geometry.ts';

/*
 * Scoring a reconstruction against an answer key. The key is an EagleView report (truth grade 'eagleview': faces with
 * pitch, sloped area and plan ring, the roof outline, the total sloped area and its line lengths) or, for a few houses,
 * an outline drawn by hand on a leaf-off orthophoto (truth grade 'visual': outline only, see docs/roof-3d/benchmark.md).
 * The metrics are the ones the earlier Python scorer (ev_score.py) printed, ported so the repository has no Python
 * dependency, plus the boundary distances. The two are cross-checked in docs/roof-3d/benchmark.md.
 */

export const LINE_KINDS = ['ridge', 'hip', 'valley', 'eave', 'rake'] as const;
export type ScoredLineKind = (typeof LINE_KINDS)[number];

const GeoJsonSchema = z.object({ type: z.string(), coordinates: z.unknown() });

export const EagleViewTruthSchema = z.object({
  report: z.string(),
  product: z.string().nullable().optional(),
  address: z.string(),
  faces: z.array(
    z.object({
      label: z.string().nullable().optional(),
      pitch_x12: z.number().nullable(),
      sloped_sqft: z.number().nullable(),
      facing: z.number().nullable().optional(),
      plan_sqft: z.number().nullable().optional(),
      ring: z.array(z.array(z.number()).min(2)).min(3),
    }),
  ),
  outline: GeoJsonSchema,
  total_sloped_sqft: z.number(),
  predominant_pitch: z.string().nullable().optional(),
  lines_ft: z.object({ ridge: z.number(), hip: z.number(), valley: z.number(), rake: z.number(), eave: z.number() }),
  structures: z.number(),
});
export type EagleViewTruth = z.infer<typeof EagleViewTruthSchema>;

/** A hand-drawn roof outline on a leaf-off photo: [lng, lat] ring and how far (metres) a good outline may be off. */
export const VisualTruthSchema = z.object({
  outline: z.array(z.array(z.number()).min(2)).min(3),
  toleranceM: z.number().positive(),
  source: z.string(),
  note: z.string().optional(),
});
export type VisualTruth = z.infer<typeof VisualTruthSchema>;

/** The pitch (whole x/12, half to even like the earlier scorer) carrying the most area; null when no area. */
export function dominantPitch(items: readonly { pitch: number; area: number }[]): number | null {
  const acc = new Map<number, number>();
  for (const { pitch, area } of items) {
    const k = roundHalfEven(pitch);
    acc.set(k, (acc.get(k) ?? 0) + area);
  }
  let best: number | null = null;
  let bestArea = -Infinity;
  // Map keeps insertion order: the first pitch met wins a tie, the way Python's max() over a dict does.
  for (const [k, a] of acc) {
    if (a > bestArea) {
      best = k;
      bestArea = a;
    }
  }
  return best;
}

/** A house's outline polygon in metres, from the reconstruction's [lng, lat] ring. */
export function outlineXY(roof: Roof3d): { zone: ReturnType<typeof zoneOfLngLat>; poly: MultiPoly } {
  const zone = zoneOfLngLat(roof.outline[0]![0], roof.outline[0]![1]);
  return { zone, poly: [[ringToXY(zone, roof.outline)]] };
}

export type TruthMetrics = {
  grade: 'eagleview' | 'visual';
  /** The same single building: IoU >= 0.5 and (EagleView) one structure measured. Only comparable houses are aggregated. */
  comparable: boolean;
  iou: number;
  meanBoundaryM: number;
  hd95M: number;
  /** Outline-only grades end here. */
  areaErrPct: number | null;
  slopedSqFt: number | null;
  truthSlopedSqFt: number | null;
  mainPitchOurs: number | null;
  mainPitchTruth: number | null;
  mainPitchErr: number | null;
  /** Area-weighted mean pitch error over EagleView faces of 100 sq ft or more, x/12; null when none matched. */
  facePitchMAE: number | null;
  /** Share (percent) of the matched EagleView area whose face pitch is within 1/12. */
  within1Pct: number | null;
  /** Share (percent) of the EagleView face area (>= 100 sq ft faces) that no face of ours covers well enough. */
  unmatchedPct: number | null;
  lines: Record<ScoredLineKind, [number, number]> | null;
  truthFaces: number | null;
  structures: number | null;
};

/** The EagleView faces of this size or more are matched to ours for the per-face pitch. */
export const MATCH_MIN_SQFT = 100;
/** An EagleView face is matched when one of our faces covers at least this share of it. */
export const MATCH_MIN_OVERLAP = 0.3;

export function eagleViewMetrics(roof: Roof3d, truth: EagleViewTruth): TruthMetrics {
  const { zone, poly: ours } = outlineXY(roof);
  const evOutline = geoJsonToXY(zone, truth.outline);
  const overlap = iou(ours, evOutline) ?? 0;
  const bd = boundaryDistance(ours, evOutline);
  const slopedSqFt = roof.faces.reduce((t, f) => t + f.slopedAreaSqFt, 0);
  const rounded = Math.round(slopedSqFt * 10) / 10;
  const areaErrPct = truth.total_sloped_sqft > 0 ? (100 * (rounded - truth.total_sloped_sqft)) / truth.total_sloped_sqft : null;

  const ourMain = dominantPitch(roof.faces.filter((f) => !f.flat).map((f) => ({ pitch: f.pitchX12, area: f.slopedAreaSqFt })));
  const evMain = dominantPitch(truth.faces.map((f) => ({ pitch: f.pitch_x12 ?? 0, area: f.sloped_sqft ?? 0 })));

  const ourFaces = roof.faces.map((f) => ({ f, poly: [[ringToXY(zone, f.ring)]] as MultiPoly }));
  let weightedErr = 0;
  let matchedArea = 0;
  let within1 = 0;
  let unmatched = 0;
  let allArea = 0;
  for (const ef of truth.faces) {
    const a = ef.sloped_sqft ?? 0;
    if (a < MATCH_MIN_SQFT) continue;
    allArea += a;
    const ep: MultiPoly = [[ringToXY(zone, ef.ring)]];
    const epArea = Math.abs(polyArea(ep));
    let best: (typeof ourFaces)[number] | null = null;
    let bestOverlap = 0;
    for (const o of ourFaces) {
      const ov = overlapArea(o.poly, ep);
      if (ov > bestOverlap) {
        best = o;
        bestOverlap = ov;
      }
    }
    if (best === null || bestOverlap < MATCH_MIN_OVERLAP * epArea) {
      unmatched += a;
      continue;
    }
    const e = Math.abs(best.f.pitchX12 - (ef.pitch_x12 ?? 0));
    weightedErr += e * a;
    matchedArea += a;
    if (e <= 1.0) within1 += a;
  }

  const byKind: Record<string, number> = {};
  for (const l of roof.lines) byKind[l.kind] = (byKind[l.kind] ?? 0) + l.lengthFt;
  const lines = Object.fromEntries(LINE_KINDS.map((k) => [k, [byKind[k] ?? 0, truth.lines_ft[k]]])) as Record<ScoredLineKind, [number, number]>;

  return {
    grade: 'eagleview',
    comparable: overlap >= 0.5 && truth.structures === 1,
    iou: overlap,
    meanBoundaryM: bd.mean,
    hd95M: bd.hd95,
    areaErrPct,
    slopedSqFt: rounded,
    truthSlopedSqFt: truth.total_sloped_sqft,
    mainPitchOurs: ourMain,
    mainPitchTruth: evMain,
    mainPitchErr: ourMain === null || evMain === null ? null : Math.abs(ourMain - evMain),
    facePitchMAE: matchedArea > 0 ? weightedErr / matchedArea : null,
    within1Pct: matchedArea > 0 ? (100 * within1) / matchedArea : null,
    unmatchedPct: allArea > 0 ? (100 * unmatched) / allArea : null,
    lines,
    truthFaces: truth.faces.length,
    structures: truth.structures,
  };
}

function polyArea(mp: MultiPoly): number {
  let t = 0;
  for (const poly of mp) {
    poly.forEach((r, k) => {
      let a = 0;
      for (let i = 0; i + 1 < r.length; i++) a += r[i]![0] * r[i + 1]![1] - r[i + 1]![0] * r[i]![1];
      t += (k === 0 ? 1 : -1) * Math.abs(a / 2);
    });
  }
  return t;
}

/** Outline-only scoring against a hand-drawn outline (truth grade 'visual'). */
export function visualMetrics(roof: Roof3d, truth: VisualTruth): TruthMetrics {
  const { zone, poly: ours } = outlineXY(roof);
  const theirs: MultiPoly = [[ringToXY(zone, truth.outline)]];
  const bd = boundaryDistance(ours, theirs);
  const overlap = iou(ours, theirs) ?? 0;
  return {
    grade: 'visual',
    comparable: overlap >= 0.5,
    iou: overlap,
    meanBoundaryM: bd.mean,
    hd95M: bd.hd95,
    areaErrPct: null,
    slopedSqFt: null,
    truthSlopedSqFt: null,
    mainPitchOurs: null,
    mainPitchTruth: null,
    mainPitchErr: null,
    facePitchMAE: null,
    within1Pct: null,
    unmatchedPct: null,
    lines: null,
    truthFaces: null,
    structures: null,
  };
}

/** Whether a house with truth has a review-worthy error: area off by more than 10 percent or main pitch by more than 1/12. */
export function isBad(t: TruthMetrics): boolean {
  return (t.areaErrPct !== null && Math.abs(t.areaErrPct) > 10) || (t.mainPitchErr !== null && t.mainPitchErr > 1);
}

export { mean };
