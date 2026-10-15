import { z } from 'zod';
import type { CohortReport } from './aggregate.ts';
import type { SplitReport } from './report.ts';

/*
 * The regression gates: the contract every change to the roof reconstruction is held to. gates.json holds the limits;
 * `--compare baseline.json` checks the current run against the frozen baseline, cohort by cohort, and exits non-zero
 * when any gate fails. A gate that cannot be judged (too few houses with an answer key in the cohort) is skipped and
 * said so, never silently passed.
 */

export const GatesSchema = z.object({
  version: z.literal(1),
  /** Cohorts with fewer houses that have an answer key skip the truth gates. */
  minTruthHouses: z.number().int().min(1),
  /**
   * Cohorts with fewer houses than this (in the baseline or the run) are reported but not gated, except determinism and
   * failures: the median or count of a handful of houses moves by a house's worth when only the random seeds change
   * (A/A runs at seeds 20-22 failed gates in cohorts of 4, 8 and 9 houses).
   */
  minCohortHouses: z.number().int().min(1),
  /**
   * How the gates treat the seed-to-seed spread of the baseline. 'baseline-range': a number may move by the larger of
   * its limit below and the baseline's own range over seeds 7, 8, 9 (max - min of that number) before it counts as
   * worse: the same code at other seeds moves a number by about that much (a strict A/A run at seeds 10-12 failed 17
   * gates, all on checker-pass and thin-face counts), so a smaller move cannot be told from noise. 'none': exactly the
   * limits. A number with no spread (0 slivers at every seed, an IoU median the seed does not touch) keeps its limit.
   */
  seedNoise: z.enum(['baseline-range', 'none']),
  /** Median outline IoU may not fall by more than this. */
  medianOutlineIoU: z.object({ maxDrop: z.number().nonnegative() }),
  /** Median mean boundary distance (metres) may not rise by more than this. */
  medianBoundaryDistM: z.object({ maxRise: z.number().nonnegative() }),
  /** Median absolute total-area error (percentage points) may not rise by more than this. */
  medianAreaErrPct: z.object({ maxRisePoints: z.number().nonnegative() }),
  /** Houses passing every checker target may not fall by more than this. */
  checkerPass: z.object({ maxDrop: z.number().nonnegative() }),
  /** Sliver faces (under 25 sq ft) may not rise by more than this. */
  slivers: z.object({ maxRise: z.number().nonnegative() }),
  /**
   * Faces of 25 sq ft or more thinner than 0.9 m (slivers along an edge, the foliage faces the benchmark was built to
   * catch) may not rise by more than this, in these cohorts only: on simple roofs and under trees a thin face is almost
   * always junk, while a complex roof's narrow dormer cheeks are real.
   */
  thinFaces: z.object({ maxRise: z.number().nonnegative(), cohorts: z.array(z.string()) }),
  /** Faces steeper than 18/12 without a Google segment that steep may not rise by more than this. */
  steepJunk: z.object({ maxRise: z.number().nonnegative() }),
  /** Houses that fail to reconstruct (a throw, or no roof) may not rise by more than this. */
  failures: z.object({ maxRise: z.number().nonnegative() }),
  /** Every house's reconstruction must be byte-identical when run twice. */
  determinism: z.object({ mustHold: z.boolean() }),
  /** Runtime p95 (after dividing by the machine's calibration time) may not exceed this multiple of the baseline's. */
  runtimeP95: z.object({ maxRatio: z.number().min(1) }),
});
export type Gates = z.infer<typeof GatesSchema>;

export const DEFAULT_GATES: Gates = {
  version: 1,
  minTruthHouses: 3,
  minCohortHouses: 10,
  seedNoise: 'baseline-range',
  medianOutlineIoU: { maxDrop: 0.005 },
  medianBoundaryDistM: { maxRise: 0.05 },
  medianAreaErrPct: { maxRisePoints: 0.5 },
  checkerPass: { maxDrop: 0 },
  slivers: { maxRise: 0 },
  thinFaces: { maxRise: 0, cohorts: ['simple', 'canopy-heavy', 'canopy-light'] },
  steepJunk: { maxRise: 0 },
  failures: { maxRise: 0 },
  determinism: { mustHold: true },
  runtimeP95: { maxRatio: 1.5 },
};

export type GateRow = {
  cohort: string;
  rule: string;
  baseline: number | null;
  current: number | null;
  /** Each side's [min, max] over the seeds (when the number has one), to judge a failure against the seed noise. */
  baselineRange?: [number, number] | null;
  currentRange?: [number, number] | null;
  limit: string;
  status: 'pass' | 'fail' | 'skip';
  note?: string;
};

const EPS = 1e-9;

const mean = (s: { mean: number } | null | undefined): number | null => (s ? s.mean : null);
const range = (s: { min: number; max: number } | null | undefined): [number, number] | null => (s ? [s.min, s.max] : null);

/** Runtime p95 divided by the calibration time: a machine-independent figure (cost in units of one fixed workload). */
function normalised(c: CohortReport, calibrationMs: number): number {
  return c.runtime.p95Ms / calibrationMs;
}

/** Judges a current split against the baseline's, cohort by cohort. */
export function compareSplits(base: SplitReport, cur: SplitReport, gates: Gates, calibration: { base: number; cur: number }): GateRow[] {
  const rows: GateRow[] = [];
  for (const cohort of Object.keys(cur.cohorts).sort((a, b) => (a === 'all' ? -1 : b === 'all' ? 1 : a.localeCompare(b)))) {
    const c = cur.cohorts[cohort]!;
    const b = base.cohorts[cohort];
    if (b === undefined) {
      rows.push({ cohort, rule: 'baseline', baseline: null, current: null, limit: '-', status: 'skip', note: 'cohort not in the baseline' });
      continue;
    }
    const small = Math.min(b.n, c.n) < gates.minCohortHouses;
    const truthOk = Math.min(mean(b.stats.comparable) ?? 0, mean(c.stats.comparable) ?? 0) >= gates.minTruthHouses;
    type S = { mean: number; min: number; max: number } | null | undefined;
    const row = (rule: string, bs: S, cs: S, limit: string, fail: (bv: number, cv: number) => boolean, needsTruth: boolean): void => {
      const bv = mean(bs);
      const cv = mean(cs);
      if (small || (needsTruth && !truthOk) || bv === null || cv === null) {
        const note = small ? `cohort under ${gates.minCohortHouses} houses` : needsTruth && !truthOk ? `fewer than ${gates.minTruthHouses} houses with an answer key` : 'no value';
        rows.push({ cohort, rule, baseline: bv, current: cv, limit, status: 'skip', note });
        return;
      }
      rows.push({ cohort, rule, baseline: bv, current: cv, baselineRange: range(bs), currentRange: range(cs), limit, status: fail(bv, cv) ? 'fail' : 'pass' });
    };
    /** The room the baseline's own seed spread gives a number: the larger of the contract's limit and that spread (see Gates.seedNoise). */
    const room = (bs: S, limit: number): number => (gates.seedNoise === 'baseline-range' && bs ? Math.max(limit, bs.max - bs.min) : limit);
    const describe = (bs: S, limit: number): string => {
      const r = room(bs, limit);
      return r > limit + EPS ? `${r} (the baseline's seed range, over ${limit})` : String(limit);
    };
    const lower = (rule: string, bs: S, cs: S, drop: number, needsTruth: boolean): void => {
      const allow = room(bs, drop);
      row(rule, bs, cs, `drop <= ${describe(bs, drop)}`, (bv, cv) => cv < bv - allow - EPS, needsTruth);
    };
    const higher = (rule: string, bs: S, cs: S, rise: number, needsTruth: boolean): void => {
      const allow = room(bs, rise);
      row(rule, bs, cs, `rise <= ${describe(bs, rise)}`, (bv, cv) => cv > bv + allow + EPS, needsTruth);
    };
    lower('median outline IoU', b.stats.truth.medianIoU, c.stats.truth.medianIoU, gates.medianOutlineIoU.maxDrop, true);
    higher('median boundary distance m', b.stats.truth.medianBoundaryM, c.stats.truth.medianBoundaryM, gates.medianBoundaryDistM.maxRise, true);
    higher('median |area error| pts', b.stats.truth.medianAreaErrAbsPct, c.stats.truth.medianAreaErrAbsPct, gates.medianAreaErrPct.maxRisePoints, true);
    lower('houses passing all targets', b.stats.checkerPass, c.stats.checkerPass, gates.checkerPass.maxDrop, false);
    higher('slivers', b.stats.slivers, c.stats.slivers, gates.slivers.maxRise, false);
    if (gates.thinFaces.cohorts.includes(cohort)) higher('thin faces (simple and canopy cohorts)', b.stats.thinFaces, c.stats.thinFaces, gates.thinFaces.maxRise, false);
    higher('steep junk faces', b.stats.steepJunk, c.stats.steepJunk, gates.steepJunk.maxRise, false);
    // Failures and no-roof houses are added over the seeds' means; the range is not tracked for the sum.
    {
      const bv = (mean(b.stats.failures) ?? 0) + (mean(b.stats.noRoof) ?? 0);
      const cv = (mean(c.stats.failures) ?? 0) + (mean(c.stats.noRoof) ?? 0);
      rows.push({ cohort, rule: 'failed or no-roof houses', baseline: bv, current: cv, limit: `rise <= ${gates.failures.maxRise}`, status: cv > bv + gates.failures.maxRise + EPS ? 'fail' : 'pass' });
    }
    if (gates.determinism.mustHold) {
      rows.push({ cohort, rule: 'determinism (houses not byte-identical)', baseline: b.nondeterministic, current: c.nondeterministic, limit: '0', status: c.nondeterministic === 0 ? 'pass' : 'fail' });
    }
    const bn = normalised(b, calibration.base);
    const cn = normalised(c, calibration.cur);
    rows.push({
      cohort,
      rule: 'runtime p95 (x calibration)',
      baseline: bn,
      current: cn,
      limit: `ratio <= ${gates.runtimeP95.maxRatio}`,
      // The p95 of a handful of houses is its slowest one.
      ...(small ? { note: `cohort under ${gates.minCohortHouses} houses` } : {}),
      status: small ? 'skip' : cn > bn * gates.runtimeP95.maxRatio + EPS ? 'fail' : 'pass',
    });
  }
  return rows;
}

export function gatesFailed(rows: readonly GateRow[]): GateRow[] {
  return rows.filter((r) => r.status === 'fail');
}

export function formatGates(name: string, rows: readonly GateRow[]): string {
  const failed = gatesFailed(rows);
  const skipped = rows.filter((r) => r.status === 'skip').length;
  const lines = [`GATES (${name}): ${rows.length - failed.length - skipped} pass, ${failed.length} fail, ${skipped} skipped`];
  const rg = (v: [number, number] | null | undefined) => (v === null || v === undefined || v[0] === v[1] ? '' : ` [${v[0].toFixed(2)}-${v[1].toFixed(2)}]`);
  for (const r of rows.filter((x) => x.status === 'fail')) {
    // Seeds differ in a house or two: a failure whose two ranges overlap may be that noise, and says so (it still fails).
    const overlap = r.baselineRange && r.currentRange && r.baselineRange[0] <= r.currentRange[1] && r.currentRange[0] <= r.baselineRange[1];
    lines.push(
      `  FAIL ${r.cohort}: ${r.rule}: baseline ${r.baseline === null ? '-' : r.baseline.toFixed(4)}${rg(r.baselineRange)} -> ${r.current === null ? '-' : r.current.toFixed(4)}${rg(r.currentRange)} (limit ${r.limit})${overlap ? ' - the seed ranges overlap: check it is not seed noise' : ''}`,
    );
  }
  const skips = rows.filter((x) => x.status === 'skip' && x.note !== undefined);
  if (skips.length > 0) {
    const byNote = new Map<string, string[]>();
    for (const s of skips) byNote.set(s.note!, [...(byNote.get(s.note!) ?? []), `${s.cohort}/${s.rule}`]);
    for (const [note, items] of byNote) lines.push(`  skipped (${note}): ${items.length} checks`);
  }
  return lines.join('\n');
}
