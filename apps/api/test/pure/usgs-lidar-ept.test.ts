import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eptNames, FakeUsgsLidarApi } from '../../src/providers/usgs-lidar.ts';
import { cropEpt, lngLatToMercator, mercatorToLngLat } from '../../src/providers/usgs-lidar-ept.ts';
import { LidarTileCache, UsgsLidarService } from '../../src/providers/usgs-lidar-service.ts';
import { fixtureBytes, HOUSE_POINT, TILE_URL, unit } from './usgs-lidar-fixture.ts';

/*
 * EPT (the usgs-lidar-public octree): the nodes round a house only, Web Mercator back to UTM, the same product as the
 * tile path, and a fall back to the tiles when the EPT read fails. Fixture: make_ept_fixture.py (same house).
 */

const NOW = new Date('2026-10-15T12:00:00Z');
const ROOT = 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/USGS_LPC_AR_Fixture_LAS_2018';
const EPT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'usgs-lidar', 'ept');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function withEpt(api: FakeUsgsLidarApi): void {
  api.files.set(`${ROOT}/ept.json`, new Uint8Array(readFileSync(path.join(EPT_DIR, 'ept.json'))));
  for (const f of readdirSync(path.join(EPT_DIR, 'ept-hierarchy'))) api.files.set(`${ROOT}/ept-hierarchy/${f}`, new Uint8Array(readFileSync(path.join(EPT_DIR, 'ept-hierarchy', f))));
  for (const f of readdirSync(path.join(EPT_DIR, 'ept-data'))) api.files.set(`${ROOT}/ept-data/${f}`, new Uint8Array(readFileSync(path.join(EPT_DIR, 'ept-data', f))));
  api.epts.set('AR_Western_4_B24', `${ROOT}/ept.json`);
}

function service(api: FakeUsgsLidarApi) {
  const dir = mkdtempSync(path.join(tmpdir(), 'usgs-ept-'));
  dirs.push(dir);
  return { svc: new UsgsLidarService(api, { configured: false } as never, new LidarTileCache(dir, 1 << 30, () => NOW), () => NOW, { rangeBytes: 16 << 10, retryDelayMs: 0, cooldownMs: 0 }), dir };
}

describe('EPT', () => {
  it('Web Mercator round-trips', () => {
    const [x, y] = lngLatToMercator(-92.31, 34.75);
    const [lng, lat] = mercatorToLngLat(x, y);
    expect(lng).toBeCloseTo(-92.31, 9);
    expect(lat).toBeCloseTo(34.75, 9);
  });

  it('names a work unit may have in the bucket', () => {
    expect(eptNames(unit({ workunit: 'AR_Ouachita_B7_2016', collectEnd: '2017-03-26' }))).toEqual([
      'AR_Ouachita_B7_2016',
      'USGS_LPC_AR_Ouachita_B7_2016_LAS_2017',
      'USGS_LPC_AR_Ouachita_B7_2016_LAS_2018',
      'USGS_LPC_AR_Ouachita_B7_2016_LAS_2019',
      'USGS_LPC_AR_Ouachita_B7_2016_LAS_2020',
    ]);
  });

  it('reads only the nodes meeting the box, following a -1 to its own hierarchy file', async () => {
    const api = new FakeUsgsLidarApi();
    withEpt(api);
    const [x, y] = lngLatToMercator(...HOUSE_POINT);
    const small = await cropEpt(api, `${ROOT}/ept.json`, { x0: x + 30, x1: x + 40, y0: y + 30, y1: y + 40 });
    // The root and the north-east child only.
    expect(small.nodes).toBe(2);
    const all = await cropEpt(api, `${ROOT}/ept.json`, { x0: x - 70, x1: x + 70, y0: y - 70, y1: y + 70 });
    expect(all.nodes).toBe(5);
    expect(api.calls.some((c) => c.url?.endsWith('ept-hierarchy/1-0-0-0.json'))).toBe(true);
    await expect(cropEpt(api, `${ROOT}/ept.json`, { x0: x - 70, x1: x + 70, y0: y - 70, y1: y + 70 }, { timeoutMs: 1000, maxNodes: 3, maxHierarchyFiles: 32, maxNodeBytes: 1 << 20, maxPointsKept: 1e6, parallel: 2 })).rejects.toMatchObject({ reason: 'too-large' });
  });

  it('the service prefers EPT: no tile download, and the same points as the tile path', async () => {
    const a = new FakeUsgsLidarApi();
    withEpt(a);
    a.files.set(TILE_URL, fixtureBytes('house-14-fmt6.laz'));
    a.coverageAt = () => [unit()];
    const viaEpt = await service(a).svc.prefetch(HOUSE_POINT);
    expect(a.calls.some((c) => c.url === TILE_URL)).toBe(false);
    const b = new FakeUsgsLidarApi();
    b.files.set(TILE_URL, fixtureBytes('house-14-fmt6.laz'));
    b.coverageAt = () => [unit()];
    const viaTile = await service(b).svc.prefetch(HOUSE_POINT);
    if (!('crop' in viaEpt) || !('crop' in viaTile)) throw new Error('no crop');
    expect(viaEpt.crop.source.kind).toBe('ept');
    expect(viaEpt.crop.epsg).toBe(32615);
    const roof = (c: typeof viaEpt.crop) => [...c.cls].filter((k) => k === 6).length;
    // The EPT fixture has no noise points; the tile drops its noise: the roofs agree to a few points.
    expect(Math.abs(roof(viaEpt.crop) - roof(viaTile.crop))).toBeLessThanOrEqual(5);
    expect(Math.abs(viaEpt.crop.dx.length - viaTile.crop.dx.length) / viaTile.crop.dx.length).toBeLessThan(0.01);
  });

  it('an EPT read that fails falls back to the tiles, and says so in the ledger', async () => {
    const api = new FakeUsgsLidarApi();
    withEpt(api);
    api.files.delete(`${ROOT}/ept-data/1-1-1-0.laz`);
    api.files.set(TILE_URL, fixtureBytes('house-14-fmt6.laz'));
    api.coverageAt = () => [unit()];
    const { svc, dir } = service(api);
    const got = await svc.prefetch(HOUSE_POINT);
    expect('crop' in got && got.crop.source.kind).toBe('tile');
    expect(readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8')).toContain('ept-fallback');
  });
});
