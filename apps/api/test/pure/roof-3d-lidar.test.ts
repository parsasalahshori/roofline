import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LngLat, Ring } from '@roofline/shared';
import { utmToLngLat } from '@roofline/shared/roof-reconstruct';
import type { AppDeps } from '../../src/app.ts';
import type { RoofLayers } from '../../src/providers/solar-layers.ts';
import { roof3dAt, roof3dFromKept } from '../../src/estimator/roof-3d.ts';
import { FakeUsgsLidarApi } from '../../src/providers/usgs-lidar.ts';
import { lidarAreaOf, prefetchLidar, runLidarAreaJob } from '../../src/providers/usgs-lidar-roof.ts';
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

/** The layers resampled (nearest) onto Google's MEDIUM 0.25 m grid. */
function toMedium(l: RoofLayers): RoofLayers {
  const { width: W, height: H, pixelSizeM: s, dsm, mask } = l.raster;
  const t = 0.25;
  const w = Math.floor((W * s) / t);
  const h = Math.floor((H * s) / t);
  const d2 = new Float32Array(w * h);
  const m2 = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const src = Math.min(H - 1, Math.floor(((r + 0.5) * t) / s)) * W + Math.min(W - 1, Math.floor(((c + 0.5) * t) / s));
      d2[r * w + c] = dsm[src]!;
      m2[r * w + c] = mask[src]!;
    }
  }
  return { ...l, raster: { width: w, height: h, pixelSizeM: t, dsm: d2, mask: m2 }, photo: null, imageryQuality: 'MEDIUM' };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function depsWith(mode: 'off' | 'prefetch' | 'on' | undefined, o: { waitMs?: number; layers?: RoofLayers; answer?: () => Promise<RoofLayers> } = {}) {
  const api = new FakeUsgsLidarApi();
  api.files.set(TILE_URL, fixtureBytes('house-14-fmt6.laz'));
  api.coverageAt = () => [unit()];
  const dir = mkdtempSync(path.join(tmpdir(), 'roof-lidar-'));
  dirs.push(dir);
  const svc = new UsgsLidarService(api, { configured: false } as never, new LidarTileCache(dir, 1 << 30, () => NOW), () => NOW, { measureWaitMs: o.waitMs ?? 60_000 });
  const layers = new ScriptedLayers(o.answer ?? (() => o.layers ?? LAYERS));
  const sent: { name: string; data: unknown; opts: unknown }[] = [];
  const deps = {
    solarLayers: layers,
    clock: { now: () => NOW },
    objectStore: { configured: false },
    config: { ROOF_3D_MODE: 'on', NODE_ENV: 'test', ...(mode !== undefined ? { USGS_LIDAR_MODE: mode } : {}) },
    logError: () => undefined,
    usgsLidar: svc,
    jobs: { sent, send: async (name: string, data: unknown, opts: unknown) => void sent.push({ name, data, opts }) },
  } as unknown as AppDeps;
  return { deps, api, layers, sent };
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
    // Asked again in this process while still pending: the same answer, nothing bought again.
    expect(await roof3dAt(deps, INSIDE, buildingOf(HOUSE))).toBe(first);
    // Still pending: the kept roof is reused (making it again would buy Google's layers for nothing).
    const { deps: d2, layers: l2 } = depsWith('on', { waitMs: 0 });
    (d2 as { usgsLidar: unknown }).usgsLidar = deps.usgsLidar;
    expect(await roof3dFromKept(d2, first, INSIDE, Promise.resolve(buildingOf(HOUSE)))).toBe(first);
    expect(l2.calls).toHaveLength(0);
    open();
    await deps.usgsLidar!.prefetch(INSIDE);
    // Ready now: the kept snapshot from the first Measure is made again, with the lidar.
    const again = await roof3dFromKept(deps, first, INSIDE, Promise.resolve(buildingOf(HOUSE)));
    expect(again?.lidar?.status).toBe('used');
    // And in this process too: the cached answer is made again once, then shared.
    const third = await roof3dAt(deps, INSIDE, buildingOf(HOUSE));
    expect(third?.lidar?.status).toBe('used');
    expect(await roof3dAt(deps, INSIDE, buildingOf(HOUSE))).toBe(third);
  });

  it('Google MEDIUM (0.25 m) layers: the lidar goes in the same way, and the answer is identical run to run', async () => {
    const medium = toMedium(LAYERS);
    const run = async () => {
      const { deps } = depsWith('on', { layers: medium });
      return roof3dAt(deps, INSIDE, buildingOf(HOUSE));
    };
    const a = await run();
    expect(a?.roof?.pixelSizeM).toBe(0.25);
    expect(a?.lidar?.status).toBe('used');
    expect(a?.roof?.lidarEdges).toBeDefined();
    const b = await run();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('a snapshot stored before lidar existed (no lidar field) still reads and is reused with lidar on, asking USGS nothing', async () => {
    const { deps: off } = depsWith(undefined);
    const old = await roof3dAt(off, INSIDE, buildingOf(HOUSE));
    expect(old).not.toHaveProperty('lidar');
    const { deps, api, layers } = depsWith('on');
    expect(await roof3dFromKept(deps, old, INSIDE, Promise.resolve(buildingOf(HOUSE)))).toBe(old);
    expect(api.calls).toHaveLength(0);
    expect(layers.calls).toHaveLength(0);
  });

  it("the lidar's budget runs while Google's layers come, not after them", async () => {
    let asked!: () => void;
    const lidarAsked = new Promise<void>((r) => {
      asked = r;
    });
    // The layers answer only once the lidar has been asked for: were the lidar started after them, this would hang.
    const { deps, api } = depsWith('on', { answer: async () => (await lidarAsked, LAYERS) });
    api.coverageAt = () => {
      asked();
      return [unit()];
    };
    const snap = await roof3dAt(deps, INSIDE, buildingOf(HOUSE));
    expect(snap?.lidar?.status).toBe('used');
  }, 20_000);

  it('no coverage: typed, and the roof is Google-only', async () => {
    const { deps, api } = depsWith('on');
    api.coverageAt = () => [];
    const snap = await roof3dAt(deps, INSIDE, buildingOf(HOUSE));
    expect(snap?.lidar).toEqual({ status: 'none', reason: 'no-coverage' });
    expect(snap?.roof?.lidarEdges).toBeUndefined();
  });

  it('a searched address fetches its lidar and queues one area job for its square; off queues nothing', async () => {
    const { deps, api, sent } = depsWith('prefetch');
    await prefetchLidar(deps, INSIDE, 'company-1');
    const area = lidarAreaOf(INSIDE);
    expect(sent).toEqual([{ name: 'lidar-area', data: { companyId: 'company-1', lidarBox: area.box }, opts: { singletonKey: area.key } }]);
    expect(api.calls.some((c) => c.kind === 'get')).toBe(true);
    const off = depsWith('off');
    await prefetchLidar(off.deps, INSIDE, 'company-1');
    expect(off.sent).toHaveLength(0);
    expect(off.api.calls).toHaveLength(0);
  });

  it('the area job reads the square\'s tiles; a malformed or oversized box does nothing', async () => {
    const { deps, api } = depsWith('prefetch');
    await runLidarAreaJob(deps, [1, 2, 3]);
    await runLidarAreaJob(deps, [-93, 34, -92, 35]);
    await runLidarAreaJob(deps, ['a', 1, 2, 3]);
    expect(api.calls).toHaveLength(0);
    await runLidarAreaJob(deps, lidarAreaOf(INSIDE).box);
    expect(api.calls.filter((c) => c.kind === 'size')).toHaveLength(1);
  });
});
