import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LngLat } from '@roofline/shared';
import { utmToLngLat } from '@roofline/shared/roof-reconstruct';
import type { LidarUnit } from '../../src/providers/usgs-lidar.ts';

/*
 * The synthetic 3DEP tile (scripts/roof-bench-lidar/make_fixture.py): 100 m of UTM 15N from (560000, 3845000), flat
 * ground at 100 m (class 2), a 12 x 20 m roof at 106 m (class 6) round (560050, 3845050), 4 points per m2, single
 * returns flown 2025-02-10, every 997th point low noise (class 7).
 */

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usgs-lidar');
export const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(DIR, name)));

export const E0 = 560000;
export const N0 = 3845000;
/** The roof's centre as lng/lat. */
export const HOUSE_POINT: LngLat = utmToLngLat({ zone: 15, south: false }, E0 + 50, N0 + 50) as LngLat;

export const TILE_URL = 'https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/AR_Western_B24/AR_Western_4_B24/LAZ/USGS_LPC_fixture.laz';

export function unit(over: Partial<LidarUnit> = {}): LidarUnit {
  return {
    workunit: 'AR_Western_4_B24',
    project: 'AR_Western_B24',
    ql: 1,
    collectStart: '2025-01-02',
    collectEnd: '2025-03-26',
    leafOff: true,
    tiles: [{ url: TILE_URL, bytes: null }],
    ...over,
  };
}
