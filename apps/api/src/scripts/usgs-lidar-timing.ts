import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { LngLat } from '@roofline/shared';
import { MemoryObjectStore } from '../providers/fakes/object-store.ts';
import { chooseUnit, RealUsgsLidarApi } from '../providers/usgs-lidar.ts';
import { LidarTileCache, UsgsLidarService } from '../providers/usgs-lidar-service.ts';

/*
 * Cold and warm timings of the lidar service against the real USGS servers (no Google, no key):
 *   tsx src/scripts/usgs-lidar-timing.ts <tile dir> [--seed <dir of LAZ tiles>] <slug>=<lng>,<lat> ...
 * Per house, as a person would meet it:
 *   coldMeasureMs  Measure right after the search, nothing cached: the budget, then 'lidar-pending'.
 *   readyAfterMs   from that Measure until the crop is kept (index + download + derive), with one retry of a failed
 *                  fetch (what the next search or Measure would do).
 *   warmMeasureMs  a later Measure in a fresh process (product read from the shared object store).
 *   fromTileMs     a house whose tile is already cached (the area job ran) but whose crop is not derived.
 * --seed copies tiles already on disk into the tile cache first.
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const seedAt = args.indexOf('--seed');
  const seed = seedAt >= 0 ? args.splice(seedAt, 2)[1] : undefined;
  const [dir, ...houses] = args;
  if (dir === undefined || houses.length === 0) throw new Error('usage: usgs-lidar-timing <tile dir> [--seed dir] slug=lng,lat ...');
  mkdirSync(dir, { recursive: true });
  const store = new MemoryObjectStore();
  const tiles = new LidarTileCache(dir, 20 * 1024 ** 3, () => new Date());
  const make = (s = store) => new UsgsLidarService(new RealUsgsLidarApi(), s, tiles, () => new Date());
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
    const t0 = performance.now();
    const first = await svc.forMeasure(point, 1500);
    const coldMeasureMs = performance.now() - t0;
    let got = await svc.prefetch(point);
    let retried: string | null = null;
    if ('none' in got && got.none === 'error') {
      retried = got.detail ?? 'error';
      got = await svc.prefetch(point);
    }
    const readyAfterMs = performance.now() - t0;
    let t = performance.now();
    const warm = await make().forMeasure(point, 1500);
    const warmMeasureMs = performance.now() - t;
    t = performance.now();
    await make(new MemoryObjectStore()).prefetch(point);
    const fromTileMs = performance.now() - t;
    const src = 'crop' in got ? got.crop.source : null;
    console.log(
      JSON.stringify({
        slug,
        seededTiles: seeded,
        coldMeasure: 'none' in first ? first.none : 'crop',
        coldMeasureMs: Math.round(coldMeasureMs),
        readyAfterMs: Math.round(readyAfterMs),
        retriedAfter: retried,
        warm: 'none' in warm ? warm.none : 'crop',
        warmMeasureMs: Math.round(warmMeasureMs * 10) / 10,
        fromTileMs: Math.round(fromTileMs),
        result:
          src === null
            ? got
            : { workunit: src.workunit, ql: src.ql, flown: [src.collectStart, src.collectEnd], leafOff: src.leafOff, points: src.points, lastPerM2: src.lastPerM2, files: src.files, pointDates: src.pointDates },
      }),
    );
  }
}

void main();
