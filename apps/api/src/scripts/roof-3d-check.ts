import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LngLat, Roof3d, SolarBuilding } from '@roofline/shared';
import { lngLatToUtm, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import { checkRoof, formatCheck, withGoogleCheck } from '../estimator/roof-3d-compare.ts';
import { layersRequest, roofOnLayers, steepRoof } from '../estimator/roof-3d.ts';
import { encodeRgbPng } from '../estimator/png.ts';
import { parseBuildingInsights } from '../providers/google-solar.ts';
import { layersFrom, readGeoTiff, readRgbGeoTiff } from '../providers/google-solar-layers.ts';
import type { RoofLayers } from '../providers/solar-layers.ts';

/*
 * The 3D roof on real Google data, house by house: the faces against Google Solar's own roof segments, the outline
 * against Google's roof mask, the quality result, and the acceptance targets (estimator/roof-3d-compare.ts).
 *
 *   npm run roof3d:check -w @roofline/api -- [--cache DIR] [--svg DIR] [--json DIR] TARGET...
 *
 * TARGET is one of:
 *   "lat,lng"                     a point on the roof
 *   "305 Ridgeway Dr, Little Rock, AR 72205"   an address (looked up with Geocodio)
 *   DIR@lat,lng[@INSIGHTS]        a folder already holding dsm.tif and mask.tif (and rgb.tif) as Google serves them,
 *                                 the point, and Google's buildingInsights answer (raw JSON or a SolarBuilding)
 *   @FILE                         one target a line (blank lines and lines starting with # are skipped)
 *
 * A point or an address costs one Google Solar buildingInsights request and one Data Layers request (an Enterprise SKU:
 * 1,000 free a month, then about $75 per 1,000). Everything Google sends is kept in the cache folder (default
 * .roof-3d-cache at the repository root, git-ignored), so running the same house again never buys again. The Solar API
 * terms allow keeping it 30 days: empty the folder after that. Keys: GOOGLE_SOLAR_API_KEY (else GOOGLE_MAPS_API_KEY)
 * and GEOCODIO_API_KEY from the environment, else from the repository's .env.keys. They are never printed.
 * --svg DIR writes a picture of each roof over Google's photo; --json DIR writes each house's whole result (outline,
 * faces, lines in [lng, lat] with feet and square feet, totals, the quality result and the check) to DIR/<house>.json.
 * A summary table of the targets per house ends the run. Exit code 1 when any house misses a target.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOLAR = 'https://solar.googleapis.com/v1';

function key(name: string, fallback?: string): string | undefined {
  const fromEnv = process.env[name] ?? (fallback ? process.env[fallback] : undefined);
  if (fromEnv) return fromEnv;
  const file = path.join(REPO_ROOT, '.env.keys');
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  for (const n of [name, fallback].filter((x): x is string => x !== undefined)) {
    const found = new RegExp(`^${n}=(\\S+)$`, 'm').exec(text)?.[1];
    if (found) return found;
  }
  return undefined;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  // Never echo the URL: it holds the key.
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  return res.json();
}

async function getBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function geocode(address: string): Promise<LngLat> {
  const k = key('GEOCODIO_API_KEY');
  if (!k) throw new Error('An address needs GEOCODIO_API_KEY.');
  const body = (await getJson(`https://api.geocod.io/v1.7/geocode?q=${encodeURIComponent(address)}&limit=1&api_key=${encodeURIComponent(k)}`)) as {
    results?: { location?: { lat: number; lng: number } }[];
  };
  const loc = body.results?.[0]?.location;
  if (!loc) throw new Error(`No match for ${address}.`);
  return [loc.lng, loc.lat];
}

/** Buys (once) and keeps Google's files for a point: insights.json, dsm.tif, mask.tif, rgb.tif and meta.json. */
async function fetchInto(dir: string, point: LngLat): Promise<void> {
  if (existsSync(path.join(dir, 'dsm.tif')) && existsSync(path.join(dir, 'mask.tif'))) return;
  const k = key('GOOGLE_SOLAR_API_KEY', 'GOOGLE_MAPS_API_KEY');
  if (!k) throw new Error('A point needs GOOGLE_SOLAR_API_KEY (or GOOGLE_MAPS_API_KEY).');
  mkdirSync(dir, { recursive: true });
  const [lng, lat] = point;
  let building: SolarBuilding | null = null;
  try {
    const raw = await getJson(`${SOLAR}/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=LOW&key=${encodeURIComponent(k)}`);
    writeFileSync(path.join(dir, 'insights.json'), JSON.stringify(raw));
    building = parseBuildingInsights(raw);
  } catch (err) {
    process.stderr.write(`  no buildingInsights: ${(err as Error).message}\n`);
  }
  const req = layersRequest(point, building);
  const layers = (await getJson(
    `${SOLAR}/dataLayers:get?location.latitude=${req.center[1]}&location.longitude=${req.center[0]}&radiusMeters=${req.radiusM}` +
      `&view=IMAGERY_LAYERS&requiredQuality=MEDIUM&pixelSizeMeters=0.1&key=${encodeURIComponent(k)}`,
  )) as Record<string, unknown>;
  for (const name of ['dsm', 'mask', 'rgb'] as const) {
    const url = layers[`${name}Url`];
    if (typeof url === 'string') writeFileSync(path.join(dir, `${name}.tif`), await getBytes(`${url}&key=${encodeURIComponent(k)}`));
  }
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ point, imageryQuality: layers.imageryQuality ?? null, imageryDate: layers.imageryDate ?? null }));
}

async function readFile(file: string): Promise<ArrayBuffer> {
  const b = readFileSync(file);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

async function layersIn(dir: string): Promise<RoofLayers> {
  const dsm = await readGeoTiff(await readFile(path.join(dir, 'dsm.tif')));
  const mask = await readGeoTiff(await readFile(path.join(dir, 'mask.tif')));
  const metaFile = path.join(dir, 'meta.json');
  const meta = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, 'utf8')) as { imageryQuality?: string | null }) : {};
  const layers = layersFrom(dsm, mask, { imageryQuality: meta.imageryQuality ?? null, imageryDate: null });
  const rgb = path.join(dir, 'rgb.tif');
  return { ...layers, photo: existsSync(rgb) ? await readRgbGeoTiff(await readFile(rgb)) : null };
}

function insightsIn(file: string | null): SolarBuilding | null {
  if (file === null || !existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  return 'segments' in raw ? (raw as unknown as SolarBuilding) : parseBuildingInsights(raw);
}

const LINE_COLOURS: Record<string, string> = {
  ridge: '#e61e1e',
  hip: '#ff8c00',
  valley: '#00c8ff',
  eave: '#9678ff',
  rake: '#28dc78',
  step: '#ffffff',
  'flat-edge': '#c8c8c8',
};

/** The roof over Google's photo, as an SVG (the photo embedded as a PNG). */
function svgOf(layers: RoofLayers, roof: Roof3d): string | null {
  const photo = layers.photo ?? null;
  const zone = utmZoneOfEpsg(layers.epsg);
  if (photo === null || zone === null) return null;
  const px = (p: LngLat): [number, number] => {
    const u = lngLatToUtm(zone, p[0], p[1]);
    return [(u.easting - photo.originX) / photo.pixelSizeM, (photo.originY - u.northing) / photo.pixelSizeM];
  };
  const png = Buffer.from(encodeRgbPng(photo.width, photo.height, photo.rgb)).toString('base64');
  const pts = (ring: LngLat[]) => ring.map((p) => px(p).map((v) => v.toFixed(1)).join(',')).join(' ');
  const faces = roof.faces
    .map((f, k) => {
      const [x, y] = px(f.labelAt);
      return `<polygon points="${pts(f.ring)}" fill="hsl(${(k * 67) % 360} 80% 55% / 0.28)" stroke="white" stroke-width="0.6"/><text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="9" fill="white" stroke="black" stroke-width="0.3">${String.fromCharCode(65 + (k % 26))} ${f.flat ? 'flat' : `${f.pitchX12.toFixed(1)}/12`}</text>`;
    })
    .join('');
  const lines = roof.lines.map((l) => `<polyline points="${pts([l.coords[0], l.coords[1]])}" stroke="${LINE_COLOURS[l.kind] ?? 'black'}" stroke-width="2" fill="none"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${photo.width} ${photo.height}" width="${photo.width * 2}" height="${photo.height * 2}"><image href="data:image/png;base64,${png}" width="${photo.width}" height="${photo.height}"/>${faces}${lines}</svg>`;
}

/** A file name for a target: a folder's own name, else the target's words. */
function slugOf(target: string): string {
  const local = /^(.+?)@/.exec(target);
  const base = local !== null && existsSync(local[1]!) ? path.basename(local[1]!) : target;
  return base.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'roof';
}

/** Everything about one house, for scoring elsewhere (--json): [lng, lat], feet and square feet. */
function resultOf(target: string, point: LngLat, roof: Roof3d, check: ReturnType<typeof checkRoof>) {
  const byKind: Record<string, number> = {};
  for (const l of roof.lines) byKind[l.kind] = Math.round(((byKind[l.kind] ?? 0) + l.lengthFt) * 10) / 10;
  const plan = roof.faces.reduce((t, f) => t + f.planAreaSqFt, 0);
  const sloped = roof.faces.reduce((t, f) => t + f.slopedAreaSqFt, 0);
  return {
    target,
    point,
    imageryQuality: roof.imageryQuality,
    imageryDate: roof.imageryDate,
    pixelSizeM: roof.pixelSizeM,
    outline: roof.outline,
    faces: roof.faces.map((f, k) => ({
      id: check.rows[k]?.face ?? String(k),
      ring: f.ring,
      pitchX12: f.pitchX12,
      azimuthDeg: f.azimuthDeg,
      flat: f.flat,
      planSqFt: f.planAreaSqFt,
      slopedSqFt: f.slopedAreaSqFt,
    })),
    lines: roof.lines.map((l) => ({ kind: l.kind, coords: l.coords, lengthFt: l.lengthFt, faces: l.faces })),
    totals: {
      faces: roof.faces.length,
      planSqFt: Math.round(plan * 10) / 10,
      slopedSqFt: Math.round(sloped * 10) / 10,
      squares: Math.round(sloped / 10) / 10,
      linesFt: byKind,
    },
    quality: roof.quality ?? null,
    check: { mainOk: check.mainOk, mainChecked: check.mainChecked, junkFaces: check.junkFaces, steepFaces: check.steepFaces, outlineOk: check.outlineOk, passed: check.passed },
  };
}

async function targetsOf(args: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const a of args) {
    if (a.startsWith('@')) {
      for (const line of readFileSync(a.slice(1), 'utf8').split('\n')) if (line.trim() !== '' && !line.trim().startsWith('#')) out.push(line.trim());
    } else out.push(a);
  }
  return out;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const cache = opt('--cache') ?? path.join(REPO_ROOT, '.roof-3d-cache');
  const svgDir = opt('--svg');
  const jsonDir = opt('--json');
  const targets = await targetsOf(argv);
  if (targets.length === 0) {
    process.stderr.write('Usage: roof-3d-check [--cache DIR] [--svg DIR] TARGET... (see the file header)\n');
    return 2;
  }
  let failed = 0;
  const summary: string[] = [];
  for (const target of targets) {
    try {
      let dir: string;
      let point: LngLat;
      let insights: string | null;
      const local = /^(.+?)@(-?[\d.]+),\s*(-?[\d.]+)(?:@(.+))?$/.exec(target);
      const latLng = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(target);
      if (local !== null && existsSync(local[1]!)) {
        dir = local[1]!;
        point = [Number(local[3]), Number(local[2])];
        insights = local[4] ?? path.join(dir, 'insights.json');
      } else {
        point = latLng !== null ? [Number(latLng[2]), Number(latLng[1])] : await geocode(target);
        dir = path.join(cache, `p_${point[1].toFixed(6)}_${point[0].toFixed(6)}`);
        await fetchInto(dir, point);
        insights = path.join(dir, 'insights.json');
      }
      const layers = await layersIn(dir);
      const building = insightsIn(insights);
      const started = performance.now();
      const found = roofOnLayers(layers, point, { steep: steepRoof(building) });
      const ms = performance.now() - started;
      // As the server keeps it: Google's segments checked against the faces too.
      const roof = found === null ? null : withGoogleCheck(found, building);
      if (roof === null) {
        process.stdout.write(`${target}: no roof reconstructed at the point\n\n`);
        summary.push(`${slugOf(target).padEnd(34)} | no roof`);
        failed++;
        continue;
      }
      const check = checkRoof(roof, building);
      process.stdout.write(`${formatCheck(target, roof, check, ms)}\n\n`);
      if (!check.passed) failed++;
      const q = roof.quality;
      summary.push(
        [
          slugOf(target).padEnd(34),
          String(roof.faces.length).padStart(5),
          `${check.mainOk}/${check.mainChecked}`.padStart(5),
          String(check.junkFaces).padStart(4),
          String(check.steepFaces).padStart(5),
          (q?.outlineIoU.toFixed(3) ?? '-').padStart(5),
          (q === undefined ? '-' : `${Math.round(q.edgeFit * 100)}%`).padStart(5),
          (q === undefined ? '-' : q.reasons.join(',') || 'ok').padEnd(28),
          check.passed ? 'PASS' : 'FAIL',
        ].join(' | '),
      );
      if (jsonDir !== undefined) {
        mkdirSync(jsonDir, { recursive: true });
        writeFileSync(path.join(jsonDir, `${slugOf(target)}.json`), JSON.stringify(resultOf(target, point, roof, check), null, 1));
      }
      if (svgDir !== undefined) {
        const svg = svgOf(layers, roof);
        if (svg !== null) {
          mkdirSync(svgDir, { recursive: true });
          writeFileSync(path.join(svgDir, `${slugOf(target)}.svg`), svg);
        }
      }
    } catch (err) {
      process.stdout.write(`${target}: ${(err as Error).message}\n\n`);
      summary.push(`${slugOf(target).padEnd(34)} | error: ${(err as Error).message}`);
      failed++;
    }
  }
  process.stdout.write(
    `${'house'.padEnd(34)} | faces | main | junk | steep |   IoU | edges | review${' '.repeat(22)} | targets\n${summary.join('\n')}\n\n`,
  );
  process.stdout.write(`${targets.length - failed} of ${targets.length} houses met every target.\n`);
  return failed > 0 ? 1 : 0;
}

process.exitCode = await main();
