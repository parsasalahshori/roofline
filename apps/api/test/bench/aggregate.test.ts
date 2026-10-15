import { describe, expect, test } from 'vitest';
import { aggregateSeed, cohortReport, combineSeeds } from '../../src/bench/roof3d/aggregate.ts';
import { EMPTY_PROXY, type HouseMetrics, emptyMetrics } from '../../src/bench/roof3d/metrics.ts';
import { type HouseRun, materiallyDiffers } from '../../src/bench/roof3d/run.ts';
import type { TruthMetrics } from '../../src/bench/roof3d/truth.ts';

function truth(o: Partial<TruthMetrics> = {}): TruthMetrics {
  return {
    grade: 'eagleview',
    comparable: true,
    iou: 0.8,
    meanBoundaryM: 1,
    hd95M: 2,
    areaErrPct: 3,
    slopedSqFt: 2000,
    truthSlopedSqFt: 1940,
    mainPitchOurs: 6,
    mainPitchTruth: 6,
    mainPitchErr: 0,
    facePitchMAE: 0.5,
    within1Pct: 90,
    unmatchedPct: 0,
    lines: { ridge: [100, 100], hip: [50, 100], valley: [0, 0], eave: [200, 100], rake: [10, 10] },
    truthFaces: 8,
    structures: 1,
    ...o,
  };
}

function metrics(o: Partial<HouseMetrics> = {}): HouseMetrics {
  return {
    ...emptyMetrics('failed'),
    status: 'ok',
    faces: 8,
    slivers: 0,
    steepJunk: 0,
    steepAny: 0,
    vertices: 12,
    rectilinearity: 0.9,
    slopedSqFt: 2000,
    checkerPassed: true,
    proxy: { ...EMPTY_PROXY, maskIoU: 0.97 },
    truth: truth(),
    bad: false,
    ...o,
  };
}

describe('one seed of a cohort', () => {
  test('medians are over houses that are the same building as the key, counts over every house', () => {
    const ms = [
      metrics({ truth: truth({ iou: 0.9 }) }),
      metrics({ truth: truth({ iou: 0.7 }) }),
      metrics({ truth: truth({ iou: 0.3, comparable: false }), checkerPassed: false, slivers: 2 }),
      metrics({ truth: null, bad: null, steepJunk: 1 }),
      emptyMetrics('no-roof'),
      emptyMetrics('failed'),
    ];
    const a = aggregateSeed(ms);
    expect(a.houses).toBe(6);
    expect(a.withTruth).toBe(3);
    expect(a.comparable).toBe(2);
    expect(a.truth.medianIoU).toBeCloseTo(0.8, 12);
    expect(a.slivers).toBe(2);
    expect(a.steepJunk).toBe(1);
    expect(a.checkerPass).toBe(3);
    expect(a.noRoof).toBe(1);
    expect(a.failures).toBe(1);
  });

  test('line totals are summed over houses before the percentage is taken', () => {
    const a = aggregateSeed([metrics(), metrics({ truth: truth({ lines: { ridge: [300, 100], hip: [0, 0], valley: [0, 0], eave: [0, 0], rake: [0, 0] } }) })]);
    expect(a.truth.lineErrPct.ridge).toBeCloseTo((100 * (400 - 200)) / 200, 9);
    expect(a.truth.lineErrPct.hip).toBeCloseTo((100 * (50 - 100)) / 100, 9);
    expect(a.truth.lineErrPct.valley).toBeNull();
  });

  test('review flags: precision and recall against real error', () => {
    // bad = area off over 10 percent or pitch off over 1/12.
    const ms = [
      metrics({ flagged: true, bad: true }),
      metrics({ flagged: true, bad: true }),
      metrics({ flagged: true, bad: false }),
      metrics({ flagged: false, bad: true }),
      metrics({ flagged: false, bad: false }),
      metrics({ flagged: false, bad: false }),
    ];
    const f = aggregateSeed(ms).flags;
    expect([f.tp, f.fp, f.fn, f.tn]).toEqual([2, 1, 1, 2]);
    expect(f.precision).toBeCloseTo(2 / 3, 12);
    expect(f.recall).toBeCloseTo(2 / 3, 12);
    expect(f.rate).toBeCloseTo(0.5, 12);
  });

  test('review reasons are counted by house', () => {
    const a = aggregateSeed([metrics({ reasons: ['trees', 'roof-hidden'] }), metrics({ reasons: ['trees'] }), metrics({ reasons: [] }), emptyMetrics('no-roof')]);
    expect(a.reasons.trees).toBe(2);
    expect(a.reasons['roof-hidden']).toBe(1);
    expect(a.reasons['outline-off']).toBe(0);
  });

  test('no houses with a key leaves the truth numbers empty, not zero', () => {
    const a = aggregateSeed([metrics({ truth: null, bad: null })]);
    expect(a.truth.medianIoU).toBeNull();
    expect(a.truth.medianAreaErrAbsPct).toBeNull();
    expect(a.flags.precision).toBeNull();
  });
});

describe('over seeds', () => {
  test('each number is the mean with its range', () => {
    const run = (areas: number[]): HouseRun => ({
      slug: 'x',
      seeds: areas.map((a) => metrics({ truth: truth({ areaErrPct: a }) })),
      runtimesMs: [10, 12, 11, 10],
      deterministic: true,
      seedStable: false,
      seedIdentical: false,
    });
    const r = cohortReport([run([2, 4, 6])], 3);
    expect(r.stats.truth.medianAreaErrAbsPct).toEqual({ mean: 4, min: 2, max: 6 });
    expect(r.runtime.p50Ms).toBe(10.5);
    expect(r.seedSensitive).toBe(1);
    expect(r.nondeterministic).toBe(0);
  });

  test('a missing value in every seed stays missing', () => {
    const s = combineSeeds([aggregateSeed([]), aggregateSeed([])]);
    expect(s.truth.medianIoU).toBeNull();
  });

  test('a difference is material when a count or a verdict changes or the area moves over 1 percent', () => {
    const a = metrics();
    expect(materiallyDiffers(a, { ...a, slopedSqFt: 2015 })).toBe(false);
    expect(materiallyDiffers(a, { ...a, slopedSqFt: 2030 })).toBe(true);
    expect(materiallyDiffers(a, { ...a, faces: 9 })).toBe(true);
    expect(materiallyDiffers(a, { ...a, flagged: true })).toBe(true);
    expect(materiallyDiffers(a, { ...a, truth: truth({ iou: 0.806 }) })).toBe(true);
    expect(materiallyDiffers(a, { ...a, truth: truth({ iou: 0.803 }) })).toBe(false);
  });
});
