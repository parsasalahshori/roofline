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
  medianOutlineIoU: { maxDrop: 0.005 },
  medianBoundaryDistM: { maxRise: 0.05 },
  medianAreaErrPct: { maxRisePoints: 0.5 },
  checkerPass: { maxDrop: 0 },
  slivers: { maxRise: 0 },
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
  limit: string;
  status: 'pass' | 'fail' | 'skip';
  note?: string;
};

const EPS = 1e-9;

const mean = (s: { mean: number } | null | undefined): number | null => (s ? s.mean : null);

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
    const truthOk = Math.min(mean(b.stats.comparable) ?? 0, mean(c.stats.comparable) ?? 0) >= gates.minTruthHouses;
    const lower = (rule: string, bv: number | null, cv: number | null, drop: number, needsTruth: boolean): void => {
      if ((needsTruth && !truthOk) || bv === null || cv === null) {
        rows.push({ cohort, rule, baseline: bv, current: cv, limit: `drop <= ${drop}`, status: 'skip', note: needsTruth && !truthOk ? `fewer than ${gates.minTruthHouses} houses with an answer key` : 'no value' });
        return;
      }
      rows.push({ cohort, rule, baseline: bv, current: cv, limit: `drop <= ${drop}`, status: cv < bv - drop - EPS ? 'fail' : 'pass' });
    };
    const higher = (rule: string, bv: number | null, cv: number | null, rise: number, needsTruth: boolean): void => {
      if ((needsTruth && !truthOk) || bv === null || cv === null) {
        rows.push({ cohort, rule, baseline: bv, current: cv, limit: `rise <= ${rise}`, status: 'skip', note: needsTruth && !truthOk ? `fewer than ${gates.minTruthHouses} houses with an answer key` : 'no value' });
        return;
      }
      rows.push({ cohort, rule, baseline: bv, current: cv, limit: `rise <= ${rise}`, status: cv > bv + rise + EPS ? 'fail' : 'pass' });
    };
    lower('median outline IoU', mean(b.stats.truth.medianIoU), mean(c.stats.truth.medianIoU), gates.medianOutlineIoU.maxDrop, true);
    higher('median boundary distance m', mean(b.stats.truth.medianBoundaryM), mean(c.stats.truth.medianBoundaryM), gates.medianBoundaryDistM.maxRise, true);
    higher('median |area error| pts', mean(b.stats.truth.medianAreaErrAbsPct), mean(c.stats.truth.medianAreaErrAbsPct), gates.medianAreaErrPct.maxRisePoints, true);
    lower('houses passing all targets', mean(b.stats.checkerPass), mean(c.stats.checkerPass), gates.checkerPass.maxDrop, false);
    higher('slivers', mean(b.stats.slivers), mean(c.stats.slivers), gates.slivers.maxRise, false);
    higher('steep junk faces', mean(b.stats.steepJunk), mean(c.stats.steepJunk), gates.steepJunk.maxRise, false);
    higher('failed or no-roof houses', (mean(b.stats.failures) ?? 0) + (mean(b.stats.noRoof) ?? 0), (mean(c.stats.failures) ?? 0) + (mean(c.stats.noRoof) ?? 0), gates.failures.maxRise, false);
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
      status: cn > bn * gates.runtimeP95.maxRatio + EPS ? 'fail' : 'pass',
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
  for (const r of rows.filter((x) => x.status === 'fail')) {
    lines.push(`  FAIL ${r.cohort}: ${r.rule}: baseline ${r.baseline === null ? '-' : r.baseline.toFixed(4)} -> ${r.current === null ? '-' : r.current.toFixed(4)} (limit ${r.limit})`);
  }
  const skips = rows.filter((x) => x.status === 'skip' && x.note !== undefined);
  if (skips.length > 0) {
    const byNote = new Map<string, string[]>();
    for (const s of skips) byNote.set(s.note!, [...(byNote.get(s.note!) ?? []), `${s.cohort}/${s.rule}`]);
    for (const [note, items] of byNote) lines.push(`  skipped (${note}): ${items.length} checks`);
  }
  return lines.join('\n');
}
