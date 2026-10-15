import { ROOF_QUALITY_REASONS, type RoofQualityReason } from '@roofline/shared';
import { mean, median, percentile } from './geometry.ts';
import type { HouseMetrics } from './metrics.ts';
import { addEdges, type EdgeSet } from './lidar.ts';
import { LINE_KINDS } from './truth.ts';
import type { HouseRun } from './run.ts';

/*
 * Cohort numbers. For each seed the houses' metrics are summarised (CohortAgg: medians over houses, counts); the
 * report gives each number as the mean over the seeds with its range (Stat). Medians and rates over truth are taken
 * only on houses that are comparable (the same single building as the answer key).
 */

export type Stat = { mean: number; min: number; max: number };

export type FlagAgg = {
  /** Share of all houses the estimator marks for review. */
  rate: number | null;
  /** Over houses with a comparable answer key: flagged and bad / flagged, and flagged and bad / bad. */
  precision: number | null;
  recall: number | null;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
};

export type CohortAgg = {
  houses: number;
  /** Houses with an answer key (EagleView or hand-drawn) and those among them that are the same building. */
  withTruth: number;
  comparable: number;
  failures: number;
  noRoof: number;
  unusable: number;
  checkerPass: number;
  /** The checker with its circular outline target replaced by an independent one (metrics.ts outlineCheck). */
  checkerIndependentPass: number;
  outlineCheckOk: number;
  outlineChecked: number;
  faces: { median: number | null; total: number };
  slivers: number;
  thinFaces: number;
  steepJunk: number;
  steepAny: number;
  vertices: { median: number | null };
  rectilinearity: { median: number | null };
  truth: {
    medianIoU: number | null;
    medianBoundaryM: number | null;
    medianHd95M: number | null;
    /** The same after the best translation of the key (EagleView's frame offset removed); median shift in metres. */
    medianAlignedIoU: number | null;
    medianAlignedBoundaryM: number | null;
    medianAlignedHd95M: number | null;
    medianShiftM: number | null;
    medianAreaErrAbsPct: number | null;
    medianAreaErrSignedPct: number | null;
    areaWithin5: number;
    areaWithin10: number;
    areaScored: number;
    mainPitchExact: number;
    mainPitchWithin1: number;
    mainPitchScored: number;
    medianFacePitchMAE: number | null;
    medianFaceCountErrPct: number | null;
    medianWithin1Pct: number | null;
    /** Our line total against EagleView's over comparable EagleView houses, percent; null without EagleView houses. */
    lineErrPct: Record<(typeof LINE_KINDS)[number], number | null>;
  };
  /**
   * Against lidar truth (houses with accepted lidar truth that are the same building, IoU >= 0.5). Missing in
   * reports made before lidar truth existed (read them as undefined). Edge sets are pooled over the houses' samples.
   */
  lidar: LidarAgg;
  flags: FlagAgg;
  /** Houses carrying each review reason (a house can carry several). */
  reasons: Record<RoofQualityReason, number>;
  proxy: {
    medianMaskIoU: number | null;
    medianBoxIoU: number | null;
    medianGoogleAreaAbsPct: number | null;
    medianSegmentFaceRatio: number | null;
    medianOsmIoU: number | null;
    osmHouses: number;
  };
};

const nums = (xs: (number | null | undefined)[]): number[] => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
const med = (xs: (number | null | undefined)[]): number | null => {
  const v = nums(xs);
  return v.length === 0 ? null : median(v);
};
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Pooled edge samples: how many, their mean distance (metres) and the share within HIDDEN_WITHIN_M; houses that had any. */
export type EdgeAgg = { houses: number; samples: number; meanM: number | null; withinShare: number | null };

export type LidarAgg = {
  houses: number;
  comparable: number;
  medianIoU: number | null;
  medianBoundaryM: number | null;
  medianHd95M: number | null;
  medianAlignedIoU: number | null;
  medianAlignedBoundaryM: number | null;
  medianPlanErrAbsPct: number | null;
  medianSlopedErrAbsPct: number | null;
  medianSlopedErrSignedPct: number | null;
  mainPitchWithin1: number;
  mainPitchScored: number;
  /** Our outline's samples with eave support 'none' (the canopy-hidden stretches), against the lidar outline. */
  hidden: EdgeAgg;
  /** Our outline's supported samples, against the lidar outline (the contrast). */
  visible: EdgeAgg;
  /** The lidar outline's samples Google's heights cannot vouch for, against our outline (a fixed set of stretches). */
  truthHidden: EdgeAgg;
  /** Houses whose lidar scoring or eave support failed. */
  errors: number;
};

function edgeAgg(sets: readonly EdgeSet[]): EdgeAgg {
  const t = sets.reduce(addEdges, { samples: 0, sumM: 0, within: 0 });
  return { houses: sets.filter((s) => s.samples > 0).length, samples: t.samples, meanM: t.samples > 0 ? t.sumM / t.samples : null, withinShare: t.samples > 0 ? t.within / t.samples : null };
}

export function lidarAgg(ms: readonly HouseMetrics[]): LidarAgg {
  const withL = ms.filter((m) => m.lidar !== undefined && m.lidar !== null);
  const comp = withL.filter((m) => m.lidar!.comparable).map((m) => m.lidar!);
  const sloped = comp.map((l) => l.slopedErrPct).filter((x): x is number => x !== null);
  const pitch = comp.map((l) => l.mainPitchErr).filter((x): x is number => x !== null);
  return {
    houses: withL.length,
    comparable: comp.length,
    medianIoU: med(comp.map((l) => l.iou)),
    medianBoundaryM: med(comp.map((l) => l.meanBoundaryM)),
    medianHd95M: med(comp.map((l) => l.hd95M)),
    medianAlignedIoU: med(comp.map((l) => l.aligned.iou)),
    medianAlignedBoundaryM: med(comp.map((l) => l.aligned.meanBoundaryM)),
    medianPlanErrAbsPct: med(comp.map((l) => (l.planErrPct === null ? null : Math.abs(l.planErrPct)))),
    medianSlopedErrAbsPct: sloped.length === 0 ? null : median(sloped.map(Math.abs)),
    medianSlopedErrSignedPct: sloped.length === 0 ? null : median(sloped),
    mainPitchWithin1: pitch.filter((p) => p <= 1).length,
    mainPitchScored: pitch.length,
    hidden: edgeAgg(comp.map((l) => l.hidden)),
    visible: edgeAgg(comp.map((l) => l.visible)),
    truthHidden: edgeAgg(comp.map((l) => l.truthHidden)),
    errors: ms.filter((m) => (m.lidarError ?? null) !== null || (m.lidar?.edgeError ?? null) !== null).length,
  };
}


/** One seed's summary of a set of houses. */
export function aggregateSeed(ms: readonly HouseMetrics[]): CohortAgg {
  const ok = ms.filter((m) => m.status === 'ok');
  const truthed = ms.filter((m) => m.truth !== null);
  const comp = ms.filter((m) => m.truth !== null && m.truth.comparable);
  const ev = comp.filter((m) => m.truth!.grade === 'eagleview');
  const lineErr = Object.fromEntries(
    LINE_KINDS.map((k) => {
      const ours = ev.reduce((t, m) => t + (m.truth!.lines?.[k][0] ?? 0), 0);
      const theirs = ev.reduce((t, m) => t + (m.truth!.lines?.[k][1] ?? 0), 0);
      return [k, theirs > 0 ? (100 * (ours - theirs)) / theirs : null];
    }),
  ) as Record<(typeof LINE_KINDS)[number], number | null>;
  const area = comp.filter((m) => m.truth!.areaErrPct !== null).map((m) => m.truth!.areaErrPct!);
  const pitch = comp.filter((m) => m.truth!.mainPitchErr !== null).map((m) => m.truth!.mainPitchErr!);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  // Only EagleView keys have an area and pitch to be wrong about; a hand-drawn outline has neither.
  for (const m of ev) {
    if (m.bad === null) continue;
    if (m.flagged && m.bad) tp++;
    else if (m.flagged) fp++;
    else if (m.bad) fn++;
    else tn++;
  }
  return {
    houses: ms.length,
    withTruth: truthed.length,
    comparable: comp.length,
    failures: ms.filter((m) => m.status === 'failed').length,
    noRoof: ms.filter((m) => m.status === 'no-roof').length,
    unusable: ok.filter((m) => m.unusable).length,
    checkerPass: ok.filter((m) => m.checkerPassed).length,
    checkerIndependentPass: ok.filter((m) => m.checkerIndependentPassed === true).length,
    outlineCheckOk: ok.filter((m) => m.outlineCheck?.ok === true).length,
    outlineChecked: ok.filter((m) => m.outlineCheck?.ok != null).length,
    faces: { median: med(ok.map((m) => m.faces)), total: ok.reduce((t, m) => t + m.faces, 0) },
    slivers: ok.reduce((t, m) => t + m.slivers, 0),
    thinFaces: ok.reduce((t, m) => t + m.thinFaces, 0),
    steepJunk: ok.reduce((t, m) => t + m.steepJunk, 0),
    steepAny: ok.reduce((t, m) => t + m.steepAny, 0),
    vertices: { median: med(ok.map((m) => m.vertices)) },
    rectilinearity: { median: med(ok.map((m) => m.rectilinearity)) },
    truth: {
      medianIoU: med(comp.map((m) => m.truth!.iou)),
      medianBoundaryM: med(comp.map((m) => m.truth!.meanBoundaryM)),
      medianHd95M: med(comp.map((m) => m.truth!.hd95M)),
      medianAlignedIoU: med(comp.map((m) => m.truth!.aligned?.iou)),
      medianAlignedBoundaryM: med(comp.map((m) => m.truth!.aligned?.meanBoundaryM)),
      medianAlignedHd95M: med(comp.map((m) => m.truth!.aligned?.hd95M)),
      medianShiftM: med(comp.map((m) => (m.truth!.aligned ? Math.hypot(m.truth!.aligned.shiftM[0], m.truth!.aligned.shiftM[1]) : null))),
      medianAreaErrAbsPct: area.length === 0 ? null : median(area.map(Math.abs)),
      medianAreaErrSignedPct: area.length === 0 ? null : median(area),
      areaWithin5: area.filter((a) => Math.abs(a) <= 5).length,
      areaWithin10: area.filter((a) => Math.abs(a) <= 10).length,
      areaScored: area.length,
      mainPitchExact: pitch.filter((p) => p === 0).length,
      mainPitchWithin1: pitch.filter((p) => p <= 1).length,
      mainPitchScored: pitch.length,
      medianFacePitchMAE: med(comp.map((m) => m.truth!.facePitchMAE)),
      // Face count against EagleView's, |ours - theirs| / theirs, percent: a junk-face measure that is not any cleanup
      // rule's own threshold (the thin-face count is the weak-face cleanup's width limit, so it moves by construction).
      medianFaceCountErrPct: med(comp.map((m) => (m.truth!.truthFaces !== null && m.truth!.truthFaces > 0 ? (100 * Math.abs(m.faces - m.truth!.truthFaces)) / m.truth!.truthFaces : null))),
      medianWithin1Pct: med(comp.map((m) => m.truth!.within1Pct)),
      lineErrPct: lineErr,
    },
    lidar: lidarAgg(ms),
    flags: {
      rate: ratio(ms.filter((m) => m.flagged).length, ok.length),
      precision: ratio(tp, tp + fp),
      recall: ratio(tp, tp + fn),
      tp,
      fp,
      fn,
      tn,
    },
    reasons: Object.fromEntries(ROOF_QUALITY_REASONS.map((r) => [r, ok.filter((m) => m.reasons.includes(r)).length])) as Record<RoofQualityReason, number>,
    proxy: {
      medianMaskIoU: med(ok.map((m) => m.proxy.maskIoU)),
      medianBoxIoU: med(ok.map((m) => m.proxy.boxIoU)),
      medianGoogleAreaAbsPct: med(ok.map((m) => (m.proxy.googleAreaPct === null ? null : Math.abs(m.proxy.googleAreaPct)))),
      medianSegmentFaceRatio: med(ok.map((m) => m.proxy.segmentFaceRatio)),
      medianOsmIoU: med(ok.map((m) => m.proxy.osmIoU)),
      osmHouses: nums(ok.map((m) => m.proxy.osmIoU)).length,
    },
  };
}

/** Every number of a CohortAgg as mean/min/max over seeds. */
export type Stats<T> = { [K in keyof T]: T[K] extends number | null ? Stat | null : T[K] extends object ? Stats<T[K]> : T[K] };

function stat(values: (number | null)[]): Stat | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  if (v.length === 0) return null;
  return { mean: mean(v), min: Math.min(...v), max: Math.max(...v) };
}

function combine(items: unknown[]): unknown {
  const first = items[0];
  if (first === null || typeof first === 'number') return stat(items as (number | null)[]);
  if (typeof first === 'object' && first !== undefined) {
    return Object.fromEntries(Object.keys(first as object).map((k) => [k, combine(items.map((i) => (i as Record<string, unknown>)[k]))]));
  }
  return first;
}

export function combineSeeds(aggs: readonly CohortAgg[]): Stats<CohortAgg> {
  return combine([...aggs]) as Stats<CohortAgg>;
}

export type CohortReport = {
  n: number;
  stats: Stats<CohortAgg>;
  runtime: { p50Ms: number; p95Ms: number };
  nondeterministic: number;
  seedSensitive: number;
};

/** The report of one cohort: per-seed aggregates combined, runtimes (per-house median over its runs), determinism. */
export function cohortReport(runs: readonly HouseRun[], seedCount: number): CohortReport {
  const perSeed: CohortAgg[] = [];
  for (let s = 0; s < seedCount; s++) perSeed.push(aggregateSeed(runs.map((r) => r.seeds[s]!)));
  const times = runs.map((r) => median(r.runtimesMs));
  return {
    n: runs.length,
    stats: combineSeeds(perSeed),
    runtime: { p50Ms: runs.length ? percentile(times, 0.5) : Number.NaN, p95Ms: runs.length ? percentile(times, 0.95) : Number.NaN },
    nondeterministic: runs.filter((r) => !r.deterministic).length,
    seedSensitive: runs.filter((r) => !r.seedStable).length,
  };
}
