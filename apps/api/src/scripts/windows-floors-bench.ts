import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { lngLatToUtm, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import { encodeRgbPng } from '../estimator/png.ts';
import type { RoofLayers } from '../providers/solar-layers.ts';
import path from 'node:path';
import type { LngLat } from '@roofline/shared';
import { readLayers, readInsights } from '../bench/roof3d/data.ts';
import { benchDir } from '../bench/roof3d/paths.ts';
import { maskShift, wallHeights } from '../estimator/windows-heights.ts';
import { estimateAllSides, houseWalls } from '../estimator/windows-estimate.ts';
import { fileURLToPath } from 'node:url';

/*
 * The floors bench for Measure windows (development; no network): the roof benchmark's houses with cached Google
 * heights (~/RooflineWork/roof-bench, ROOF_BENCH_DIR) and the Microsoft footprint at their point (free/ms), against the
 * storeys labelled in docs/windows/floors-bench-labels.csv (read from the height map and the aerial photo, only where
 * clear). For each house: the floors and the walls estimate before (the whole outline's lowest eave, as the estimate
 * was before per-wall heights) and now (windows-heights.ts wallHeights + windows-estimate.ts).
 *   npx tsx apps/api/src/scripts/windows-floors-bench.ts [--all] [--png DIR] [slug...]
 * --all also prints unlabelled houses; --png DIR writes each house's height map (1 m colour bands) beside its photo.
 */

type MsFeature = { id: string; props: { height?: number }; rings: LngLat[][] };

function inRing(p: LngLat, ring: readonly LngLat[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function centreDist(p: LngLat, ring: readonly LngLat[]): number {
  const c = ring.reduce((a, q) => [a[0] + q[0] / ring.length, a[1] + q[1] / ring.length], [0, 0]);
  const k = Math.cos((p[1] * Math.PI) / 180);
  return Math.hypot((c[0] - p[0]) * 111_320 * k, (c[1] - p[1]) * 110_540);
}

/** The ground level round the ring (25th percentile 2-8 m outside, off roof), absolute metres. */
function groundOf(layers: RoofLayers, ring: readonly LngLat[]): number {
  const zone = utmZoneOfEpsg(layers.epsg)!;
  const { width, height, pixelSizeM: s, dsm, mask } = layers.raster;
  const pts = ring.map(([lng, lat]) => {
    const u = lngLatToUtm(zone, lng, lat);
    return [u.easting - layers.originX, layers.originY - u.northing] as [number, number];
  });
  const cx = pts.reduce((t, p) => t + p[0], 0) / pts.length;
  const cy = pts.reduce((t, p) => t + p[1], 0) / pts.length;
  const reach = Math.max(...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy))) + 8;
  const zs: number[] = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const x = (c + 0.5) * s;
      const y = (r + 0.5) * s;
      const d = Math.hypot(x - cx, y - cy);
      if (d > reach || d < reach - 6 || mask[r * width + c] !== 0) continue;
      const z = dsm[r * width + c]!;
      if (Number.isFinite(z)) zs.push(z);
    }
  }
  zs.sort((a, b) => a - b);
  return zs[Math.floor(zs.length * 0.25)] ?? 0;
}

const bench = benchDir();
const rows: {
  slug: string;
  label: number | null;
  before: number;
  after: number;
  oldWindows: number;
  windows: number;
  range: { low: number; high: number } | null;
}[] = [];
const manifest = JSON.parse(readFileSync(path.join(bench, 'manifest.json'), 'utf8')) as {
  houses: { slug: string; dir: string; point: LngLat; address: string }[];
};
const pngAt = process.argv.indexOf('--png');
const pngDir = pngAt >= 0 ? process.argv[pngAt + 1]! : null;
const all = process.argv.includes('--all');
const only = process.argv.slice(2).filter((a, i, args) => a !== '--png' && a !== '--all' && args[i - 1] !== '--png');
const LABELS = fileURLToPath(new URL('../../../../docs/windows/floors-bench-labels.csv', import.meta.url));
const labels = new Map(
  readFileSync(LABELS, 'utf8')
    .split('\n')
    .slice(1)
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [slug, storeys] = l.split(',');
      return [slug!, Number(storeys)] as const;
    }),
);

/** The estimate before per-wall heights: the whole outline's 10th-percentile eave (0.2-0.8 m in), floors 4.5 / 7.5 m. */
function before(layers: RoofLayers, ring: readonly LngLat[], perimeterM: number): { floors: number; eaveM: number | null; windows: number } {
  const zone = utmZoneOfEpsg(layers.epsg)!;
  const { width, height, pixelSizeM: s, dsm, mask } = layers.raster;
  const pts = ring.map(([lng, lat]) => {
    const u = lngLatToUtm(zone, lng, lat);
    return [u.easting - layers.originX, layers.originY - u.northing] as [number, number];
  });
  const roof: number[] = [];
  const ground: number[] = [];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const c0 = Math.max(0, Math.floor((Math.min(...xs) - 8.5) / s));
  const c1 = Math.min(width - 1, Math.ceil((Math.max(...xs) + 8.5) / s));
  const r0 = Math.max(0, Math.floor((Math.min(...ys) - 8.5) / s));
  const r1 = Math.min(height - 1, Math.ceil((Math.max(...ys) + 8.5) / s));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const z = dsm[r * width + c]!;
      if (!Number.isFinite(z)) continue;
      const x = (c + 0.5) * s;
      const y = (r + 0.5) * s;
      let d = Infinity;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [ax, ay] = pts[j]!;
        const [bx, by] = pts[i]!;
        const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
        const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2));
        d = Math.min(d, Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))));
      }
      if (inRing([x, y], pts)) {
        if (d >= 0.2 && d <= 0.8 && mask[r * width + c] !== 0) roof.push(z);
      } else if (d >= 2 && d <= 8 && mask[r * width + c] === 0) ground.push(z);
    }
  }
  const pct = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.floor(p * (v.length - 1))]!;
  const e = roof.length >= 30 && ground.length >= 30 ? pct(roof, 0.1) - pct(ground, 0.25) : null;
  const eaveM = e !== null && e >= 2 && e <= 15 ? e : null;
  const floors = eaveM === null ? 1 : eaveM < 4.5 ? 1 : eaveM < 7.5 ? 2 : 3;
  const hFt = eaveM === null ? 9 : Math.round(eaveM * 3.28084 * 10) / 10;
  const windows = Math.max(1, Math.round((Math.round(perimeterM * 3.28084) * hFt * 0.12) / 15));
  return { floors, eaveM, windows };
}

/** Heights above `groundZ` (0 black .. 12 m white through blue/green/red) beside the photo, the ring drawn on both, 4x. */
function picture(layers: RoofLayers, ring: readonly LngLat[], groundZ: number, file: string): void {
  const zone = utmZoneOfEpsg(layers.epsg)!;
  const { width, pixelSizeM: s, dsm } = layers.raster;
  const m = ring.map(([lng, lat]) => {
    const u = lngLatToUtm(zone, lng, lat);
    return [u.easting - layers.originX, layers.originY - u.northing] as [number, number];
  });
  const [sx, sy] = maskShift(layers, m);
  const pts = m.map(([x, y]) => [(x + sx) / s, (y + sy) / s] as [number, number]);
  const pad = 12 / s;
  const c0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0])) - pad));
  const c1 = Math.min(width - 1, Math.ceil(Math.max(...pts.map((p) => p[0])) + pad));
  const r0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1])) - pad));
  const r1 = Math.min(layers.raster.height - 1, Math.ceil(Math.max(...pts.map((p) => p[1])) + pad));
  const w = c1 - c0 + 1;
  const h = r1 - r0 + 1;
  const W = w * 2;
  const img = new Uint8Array(W * h * 3);
  const photo = layers.photo ?? null;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const z = dsm[(r + r0) * width + (c + c0)]! - groundZ;
      // 1 m bands: 0-1 navy, 1-2 blue, 2-3 teal, 3-4 green, 4-5 lime, 5-6 yellow, 6-7 orange, 7-8 red, 8-9 magenta-ish, 9+ white
      const PAL = [
        [10, 10, 60],
        [30, 60, 200],
        [0, 150, 160],
        [0, 180, 60],
        [150, 220, 0],
        [255, 230, 0],
        [255, 140, 0],
        [220, 30, 30],
        [170, 40, 120],
        [240, 240, 240],
      ];
      const col = PAL[Number.isFinite(z) ? Math.max(0, Math.min(9, Math.floor(z))) : 0]!;
      img.set(col, (r * W + c) * 3);
      if (photo !== null) {
        const x = layers.originX + (c + c0 + 0.5) * s;
        const y = layers.originY - (r + r0 + 0.5) * s;
        const pc = Math.floor((x - photo.originX) / photo.pixelSizeM);
        const pr = Math.floor((photo.originY - y) / photo.pixelSizeM);
        if (pc >= 0 && pr >= 0 && pc < photo.width && pr < photo.height)
          img.set(photo.rgb.subarray((pr * photo.width + pc) * 3, (pr * photo.width + pc) * 3 + 3), (r * W + c + w) * 3);
      }
    }
  }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2) + 1;
    for (let k = 0; k <= n; k++) {
      const x = Math.round(a[0] + ((b[0] - a[0]) * k) / n) - c0;
      const y = Math.round(a[1] + ((b[1] - a[1]) * k) / n) - r0;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      for (const off of [0, w]) img.set([255, 0, 255], (y * W + x + off) * 3);
    }
  }
  writeFileSync(file, encodeRgbPng(W, h, img));
}
for (const h of manifest.houses) {
  if (only.length > 0 && !only.includes(h.slug)) continue;
  const msFile = path.join(bench, 'free', 'ms', `${h.slug}.json`);
  if (!existsSync(msFile)) continue;
  const ms = JSON.parse(readFileSync(msFile, 'utf8')) as {
    features: MsFeature[];
  };
  const open = (r: LngLat[]) => (r.length > 1 && r[0]![0] === r.at(-1)![0] && r[0]![1] === r.at(-1)![1] ? r.slice(0, -1) : r);
  const feats = ms.features.map((f) => ({ ...f, ring: open(f.rings[0]!) }));
  const hit = feats.find((f) => inRing(h.point, f.ring)) ?? feats.sort((a, b) => centreDist(h.point, a.ring) - centreDist(h.point, b.ring))[0];
  if (hit === undefined) continue;
  const layers = await readLayers(path.join(bench, h.dir));
  readInsights(path.join(bench, h.dir));
  const wh = wallHeights(layers, hit.ring);
  if (pngDir !== null && wh !== null) {
    mkdirSync(pngDir, { recursive: true });
    // ground back out of the main eave and one wall: picture() only needs a reference level
    picture(layers, hit.ring, groundOf(layers, hit.ring), path.join(pngDir, `${h.slug}.png`));
  }
  const label = labels.get(h.slug);
  if (label === undefined && !all) continue;
  const k = Math.cos((h.point[1] * Math.PI) / 180);
  const lens = hit.ring.map((p, i) => {
    const q = hit.ring[(i + 1) % hit.ring.length]!;
    return Math.hypot((q[0] - p[0]) * 111_320 * k, (q[1] - p[1]) * 110_540);
  });
  const perimeterM = lens.reduce((t, v) => t + v, 0);
  const old = before(layers, hit.ring, perimeterM);
  const walls = houseWalls(perimeterM, null, wh?.eaveM ?? null, {
    walls: wh === null ? null : wh.wallEavesM.map((e, i) => ({ eaveM: e, lengthM: lens[i]! })),
    ridgeM: wh?.ridgeM ?? null,
  });
  const est = estimateAllSides(walls);
  const now = Object.values(est.bySizeClass).reduce((t, v) => t + v, 0);
  rows.push({
    slug: h.slug,
    label: label ?? null,
    before: old.floors,
    after: walls.floors,
    oldWindows: old.windows,
    windows: now,
    range: est.range ?? null,
  });
  console.log(
    [
      h.slug.padEnd(32),
      `label=${label ?? '-'}`,
      `before=${old.floors} (${old.eaveM?.toFixed(1) ?? '-'} m)`,
      `now=${walls.floors} (${wh?.eaveM.toFixed(1) ?? '-'} m, ridge ${wh?.ridgeM.toFixed(1) ?? '-'}, shift ${wh?.shiftM.toFixed(1) ?? '-'})`,
      `windows ${old.windows} -> ${now}${est.range ? ` (${est.range.low}-${est.range.high})` : ''}`,
      walls.lowWingFt > 0 ? `low wing ${walls.lowWingFt} ft` : '',
    ].join('  '),
  );
}

const scored = rows.filter((r) => r.label !== null);
const right = (key: 'before' | 'after') => scored.filter((r) => (r.label === 1.5 ? r[key] === 1.5 || r[key] === 2 : r[key] === r.label)).length;
const byLabel = (n: number, key: 'before' | 'after') => {
  const of = scored.filter((r) => r.label === n);
  return `${of.filter((r) => r[key] === n).length}/${of.length}`;
};
console.log(`\nfloors right: before ${right('before')}/${scored.length}, now ${right('after')}/${scored.length}`);
for (const n of [1, 2, 3]) console.log(`  ${n} storey: before ${byLabel(n, 'before')}, now ${byLabel(n, 'after')}`);
