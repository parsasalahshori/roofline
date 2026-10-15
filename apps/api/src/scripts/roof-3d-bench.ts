import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BenchDataError, cohortCounts, runBench } from '../bench/roof3d/bench.ts';
import { DEFAULT_GATES, formatGates, GatesSchema, compareSplits, gatesFailed, type GateRow } from '../bench/roof3d/gates.ts';
import { manifestHash, manifestProblems, parseManifest, SPLITS, type Manifest } from '../bench/roof3d/manifest.ts';
import { benchDir, FALLBACK_DATA_DIR } from '../bench/roof3d/paths.ts';
import { formatHouses, formatSplit, type BenchReport } from '../bench/roof3d/report.ts';

/*
 * The roof reconstruction benchmark: every house in <ROOF_BENCH_DIR>/manifest.json, reconstructed as the server does
 * it at seeds 7, 8 and 9, scored against EagleView where there is a report, against proxies where there is not, and
 * summarised per cohort. Hermetic: it reads files and makes no network request.
 *
 *   npm run roof3d:bench -w @roofline/api -- [options]
 *     --split dev|heldout|all   default dev. Held-out results are aggregates only (add --reveal to see houses)
 *     --house a,b               only these houses, for a quick look while working on one (held-out ones need --reveal)
 *     --cohort NAME             one cohort (all, canopy-heavy, canopy-light, canopy-none, canopy-any, simple, complex,
 *                               lowslope, steep, truth-eagleview, truth-proxy, has-truth, state-XX, set-testset...)
 *     --compare FILE            judge this run against a frozen baseline with the regression gates; exit 1 on failure
 *     --json OUT                write the full report (aggregates; dev houses; held-out houses only with --reveal)
 *     --counts                  print how many houses are in each cohort and exit (no run)
 *     --init-gates              write <ROOF_BENCH_DIR>/gates.json with the default limits if it is not there, and exit
 *     --gates FILE              gates file (default <ROOF_BENCH_DIR>/gates.json)
 *     --reveal                  per-house held-out output (integrator and verifiers only)
 *     --allow-expired           run on Google data past its 30-day date (a one-off; delete the data instead)
 *     --seeds 7,8,9             the seeds (default 7,8,9)
 *     --allow-manifest-change   compare against a baseline made from a different manifest (gates then mean little)
 *     --base SHA                record which commit's reconstruction this run claims to measure, with the reconstruction
 *                               files that differ from it (for a baseline made on a later harness commit)
 * Exit code: 0 ok, 1 a gate failed, 2 bad usage, 3 a data problem (missing files, expired data, a manifest that
 * breaks its frozen split).
 */

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
function value(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The files whose change can change a reconstruction (everything the estimator's roof depends on). */
const RECONSTRUCTION_PATHS = ['packages/shared/src/roof-reconstruct', 'packages/shared/src/roof-3d.ts', 'apps/api/src/estimator/roof-3d.ts', 'apps/api/src/estimator/roof-3d-compare.ts', 'apps/api/src/providers/google-solar-layers.ts', 'apps/api/src/providers/google-solar.ts'];

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

async function main(): Promise<number> {
  const bench = benchDir();
  const split = value('--split') ?? 'dev';
  if (split !== 'all' && !(SPLITS as readonly string[]).includes(split)) {
    process.stderr.write('--split must be dev, heldout or all\n');
    return 2;
  }
  const gatesFile = value('--gates') ?? path.join(bench, 'gates.json');
  if (flag('--init-gates')) {
    if (existsSync(gatesFile)) process.stdout.write(`${gatesFile} already exists; left alone\n`);
    else {
      writeFileSync(gatesFile, `${JSON.stringify(DEFAULT_GATES, null, 2)}\n`);
      process.stdout.write(`wrote ${gatesFile}\n`);
    }
    return 0;
  }
  const manifestFile = path.join(bench, 'manifest.json');
  if (!existsSync(manifestFile)) {
    process.stderr.write(`No manifest at ${manifestFile}. Build it with: npm run roof3d:bench-manifest -w @roofline/api (data fallback: ${FALLBACK_DATA_DIR})\n`);
    return 3;
  }
  let manifest: Manifest;
  try {
    manifest = parseManifest(JSON.parse(readFileSync(manifestFile, 'utf8')));
  } catch (err) {
    process.stderr.write(`manifest.json is not valid: ${(err as Error).message.slice(0, 400)}\n`);
    return 3;
  }
  const problems = manifestProblems(manifest);
  if (problems.length > 0) {
    process.stderr.write(`manifest.json breaks its rules:\n${problems.join('\n')}\n`);
    return 3;
  }
  if (flag('--counts')) {
    const counts = cohortCounts(manifest);
    const w = Math.max(...Object.keys(counts).map((k) => k.length));
    process.stdout.write(`manifest ${manifestHash(manifest)}: ${manifest.houses.length} houses\n${'cohort'.padEnd(w)}   dev heldout total\n`);
    for (const name of Object.keys(counts).sort((a, b) => (a === 'all' ? -1 : b === 'all' ? 1 : a.localeCompare(b)))) {
      const c = counts[name]!;
      process.stdout.write(`${name.padEnd(w)}  ${String(c.dev).padStart(4)} ${String(c.heldout).padStart(7)} ${String(c.total).padStart(5)}\n`);
    }
    return 0;
  }
  const seedsArg = value('--seeds');
  const seeds = seedsArg === undefined ? undefined : seedsArg.split(',').map(Number);
  if (seeds !== undefined && (seeds.length === 0 || seeds.some((s) => !Number.isInteger(s)))) {
    process.stderr.write('--seeds takes whole numbers separated by commas\n');
    return 2;
  }
  const reveal = flag('--reveal');
  const baseSha = value('--base');
  let report: BenchReport;
  try {
    report = await runBench({
      manifest,
      split: split as 'dev' | 'heldout' | 'all',
      cohort: value('--cohort') ?? null,
      houses: value('--house')?.split(',') ?? null,
      ...(seeds !== undefined ? { seeds } : {}),
      reveal,
      today: new Date().toISOString().slice(0, 10),
      allowExpired: flag('--allow-expired'),
      bench,
      commit: { sha: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain', '--untracked-files=no']) !== '' },
      base: baseSha === undefined ? null : { sha: git(['rev-parse', baseSha]), changedFiles: git(['diff', '--name-only', baseSha, '--', ...RECONSTRUCTION_PATHS]).split('\n').filter((l) => l !== '') },
      onHouse: (slug, k, n) => {
        if (process.stderr.isTTY) process.stderr.write(`\r[${k}/${n}] ${slug.padEnd(30)}`);
      },
    });
  } catch (err) {
    if (err instanceof BenchDataError) {
      process.stderr.write(`${err.message}\n`);
      return 3;
    }
    throw err;
  }
  if (process.stderr.isTTY) process.stderr.write('\r'.padEnd(50));
  const dueSoon = manifest.houses.map((h) => h.data.deleteBy).sort()[0];
  if (dueSoon !== undefined) process.stdout.write(`Google data: the earliest delete-by date in the manifest is ${dueSoon} (Solar API terms: keep 30 days).\n`);
  process.stdout.write(`roof3d bench at ${report.commit.sha.slice(0, 8)}${report.commit.dirty ? '+dirty' : ''}${report.base ? ` (reconstruction as ${report.base.sha.slice(0, 8)}${report.base.changedFiles.length > 0 ? ` plus changes to ${report.base.changedFiles.join(', ')}` : ''})` : ''}, ${report.date.slice(0, 10)}, seeds ${report.seeds.join(',')}, manifest ${report.manifestHash}, calibration ${report.calibrationMs.toFixed(0)} ms${report.cohortFilter ? `, cohort ${report.cohortFilter}` : ''}\n\n`);
  for (const name of ['dev', 'heldout'] as const) {
    const s = report.splits[name];
    if (s === undefined) continue;
    process.stdout.write(`${formatSplit(name, s)}\n\n`);
    if (s.perHouse !== undefined) process.stdout.write(`${name.toUpperCase()} houses (* = result differs between seeds):\n${formatHouses(s.perHouse)}\n\n`);
    else process.stdout.write('Held-out houses are sealed (aggregates only); --reveal shows them.\n\n');
  }
  const out = value('--json');
  if (out !== undefined) {
    writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
    process.stdout.write(`report -> ${out}\n`);
  }
  const against = value('--compare');
  let failed = 0;
  if (against !== undefined) {
    let baseline: BenchReport;
    try {
      baseline = JSON.parse(readFileSync(against, 'utf8')) as BenchReport;
      z.object({ version: z.literal(1), manifestHash: z.string(), calibrationMs: z.number(), splits: z.object({}).passthrough() }).parse(baseline);
    } catch (err) {
      process.stderr.write(`cannot read the baseline ${against}: ${(err as Error).message.slice(0, 300)}\n`);
      return 3;
    }
    if (baseline.manifestHash !== report.manifestHash && !flag('--allow-manifest-change')) {
      process.stderr.write(`The baseline was made from manifest ${baseline.manifestHash} and this run uses ${report.manifestHash}: freeze a new baseline (--json) before comparing.\n`);
      return 3;
    }
    if (!existsSync(gatesFile)) {
      process.stderr.write(`No gates file at ${gatesFile} (npm run roof3d:bench -w @roofline/api -- --init-gates).\n`);
      return 3;
    }
    const gates = GatesSchema.parse(JSON.parse(readFileSync(gatesFile, 'utf8')));
    const all: { name: string; rows: GateRow[] }[] = [];
    for (const name of ['dev', 'heldout'] as const) {
      const cur = report.splits[name];
      const base = baseline.splits[name];
      if (cur === undefined) continue;
      if (base === undefined) {
        process.stdout.write(`GATES (${name}): the baseline has no ${name} split; nothing to compare\n`);
        continue;
      }
      all.push({ name, rows: compareSplits(base, cur, gates, { base: baseline.calibrationMs, cur: report.calibrationMs }) });
    }
    for (const g of all) {
      process.stdout.write(`${formatGates(g.name, g.rows)}\n`);
      failed += gatesFailed(g.rows).length;
    }
    process.stdout.write(failed > 0 ? `\n${failed} gate(s) FAILED.\n` : '\nAll gates pass.\n');
  }
  return failed > 0 ? 1 : 0;
}

process.exitCode = await main();
