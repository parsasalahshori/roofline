import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readInsights, readLayers } from '../bench/roof3d/data.ts';
import { parseExtraManifest, parseManifest } from '../bench/roof3d/manifest.ts';
import { benchDir, houseDir } from '../bench/roof3d/paths.ts';
import { hiddenEdgeFromEnv, tuningFromEnv } from '../bench/roof3d/run.ts';
import { roofOnLayers, steepRoof } from '../estimator/roof-3d.ts';

/*
 * Development only: writes each benchmark house's reconstruction (the stored Roof3d, as the server makes it at seed 7)
 * to <out>/<slug>.json, for drawing it against the answer key. Reads files only.
 *
 *   npm run roof3d:dump -w @roofline/api -- --out DIR [--house a,b] [--set testset-ev] [--manifest FILE] [--features]
 *
 * --manifest FILE reads another list of houses than the benchmark's own manifest.json: a manifest kept beside it (a
 * path, or a name inside the bench folder) for a set that must stay out of the frozen one, such as a sealed fresh set
 * of answer keys. Its houses' folders are looked up in the bench folder like any other.
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
const manifestArg = value('--manifest');
if (argv.includes('--manifest') && (manifestArg === undefined || manifestArg.startsWith('--'))) {
  process.stderr.write('--manifest takes a file\n');
  process.exit(2);
}
const manifestFile = manifestArg === undefined ? path.join(bench, 'manifest.json') : path.resolve(bench, manifestArg);
const manifestJson: unknown = JSON.parse(readFileSync(manifestFile, 'utf8'));
const manifest = manifestArg === undefined ? parseManifest(manifestJson) : parseExtraManifest(manifestJson);
const only = value('--house')?.split(',') ?? null;
const set = value('--set') ?? null;
const hiddenEdge = hiddenEdgeFromEnv();
const tuning = tuningFromEnv();
mkdirSync(out, { recursive: true });
let n = 0;
for (const entry of manifest.houses) {
  if (only !== null && !only.includes(entry.slug)) continue;
  if (set !== null && entry.set !== set) continue;
  const dir = houseDir(entry.dir, bench);
  if (dir === null) throw new Error(`no data for ${entry.slug} (looked for ${entry.dir}/dsm.tif)`);
  const h = { layers: await readLayers(dir), building: readInsights(dir).building };
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
