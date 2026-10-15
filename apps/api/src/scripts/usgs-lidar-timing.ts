import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { LngLat } from '@roofline/shared';
import { chooseUnit, RealUsgsLidarApi } from '../providers/usgs-lidar.ts';
import { LidarTileCache, UsgsLidarService } from '../providers/usgs-lidar-service.ts';

/*
 * Cold and warm timings of the lidar service against the real USGS servers (no Google, no key):
 *   tsx src/scripts/usgs-lidar-timing.ts <tile dir> [--seed <dir of LAZ tiles>] <slug>=<lng>,<lat> ...
 * --seed puts tiles already on disk into the tile cache first (what the area job leaves), so the run times a house
 * whose tile is cached but whose crop is not derived yet.
 * Per house: Measure on a cold cell with the default budget (should be 'lidar-pending' within it), the cold prefetch
 * (index + download + derive), a re-derive from the cached tile (what the area job leaves), and a warm Measure.
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const seedAt = args.indexOf('--seed');
  const seed = seedAt >= 0 ? args.splice(seedAt, 2)[1] : undefined;
  const [dir, ...houses] = args;
  if (dir === undefined || houses.length === 0) throw new Error('usage: usgs-lidar-timing <tile dir> slug=lng,lat ...');
  mkdirSync(dir, { recursive: true });
  const store = { configured: false } as never;
  const tiles = new LidarTileCache(dir, 20 * 1024 ** 3, () => new Date());
  const make = () => new UsgsLidarService(new RealUsgsLidarApi(), store, tiles, () => new Date());
  for (const h of houses) {
    const [slug, ll] = h.split('=');
    const point = ll!.split(',').map(Number) as LngLat;
    const svc = make();
    let seeded = 0;
    if (seed !== undefined) {
      const choice = chooseUnit(await svc.api.coverage(point, { timeoutMs: 20_000 }));
      for (const tile of 'unit' in choice ? choice.unit.tiles : []) {
        const local = path.join(seed, tile.url.slice(tile.url.lastIndexOf('/') + 1));
        if (existsSync(local)) {
          await tiles.put(tile.url, new Uint8Array(readFileSync(local)), 0);
          seeded++;
        }
      }
    }
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
        seededTiles: seeded,
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
