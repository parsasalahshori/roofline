import { ROOF_QUALITY_REASONS, type RoofQualityReason } from '@roofline/shared';
import { mean, median, percentile } from './geometry.ts';
import type { HouseMetrics } from './metrics.ts';
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
    medianAreaErrAbsPct: number | null;
    medianAreaErrSignedPct: number | null;
    areaWithin5: number;
    areaWithin10: number;
    areaScored: number;
    mainPitchExact: number;
    mainPitchWithin1: number;
    mainPitchScored: number;
    medianFacePitchMAE: number | null;
    medianWithin1Pct: number | null;
    /** Our line total against EagleView's over comparable EagleView houses, percent; null without EagleView houses. */
    lineErrPct: Record<(typeof LINE_KINDS)[number], number | null>;
  };
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
      medianAreaErrAbsPct: area.length === 0 ? null : median(area.map(Math.abs)),
      medianAreaErrSignedPct: area.length === 0 ? null : median(area),
      areaWithin5: area.filter((a) => Math.abs(a) <= 5).length,
      areaWithin10: area.filter((a) => Math.abs(a) <= 10).length,
      areaScored: area.length,
      mainPitchExact: pitch.filter((p) => p === 0).length,
      mainPitchWithin1: pitch.filter((p) => p <= 1).length,
      mainPitchScored: pitch.length,
      medianFacePitchMAE: med(comp.map((m) => m.truth!.facePitchMAE)),
      medianWithin1Pct: med(comp.map((m) => m.truth!.within1Pct)),
      lineErrPct: lineErr,
    },
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
