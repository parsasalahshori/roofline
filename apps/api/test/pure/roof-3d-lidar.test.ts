import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LngLat, Ring } from '@roofline/shared';
import { utmToLngLat } from '@roofline/shared/roof-reconstruct';
import type { AppDeps } from '../../src/app.ts';
import { roof3dAt, roof3dFromKept } from '../../src/estimator/roof-3d.ts';
import { FakeUsgsLidarApi } from '../../src/providers/usgs-lidar.ts';
import { LidarTileCache, UsgsLidarService } from '../../src/providers/usgs-lidar-service.ts';
import { hipLayers } from '../roof-3d-fixture.ts';
import { buildingOf, NOW, ScriptedLayers } from './helpers.ts';
import { E0, fixtureBytes, N0, TILE_URL, unit } from './usgs-lidar-fixture.ts';

/*
 * The one hook between Measure and the lidar (roof-3d's attempt): off by default and then invisible (no USGS call, no
 * field, the same roof); prefetch keeps provenance without changing the roof; on hands the points to the
 * reconstruction; lidar not ready in time is recorded as 'lidar-pending' and never reused.
 */

const at = (e: number, n: number): LngLat => utmToLngLat({ zone: 15, south: false }, E0 + e, N0 + n) as LngLat;
// Google's roof over the fixture's lidar roof (12 x 20 m round the tile's centre).
const HOUSE: Ring = [at(44, 40), at(56, 40), at(56, 60), at(44, 60), at(44, 40)];
const INSIDE = at(50, 50);
const LAYERS = hipLayers(HOUSE);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function depsWith(mode: 'off' | 'prefetch' | 'on' | undefined, o: { waitMs?: number } = {}) {
  const api = new FakeUsgsLidarApi();
  api.files.set(TILE_URL, fixtureBytes('house-14-fmt6.laz'));
  api.coverageAt = () => [unit()];
  const dir = mkdtempSync(path.join(tmpdir(), 'roof-lidar-'));
  dirs.push(dir);
  const svc = new UsgsLidarService(api, { configured: false } as never, new LidarTileCache(dir, 1 << 30, () => NOW), () => NOW, { measureWaitMs: o.waitMs ?? 60_000 });
  const layers = new ScriptedLayers(() => LAYERS);
  const deps = {
    solarLayers: layers,
    clock: { now: () => NOW },
    objectStore: { configured: false },
    config: { ROOF_3D_MODE: 'on', NODE_ENV: 'test', ...(mode !== undefined ? { USGS_LIDAR_MODE: mode } : {}) },
    logError: () => undefined,
    usgsLidar: svc,
  } as unknown as AppDeps;
  return { deps, api, layers };
}

describe('roof-3d with USGS lidar', () => {
  it('off by default: no USGS call, no lidar field, and the roof is the one made without the service', async () => {
    const { deps, api } = depsWith(undefined);
    const snap = await roof3dAt(deps, INSIDE, buildingOf(HOUSE));
    expect(snap?.roof).not.toBeNull();
    expect(snap).not.toHaveProperty('lidar');
    expect(api.calls).toHaveLength(0);
    const { deps: bare } = depsWith('off');
    delete (bare as { usgsLidar?: unknown }).usgsLidar;
    expect((await roof3dAt(bare, INSIDE, buildingOf(HOUSE)))?.roof).toEqual(snap?.roof);
  });

  it('prefetch: the lidar is fetched and its provenance kept, the roof is unchanged', async () => {
    const { deps } = depsWith('prefetch');
    const snap = await roof3dAt(deps, INSIDE, buildingOf(HOUSE));
    expect(snap?.lidar).toMatchObject({ status: 'kept', workunit: 'AR_Western_4_B24', ql: 1, flown: ['2025-01-02', '2025-03-26'], leafOff: true, credit: expect.stringMatching(/USGS/) });
    const { deps: off } = depsWith('off');
    expect(snap?.roof).toEqual((await roof3dAt(off, INSIDE, buildingOf(HOUSE)))?.roof);
  });

  it('on: the points go to the reconstruction (the roof reports what its lidar step did)', async () => {
    const { deps } = depsWith('on');
    const snap = await roof3dAt(deps, INSIDE, buildingOf(HOUSE));
    expect(snap?.lidar).toMatchObject({ status: 'used', workunit: 'AR_Western_4_B24' });
    expect(snap?.lidar?.points).toBeGreaterThan(10_000);
    expect(snap?.roof?.lidarEdges).toBeDefined();
  });

  it('not ready in time: Measure goes on with Google alone, records lidar-pending, and the next Measure makes the roof again with the lidar', async () => {
    const { deps, api } = depsWith('on', { waitMs: 0 });
    let open!: () => void;
    const g = new Promise<void>((r) => {
      open = r;
    });
    api.gate = () => g;
    const first = await roof3dAt(deps, INSIDE, buildingOf(HOUSE));
    expect(first?.roof).not.toBeNull();
    expect(first?.lidar).toEqual({ status: 'none', reason: 'lidar-pending' });
    open();
    await deps.usgsLidar!.prefetch(INSIDE);
    // The kept snapshot from the first Measure is not reused: it was made before the lidar was there.
    const again = await roof3dFromKept(deps, first, INSIDE, Promise.resolve(buildingOf(HOUSE)));
    expect(again?.lidar?.status).toBe('used');
  });

  it('no coverage: typed, and the roof is Google-only', async () => {
    const { deps, api } = depsWith('on');
    api.coverageAt = () => [];
    const snap = await roof3dAt(deps, INSIDE, buildingOf(HOUSE));
    expect(snap?.lidar).toEqual({ status: 'none', reason: 'no-coverage' });
    expect(snap?.roof?.lidarEdges).toBeUndefined();
  });
});
