// What the lidar hidden-edge step does on every house of a split (not a score: most houses have no answer key that
// can judge it; see roof-3d-lidar-eval.ts for the EagleView score). Outcome, edges moved, plan area change, runtime,
// and the crop's size and fetch cost. Held-out houses print counts only unless --reveal.
//   npx tsx src/scripts/roof-3d-lidar-coverage.ts [--split dev|heldout|all] [--reveal] [--param name=value ...]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadHouse } from '../bench/roof3d/data.ts';
import { readLidarEdgePoints } from '../bench/roof3d/lidar-edges.ts';
import { parseManifest } from '../bench/roof3d/manifest.ts';
import { benchDir } from '../bench/roof3d/paths.ts';
import { roofOnLayers, steepRoof } from '../estimator/roof-3d.ts';

const a = process.argv.slice(2);
const split = a.includes('--split') ? a[a.indexOf('--split') + 1]! : 'dev';
const reveal = a.includes('--reveal');
const params: Record<string, number | boolean> = {};
a.forEach((x, i) => {
  if (x !== '--param') return;
  const [k, v] = a[i + 1]!.split('=');
  params[k!] = v === 'true' ? true : v === 'false' ? false : Number(v);
});
const bench = benchDir();
const m = parseManifest(JSON.parse(readFileSync(path.join(bench, 'manifest.json'), 'utf8')));
const counts: Record<string, Record<string, number>> = {};
const rows: string[] = [];
const extraMs: number[] = [];
for (const e of m.houses) {
  if (split !== 'all' && e.split !== split) continue;
  const h = await loadHouse(e, bench);
  const lp = readLidarEdgePoints(bench, e.slug, e.data?.imageryDate ?? null);
  const base = { steep: steepRoof(h.building), building: h.building, seed: 7 };
  let t = performance.now();
  const off = roofOnLayers(h.layers, e.point, base);
  const msOff = performance.now() - t;
  t = performance.now();
  const on = lp === null ? null : roofOnLayers(h.layers, e.point, { ...base, lidar: lp.points, lidarParams: params });
  const msOn = performance.now() - t;
  const outcome = lp === null ? 'no-crop' : on?.lidarEdges === undefined ? 'no-roof' : on.lidarEdges.applied ? 'applied' : on.lidarEdges.reason ?? '?';
  const c = (counts[e.split] ??= {});
  c[outcome] = (c[outcome] ?? 0) + 1;
  if (lp !== null) extraMs.push(msOn - msOff);
  const area = (r: typeof off) => (r === null ? 0 : r.faces.reduce((s, f) => s + f.planAreaSqFt, 0) / 10.7639104167);
  if (e.split === 'dev' || reveal) {
    rows.push(
      `${e.slug.padEnd(26)} ${e.split.padEnd(7)} ${(e.tags.canopy?.class ?? '').padEnd(6)} ${e.set.padEnd(14)} ${outcome.padEnd(16)} ${lp === null ? '' : `${lp.info.ql ?? ''} ${lp.info.leafOff ? 'leaf-off' : 'leaf-on '} ${lp.info.fetchKind} ${((lp.info.fetchBytes ?? 0) / 1e6).toFixed(1)} MB fetch, ${(lp.info.cropBytes / 1e6).toFixed(2)} MB crop`} area ${area(off).toFixed(1)} -> ${on === null ? '-' : area(on).toFixed(1)} m2  moved ${(on?.lidarEdges?.moved ?? []).map((q) => (q.offsetFt / 3.2808).toFixed(2)).join(' ')}  +${(msOn - msOff).toFixed(0)} ms`,
    );
  }
}
console.log(rows.join('\n'));
console.log(JSON.stringify(counts));
extraMs.sort((x, y) => x - y);
console.log(`extra ms per house with a crop: p50 ${extraMs[Math.floor(extraMs.length / 2)]?.toFixed(0)} p95 ${extraMs[Math.floor(extraMs.length * 0.95)]?.toFixed(0)}`);
