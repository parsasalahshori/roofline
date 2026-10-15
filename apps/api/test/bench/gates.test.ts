import { describe, expect, test } from 'vitest';
import type { CohortReport, Stat } from '../../src/bench/roof3d/aggregate.ts';
import { DEFAULT_GATES, GatesSchema, compareSplitGap, compareSplits, gatesFailed, formatGates } from '../../src/bench/roof3d/gates.ts';
import type { SplitReport } from '../../src/bench/roof3d/report.ts';

const st = (v: number): Stat => ({ mean: v, min: v, max: v });

type Knobs = { lidarHouses: number; lidarIoU: number; lidarBnd: number; lidarArea: number; hiddenSamples: number; hiddenMean: number; hiddenWithin: number; truthHiddenMean: number; truthHiddenWithin: number; recall: number; aligned: number; thin: number; iou: number; bnd: number; area: number; pass: number; slivers: number; steep: number; failed: number; noRoof: number; comparable: number; nondet: number; p95: number };
const BASE: Knobs = { lidarHouses: 10, lidarIoU: 0.88, lidarBnd: 0.4, lidarArea: 5, hiddenSamples: 400, hiddenMean: 0.6, hiddenWithin: 0.55, truthHiddenMean: 0.7, truthHiddenWithin: 0.5, recall: 0.5, aligned: 0.9, thin: 2, iou: 0.8, bnd: 1.0, area: 4, pass: 20, slivers: 3, steep: 2, failed: 0, noRoof: 0, comparable: 12, nondet: 0, p95: 700 };

function cohort(k: Partial<Knobs> = {}): CohortReport {
  const v = { ...BASE, ...k };
  const none = null;
  return {
    n: 30,
    runtime: { p50Ms: 200, p95Ms: v.p95 },
    nondeterministic: v.nondet,
    seedSensitive: 0,
    stats: {
      houses: st(30),
      withTruth: st(v.comparable),
      comparable: st(v.comparable),
      failures: st(v.failed),
      noRoof: st(v.noRoof),
      unusable: st(0),
      checkerPass: st(v.pass),
      checkerIndependentPass: st(v.pass),
      outlineCheckOk: st(30),
      outlineChecked: st(30),
      faces: { median: st(10), total: st(300) },
      slivers: st(v.slivers),
      thinFaces: st(v.thin),
      steepJunk: st(v.steep),
      steepAny: st(v.steep),
      vertices: { median: st(12) },
      rectilinearity: { median: st(0.9) },
      truth: {
        medianIoU: st(v.iou),
        medianBoundaryM: st(v.bnd),
        medianHd95M: st(2),
        medianAlignedIoU: st(v.aligned),
        medianAlignedBoundaryM: st(0.5),
        medianAlignedHd95M: st(1.5),
        medianShiftM: st(1.4),
        medianAreaErrAbsPct: st(v.area),
        medianAreaErrSignedPct: st(1),
        areaWithin5: st(10),
        areaWithin10: st(11),
        areaScored: st(12),
        mainPitchExact: st(8),
        mainPitchWithin1: st(10),
        mainPitchScored: st(12),
        medianFacePitchMAE: st(0.7),
        medianFaceCountErrPct: st(20),
        medianWithin1Pct: st(85),
        lineErrPct: { ridge: none, hip: none, valley: none, eave: none, rake: none },
      },
      reasons: { 'coarse-imagery': st(0), 'outline-off': st(0), 'faces-patchy': st(0), 'rough-heights': st(0), trees: st(0), 'differs-from-google': st(0), 'joined-buildings': st(0), 'roof-hidden': st(0), 'low-attachment': st(0), 'edges-unverified': st(0), 'roof-inferred': st(0), 'roof-from-lidar': st(0), 'lidar-past-building': st(0) },
      flags: { rate: st(0.5), precision: st(0.5), recall: st(v.recall), tp: st(1), fp: st(1), fn: st(1), tn: st(1) },
      proxy: { medianMaskIoU: st(0.97), medianBoxIoU: st(0.97), medianGoogleAreaAbsPct: st(8), medianSegmentFaceRatio: st(1), medianOsmIoU: none, osmHouses: st(0) },
      lidar: {
        houses: st(v.lidarHouses),
        comparable: st(v.lidarHouses),
        medianIoU: st(v.lidarIoU),
        medianBoundaryM: st(v.lidarBnd),
        medianHd95M: st(1.2),
        medianAlignedIoU: st(0.92),
        medianAlignedBoundaryM: st(0.35),
        medianPlanErrAbsPct: st(4),
        medianSlopedErrAbsPct: st(v.lidarArea),
        medianSlopedErrSignedPct: st(-2),
        mainPitchWithin1: st(8),
        mainPitchScored: st(10),
        hidden: { houses: st(8), samples: st(v.hiddenSamples), meanM: st(v.hiddenMean), withinShare: st(v.hiddenWithin) },
        visible: { houses: st(10), samples: st(2000), meanM: st(0.3), withinShare: st(0.85) },
        truthHidden: { houses: st(8), samples: st(v.hiddenSamples), meanM: st(v.truthHiddenMean), withinShare: st(v.truthHiddenWithin) },
        errors: st(0),
      },
    },
  };
}

const split = (c: CohortReport): SplitReport => ({ houses: 30, cohorts: { all: c } });
const run = (cur: Partial<Knobs>, base: Partial<Knobs> = {}, calib = { base: 100, cur: 100 }) => compareSplits(split(cohort(base)), split(cohort(cur)), DEFAULT_GATES, calib);
const failedRules = (rows: ReturnType<typeof run>) => gatesFailed(rows).map((r) => r.rule);

describe('the gates are the contract', () => {
  test('the default limits are the ones the owner set', () => {
    expect(DEFAULT_GATES.medianOutlineIoU.maxDrop).toBe(0.005);
    expect(DEFAULT_GATES.medianBoundaryDistM.maxRise).toBe(0.05);
    expect(DEFAULT_GATES.medianAreaErrPct.maxRisePoints).toBe(0.5);
    expect(DEFAULT_GATES.checkerPass.maxDrop).toBe(0);
    expect(DEFAULT_GATES.slivers.maxRise).toBe(0);
    expect(DEFAULT_GATES.steepJunk.maxRise).toBe(0);
    expect(DEFAULT_GATES.determinism.mustHold).toBe(true);
    expect(DEFAULT_GATES.seedNoise).toBe('baseline-range');
    expect(DEFAULT_GATES.runtimeP95.maxRatio).toBe(1.5);
    expect(() => GatesSchema.parse(DEFAULT_GATES)).not.toThrow();
  });

  test('review-flag recall and aligned outline IoU are gated (a bad roof that loses its flag fails)', () => {
    expect(failedRules(run({ recall: 0.4 }))).toEqual(['review flag recall']);
    expect(failedRules(run({ recall: 0.6 }))).toEqual([]);
    expect(failedRules(run({ aligned: 0.894 }))).toEqual(['median aligned outline IoU']);
    expect(failedRules(run({ aligned: 0.896 }))).toEqual([]);
    // An older gates file without these rules still parses and does not gate them.
    const old = { ...DEFAULT_GATES } as Record<string, unknown>;
    delete old.flagRecall;
    delete old.medianAlignedIoU;
    delete old.splitGap;
    const parsed = GatesSchema.parse(old);
    expect(gatesFailed(compareSplits(split(cohort()), split(cohort({ recall: 0 })), parsed, { base: 1, cur: 1 }))).toEqual([]);
  });

  test('held-out vs dev: a change that helps dev and hurts held-out fails', () => {
    const both = (dev: Partial<Knobs>, held: Partial<Knobs>) => compareSplitGap({ dev: split(cohort()), heldout: split(cohort()) }, { dev: split(cohort(dev)), heldout: split(cohort(held)) }, DEFAULT_GATES);
    // Both a point better: fine. Dev 0.5 better, held-out 0.5 worse: one point apart, fails.
    expect(gatesFailed(both({ area: 3 }, { area: 3 }))).toEqual([]);
    expect(gatesFailed(both({ area: 3.5 }, { area: 4.5 })).map((r) => r.rule)).toEqual(['held-out vs dev: change in median |area error| pts']);
    expect(gatesFailed(both({ area: 4 }, { area: 4.5 }))).toEqual([]);
    expect(gatesFailed(both({ iou: 0.81 }, { iou: 0.8 })).map((r) => r.rule)).toEqual(['held-out vs dev: change in median outline IoU']);
    // Dev only (no held-out split): nothing to compare.
    expect(compareSplitGap({ dev: split(cohort()) }, { dev: split(cohort()) }, DEFAULT_GATES)).toEqual([]);
  });

  test('an unchanged result passes everything', () => {
    expect(failedRules(run({}))).toEqual([]);
  });

  test('median outline IoU: 0.005 lower passes, more fails; higher always passes', () => {
    expect(failedRules(run({ iou: 0.795 }))).toEqual([]);
    expect(failedRules(run({ iou: 0.7949 }))).toEqual(['median outline IoU']);
    expect(failedRules(run({ iou: 0.9 }))).toEqual([]);
  });

  test('median boundary distance: 0.05 m higher passes, more fails', () => {
    expect(failedRules(run({ bnd: 1.05 }))).toEqual([]);
    expect(failedRules(run({ bnd: 1.0501 }))).toEqual(['median boundary distance m']);
    expect(failedRules(run({ bnd: 0.5 }))).toEqual([]);
  });

  test('median area error: half a point higher passes, more fails', () => {
    expect(failedRules(run({ area: 4.5 }))).toEqual([]);
    expect(failedRules(run({ area: 4.51 }))).toEqual(['median |area error| pts']);
  });

  test('houses passing every target may not fall; slivers and steep junk may not rise', () => {
    expect(failedRules(run({ pass: 19 }))).toEqual(['houses passing all targets']);
    expect(failedRules(run({ pass: 21 }))).toEqual([]);
    expect(failedRules(run({ slivers: 4 }))).toEqual(['slivers']);
    expect(failedRules(run({ slivers: 1 }))).toEqual([]);
    expect(failedRules(run({ steep: 3 }))).toEqual(['steep junk faces']);
  });

  test('thin faces may not rise in the cohorts that name them, and are not gated elsewhere', () => {
    const gated = (name: string, thin: number) => compareSplits({ houses: 5, cohorts: { [name]: cohort() } }, { houses: 5, cohorts: { [name]: cohort({ thin }) } }, DEFAULT_GATES, { base: 1, cur: 1 });
    expect(gatesFailed(gated('canopy-heavy', 3)).map((r) => r.rule)).toEqual(['thin faces (simple and canopy cohorts)']);
    expect(gatesFailed(gated('simple', 3)).length).toBe(1);
    expect(gatesFailed(gated('canopy-heavy', 1))).toEqual([]);
    expect(gatesFailed(gated('complex', 30))).toEqual([]);
    expect(gatesFailed(gated('all', 30))).toEqual([]);
  });

  test('a house that no longer reconstructs fails, by throwing or by finding no roof', () => {
    expect(failedRules(run({ failed: 1 }))).toEqual(['failed or no-roof houses']);
    expect(failedRules(run({ noRoof: 1 }))).toEqual(['failed or no-roof houses']);
    expect(failedRules(run({ noRoof: 1 }, { noRoof: 1 }))).toEqual([]);
  });

  test('determinism must hold absolutely, whatever the baseline said', () => {
    expect(failedRules(run({ nondet: 1 }))).toEqual(['determinism (houses not byte-identical)']);
    expect(failedRules(run({ nondet: 1 }, { nondet: 1 }))).toEqual(['determinism (houses not byte-identical)']);
  });

  test('runtime p95 may be 1.5x the baseline, after the machine calibration', () => {
    expect(failedRules(run({ p95: 1050 }))).toEqual([]);
    expect(failedRules(run({ p95: 1051 }))).toEqual(['runtime p95 (x calibration)']);
    // The same wall time on a machine twice as slow (calibration 200 ms against 100) is half the work: fine.
    expect(failedRules(run({ p95: 1400 }, {}, { base: 100, cur: 200 }))).toEqual([]);
    // A faster machine does not hide a slowdown.
    expect(failedRules(run({ p95: 700 }, {}, { base: 100, cur: 50 }))).toEqual(['runtime p95 (x calibration)']);
  });

  test('truth gates are skipped, and said so, when a cohort has too few houses with an answer key', () => {
    const rows = run({ iou: 0.1, comparable: 2 }, { comparable: 2 });
    expect(gatesFailed(rows)).toEqual([]);
    const skipped = rows.filter((r) => r.status === 'skip').map((r) => r.rule);
    expect(skipped).toEqual(expect.arrayContaining(['median outline IoU', 'median boundary distance m', 'median |area error| pts']));
    expect(formatGates('dev', rows)).toMatch(/skipped .*answer key/);
  });

  test('a cohort missing from the baseline is reported, not passed', () => {
    const cur: SplitReport = { houses: 30, cohorts: { all: cohort(), 'canopy-heavy': cohort() } };
    const rows = compareSplits(split(cohort()), cur, DEFAULT_GATES, { base: 1, cur: 1 });
    expect(rows.find((r) => r.cohort === 'canopy-heavy')?.status).toBe('skip');
  });

  test('a cohort under minCohortHouses is reported, not gated; determinism and failures still are', () => {
    const tiny = (k: Partial<Knobs>): CohortReport => ({ ...cohort(k), n: 4 });
    const rows = compareSplits({ houses: 4, cohorts: { 'state-TX': tiny({}) } }, { houses: 4, cohorts: { 'state-TX': tiny({ pass: 1, iou: 0.1, nondet: 1, failed: 1 }) } }, DEFAULT_GATES, { base: 1, cur: 1 });
    expect(gatesFailed(rows).map((r) => r.rule).sort()).toEqual(['determinism (houses not byte-identical)', 'failed or no-roof houses']);
    expect(rows.filter((r) => r.status === 'skip').length).toBeGreaterThan(5);
  });

  test('continuous gates also give the baseline its seed range when that is wider than the limit', () => {
    const wide = (iou: number, min: number, max: number): CohortReport => {
      const c = cohort();
      return { ...c, stats: { ...c.stats, truth: { ...c.stats.truth, medianIoU: { mean: iou, min, max } } } };
    };
    const judge = (base: CohortReport, cur: CohortReport) => gatesFailed(compareSplits({ houses: 30, cohorts: { all: base } }, { houses: 30, cohorts: { all: cur } }, DEFAULT_GATES, { base: 1, cur: 1 })).map((r) => r.rule);
    // No spread: the contract's 0.005. A spread of 0.04: that much.
    expect(judge(wide(0.8, 0.8, 0.8), wide(0.794, 0.794, 0.794))).toEqual(['median outline IoU']);
    expect(judge(wide(0.75, 0.74, 0.78), wide(0.71, 0.71, 0.71))).toEqual([]);
    expect(judge(wide(0.75, 0.74, 0.78), wide(0.70, 0.70, 0.70))).toEqual(['median outline IoU']);
  });

  test('count gates allow the baseline\'s own seed range, and strict mode does not', () => {
    const noisy = (mean: number, min: number, max: number): CohortReport => {
      const c = cohort();
      return { ...c, stats: { ...c.stats, checkerPass: { mean, min, max }, thinFaces: { mean, min, max } } };
    };
    const judge = (base: CohortReport, cur: CohortReport, seedNoise: 'baseline-range' | 'none') =>
      gatesFailed(compareSplits({ houses: 30, cohorts: { simple: base } }, { houses: 30, cohorts: { simple: cur } }, { ...DEFAULT_GATES, seedNoise }, { base: 1, cur: 1 })).map((r) => r.rule);
    // The baseline's passes ranged 33 to 35 over seeds (range 2): a mean of 31.7 is within it, 31.6 is not.
    expect(judge(noisy(34, 33, 35), noisy(32, 31, 33), 'baseline-range')).toEqual([]);
    expect(judge(noisy(34, 33, 35), noisy(31.9, 31, 33), 'baseline-range')).toEqual(['houses passing all targets']);
    expect(judge(noisy(34, 33, 35), noisy(33.9, 33, 35), 'none')).toEqual(['houses passing all targets']);
    // Thin faces rise by the range too.
    expect(judge(noisy(34, 33, 35), noisy(36.2, 35, 37), 'baseline-range')).toEqual(['thin faces (simple and canopy cohorts)']);
    expect(judge(noisy(34, 33, 35), noisy(36, 35, 37), 'baseline-range')).toEqual([]);
    // No spread, no allowance: a baseline of 0 slivers at every seed is strict.
    expect(failedRules(run({ slivers: 4 }))).toEqual(['slivers']);
  });

  test('every cohort is judged on its own', () => {
    const base: SplitReport = { houses: 30, cohorts: { all: cohort(), 'canopy-heavy': cohort() } };
    const cur: SplitReport = { houses: 30, cohorts: { all: cohort(), 'canopy-heavy': cohort({ slivers: 5 }) } };
    const rows = compareSplits(base, cur, DEFAULT_GATES, { base: 1, cur: 1 });
    expect(gatesFailed(rows).map((r) => `${r.cohort}:${r.rule}`)).toEqual(['canopy-heavy:slivers']);
  });
});

describe('lidar truth gates (hidden edges under canopy)', () => {
  test('a fall in the share of hidden-edge samples within 0.5 m fails; within the limit passes', () => {
    expect(failedRules(run({ hiddenWithin: 0.52 }))).toEqual(['lidar: hidden edges within 0.5 m (share)']);
    expect(failedRules(run({ hiddenWithin: 0.54 }))).toEqual([]);
    expect(failedRules(run({ hiddenMean: 0.7 }))).toEqual(['lidar: hidden edges mean distance m']);
    expect(failedRules(run({ truthHiddenWithin: 0.4, truthHiddenMean: 0.9 }))).toEqual(['lidar: truth-hidden edges within 0.5 m (share)', 'lidar: truth-hidden edges mean distance m']);
    expect(failedRules(run({ lidarIoU: 0.87, lidarBnd: 0.5, lidarArea: 6 }))).toEqual(['lidar: median outline IoU', 'lidar: median boundary distance m', 'lidar: median |sloped area error| pts']);
  });

  test('too few lidar houses or edge samples skip the gates and say why', () => {
    const few = run({ lidarHouses: 2, hiddenWithin: 0.1 });
    expect(gatesFailed(few)).toEqual([]);
    expect(few.filter((r) => r.rule.startsWith('lidar:')).every((r) => r.status === 'skip' && r.note === 'fewer than 3 houses with lidar truth')).toBe(true);
    const thin = run({ hiddenSamples: 20, hiddenWithin: 0.1 });
    expect(gatesFailed(thin)).toEqual([]);
    expect(thin.find((r) => r.rule === 'lidar: hidden edges within 0.5 m (share)')?.note).toBe('fewer than 50 edge samples');
  });

  test('gates files without the lidar section still parse and do not gate lidar', () => {
    const old: Record<string, unknown> = { ...DEFAULT_GATES };
    delete old.lidar;
    const parsed = GatesSchema.parse(old);
    expect(parsed.lidar).toBeUndefined();
    const rows = compareSplits(split(cohort()), split(cohort({ hiddenWithin: 0.1 })), parsed, { base: 1, cur: 1 });
    expect(rows.some((r) => r.rule.startsWith('lidar:'))).toBe(false);
  });

  test('a baseline made before lidar truth (no lidar block) skips the lidar gates instead of crashing', () => {
    const b = cohort();
    const stats: Record<string, unknown> = { ...b.stats };
    delete stats.lidar;
    const old = { ...b, stats: stats as typeof b.stats };
    const rows = compareSplits(split(old), split(cohort()), DEFAULT_GATES, { base: 1, cur: 1 });
    expect(gatesFailed(rows)).toEqual([]);
    expect(rows.filter((r) => r.rule.startsWith('lidar:')).every((r) => r.status === 'skip')).toBe(true);
  });
});
