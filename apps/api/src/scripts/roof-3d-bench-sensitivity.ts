import { readFileSync } from 'node:fs';
import path from 'node:path';
import { aggregateSeed } from '../bench/roof3d/aggregate.ts';
import { type CanopyParams, DEFAULT_CANOPY, canopyStats } from '../bench/roof3d/canopy.ts';
import { type LoadedHouse, loadHouse } from '../bench/roof3d/data.ts';
import { median } from '../bench/roof3d/geometry.ts';
import { parseManifest } from '../bench/roof3d/manifest.ts';
import { DEFAULT_METRICS, type MetricParams } from '../bench/roof3d/metrics.ts';
import { benchDir } from '../bench/roof3d/paths.ts';
import { reconstructOnce } from '../bench/roof3d/run.ts';
import { canopyClass } from '../bench/roof3d/tags.ts';

/*
 * How much the benchmark's own constants matter: each is moved by -20 and +20 percent and the cohort counts or
 * headline numbers it feeds are shown beside the value in use. Dev split only (the held-out split is never looked at
 * while the harness is being tuned).
 *
 *   npm run roof3d:bench-sensitivity -w @roofline/api
 */

const bench = benchDir();
const manifest = parseManifest(JSON.parse(readFileSync(path.join(bench, 'manifest.json'), 'utf8')));
const t = manifest.thresholds;
const dev = manifest.houses.filter((h) => h.split === 'dev');
const houses: LoadedHouse[] = [];
for (const e of dev) houses.push(await loadHouse(e, bench));

const scale = (v: number, f: number) => Math.round(v * f * 1e6) / 1e6;
const pct = (f: number) => (f === 1 ? 'in use' : f < 1 ? '-20%' : '+20%');
const out: string[] = [];

// 1. Canopy: the class of every house under each variant, against the class in use.
const stats = (p: CanopyParams) => houses.map((h) => canopyStats(h.layers, h.entry.point, p));
const classes = (rows: ReturnType<typeof stats>, th = t) => rows.map((s) => (s === null ? 'none' : canopyClass(s.roofShare, s.rimShare, s.biteShare, th)));
const base = classes(stats(DEFAULT_CANOPY));
const count = (cs: string[]) => `heavy ${cs.filter((c) => c === 'heavy').length}, light ${cs.filter((c) => c === 'light').length}, none ${cs.filter((c) => c === 'none').length}`;
out.push(`Canopy class counts over ${houses.length} dev houses (in use: ${count(base)})`, 'constant | value | counts | houses that change class');
const canopyVariants: [keyof CanopyParams, string][] = [
  ['greenMinExcess', 'green: 2G-R-B at least'],
  ['roughM', 'rough: second difference at least (m)'],
  ['crownDensity', 'crown: tree-like share of the window'],
  ['crownRadiusM', 'crown window half-width (m)'],
  ['rimM', 'rim reach (m)'],
];
for (const [key, label] of canopyVariants) {
  for (const f of [0.8, 1, 1.2]) {
    const p = { ...DEFAULT_CANOPY, [key]: scale(DEFAULT_CANOPY[key], f) };
    const cs = classes(stats(p));
    out.push(`${label.padEnd(40)} | ${String(p[key]).padEnd(6)} (${pct(f).padEnd(6)}) | ${count(cs)} | ${cs.filter((c, i) => c !== base[i]).length}`);
  }
}
const thresholdVariants: [string, (f: number) => typeof t][] = [
  ['heavy: rim share at least', (f) => ({ ...t, heavyRim: scale(t.heavyRim, f) })],
  ['light: rim share at least', (f) => ({ ...t, lightRim: scale(t.lightRim, f) })],
  ['heavy: roof share at least', (f) => ({ ...t, heavyRoof: scale(t.heavyRoof, f) })],
  ['heavy: bite share at least', (f) => ({ ...t, heavyBite: scale(t.heavyBite, f) })],
];
const rows0 = stats(DEFAULT_CANOPY);
for (const [label, make] of thresholdVariants) {
  for (const f of [0.8, 1, 1.2]) {
    const cs = classes(rows0, make(f));
    out.push(`${label.padEnd(40)} | ${pct(f).padEnd(6)}              | ${count(cs)} | ${cs.filter((c, i) => c !== base[i]).length}`);
  }
}

// 2. Scoring constants: reconstruct each house once per variant (seed 7) and summarise.
function summary(p: MetricParams) {
  const ms = houses.map((h) => reconstructOnce(h, 7, p).metrics);
  const a = aggregateSeed(ms);
  return {
    thin: a.thinFaces,
    rect: a.rectilinearity.median,
    bnd: a.truth.medianBoundaryM,
    hd95: a.truth.medianHd95M,
    mae: a.truth.medianFacePitchMAE,
    w1: a.truth.medianWithin1Pct,
    n: ms.filter((m) => m.truth?.comparable).length,
  };
}
const f2 = (x: number | null) => (x === null ? '-' : x.toFixed(3));
out.push('', 'Scoring constants (dev houses, seed 7)', 'constant | value | thin faces | median rectilinearity | median boundary m | median HD95 m | median face pitch MAE | median share within 1/12');
const metricVariants: [string, (f: number) => MetricParams, string][] = [
  ['thinM: a thin face is under (m)', (f) => ({ ...DEFAULT_METRICS, thinM: scale(DEFAULT_METRICS.thinM, f) }), String(DEFAULT_METRICS.thinM)],
  ['rectToleranceDeg', (f) => ({ ...DEFAULT_METRICS, rectToleranceDeg: scale(DEFAULT_METRICS.rectToleranceDeg, f) }), String(DEFAULT_METRICS.rectToleranceDeg)],
  ['boundaryStepM', (f) => ({ ...DEFAULT_METRICS, truth: { ...DEFAULT_METRICS.truth, boundaryStepM: scale(DEFAULT_METRICS.truth.boundaryStepM, f) } }), String(DEFAULT_METRICS.truth.boundaryStepM)],
  ['matchMinSqFt', (f) => ({ ...DEFAULT_METRICS, truth: { ...DEFAULT_METRICS.truth, matchMinSqFt: scale(DEFAULT_METRICS.truth.matchMinSqFt, f) } }), String(DEFAULT_METRICS.truth.matchMinSqFt)],
  ['matchMinOverlap', (f) => ({ ...DEFAULT_METRICS, truth: { ...DEFAULT_METRICS.truth, matchMinOverlap: scale(DEFAULT_METRICS.truth.matchMinOverlap, f) } }), String(DEFAULT_METRICS.truth.matchMinOverlap)],
];
for (const [label, make, value] of metricVariants) {
  for (const f of [0.8, 1, 1.2]) {
    const s = summary(make(f));
    out.push(`${label.padEnd(32)} | ${(f === 1 ? value : String(scale(Number(value), f))).padEnd(6)} (${pct(f).padEnd(6)}) | ${s.thin} | ${f2(s.rect)} | ${f2(s.bnd)} | ${f2(s.hd95)} | ${f2(s.mae)} | ${s.w1 === null ? '-' : s.w1.toFixed(1)}`);
  }
}
out.push('', `median of ${median(houses.map((h) => h.entry.tags.canopy?.rimShare ?? 0)).toFixed(3)} is the dev houses' median rim share.`);
process.stdout.write(`${out.join('\n')}\n`);
