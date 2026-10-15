import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fromArrayBuffer } from 'geotiff';

/*
 * Candidate tree-heavy houses for the roof benchmark, found WITHOUT any paid request:
 *
 *   npm run roof3d:bench-candidates -w @roofline/api -- [--out DIR] [--regions seattle-portland,houston]
 *
 * For each leafy neighbourhood in NEIGHBOURHOODS: the house-sized building outlines OpenStreetMap has there (Overpass,
 * ODbL), and the USGS National Agriculture Imagery Program photo of the same square (public domain, 4 bands, about
 * 0.6 m, taken in the growing season). A pixel is "crown" when it is vegetated (NDVI >= 0.30, or the tile's 65th
 * percentile when the tile is mostly below that: imagery out of leaf) and dark (mean of red,
 * green and blue <= 95 of 255): lawn is vegetated but bright. Per outline we keep the crown share over the outline
 * (trees hiding the roof, `over`) and in the 6 m round it (trees beside the roof, `ring`). The output
 * (candidates.json) ranks them per region for roof-3d-bench-fetch.ts, which buys Google's layers for the best ones.
 * This is only a pre-screen so the few paid requests go to houses worth testing; the benchmark's own canopy cohort is
 * measured on Google's height map and photo (bench/roof3d/cohorts.ts), not on this.
 */

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
void REPO_ROOT;
const UA = 'roofline-bench/1.0 (internal R&D; contact: owner)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const NAIP = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage';
const K = (Math.PI / 180) * 6371008.8;
/** Search radius round a neighbourhood centre, metres. */
const RADIUS_M = 450;
/** The NAIP square is the search circle plus this margin, metres. */
const MARGIN_M = 40;
const NAIP_PX_M = 0.8;
/** House-sized outlines (OSM footprint, square metres): 1,130 to 6,000 sq ft. Google's own area is checked later. */
const MIN_AREA_M2 = 105;
const MAX_AREA_M2 = 560;
const NDVI_MIN = 0.3;
const DARK_MAX = 95;
const RING_M = 6;

type Hood = { region: string; metro: string; state: string; name: string; lat: number; lng: number };
export const NEIGHBOURHOODS: Hood[] = [
  ...[
    ['Hillcrest', 34.7535, -92.301],
    ['Edgehill', 34.76, -92.335],
    ['Pleasant Valley', 34.765, -92.4],
    ['Heights north', 34.7745, -92.3395],
    ['Westover Hills', 34.7365, -92.3485],
  ].map(([name, lat, lng]) => ({ region: 'little-rock', metro: 'Little Rock', state: 'AR', name: name as string, lat: lat as number, lng: lng as number })),
  ...[
    ['Lakewood', 34.81, -92.243],
    ['Park Hill', 34.787, -92.256],
    ['Indian Hills', 34.812, -92.272],
  ].map(([name, lat, lng]) => ({ region: 'north-little-rock', metro: 'North Little Rock', state: 'AR', name: name as string, lat: lat as number, lng: lng as number })),
  ...[
    ['Wilson Park', 36.068, -94.156],
    ['Mount Sequoyah', 36.054, -94.169],
    ['Hamestring', 36.075, -94.21],
    ['Washington-Willow', 36.0545, -94.1625],
  ].map(([name, lat, lng]) => ({ region: 'fayetteville', metro: 'Fayetteville', state: 'AR', name: name as string, lat: lat as number, lng: lng as number })),
  ...[
    ['Belle Grove', 35.383, -94.427],
    ['Hillcrest', 35.348, -94.4],
    ['Lexington', 35.364, -94.4150],
    ['Chaffee Crossing', 35.317, -94.33],
  ].map(([name, lat, lng]) => ({ region: 'fort-smith', metro: 'Fort Smith', state: 'AR', name: name as string, lat: lat as number, lng: lng as number })),
  ...[
    ['Park Avenue', 34.498, -93.048],
    ['Lake Hamilton', 34.438, -93.09],
    ['Hot Springs Village', 34.67, -92.983],
    ['Mountain Road', 34.514, -93.055],
  ].map(([name, lat, lng]) => ({ region: 'hot-springs', metro: 'Hot Springs', state: 'AR', name: name as string, lat: lat as number, lng: lng as number })),
  ...[
    ['Morningside', 33.815, -84.35],
    ['Druid Hills', 33.787, -84.332],
    ['Oakhurst', 33.757, -84.298],
    ['Peachtree Hills', 33.824, -84.368],
    ['Kirkwood', 33.744, -84.326],
  ].map(([name, lat, lng]) => ({ region: 'atlanta', metro: 'Atlanta', state: 'GA', name: name as string, lat: lat as number, lng: lng as number })),
  ...[
    ['Myers Park', 35.193, -80.833],
    ['Dilworth', 35.206, -80.854],
    ['Plaza Midwood', 35.225, -80.81],
    ['Eastover', 35.198, -80.81],
  ].map(([name, lat, lng]) => ({ region: 'charlotte', metro: 'Charlotte', state: 'NC', name: name as string, lat: lat as number, lng: lng as number })),
  ...[
    ['Oakwood', 35.787, -78.625],
    ['Five Points', 35.805, -78.637],
    ['Hayes Barton', 35.792, -78.617],
    ['Cameron Park', 35.782, -78.655],
  ].map(([name, lat, lng]) => ({ region: 'raleigh', metro: 'Raleigh', state: 'NC', name: name as string, lat: lat as number, lng: lng as number })),
  ...[
    ['Belle Meade', 36.103, -86.86],
    ['Green Hills', 36.1, -86.81],
    ['Forest Hills', 36.06, -86.845],
    ['Lockeland Springs', 36.175, -86.75],
    ['Inglewood', 36.2, -86.72],
  ].map(([name, lat, lng]) => ({ region: 'nashville', metro: 'Nashville', state: 'TN', name: name as string, lat: lat as number, lng: lng as number })),
  ...[
    ['Hunters Creek', 29.775, -95.52],
    ['Spring Branch', 29.79, -95.5],
    ['Tanglewood', 29.74, -95.465],
    ['Oak Forest', 29.83, -95.42],
    ['Montrose', 29.74, -95.39],
  ].map(([name, lat, lng]) => ({ region: 'houston', metro: 'Houston', state: 'TX', name: name as string, lat: lat as number, lng: lng as number })),
  ...[
    ['Preston Hollow', 32.87, -96.795],
    ['Lake Highlands', 32.905, -96.73],
    ['Kessler Park', 32.74, -96.845],
    ['Tarrytown', 30.3, -97.77],
    ['Barton Hills', 30.25, -97.775],
    ['Travis Heights', 30.24, -97.74],
    ['Allandale', 30.35, -97.74],
  ].map(([name, lat, lng]) => ({ region: 'dallas-austin', metro: (name as string).includes('Tarry') || (name as string).includes('Barton') || (name as string).includes('Travis') || (name as string).includes('Allan') ? 'Austin' : 'Dallas', state: 'TX', name: name as string, lat: lat as number, lng: lng as number })),
  ...[
    ['Ravenna', 47.678, -122.3],
    ['Magnolia', 47.648, -122.4],
    ['Maple Leaf', 47.702, -122.32],
    ['Wedgwood', 47.69, -122.265],
    ['Laurelhurst', 45.527, -122.625],
    ['Alameda', 45.553, -122.635],
    ['Eastmoreland', 45.48, -122.63],
    ['Hillsdale', 45.485, -122.71],
  ].map(([name, lat, lng]) => ({ region: 'seattle-portland', metro: (lat as number) > 46 ? 'Seattle' : 'Portland', state: (lat as number) > 46 ? 'WA' : 'OR', name: name as string, lat: lat as number, lng: lng as number })),
];

/** How many houses each region should end up with (roof-3d-bench-fetch.ts); up to 30 in all. */
export const REGION_QUOTA: Record<string, number> = {
  'little-rock': 4,
  'north-little-rock': 2,
  fayetteville: 2,
  'fort-smith': 2,
  'hot-springs': 2,
  atlanta: 3,
  charlotte: 2,
  raleigh: 2,
  nashville: 2,
  houston: 2,
  'dallas-austin': 3,
  'seattle-portland': 3,
};

export type Candidate = {
  id: string;
  region: string;
  metro: string;
  state: string;
  neighbourhood: string;
  lat: number;
  lng: number;
  areaM2: number;
  /** Share of the outline under crown pixels. */
  over: number;
  /** Share of the 6 m ring round it under crown pixels. */
  ring: number;
  kind: 'over' | 'beside';
  score: number;
  /** [lng, lat] ring (ODbL, OpenStreetMap contributors). */
  footprint: [number, number][];
};

type Way = { id: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] };

async function overpass(hood: Hood): Promise<Way[]> {
  const q = `[out:json][timeout:60];way["building"~"^(house|detached|residential|semidetached_house|bungalow|yes)$"](around:${RADIUS_M},${hood.lat},${hood.lng});out geom tags;`;
  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length]!;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(q)}`, signal: AbortSignal.timeout(40_000) });
      if (res.ok) return ((await res.json()) as { elements: Way[] }).elements;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`Overpass for ${hood.name}: ${lastErr}`);
}

type Crowns = { w: number; h: number; tree: Uint8Array; west: number; north: number; pxLng: number; pxLat: number };

async function crownsAround(hood: Hood): Promise<Crowns> {
  const half = RADIUS_M + MARGIN_M;
  const dLat = half / K;
  const dLng = half / (K * Math.cos((hood.lat * Math.PI) / 180));
  const west = hood.lng - dLng;
  const east = hood.lng + dLng;
  const south = hood.lat - dLat;
  const north = hood.lat + dLat;
  const px = Math.round((2 * half) / NAIP_PX_M);
  const url = `${NAIP}?bbox=${west},${south},${east},${north}&bboxSR=4326&imageSR=4326&size=${px},${px}&format=tiff&pixelType=U8&interpolation=RSP_BilinearInterpolation&f=image`;
  let bytes: ArrayBuffer | null = null;
  for (let attempt = 0; attempt < 4 && bytes === null; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(120_000) });
      if (res.ok && (res.headers.get('content-type') ?? '').includes('tiff')) bytes = await res.arrayBuffer();
    } catch {
      /* retry */
    }
    if (bytes === null) await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  if (bytes === null) throw new Error(`NAIP for ${hood.name} did not come`);
  const image = await (await fromArrayBuffer(bytes)).getImage();
  const w = image.getWidth();
  const h = image.getHeight();
  if (image.getSamplesPerPixel() < 4) throw new Error('NAIP without its infrared band');
  const r = (await image.readRasters()) as unknown as ArrayLike<number>[];
  const tree = new Uint8Array(w * h);
  const ndviOf = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) ndviOf[i] = (r[3]![i]! - r[0]![i]!) / (r[3]![i]! + r[0]![i]! + 1e-6);
  // Imagery taken out of leaf (or of evergreens) has lower NDVI everywhere: when fewer than a third of the tile reaches
  // NDVI_MIN, the limit drops to the tile's 65th percentile (never under 0.10), so a leaf-off tile still shows crowns.
  const sorted = Float32Array.from(ndviOf).sort();
  const ndviLimit = Math.min(NDVI_MIN, Math.max(0.1, sorted[Math.floor(sorted.length * 0.65)]!));
  for (let i = 0; i < w * h; i++) {
    if (ndviOf[i]! >= ndviLimit && (r[0]![i]! + r[1]![i]! + r[2]![i]!) / 3 <= DARK_MAX) tree[i] = 1;
  }
  return { w, h, tree, west, north, pxLng: (east - west) / w, pxLat: (north - south) / h };
}

function inPoly(x: number, y: number, ring: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function distToRing(x: number, y: number, ring: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i]!;
    const [bx, by] = ring[(i + 1) % ring.length]!;
    const dx = bx - ax;
    const dy = by - ay;
    const t = dx * dx + dy * dy > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

function scoreWay(way: Way, hood: Hood, crowns: Crowns): Candidate | null {
  const geom = way.geometry;
  if (!geom || geom.length < 5) return null;
  const t = way.tags ?? {};
  if (t.amenity || t.shop || t.office || t.tourism || t.man_made || t.power || (t['building:levels'] && Number(t['building:levels']) >= 4)) return null;
  const cos = Math.cos((hood.lat * Math.PI) / 180);
  const ring: [number, number][] = geom.slice(0, -1).map((p) => [(p.lon - hood.lng) * K * cos, (p.lat - hood.lat) * K]);
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    a += x1 * y2 - x2 * y1;
  }
  const area = Math.abs(a) / 2;
  if (area < MIN_AREA_M2 || area > MAX_AREA_M2) return null;
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const pad = RING_M + 1;
  let inside = 0;
  let insideTree = 0;
  let band = 0;
  let bandTree = 0;
  for (let y = Math.min(...ys) - pad; y <= Math.max(...ys) + pad; y += NAIP_PX_M) {
    for (let x = Math.min(...xs) - pad; x <= Math.max(...xs) + pad; x += NAIP_PX_M) {
      const lng = hood.lng + x / (K * cos);
      const lat = hood.lat + y / K;
      const c = Math.floor((lng - crowns.west) / crowns.pxLng);
      const r = Math.floor((crowns.north - lat) / crowns.pxLat);
      if (c < 0 || r < 0 || c >= crowns.w || r >= crowns.h) continue;
      const isTree = crowns.tree[r * crowns.w + c] === 1;
      if (inPoly(x, y, ring)) {
        inside++;
        if (isTree) insideTree++;
      } else if (distToRing(x, y, ring) <= RING_M) {
        band++;
        if (isTree) bandTree++;
      }
    }
  }
  if (inside < 20 || band < 20) return null;
  const over = insideTree / inside;
  const ringShare = bandTree / band;
  const cx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const cy = ys.reduce((s, v) => s + v, 0) / ys.length;
  // Wanted: crowns over the outline (up to 0.6 counts in full), and trees all round it (up to 0.7).
  const score = 0.6 * Math.min(over, 0.6) / 0.6 + 0.4 * Math.min(ringShare, 0.7) / 0.7;
  return {
    id: `osm-${way.id}`,
    region: hood.region,
    metro: hood.metro,
    state: hood.state,
    neighbourhood: hood.name,
    lat: Math.round((hood.lat + cy / K) * 1e7) / 1e7,
    lng: Math.round((hood.lng + cx / (K * cos)) * 1e7) / 1e7,
    areaM2: Math.round(area),
    over: Math.round(over * 1000) / 1000,
    ring: Math.round(ringShare * 1000) / 1000,
    kind: over >= 0.25 ? 'over' : 'beside',
    score: Math.round(score * 1000) / 1000,
    footprint: geom.map((p) => [Math.round(p.lon * 1e7) / 1e7, Math.round(p.lat * 1e7) / 1e7]),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const oi = argv.indexOf('--out');
  const outDir = path.resolve(oi >= 0 ? argv[oi + 1]! : path.join(process.env.ROOF_BENCH_DIR ?? '/Users/parsasalahshori-a/RooflineWork/roof-bench', 'trees-candidates'));
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'candidates.json');
  const all: Candidate[] = [];
  const done: string[] = [];
  const ri = argv.indexOf('--regions');
  const only = ri >= 0 ? new Set(argv[ri + 1]!.split(',')) : null;
  for (const hood of NEIGHBOURHOODS) {
    if (only !== null && !only.has(hood.region)) continue;
    const cacheFile = path.join(outDir, `hood-${hood.region}-${hood.name.replace(/\W+/g, '_')}.json`);
    if (existsSync(cacheFile)) {
      all.push(...(JSON.parse(readFileSync(cacheFile, 'utf8')) as Candidate[]));
      done.push(hood.name);
      continue;
    }
    try {
      const ways = await overpass(hood);
      const crowns = await crownsAround(hood);
      const found = ways.map((w) => scoreWay(w, hood, crowns)).filter((c): c is Candidate => c !== null);
      writeFileSync(cacheFile, JSON.stringify(found));
      all.push(...found);
      process.stdout.write(`${hood.metro} / ${hood.name}: ${ways.length} buildings, ${found.length} house-sized, ${found.filter((c) => c.over >= 0.15).length} with crowns over the roof\n`);
    } catch (err) {
      process.stdout.write(`${hood.metro} / ${hood.name}: ${(err as Error).message}\n`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (only === null) {
    writeFileSync(outFile, JSON.stringify(all));
    process.stdout.write(`${all.length} candidates from ${done.length} cached + fresh neighbourhoods -> ${outFile}\n`);
  } else process.stdout.write(`${all.length} candidates in ${[...only].join(', ')} (neighbourhood caches written; run without --regions to merge)\n`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
