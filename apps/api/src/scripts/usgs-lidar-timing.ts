import { mkdirSync } from 'node:fs';
import type { LngLat } from '@roofline/shared';
import { RealUsgsLidarApi } from '../providers/usgs-lidar.ts';
import { LidarTileCache, UsgsLidarService } from '../providers/usgs-lidar-service.ts';

/*
 * Cold and warm timings of the lidar service against the real USGS servers (no Google, no key):
 *   tsx src/scripts/usgs-lidar-timing.ts <tile dir> <slug>=<lng>,<lat> ...
 * Per house: Measure on a cold cell with the default budget (should be 'lidar-pending' within it), the cold prefetch
 * (index + download + derive), a re-derive from the cached tile (what the area job leaves), and a warm Measure.
 */

async function main(): Promise<void> {
  const [dir, ...houses] = process.argv.slice(2);
  if (dir === undefined || houses.length === 0) throw new Error('usage: usgs-lidar-timing <tile dir> slug=lng,lat ...');
  mkdirSync(dir, { recursive: true });
  const store = { configured: false } as never;
  const make = () => new UsgsLidarService(new RealUsgsLidarApi(), store, new LidarTileCache(dir, 20 * 1024 ** 3, () => new Date()), () => new Date());
  for (const h of houses) {
    const [slug, ll] = h.split('=');
    const point = ll!.split(',').map(Number) as LngLat;
    const svc = make();
    let t = performance.now();
    const pending = await svc.forMeasure(point, 1500);
    const coldMeasureMs = performance.now() - t;
    t = performance.now();
    const cold = await svc.prefetch(point);
    const coldPrefetchMs = performance.now() - t + coldMeasureMs;
    // A fresh service (empty product store) on the cached tile: what a house costs after the area job.
    const svc2 = make();
    t = performance.now();
    await svc2.prefetch(point);
    const fromTileMs = performance.now() - t;
    t = performance.now();
    const warm = await svc.forMeasure(point, 1500);
    const warmMs = performance.now() - t;
    const src = 'crop' in cold ? cold.crop.source : null;
    console.log(
      JSON.stringify({
        slug,
        coldMeasure: 'none' in pending ? pending.none : 'crop',
        coldMeasureMs: Math.round(coldMeasureMs),
        coldPrefetchMs: Math.round(coldPrefetchMs),
        fromCachedTileMs: Math.round(fromTileMs),
        warmMeasureMs: Math.round(warmMs * 10) / 10,
        warm: 'none' in warm ? warm.none : 'crop',
        result: 'none' in cold ? { none: cold.none, detail: 'detail' in cold ? cold.detail : undefined } : { workunit: src!.workunit, ql: src!.ql, flown: [src!.collectStart, src!.collectEnd], leafOff: src!.leafOff, points: src!.points, lastPerM2: src!.lastPerM2, files: src!.files.length, pointDates: src!.pointDates },
      }),
    );
  }
}

void main();
