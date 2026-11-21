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
 *   npm run roof3d:dump -w @roofline/api -- --out DIR [--house a,b] [--set testset-ev] [--features]
 *
 * --features also writes <slug>.features.json: the measurements behind each line's name (LineFeatures), in UTM metres
 * (originX + x, originY + y), for studying the naming rules against an answer key.
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
  let rows: unknown[] | null = null;
  const roof = roofOnLayers(h.layers, entry.point, {
    steep: steepRoof(h.building),
    building: h.building,
    seed: 7,
    ...(argv.includes('--debug') ? { debug: (m: string) => process.stdout.write(`[${entry.slug}] ${m}\n`) } : {}),
    ...(argv.includes('--features') ? { lineFeatures: (r) => (rows = r) } : {}),
    ...(tuning !== undefined ? { tuning } : {}),
    ...(hiddenEdge !== undefined ? { hiddenEdge } : {}),
  });
  writeFileSync(path.join(out, `${entry.slug}.json`), JSON.stringify(roof));
  if (rows !== null) writeFileSync(path.join(out, `${entry.slug}.features.json`), JSON.stringify({ originX: h.layers.originX, originY: h.layers.originY, epsg: h.layers.epsg, rows }));
  n++;
}
process.stdout.write(`${n} houses written to ${out}\n`);
