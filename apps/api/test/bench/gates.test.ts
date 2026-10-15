import { describe, expect, test } from 'vitest';
import type { CohortReport, Stat } from '../../src/bench/roof3d/aggregate.ts';
import { DEFAULT_GATES, GatesSchema, compareSplits, gatesFailed, formatGates } from '../../src/bench/roof3d/gates.ts';
import type { SplitReport } from '../../src/bench/roof3d/report.ts';

const st = (v: number): Stat => ({ mean: v, min: v, max: v });

type Knobs = { thin: number; iou: number; bnd: number; area: number; pass: number; slivers: number; steep: number; failed: number; noRoof: number; comparable: number; nondet: number; p95: number };
const BASE: Knobs = { thin: 2, iou: 0.8, bnd: 1.0, area: 4, pass: 20, slivers: 3, steep: 2, failed: 0, noRoof: 0, comparable: 12, nondet: 0, p95: 700 };

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
        medianAreaErrAbsPct: st(v.area),
        medianAreaErrSignedPct: st(1),
        areaWithin5: st(10),
        areaWithin10: st(11),
        areaScored: st(12),
        mainPitchExact: st(8),
        mainPitchWithin1: st(10),
        mainPitchScored: st(12),
        medianFacePitchMAE: st(0.7),
        medianWithin1Pct: st(85),
        lineErrPct: { ridge: none, hip: none, valley: none, eave: none, rake: none },
      },
      reasons: { 'coarse-imagery': st(0), 'outline-off': st(0), 'faces-patchy': st(0), 'rough-heights': st(0), trees: st(0), 'differs-from-google': st(0), 'joined-buildings': st(0), 'roof-hidden': st(0), 'low-attachment': st(0) },
      flags: { rate: st(0.5), precision: st(0.5), recall: st(0.5), tp: st(1), fp: st(1), fn: st(1), tn: st(1) },
      proxy: { medianMaskIoU: st(0.97), medianBoxIoU: st(0.97), medianGoogleAreaAbsPct: st(8), medianSegmentFaceRatio: st(1), medianOsmIoU: none, osmHouses: st(0) },
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
    expect(DEFAULT_GATES.runtimeP95.maxRatio).toBe(1.5);
    expect(() => GatesSchema.parse(DEFAULT_GATES)).not.toThrow();
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

  test('every cohort is judged on its own', () => {
    const base: SplitReport = { houses: 30, cohorts: { all: cohort(), 'canopy-heavy': cohort() } };
    const cur: SplitReport = { houses: 30, cohorts: { all: cohort(), 'canopy-heavy': cohort({ slivers: 5 }) } };
    const rows = compareSplits(base, cur, DEFAULT_GATES, { base: 1, cur: 1 });
    expect(gatesFailed(rows).map((r) => `${r.cohort}:${r.rule}`)).toEqual(['canopy-heavy:slivers']);
  });
});
