import { type CohortReport, cohortReport } from './aggregate.ts';
import { type LoadedHouse, loadHouse } from './data.ts';
import { type HouseEntry, type Manifest, cohortsOf, expiredHouses, manifestHash, type Split } from './manifest.ts';
import { HELDOUT_MIN_COHORT, type BenchReport, type HouseRow, type SplitReport } from './report.ts';
import { SEEDS, calibrationMs, type HouseRun, runHouse } from './run.ts';

export class BenchDataError extends Error {}

export type BenchOptions = {
  manifest: Manifest;
  /** 'all' runs both splits. */
  split: Split | 'all';
  cohort?: string | null;
  /** Only these houses (a quick look at one house while working on it). A held-out house needs `reveal`. */
  houses?: readonly string[] | null;
  seeds?: readonly number[];
  /** Print and keep held-out houses one by one (the integrator and verifiers only). */
  reveal?: boolean;
  /** YYYY-MM-DD, the day the run is made (the 30-day rule is judged against it). */
  today: string;
  allowExpired?: boolean;
  bench?: string;
  fallback?: string;
  commit: { sha: string; dirty: boolean };
  base?: { sha: string; changedFiles: string[] } | null;
  now?: () => Date;
  /** Where houses come from (default: the files under the bench folder); tests pass in-memory houses. */
  loader?: (entry: HouseEntry) => Promise<LoadedHouse>;
  onHouse?: (slug: string, k: number, n: number) => void;
};

function groupBy(entries: readonly HouseEntry[], runs: ReadonlyMap<string, HouseRun>): Map<string, HouseRun[]> {
  const groups = new Map<string, HouseRun[]>();
  for (const e of entries) {
    const run = runs.get(e.slug);
    if (run === undefined) continue;
    for (const name of cohortsOf(e)) groups.set(name, [...(groups.get(name) ?? []), run]);
  }
  return groups;
}

function splitReport(split: Split, entries: readonly HouseEntry[], runs: ReadonlyMap<string, HouseRun>, seedCount: number, reveal: boolean, only: string | null): SplitReport {
  const groups = groupBy(entries, runs);
  const cohorts: Record<string, CohortReport> = {};
  const suppressed: string[] = [];
  for (const [name, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (only !== null && name !== only) continue;
    // Sealed: a held-out cohort of a few houses would be those houses' numbers in disguise.
    if (split === 'heldout' && !reveal && list.length < HELDOUT_MIN_COHORT) {
      suppressed.push(name);
      continue;
    }
    cohorts[name] = cohortReport(list, seedCount);
  }
  const report: SplitReport = { houses: entries.length, cohorts, ...(suppressed.length > 0 ? { suppressed } : {}) };
  if (split === 'dev' || reveal) {
    report.perHouse = entries
      .map((e): HouseRow | null => {
        const r = runs.get(e.slug);
        if (r === undefined) return null;
        return {
          slug: e.slug,
          set: e.set,
          truth: e.truth,
          canopy: e.tags.canopy?.class ?? null,
          complexity: e.tags.complexity.class,
          metrics: r.seeds[0]!,
          deterministic: r.deterministic,
          seedStable: r.seedStable,
          seedIdentical: r.seedIdentical,
          runtimeMs: [...r.runtimesMs].sort((a, b) => a - b)[Math.floor(r.runtimesMs.length / 2)]!,
        };
      })
      .filter((x): x is HouseRow => x !== null);
  }
  return report;
}

/** Runs the benchmark on the houses the options select and returns its report. */
export async function runBench(o: BenchOptions): Promise<BenchReport> {
  const seeds = o.seeds ?? SEEDS;
  const only = o.cohort ?? null;
  const wanted = o.houses ?? null;
  if (wanted !== null) {
    const known = new Set(o.manifest.houses.map((h) => h.slug));
    const unknown = wanted.filter((s) => !known.has(s));
    if (unknown.length > 0) throw new BenchDataError(`no such house: ${unknown.join(', ')}`);
    const sealed = o.manifest.houses.filter((h) => wanted.includes(h.slug) && h.split === 'heldout');
    if (sealed.length > 0 && o.reveal !== true) throw new BenchDataError(`${sealed.length} of those houses are held out; they can only be shown with --reveal (integrator and verifiers)`);
  }
  const selected = o.manifest.houses.filter(
    (h) => (wanted === null ? o.split === 'all' || h.split === o.split : wanted.includes(h.slug)) && (only === null || cohortsOf(h).includes(only)),
  );
  if (only !== null && selected.length === 0) throw new BenchDataError(`no house in cohort "${only}"`);
  const stale = expiredHouses({ ...o.manifest, houses: selected }, o.today);
  if (stale.length > 0 && o.allowExpired !== true) {
    throw new BenchDataError(
      `Google's data for ${stale.length} house(s) is past its 30-day date (${stale.map((h) => `${h.slug} ${h.data.deleteBy}`).slice(0, 5).join(', ')}${stale.length > 5 ? ', ...' : ''}). Delete it, or pass --allow-expired for a one-off run.`,
    );
  }
  const calibration = calibrationMs();
  const runs = new Map<string, HouseRun>();
  let warmed = false;
  for (const [k, entry] of selected.entries()) {
    o.onHouse?.(entry.slug, k + 1, selected.length);
    let loaded;
    try {
      loaded = await (o.loader ?? ((e) => loadHouse(e, o.bench, o.fallback)))(entry);
    } catch (err) {
      throw new BenchDataError(`cannot read ${entry.slug}: ${(err as Error).message}`);
    }
    if (!warmed) {
      // One run nobody sees, so the first house is not charged for compiling the code.
      runHouse(loaded, [seeds[0]!]);
      warmed = true;
    }
    runs.set(entry.slug, runHouse(loaded, seeds));
  }
  const splits: BenchReport['splits'] = {};
  for (const split of ['dev', 'heldout'] as const) {
    if (o.split !== 'all' && o.split !== split) continue;
    const entries = selected.filter((h) => h.split === split);
    if (entries.length === 0) continue;
    splits[split] = splitReport(split, entries, runs, seeds.length, o.reveal === true, only);
  }
  return {
    version: 1,
    commit: o.commit,
    base: o.base ?? null,
    date: (o.now?.() ?? new Date()).toISOString(),
    node: process.version,
    calibrationMs: calibration,
    seeds: [...seeds],
    manifestHash: manifestHash(o.manifest),
    thresholds: o.manifest.thresholds,
    cohortFilter: only,
    splits,
    expired: stale.map((h) => h.slug),
  };
}

/** How many houses fall in each cohort, by split (counts only, no results). */
export function cohortCounts(m: Manifest): Record<string, { dev: number; heldout: number; total: number }> {
  const out: Record<string, { dev: number; heldout: number; total: number }> = {};
  for (const h of m.houses) {
    for (const name of cohortsOf(h)) {
      const c = (out[name] ??= { dev: 0, heldout: 0, total: 0 });
      c[h.split]++;
      c.total++;
    }
  }
  return out;
}
