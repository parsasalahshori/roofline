import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { benchDir } from '../bench/roof3d/paths.ts';
import { type TreeCandidate, metresBetween, rankRegion, treeSlug } from '../bench/roof3d/trees.ts';
import { REGION_QUOTA } from './roof-3d-bench-candidates.ts';

/*
 * Buys Google Solar Data Layers for tree-heavy houses and files them as benchmark houses:
 *
 *   npm run roof3d:bench-fetch -w @roofline/api -- [--go] [--regions a,b] [--metro NAME] [--ids a,b] [--out-set testset-NAME] [--more N] [--spill] [--max-houses 30] [--max-layers 40] [--max-insights 90]
 *
 * Without --go it only prints the houses it would try (no request, no cost). Candidates are the neighbourhood files
 * roof-3d-bench-candidates.ts wrote. For each region, in the order of trees.ts: buildingInsights (HIGH imagery required);
 * the building must be the candidate's house (Google's centre within 15 m of it), house-sized (900 to 6,000 sq ft of
 * roof ground area) with a pitched main roof; then ONE Data Layers request at 0.1 m (and a Geocodio reverse lookup
 * for the address). Everything lands in <ROOF_BENCH_DIR>/testset-trees/<slug>/ in the layout of the earlier sets,
 * with the download date (Google's terms: keep 30 days, then delete) and the free-source scores that picked it.
 *
 * Spend is capped by a ledger (<ROOF_BENCH_DIR>/fetch-ledger.json) that persists across runs: at most --max-layers
 * Data Layers requests (the owner's budget for this task: 40) and --max-insights buildingInsights requests, ever.
 * Keys come from the repository's .env.keys (GOOGLE_MAPS_API_KEY, else GOOGLE_SOLAR_API_KEY; GEOCODIO_API_KEY); they
 * and the URLs holding them are never printed or written.
 */

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SOLAR = 'https://solar.googleapis.com/v1';
const SQ_FT_PER_M2 = 10.7639104167;
/** Google's building centre must be this close to the candidate's outline centre. */
const MATCH_M = 15;
const MIN_FOOTPRINT_SQFT = 900;
const MAX_FOOTPRINT_SQFT = 6000;
const MIN_MAIN_PITCH_X12 = 2.5;

const Ledger = z.object({
  insights: z.number().int(),
  layers: z.number().int(),
  geocodes: z.number().int(),
  tried: z.record(z.string(), z.object({ at: z.string(), outcome: z.string() })),
});
type Ledger = z.infer<typeof Ledger>;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

function key(name: string, fallback?: string): string {
  const fromEnv = process.env[name] ?? (fallback ? process.env[fallback] : undefined);
  if (fromEnv) return fromEnv;
  // The keys file is not committed, so a worktree has none: the main checkout's (or ROOF_BENCH_KEYS) is used.
  const file = [process.env.ROOF_BENCH_KEYS, path.join(REPO_ROOT, '.env.keys'), '/Users/parsasalahshori-a/roofline-demo/.env.keys'].find((f) => f !== undefined && existsSync(f));
  const text = file === undefined ? '' : readFileSync(file, 'utf8');
  for (const n of [name, fallback].filter((x): x is string => x !== undefined)) {
    const found = new RegExp(`^${n}=(\\S+)$`, 'm').exec(text)?.[1];
    if (found) return found;
  }
  throw new Error(`${name} is not set (environment or .env.keys)`);
}

/** GET JSON. Failures name the status and path only: the URL holds the key. */
async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body };
}

async function getBytes(url: string): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    if (res.status < 500) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`gave up on ${new URL(url).pathname}`);
}

const num = (o: unknown, ...k: string[]): number | null => {
  let v: unknown = o;
  for (const x of k) v = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[x] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

async function main(): Promise<number> {
  const go = process.argv.includes('--go');
  const maxHouses = arg('--max-houses', 30);
  const maxLayers = arg('--max-layers', 40);
  const maxInsights = arg('--max-insights', 90);
  const bench = benchDir();
  // --out-set NAME: file the houses in another set folder (e.g. testset-xf: houses outside the frozen manifest).
  const osi = process.argv.indexOf('--out-set');
  const outSet = osi >= 0 ? process.argv[osi + 1]! : 'testset-trees';
  if (!/^testset-[a-z0-9-]+$/.test(outSet)) {
    process.stderr.write('--out-set takes a folder name testset-<name>\n');
    return 2;
  }
  const outRoot = path.join(bench, outSet);
  const candDir = path.join(bench, 'trees-candidates');
  const hoodFiles = existsSync(candDir) ? readdirSync(candDir).filter((f) => f.startsWith('hood-') && f.endsWith('.json')).sort() : [];
  if (hoodFiles.length === 0) {
    process.stderr.write(`No candidates in ${candDir}: run roof3d:bench-candidates first.\n`);
    return 3;
  }
  const ri = process.argv.indexOf('--regions');
  const onlyRegions = ri >= 0 ? new Set(process.argv[ri + 1]!.split(',')) : null;
  const ii = process.argv.indexOf('--ids');
  const onlyIds = ii >= 0 ? new Set(process.argv[ii + 1]!.split(',')) : null;
  const mi = process.argv.indexOf('--metro');
  const onlyMetro = mi >= 0 ? process.argv[mi + 1]! : null;
  const candidates = hoodFiles
    .flatMap((f) => JSON.parse(readFileSync(path.join(candDir, f), 'utf8')) as TreeCandidate[])
    .filter((c) => (onlyRegions === null || onlyRegions.has(c.region)) && (onlyMetro === null || c.metro === onlyMetro))
    // --ids a,b: only these candidates (picked beforehand, e.g. for lidar coverage), still in the ranking's order
    .filter((c) => onlyIds === null || onlyIds.has(c.id));
  const ledgerFile = path.join(bench, 'fetch-ledger.json');
  const ledger: Ledger = existsSync(ledgerFile) ? Ledger.parse(JSON.parse(readFileSync(ledgerFile, 'utf8'))) : { insights: 0, layers: 0, geocodes: 0, tried: {} };
  const save = () => writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 1)}\n`);

  // Houses already in the benchmark (any set): never buy the same one twice.
  const have: { lat: number; lng: number }[] = [];
  for (const set of [...new Set(['testset', 'testset-ev', 'testset-trees', outSet])]) {
    const root = path.join(bench, set);
    if (!existsSync(root)) continue;
    for (const slug of readdirSync(root)) {
      const f = path.join(root, slug, 'info.json');
      if (existsSync(f)) {
        const i = JSON.parse(readFileSync(f, 'utf8')) as { lat?: number; lng?: number };
        if (typeof i.lat === 'number' && typeof i.lng === 'number') have.push({ lat: i.lat, lng: i.lng });
      }
    }
  }
  const alreadyHouses = readdirSync(existsSync(outRoot) ? outRoot : bench).filter((n) => n.startsWith('tr-')).length;

  const regions = Object.keys(REGION_QUOTA).filter((r) => onlyRegions === null || onlyRegions.has(r));
  const ranked = new Map(regions.map((r) => [r, rankRegion(candidates.filter((c) => c.region === r && ledger.tried[c.id] === undefined), have)]));
  const plan: TreeCandidate[] = [];
  for (const r of regions) plan.push(...ranked.get(r)!.slice(0, REGION_QUOTA[r]! + 4));
  process.stdout.write(`${candidates.length} candidates, ${alreadyHouses} tree houses already bought; ledger: ${ledger.insights} insights, ${ledger.layers} layers\n`);
  for (const r of regions) process.stdout.write(`  ${r.padEnd(18)} quota ${REGION_QUOTA[r]}, ${ranked.get(r)!.length} usable candidates, top: ${ranked.get(r)!.slice(0, 3).map((c) => `${c.id}(${c.kind[0]} ${c.over.toFixed(2)}/${c.ring.toFixed(2)})`).join(' ')}\n`);
  if (!go) {
    process.stdout.write('Dry run (no --go): nothing bought.\n');
    return 0;
  }
  const googleKey = key('GOOGLE_SOLAR_API_KEY', 'GOOGLE_MAPS_API_KEY');
  const geocodio = key('GEOCODIO_API_KEY');
  const today = new Date().toLocaleDateString('en-CA');
  let bought = alreadyHouses;
  const perRegion = new Map<string, number>();
  for (const dir of existsSync(outRoot) ? readdirSync(outRoot) : []) {
    const f = path.join(outRoot, dir, 'info.json');
    if (existsSync(f)) {
      const i = JSON.parse(readFileSync(f, 'utf8')) as { region?: string };
      if (i.region) perRegion.set(i.region, (perRegion.get(i.region) ?? 0) + 1);
    }
  }
  // Each region up to its quota.
  // --more N: N houses beyond what the selected regions already have (to top a region up, e.g. one metro of it).
  const moreIdx = process.argv.indexOf('--more');
  const more = moreIdx >= 0 ? Number(process.argv[moreIdx + 1]) : null;
  const passes: { region: string; limit: number }[][] = [regions.map((r) => ({ region: r, limit: more !== null ? (perRegion.get(r) ?? 0) + more : REGION_QUOTA[r]! }))];
  // --spill: with budget left, up to 4 more in each region (the regions where a quota could not be met are short).
  if (process.argv.includes('--spill')) passes.push(regions.map((r) => ({ region: r, limit: REGION_QUOTA[r]! + 4 })));
  for (const pass of passes) {
    for (const { region, limit } of pass) {
      for (const c of ranked.get(region)!) {
        if (bought >= maxHouses || ledger.layers >= maxLayers) break;
        if ((perRegion.get(region) ?? 0) >= limit) break;
        if (ledger.tried[c.id] !== undefined) continue;
        if (ledger.insights >= maxInsights) {
          process.stdout.write('buildingInsights cap reached\n');
          save();
          return 0;
        }
        const note = (outcome: string) => {
          ledger.tried[c.id] = { at: new Date().toISOString(), outcome };
          save();
          process.stdout.write(`${c.id} (${c.metro}, ${c.neighbourhood}; ${c.kind} ${c.over.toFixed(2)}/${c.ring.toFixed(2)}): ${outcome}\n`);
        };
        ledger.insights++;
        save();
        const bi = await getJson(`${SOLAR}/buildingInsights:findClosest?location.latitude=${c.lat}&location.longitude=${c.lng}&requiredQuality=HIGH&key=${encodeURIComponent(googleKey)}`);
        if (bi.status !== 200) {
          note(bi.status === 404 ? 'no HIGH imagery' : `buildingInsights HTTP ${bi.status}`);
          continue;
        }
        const centre = { lat: num(bi.body, 'center', 'latitude'), lng: num(bi.body, 'center', 'longitude') };
        if (centre.lat === null || centre.lng === null) {
          note('no building centre');
          continue;
        }
        const away = metresBetween({ lat: centre.lat, lng: centre.lng }, c);
        if (away > MATCH_M) {
          note(`another building (${away.toFixed(0)} m away)`);
          continue;
        }
        const segs = ((bi.body as { solarPotential?: { roofSegmentStats?: unknown[] } }).solarPotential?.roofSegmentStats ?? []) as { pitchDegrees?: number; stats?: { areaMeters2?: number; groundAreaMeters2?: number } }[];
        const ground = segs.reduce((t, s) => t + (s.stats?.groundAreaMeters2 ?? 0), 0) * SQ_FT_PER_M2;
        const main = segs.reduce<(typeof segs)[number] | null>((m, s) => (m === null || (s.stats?.areaMeters2 ?? 0) > (m.stats?.areaMeters2 ?? 0) ? s : m), null);
        const pitch = main?.pitchDegrees === undefined ? 0 : Math.tan((main.pitchDegrees * Math.PI) / 180) * 12;
        if (ground < MIN_FOOTPRINT_SQFT || ground > MAX_FOOTPRINT_SQFT || pitch < MIN_MAIN_PITCH_X12) {
          note(`skipped (footprint ${ground.toFixed(0)} sq ft, main pitch ${pitch.toFixed(1)}/12)`);
          continue;
        }
        ledger.layers++;
        save();
        const dl = await getJson(
          `${SOLAR}/dataLayers:get?location.latitude=${centre.lat}&location.longitude=${centre.lng}&radiusMeters=30&view=IMAGERY_LAYERS&requiredQuality=HIGH&pixelSizeMeters=0.1&key=${encodeURIComponent(googleKey)}`,
        );
        const urls = dl.body as Record<string, unknown>;
        if (dl.status !== 200 || typeof urls.dsmUrl !== 'string' || typeof urls.maskUrl !== 'string' || typeof urls.rgbUrl !== 'string') {
          note(`dataLayers HTTP ${dl.status}`);
          continue;
        }
        const slug = treeSlug(c);
        const dir = path.join(outRoot, slug);
        mkdirSync(dir, { recursive: true });
        for (const [name, url] of [['dsm', urls.dsmUrl], ['mask', urls.maskUrl], ['rgb', urls.rgbUrl]] as const) {
          writeFileSync(path.join(dir, `${name}.tif`), await getBytes(`${url}&key=${encodeURIComponent(googleKey)}`));
        }
        writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(Object.fromEntries(Object.entries(urls).filter(([k]) => !k.endsWith('Url')))));
        writeFileSync(path.join(dir, 'bi.json'), JSON.stringify(bi.body));
        ledger.geocodes++;
        const geo = await getJson(`https://api.geocod.io/v1.7/reverse?q=${centre.lat},${centre.lng}&limit=1&api_key=${encodeURIComponent(geocodio)}`);
        const address = (geo.body as { results?: { formatted_address?: string }[] }).results?.[0]?.formatted_address ?? '(no address)';
        writeFileSync(
          path.join(dir, 'info.json'),
          JSON.stringify({
            slug,
            kind: `trees ${c.kind}, ${c.neighbourhood}`,
            address,
            lat: centre.lat,
            lng: centre.lng,
            segments: segs.length,
            footprint_sqft: Math.round(ground),
            main_pitch_x12: Math.round(pitch * 10) / 10,
            imagery: (bi.body as { imageryQuality?: string }).imageryQuality ?? null,
            region: c.region,
            metro: c.metro,
            state: c.state,
            downloadedAt: today,
            selection: { source: 'naip+osm prescreen', osm: c.id, neighbourhood: c.neighbourhood, kind: c.kind, crownOverOutline: c.over, crownInRing6m: c.ring, osmAreaM2: c.areaM2 },
          }),
        );
        writeFileSync(path.join(dir, 'osm.json'), JSON.stringify({ ring: c.footprint, source: 'OpenStreetMap contributors (ODbL)', way: c.id }));
        bought++;
        perRegion.set(region, (perRegion.get(region) ?? 0) + 1);
        note(`bought ${slug}: ${address} | ${ground.toFixed(0)} sq ft | main ${pitch.toFixed(1)}/12`);
      }
    }
  }
  save();
  process.stdout.write(`${bought} tree houses; ledger: ${ledger.insights} buildingInsights, ${ledger.layers} Data Layers, ${ledger.geocodes} reverse geocodes\n`);
  return 0;
}

/** Error text with anything key-shaped removed: a failure must never print a credential. */
function scrub(text: string): string {
  return text.replace(/(key|api_key)=[^&\s"']+/gi, '$1=<redacted>');
}

process.exitCode = await main().catch((err: unknown) => {
  process.stderr.write(`${scrub(err instanceof Error ? `${err.name}: ${err.message}` : String(err))}\n`);
  return 1;
});
