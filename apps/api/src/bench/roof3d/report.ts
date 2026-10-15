import { ROOF_QUALITY_REASONS } from '@roofline/shared';
import type { CohortReport, Stat } from './aggregate.ts';
import type { HouseMetrics } from './metrics.ts';
import type { Thresholds } from './manifest.ts';

/*
 * The benchmark's report (what --json writes and what --compare reads), and its text form. The held-out split is
 * sealed: its cohorts appear only as aggregates (and only when a cohort has HELDOUT_MIN_COHORT houses, so an aggregate
 * is never one house's numbers in disguise), and its houses only with --reveal.
 */

export const HELDOUT_MIN_COHORT = 5;

/** A house's headline numbers over the seeds: [mean, min, max]; null when no seed has one. */
export type SeedSpread = [number, number, number] | null;

export type HouseRow = {
  slug: string;
  set: string;
  truth: string;
  canopy: string | null;
  complexity: string;
  /** The full metrics at the first seed. */
  metrics: HouseMetrics;
  /** The headline numbers as [mean, min, max] over the seeds. */
  spread: { faces: SeedSpread; slopedSqFt: SeedSpread; thinFaces: SeedSpread; iou: SeedSpread; meanBoundaryM: SeedSpread; areaErrPct: SeedSpread };
  deterministic: boolean;
  seedStable: boolean;
  seedIdentical: boolean;
  runtimeMs: number;
};

export type SplitReport = {
  houses: number;
  cohorts: Record<string, CohortReport>;
  /** Cohorts left out of the held-out aggregates because they are too small. */
  suppressed?: string[];
  /** Per-house rows: always for dev; for held-out only with --reveal. */
  perHouse?: HouseRow[];
};

export type DataVersion = {
  houses: number;
  bySet: Record<string, number>;
  /** Google's imagery dates and the dates the files were downloaded (YYYY-MM-DD); houses with no recorded download date are counted. */
  imageryDate: { min: string | null; max: string | null };
  downloadedAt: { min: string | null; max: string | null; unknown: number };
  earliestDeleteBy: string | null;
  splitRule: string;
};

export type BenchReport = {
  version: 1;
  commit: { sha: string; dirty: boolean };
  /**
   * The commit the reconstruction code is claimed to be at (--base) and the reconstruction files that differ from it
   * (empty: the code is that commit's). Lets a baseline made on a harness commit say which reconstruction it measured.
   */
  base: { sha: string; changedFiles: string[] } | null;
  date: string;
  node: string;
  calibrationMs: number;
  seeds: number[];
  manifestHash: string;
  /** What data the run was made on (the whole manifest, whichever houses were run). */
  data: DataVersion;
  thresholds: Thresholds;
  cohortFilter: string | null;
  splits: { dev?: SplitReport; heldout?: SplitReport };
  /** Houses whose data was past its delete-by date when this ran (the run refuses unless told to continue). */
  expired: string[];
};

const f = (x: number, d: number) => x.toFixed(d);

/** mean, with the range over seeds in brackets when the seeds disagree. */
export function fmt(s: Stat | null | undefined, digits = 3, unit = ''): string {
  if (s === null || s === undefined) return '-';
  const m = `${f(s.mean, digits)}${unit}`;
  return s.max - s.min > 1e-9 ? `${m}[${f(s.min, digits)}-${f(s.max, digits)}]` : m;
}

/** A count: whole when it is whole (the mean of three equal seeds), else one decimal. */
export function fmtN(s: Stat | null | undefined): string {
  if (s === null || s === undefined) return '-';
  return fmt(s, Number.isInteger(s.mean) && Number.isInteger(s.min) && Number.isInteger(s.max) ? 0 : 1);
}

const pad = (v: string, n: number) => (v.length >= n ? v : v.padStart(n));
const padR = (v: string, n: number) => (v.length >= n ? v : v.padEnd(n));

function table(head: string[], widths: number[], rows: string[][]): string {
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? padR(c, widths[i]!) : pad(c, widths[i]!))).join(' | ');
  return [line(head), widths.map((w) => '-'.repeat(w)).join('-+-'), ...rows.map(line)].join('\n');
}

/** Cohort names in a fixed, readable order: all first, then the rest alphabetically. */
export function cohortNames(cohorts: Record<string, CohortReport>): string[] {
  return Object.keys(cohorts).sort((a, b) => (a === 'all' ? -1 : b === 'all' ? 1 : a.localeCompare(b)));
}

/** Cohorts under this many houses are in the JSON but left out of the text tables (their medians are one or two houses). */
export const PRINT_MIN_COHORT = 3;

export function formatSplit(name: string, s: SplitReport): string {
  const names = cohortNames(s.cohorts).filter((n) => n === 'all' || s.cohorts[n]!.n >= PRINT_MIN_COHORT);
  const hidden = Object.keys(s.cohorts).length - names.length;
  const out: string[] = [`${name.toUpperCase()}: ${s.houses} houses${hidden > 0 ? ` (${hidden} cohorts under ${PRINT_MIN_COHORT} houses are in the JSON only)` : ''}${s.suppressed && s.suppressed.length > 0 ? ` (cohorts under ${HELDOUT_MIN_COHORT} houses not shown: ${s.suppressed.join(', ')})` : ''}`];
  const L = Math.max(14, ...names.map((n) => n.length));
  out.push(
    '',
    'Against the answer key (EagleView or hand-drawn outline; houses that are the same single building):',
    table(
      ['cohort', 'n', 'key', 'IoU', 'bnd m', 'HD95 m', '|area| %', 'area<=5', 'pitch =', 'pitch +-1', 'face pitch', '<=1/12 %'],
      [L, 3, 8, 9, 9, 9, 13, 8, 12, 12, 16, 9],
      names.map((n) => {
        const c = s.cohorts[n]!.stats;
        const t = c.truth;
        return [
          n,
          String(s.cohorts[n]!.n),
          fmtN(c.comparable),
          fmt(t.medianIoU),
          fmt(t.medianBoundaryM, 2),
          fmt(t.medianHd95M, 2),
          fmt(t.medianAreaErrAbsPct, 1),
          `${fmtN(t.areaWithin5)}/${fmtN(t.areaScored)}`,
          `${fmtN(t.mainPitchExact)}/${fmtN(t.mainPitchScored)}`,
          `${fmtN(t.mainPitchWithin1)}/${fmtN(t.mainPitchScored)}`,
          fmt(t.medianFacePitchMAE, 2),
          fmt(t.medianWithin1Pct, 0),
        ];
      }),
    ),
    '',
    'Outline against EagleView after the best translation (its frame sits about 1 m east, 0.5 m south of Google\'s), and',
    'the checker with its circular outline target (outline vs the mask it was traced from) replaced by an independent one',
    '(aligned EagleView where there is a comparable key, else Google\'s raw mask before the reconstruction\'s cuts: a proxy):',
    table(
      ['cohort', 'raw IoU', 'aligned IoU', 'aligned bnd m', 'aligned HD95', 'shift m', 'outline check', 'checker (old)', 'checker (indep.)'],
      [L, 8, 11, 13, 12, 8, 13, 13, 16],
      names.map((n) => {
        const c = s.cohorts[n]!.stats;
        const t = c.truth;
        const of = `/${s.cohorts[n]!.n}`;
        return [
          n,
          fmt(t.medianIoU),
          fmt(t.medianAlignedIoU ?? null),
          fmt(t.medianAlignedBoundaryM ?? null, 2),
          fmt(t.medianAlignedHd95M ?? null, 2),
          fmt(t.medianShiftM ?? null, 2),
          `${fmtN(c.outlineCheckOk ?? null)}/${fmtN(c.outlineChecked ?? null)}`,
          `${fmtN(c.checkerPass)}${of}`,
          `${fmtN(c.checkerIndependentPass ?? null)}${of}`,
        ];
      }),
    ),
    '',
    'Line totals against EagleView, percent (ours - EagleView) / EagleView, over EagleView houses that are the same building:',
    table(
      ['cohort', 'ridge', 'hip', 'valley', 'eave', 'rake'],
      [L, 9, 9, 9, 9, 9],
      names.map((n) => {
        const l = s.cohorts[n]!.stats.truth.lineErrPct;
        return [n, fmt(l.ridge, 1), fmt(l.hip, 1), fmt(l.valley, 1), fmt(l.eave, 1), fmt(l.rake, 1)];
      }),
    ),
    '',
    'Shape and sanity (every house):',
    table(
      ['cohort', 'faces med', 'slivers', 'thin', 'steep junk', '>18/12', 'verts med', 'rectilin', 'checker', 'no roof', 'failed', 'unusable', 'flag rate', 'flag prec', 'flag recall'],
      [L, 9, 7, 5, 10, 6, 9, 8, 7, 7, 6, 8, 9, 9, 11],
      names.map((n) => {
        const c = s.cohorts[n]!.stats;
        return [
          n,
          fmtN(c.faces.median),
          fmtN(c.slivers),
          fmtN(c.thinFaces),
          fmtN(c.steepJunk),
          fmtN(c.steepAny),
          fmtN(c.vertices.median),
          fmt(c.rectilinearity.median),
          `${fmtN(c.checkerPass)}/${s.cohorts[n]!.n}`,
          fmtN(c.noRoof),
          fmtN(c.failures),
          fmtN(c.unusable),
          fmt(c.flags.rate, 2),
          fmt(c.flags.precision, 2),
          fmt(c.flags.recall, 2),
        ];
      }),
    ),
    '',
    'Review reasons (houses carrying each; a house can carry several):',
    table(
      ['cohort', ...ROOF_QUALITY_REASONS],
      [L, ...ROOF_QUALITY_REASONS.map((r) => Math.max(r.length, 4))],
      names.map((n) => [n, ...ROOF_QUALITY_REASONS.map((r) => fmtN(s.cohorts[n]!.stats.reasons[r]))]),
    ),
    '',
    'Proxy cross-checks (not truth: independent sources that should roughly agree):',
    table(
      ['cohort', 'mask IoU', 'box IoU', '|Google area| %', 'faces/segments', 'OSM IoU', 'OSM n'],
      [L, 8, 8, 15, 14, 8, 6],
      names.map((n) => {
        const p = s.cohorts[n]!.stats.proxy;
        return [n, fmt(p.medianMaskIoU), fmt(p.medianBoxIoU), fmt(p.medianGoogleAreaAbsPct, 1), fmt(p.medianSegmentFaceRatio, 2), fmt(p.medianOsmIoU), fmtN(p.osmHouses)];
      }),
    ),
    '',
    'Runtime and determinism:',
    table(
      ['cohort', 'p50 ms', 'p95 ms', 'not byte-identical', 'seeds differ'],
      [L, 7, 7, 18, 14],
      names.map((n) => {
        const c = s.cohorts[n]!;
        return [n, f(c.runtime.p50Ms, 0), f(c.runtime.p95Ms, 0), `${c.nondeterministic}/${c.n}`, `${c.seedSensitive}/${c.n}`];
      }),
    ),
  );
  return out.join('\n');
}

export function formatHouses(rows: readonly HouseRow[]): string {
  const L = Math.max(10, ...rows.map((r) => r.slug.length));
  return table(
    ['house', 'canopy', 'cplx', 'key', 'IoU', 'bnd m', 'area %', 'pitch', 'faces', 'slv', 'thn', 'stp', 'rect', 'flag', 'chk', 'ms'],
    [L, 6, 4, 4, 5, 5, 7, 7, 5, 3, 3, 3, 5, 4, 3, 5],
    rows.map((r) => {
      const m = r.metrics;
      const t = m.truth;
      const sp = r.spread;
      const mean = (v: SeedSpread, d: number) => (v === null ? '-' : f(v[0], d));
      return [
        r.slug + (r.seedStable ? '' : '*'),
        r.canopy ?? '-',
        r.complexity.slice(0, 4),
        r.truth.slice(0, 4),
        t === null ? '-' : mean(sp.iou, 3),
        t === null ? '-' : mean(sp.meanBoundaryM, 2),
        t === null || t.areaErrPct === null ? '-' : mean(sp.areaErrPct, 1),
        t === null || t.mainPitchOurs === null ? '-' : `${t.mainPitchOurs}/${t.mainPitchTruth}`,
        m.status === 'ok' ? mean(sp.faces, 0) : m.status,
        String(m.slivers),
        mean(sp.thinFaces, 0),
        String(m.steepJunk),
        f(m.rectilinearity, 2),
        m.flagged ? 'Y' : '-',
        m.checkerPassed ? 'ok' : 'x',
        f(r.runtimeMs, 0),
      ];
    }),
  );
}
