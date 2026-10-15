import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { LngLat } from '@roofline/shared';
import { benchDir, houseDir } from '../bench/roof3d/paths.ts';
import { percentile } from '../bench/roof3d/geometry.ts';
import { roofOnLayersResult } from '../estimator/roof-3d.ts';
import { layersFrom, readGeoTiff, readRgbGeoTiff } from '../providers/google-solar-layers.ts';

/*
 * The roof in 3D's latency and memory on the benchmark's DEV houses, the way a Measure runs it: decode the three
 * GeoTIFFs, line them up, reconstruct. Aggregates only (p50, p95, max, peak memory); held-out houses are never run.
 * Reads files only: no network, no key.
 *
 *   npm run roof3d:perf -w @roofline/api [-- --limit N]
 */

type Entry = { slug: string; dir: string; point: LngLat; split: string };

function main(): void {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
  const manifest = JSON.parse(readFileSync(path.join(benchDir(), 'manifest.json'), 'utf8')) as { houses: Entry[] };
  const houses = manifest.houses.filter((h) => h.split === 'dev').slice(0, limit);
  return void run(houses);
}

async function run(houses: Entry[]): Promise<void> {
  const decode: number[] = [];
  const build: number[] = [];
  const total: number[] = [];
  let peakRss = 0;
  let peakHeap = 0;
  let missing = 0;
  const misses = new Map<string, number>();
  for (const h of houses) {
    const dir = houseDir(h.dir);
    if (dir === null) {
      missing++;
      continue;
    }
    const buf = (f: string) => {
      const b = readFileSync(path.join(dir, f));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    };
    const t0 = performance.now();
    const [dsm, mask, photo] = await Promise.all([readGeoTiff(buf('dsm.tif')), readGeoTiff(buf('mask.tif')), readRgbGeoTiff(buf('rgb.tif')).catch(() => null)]);
    const layers = { ...layersFrom(dsm, mask, { imageryQuality: 'HIGH', imageryDate: null }), photo };
    const t1 = performance.now();
    const found = roofOnLayersResult(layers, h.point);
    const t2 = performance.now();
    if ('miss' in found) misses.set(found.miss, (misses.get(found.miss) ?? 0) + 1);
    decode.push(t1 - t0);
    build.push(t2 - t1);
    total.push(t2 - t0);
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    peakHeap = Math.max(peakHeap, m.heapUsed);
  }
  const row = (name: string, xs: number[]) => `${name.padEnd(12)} p50 ${percentile(xs, 0.5).toFixed(0).padStart(5)} ms   p95 ${percentile(xs, 0.95).toFixed(0).padStart(5)} ms   max ${Math.max(...xs).toFixed(0).padStart(5)} ms`;
  console.log(`roof 3D latency on ${total.length} dev houses (${missing} missing), node ${process.version}`);
  console.log(row('decode', decode));
  console.log(row('reconstruct', build));
  console.log(row('total', total));
  console.log(`peak rss ${(peakRss / 1e6).toFixed(0)} MB, peak heap ${(peakHeap / 1e6).toFixed(0)} MB; no roof: ${JSON.stringify(Object.fromEntries(misses))}`);
}

main();
