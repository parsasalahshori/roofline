import { readFileSync } from 'node:fs';
import type { Pools } from '@roofline/db';
import { claimFootprintState, finishFootprintState, insertFootprints, type FootprintInput } from '@roofline/db/system';

const STATE = 'NE';
const SOURCE_URL = 'https://fake.test/footprints/NE.zip';

/**
 * Seeds building_footprint_states NE 'ready' and the footprints-ne.json fixture rings through the system pool,
 * so the e2e stack measures Omaha addresses with no loader run. Idempotent: a state already ready (or freshly
 * loading) is left as it is. `rings` replaces the fixture's rings (the demo world loads real Omaha buildings instead).
 */
export async function seedFootprintFixture(pools: Pools, rings?: readonly FootprintInput[]): Promise<void> {
  const claimed = await claimFootprintState(pools.system, STATE, SOURCE_URL, new Date());
  if (!claimed) return;
  const loaded =
    rings ?? (JSON.parse(readFileSync(new URL('../../test/fixtures/footprints-ne.json', import.meta.url), 'utf8')) as FootprintInput[]);
  const count = await insertFootprints(pools.system, STATE, loaded);
  await finishFootprintState(pools.system, STATE, count, new Date());
}
