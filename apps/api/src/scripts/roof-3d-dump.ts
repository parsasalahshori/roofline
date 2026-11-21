import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadHouse } from '../bench/roof3d/data.ts';
import { parseManifest } from '../bench/roof3d/manifest.ts';
import { benchDir } from '../bench/roof3d/paths.ts';
import { hiddenEdgeFromEnv, tuningFromEnv } from '../bench/roof3d/run.ts';
import { roofOnLayers, steepRoof } from '../estimator/roof-3d.ts';

/*
 * Development only: writes each benchmark house's reconstruction (the stored Roof3d, as the server makes it at seed 7)
 * to <out>/<slug>.json, for drawing it against the answer key. Reads files only.
 *
 *   npm run roof3d:dump -w @roofline/api -- --out DIR [--house a,b] [--set testset-ev] [--debug] [--trace]
 *
 * --trace also writes <out>/<slug>.trace.json: the face label image by stage (after the plane search, after the face
 * cleanup, at the end), for studying where a face was lost.
 */
const argv = process.argv.slice(2);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const out = value('--out');
if (out === undefined) {
  process.stderr.write('--out DIR is required\n');
  process.exit(2);
}
const bench = benchDir();
const manifest = parseManifest(JSON.parse(readFileSync(path.join(bench, 'manifest.json'), 'utf8')));
const only = value('--house')?.split(',') ?? null;
const set = value('--set') ?? null;
const hiddenEdge = hiddenEdgeFromEnv();
const tuning = tuningFromEnv();
mkdirSync(out, { recursive: true });
let n = 0;
for (const entry of manifest.houses) {
  if (only !== null && !only.includes(entry.slug)) continue;
  if (set !== null && entry.set !== set) continue;
  const h = await loadHouse(entry, bench);
  const stages: Record<string, unknown> = {};
  const trace = argv.includes('--trace')
    ? (stage: string, d: { c0: number; r0: number; w: number; h: number; labels: Int32Array; planes: readonly { a: number; b: number; c: number }[] }) => {
        stages[stage] = { c0: d.c0, r0: d.r0, w: d.w, h: d.h, planes: d.planes, labels: Buffer.from(Int16Array.from(d.labels).buffer).toString('base64') };
      }
    : undefined;
  const roof = roofOnLayers(h.layers, entry.point, { steep: steepRoof(h.building), building: h.building, seed: 7, ...(argv.includes('--debug') ? { debug: (m: string) => process.stdout.write(`[${entry.slug}] ${m}\n`) } : {}), ...(trace !== undefined ? { trace } : {}), ...(tuning !== undefined ? { tuning } : {}), ...(hiddenEdge !== undefined ? { hiddenEdge } : {}) });
  if (trace !== undefined) writeFileSync(path.join(out, `${entry.slug}.trace.json`), JSON.stringify(stages));
  writeFileSync(path.join(out, `${entry.slug}.json`), JSON.stringify(roof));
  n++;
}
process.stdout.write(`${n} houses written to ${out}\n`);
