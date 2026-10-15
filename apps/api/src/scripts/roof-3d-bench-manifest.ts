import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadHouse, type LoadedHouse } from '../bench/roof3d/data.ts';
import { HouseSchema, type HouseEntry, type Manifest, manifestHash, manifestProblems, parseManifest, SETS, SPLIT_RULE, splitOf } from '../bench/roof3d/manifest.ts';
import { benchDir } from '../bench/roof3d/paths.ts';
import { DEFAULT_THRESHOLDS, tagsOf } from '../bench/roof3d/tags.ts';

/*
 * Builds or extends <ROOF_BENCH_DIR>/manifest.json from the house folders under <ROOF_BENCH_DIR>/{testset,testset-ev,
 * testset-trees}/<slug>/ (dsm.tif, mask.tif, rgb.tif, bi.json, info.json, meta.json; eagleview.json or visual.json for
 * a truth; osm.json for an independent outline):
 *
 *   npm run roof3d:bench-manifest -w @roofline/api -- [--ev-targets FILE] [--explore] [--retag]
 *
 * Houses already in the manifest are left exactly as they are (their split, point and tags are frozen); new folders
 * are added with their tags computed now. --retag recomputes every house's tags (do it only when a threshold
 * changed on purpose: the baseline must then be frozen again). --explore prints each house's canopy numbers and
 * writes nothing. --ev-targets FILE gives each EagleView house its point (lines "slug@lat,lng@...").
 */

/** For houses downloaded before dates were recorded: no later than the first benchmark artefact (2026-10-11) plus 30 days. */
const UNKNOWN_DOWNLOAD_DELETE_BY = '2026-11-10';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateOf(v: unknown): string | null {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (typeof v === 'object' && v !== null) {
    const { year, month, day } = v as Record<string, unknown>;
    if (typeof year === 'number' && typeof month === 'number' && typeof day === 'number') return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

function json(file: string): Record<string, unknown> {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
}

/** "street, City, ST 12345" to state and metro. */
export function regionOf(address: string): { state: string; metro: string } {
  const m = /,\s*([^,]+),\s*([A-Z]{2})\b/.exec(address);
  return m ? { state: m[2]!, metro: m[1]!.trim() } : { state: '??', metro: '??' };
}

function evPoints(file: string | undefined): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  if (file === undefined) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /(?:^|\/)([\w.-]+)@(-?[\d.]+),\s*(-?[\d.]+)/.exec(line.trim());
    if (m) out.set(m[1]!.replace(/^.*\//, ''), [Number(m[3]), Number(m[2])]);
  }
  return out;
}

async function main(): Promise<number> {
  const bench = benchDir();
  const manifestFile = path.join(bench, 'manifest.json');
  const existing: Manifest | null = existsSync(manifestFile) ? parseManifest(JSON.parse(readFileSync(manifestFile, 'utf8'))) : null;
  const thresholds = existing?.thresholds ?? DEFAULT_THRESHOLDS;
  const byslug = new Map((existing?.houses ?? []).map((h) => [h.slug, h]));
  const points = evPoints(arg('--ev-targets'));
  const explore = flag('--explore');
  const retag = flag('--retag');
  const houses: HouseEntry[] = [];
  const rows: string[] = [];
  for (const set of SETS) {
    const root = path.join(bench, set);
    if (!existsSync(root)) continue;
    for (const slug of readdirSync(root).sort()) {
      const dir = path.join(root, slug);
      if (!existsSync(path.join(dir, 'dsm.tif'))) continue;
      const old = byslug.get(slug);
      if (old !== undefined && !retag && !explore) {
        houses.push(old);
        continue;
      }
      const info = json(path.join(dir, 'info.json'));
      const meta = json(path.join(dir, 'meta.json'));
      const bi = json(path.join(dir, 'bi.json'));
      const address = String(info.address ?? old?.address ?? slug);
      const evPoint = points.get(slug);
      const point: [number, number] = old?.point ?? evPoint ?? [Number(info.lng), Number(info.lat)];
      const truth = existsSync(path.join(dir, 'eagleview.json')) ? 'eagleview' : existsSync(path.join(dir, 'visual.json')) ? 'visual' : 'proxy';
      const downloadedAt = typeof info.downloadedAt === 'string' ? info.downloadedAt : null;
      const draft = {
        slug,
        set,
        dir: `${set}/${slug}`,
        point,
        address,
        region: typeof info.state === 'string' && typeof info.metro === 'string' ? { state: info.state, metro: info.metro } : regionOf(address),
        split: splitOf(slug),
        truth,
        tags: old?.tags ?? { canopy: null, complexity: { class: 'complex', faces: 0, source: 'google-segments' }, lowSlope: false, steep: false, mainPitchX12: null, pitchSource: 'google-segments' },
        data: {
          downloadedAt,
          deleteBy: downloadedAt !== null ? addDays(downloadedAt, 30) : UNKNOWN_DOWNLOAD_DELETE_BY,
          imageryQuality: typeof meta.imageryQuality === 'string' ? meta.imageryQuality : typeof bi.imageryQuality === 'string' ? bi.imageryQuality : null,
          imageryDate: dateOf(meta.imageryDate) ?? dateOf(bi.imageryDate),
        },
        ...(typeof info.selection === 'object' && info.selection !== null ? { selection: info.selection as Record<string, string | number | boolean> } : {}),
      } satisfies HouseEntry;
      const loaded: LoadedHouse = await loadHouse(draft, bench);
      const entry = HouseSchema.parse({ ...draft, tags: tagsOf(loaded, thresholds) });
      houses.push(entry);
      const c = entry.tags.canopy;
      rows.push(
        [
          slug.padEnd(24),
          entry.region.state,
          `roof ${c === null ? '  - ' : c.roofShare.toFixed(3)}`,
          `rim ${c === null ? '  - ' : c.rimShare.toFixed(3)}`,
          `bite ${c === null ? '  - ' : c.biteShare.toFixed(3)}`,
          (c?.class ?? '-').padEnd(5),
          `${entry.tags.complexity.class.padEnd(7)} ${String(entry.tags.complexity.faces).padStart(2)} ${entry.tags.complexity.source === 'eagleview' ? 'EV' : 'G '}`,
          `main ${entry.tags.mainPitchX12 ?? '-'}/12`.padEnd(11),
          entry.tags.lowSlope ? 'low' : '   ',
          entry.tags.steep ? 'steep' : '',
        ].join(' | '),
      );
    }
  }
  if (explore) {
    process.stdout.write(`${rows.join('\n')}\n`);
    return 0;
  }
  const manifest: Manifest = { version: 1, generatedAt: existing?.generatedAt ?? new Date().toISOString(), splitRule: SPLIT_RULE, thresholds, houses };
  const problems = manifestProblems(manifest);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    return 3;
  }
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 1)}\n`);
  process.stdout.write(`${houses.length} houses (${rows.length} new or retagged) -> ${manifestFile} [hash ${manifestHash(manifest)}]\n`);
  return 0;
}

process.exitCode = await main();
