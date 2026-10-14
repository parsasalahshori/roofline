import { readFileSync } from 'node:fs';
import type { Pools } from '@roofline/db';
import { claimFootprintTile, finishFootprintTile, insertFootprints, type FootprintInput } from '@roofline/db/system';
import { quadkeyOf } from '@roofline/shared';

const STATE = 'NE';

/**
 * Seeds the footprints-ne.json fixture rings through the system pool and marks their footprint tile(s)
 * 'ready', so the e2e stack measures Omaha addresses with no loader run (and no download). Idempotent: a
 * tile already ready (or freshly loading) is left as it is. `rings` replaces the fixture's rings (the demo
 * world loads real Omaha buildings instead). Every ring is filed in the tile of its first corner; the
 * Omaha rings all fall in one tile, well inside its edges.
 */
export async function seedFootprintFixture(pools: Pools, rings?: readonly FootprintInput[]): Promise<void> {
  const loaded =
    rings ?? (JSON.parse(readFileSync(new URL('../../test/fixtures/footprints-ne.json', import.meta.url), 'utf8')) as FootprintInput[]);
  const byTile = new Map<string, FootprintInput[]>();
  for (const r of loaded) {
    const first = r.ring[0];
    if (first === undefined) continue;
    const q = quadkeyOf(first[0], first[1]);
    byTile.set(q, [...(byTile.get(q) ?? []), r]);
  }
  for (const [tile, tileRings] of byTile) {
    if (!(await claimFootprintTile(pools.system, tile, new Date()))) continue;
    const count = await insertFootprints(pools.system, { tile, state: STATE }, tileRings);
    await finishFootprintTile(pools.system, tile, count, null, new Date());
  }
}
