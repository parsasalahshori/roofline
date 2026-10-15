import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cellOf, decodeCrop, encodeCrop, LidarTileCache, UsgsLidarService } from '../../src/providers/usgs-lidar-service.ts';
import { utmToLngLat } from '@roofline/shared/roof-reconstruct';
import { FakeUsgsLidarApi } from '../../src/providers/usgs-lidar.ts';
import { fixtureBytes, HOUSE_POINT, TILE_URL, unit } from './usgs-lidar-fixture.ts';

/*
 * The lidar service with a fake USGS and a temporary tile directory: prefetch, the parallel ranged download, the tile
 * cache and ledger, the derived product, the Measure budget, and the typed reasons.
 */

const NOW = new Date('2026-10-15T12:00:00Z');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(o: { dir?: boolean; limits?: Record<string, number> } = {}) {
  const api = new FakeUsgsLidarApi();
  api.files.set(TILE_URL, fixtureBytes('house-14-fmt6.laz'));
  api.coverageAt = () => [unit()];
  const dir = o.dir === false ? null : mkdtempSync(path.join(tmpdir(), 'usgs-lidar-'));
  if (dir !== null) dirs.push(dir);
  const store = { configured: false } as never;
  const svc = new UsgsLidarService(api, store, new LidarTileCache(dir, 1 << 30, () => NOW), () => NOW, { rangeBytes: 16 << 10, rangeParallel: 4, retryDelayMs: 0, cooldownMs: 0, ...o.limits });
  return { api, svc, dir };
}

/** A gate the fake USGS waits on until the test opens it. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { wait: () => p, open };
}

describe('UsgsLidarService', () => {
  it('prefetch: one coverage lookup, the tile in parallel 16 KB ranges, the crop round the house with its provenance', async () => {
    const { api, svc, dir } = setup();
    const got = await svc.prefetch(HOUSE_POINT);
    expect('crop' in got).toBe(true);
    if (!('crop' in got)) return;
    const size = fixtureBytes('house-14-fmt6.laz').byteLength;
    expect(api.calls.filter((c) => c.kind === 'get')).toHaveLength(Math.ceil(size / (16 << 10)));
    expect(got.crop.epsg).toBe(26915);
    expect(got.crop.source).toMatchObject({ workunit: 'AR_Western_4_B24', ql: 1, leafOff: true, kind: 'tile', pointDates: ['2025-02-10', '2025-02-10', '2025-02-10'] });
    expect(got.crop.source.credit).toMatch(/USGS/);
    expect(got.crop.source.lastPerM2).toBeGreaterThan(3);
    // Roof points sit round the cell centre (the house point is inside the 10 m cell).
    const roofN = [...got.crop.cls].filter((k) => k === 6).length;
    expect(roofN).toBeGreaterThan(900);
    // The ledger records the download with its size and checksum.
    const ledger = readFileSync(path.join(dir!, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger).toEqual([expect.objectContaining({ what: 'laz-tile', url: TILE_URL, bytes: size, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), at: NOW.toISOString() })]);
    expect(readdirSync(dir!).filter((f) => f.endsWith('.laz'))).toHaveLength(1);
  });

  it('without a tile directory a house still downloads its tile once', async () => {
    const { api, svc } = setup({ dir: false });
    expect('crop' in (await svc.prefetch(HOUSE_POINT))).toBe(true);
    expect(api.calls.filter((c) => c.kind === 'size')).toHaveLength(1);
    expect(api.calls.filter((c) => c.kind === 'get')).toHaveLength(Math.ceil(fixtureBytes('house-14-fmt6.laz').byteLength / (16 << 10)));
  });

  it('a second house on the same tile reads the cached tile: no download', async () => {
    const { api, svc } = setup();
    await svc.prefetch(HOUSE_POINT);
    const gets = api.calls.filter((c) => c.kind === 'get').length;
    const next = await svc.prefetch([HOUSE_POINT[0] + 0.0002, HOUSE_POINT[1]]);
    expect('crop' in next).toBe(true);
    expect(api.calls.filter((c) => c.kind === 'get').length).toBe(gets);
  });

  it('Measure: not ready within the budget is lidar-pending; the fetch carries on and the next Measure has it', async () => {
    const { api, svc } = setup();
    const g = gate();
    api.gate = g.wait;
    expect(await svc.forMeasure(HOUSE_POINT, 0)).toEqual({ none: 'lidar-pending' });
    g.open();
    // Joins the fetch already running (one coverage lookup in all).
    const later = await svc.forMeasure(HOUSE_POINT, 60_000);
    expect('crop' in later).toBe(true);
    expect(api.calls.filter((c) => c.kind === 'coverage')).toHaveLength(1);
    // Ready: read from the kept product with no USGS call at all.
    const n = api.calls.length;
    expect('crop' in (await svc.forMeasure(HOUSE_POINT, 0))).toBe(true);
    expect(api.calls.length).toBe(n);
  });

  it('no coverage and leaf-on only are kept (no second lookup); too sparse is typed', async () => {
    const a = setup();
    a.api.coverageAt = () => [];
    expect(await a.svc.forMeasure(HOUSE_POINT, 60_000)).toEqual({ none: 'no-coverage' });
    expect(await a.svc.forMeasure(HOUSE_POINT, 60_000)).toEqual({ none: 'no-coverage' });
    expect(a.api.calls.filter((c) => c.kind === 'coverage')).toHaveLength(1);
    const b = setup();
    b.api.coverageAt = () => [unit({ leafOff: false, collectStart: '2012-06-01', collectEnd: '2012-07-01' })];
    expect(await b.svc.prefetch(HOUSE_POINT)).toEqual({ none: 'leaf-on-only' });
    const c = setup({ limits: { minLastPerM2: 100 } });
    expect(await c.svc.prefetch(HOUSE_POINT)).toEqual({ none: 'too-sparse' });
  });

  it('an outage is a typed error that is not kept: the next try succeeds', async () => {
    const { api, svc } = setup();
    api.failNext(1);
    expect(await svc.prefetch(HOUSE_POINT)).toEqual({ none: 'error', detail: 'usgs:http' });
    expect('crop' in (await svc.prefetch(HOUSE_POINT))).toBe(true);
  });

  it('a dropped byte range is tried again (up to 3 times); a range failing 3 times fails the fetch, not kept', async () => {
    const a = setup();
    a.api.failGets(2);
    expect('crop' in (await a.svc.prefetch(HOUSE_POINT))).toBe(true);
    const b = setup({ limits: { rangeParallel: 1 } });
    b.api.failGets(3);
    expect(await b.svc.prefetch(HOUSE_POINT)).toEqual({ none: 'error', detail: 'usgs:http' });
    expect('crop' in (await b.svc.prefetch(HOUSE_POINT))).toBe(true);
  });

  it('after a failed download no tile download starts until the cooldown has passed (fails fast, logged)', async () => {
    let now = NOW.getTime();
    const api = new FakeUsgsLidarApi();
    api.files.set(TILE_URL, fixtureBytes('house-14-fmt6.laz'));
    const dir = mkdtempSync(path.join(tmpdir(), 'usgs-lidar-'));
    dirs.push(dir);
    const clock = () => new Date(now);
    const svc = new UsgsLidarService(api, { configured: false } as never, new LidarTileCache(dir, 1 << 30, clock), clock, { retryDelayMs: 0, rangeParallel: 1, cooldownMs: 300_000 });
    api.failGets(3);
    await expect(svc.tile(TILE_URL)).rejects.toMatchObject({ reason: 'http' });
    const calls = api.calls.length;
    await expect(svc.tile(TILE_URL)).rejects.toMatchObject({ reason: 'cooldown' });
    expect(api.calls.length).toBe(calls);
    expect(readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8')).toContain('"what":"cooldown"');
    now += 300_001;
    await expect(svc.tile(TILE_URL)).resolves.toHaveLength(fixtureBytes('house-14-fmt6.laz').byteLength);
  });

  it('the daily download budget refuses a tile past it (logged), and frees up after 24 hours', async () => {
    const size = fixtureBytes('house-14-fmt6.laz').byteLength;
    let now = NOW.getTime();
    const api = new FakeUsgsLidarApi();
    api.files.set(TILE_URL, fixtureBytes('house-14-fmt6.laz'));
    const other = TILE_URL.replace('fixture.laz', 'other.laz');
    api.files.set(other, fixtureBytes('house-14-fmt6.laz'));
    const dir = mkdtempSync(path.join(tmpdir(), 'usgs-lidar-'));
    dirs.push(dir);
    const clock = () => new Date(now);
    const svc = new UsgsLidarService(api, { configured: false } as never, new LidarTileCache(dir, 1 << 30, clock), clock, { retryDelayMs: 0, cooldownMs: 0, maxDownloadBytesPerDay: size + 10 });
    await svc.tile(TILE_URL);
    await expect(svc.tile(other)).rejects.toMatchObject({ reason: 'budget' });
    expect(readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8')).toContain('daily-budget');
    now += 86_400_001;
    await expect(svc.tile(other)).resolves.toHaveLength(size);
  });

  it('a damaged tile, a tile over the size limit, and a tile off USGS hosts are typed errors', async () => {
    const a = setup({ dir: false });
    a.api.files.set(TILE_URL, fixtureBytes('house-14-fmt6.laz').subarray(0, 30_000));
    expect(await a.svc.prefetch(HOUSE_POINT)).toMatchObject({ none: 'error', detail: expect.stringMatching(/^las:/) });
    const b = setup({ limits: { maxTileBytes: 1000 } });
    expect(await b.svc.prefetch(HOUSE_POINT)).toEqual({ none: 'error', detail: 'usgs:too-large' });
    const c = setup();
    const evil = 'https://evil.example.com/AR_Western_4_B24/x.laz';
    c.api.files.set(evil, fixtureBytes('house-14-fmt6.laz'));
    c.api.coverageAt = () => [unit({ tiles: [{ url: evil, bytes: null }] })];
    expect(await c.svc.prefetch(HOUSE_POINT)).toEqual({ none: 'error', detail: 'usgs:host' });
  });

  it('the derived product round-trips byte for byte and is identical for identical input', async () => {
    const a = await setup().svc.prefetch(HOUSE_POINT);
    const b = await setup().svc.prefetch(HOUSE_POINT);
    if (!('crop' in a) || !('crop' in b)) throw new Error('no crop');
    const bytes = encodeCrop(a.crop);
    expect(Buffer.from(encodeCrop(b.crop))).toEqual(Buffer.from(bytes));
    const back = decodeCrop(bytes)!;
    expect(Buffer.from(encodeCrop(back))).toEqual(Buffer.from(bytes));
    expect(decodeCrop(bytes.subarray(0, bytes.byteLength - 1))).toBeNull();
    expect(decodeCrop(new TextEncoder().encode('garbage'))).toBeNull();
  });

  it('a house is cropped on a 10 m grid: nearby points share a cell, 40 m each side of its centre', () => {
    const at = (e: number, n: number) => cellOf(utmToLngLat({ zone: 15, south: false }, e, n) as [number, number]);
    const a = at(560052, 3845052);
    expect(at(560058, 3845058).key).toBe(a.key);
    expect(at(560061, 3845052).key).not.toBe(a.key);
    expect(a).toMatchObject({ zone: 15, e: 560055, n: 3845055 });
  });

  it('the tile cache keeps under its size limit, dropping the oldest tile', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'usgs-lidar-'));
    dirs.push(dir);
    const cache = new LidarTileCache(dir, 2500, () => NOW);
    await cache.put('https://rockyweb.usgs.gov/a.laz', new Uint8Array(1000), 1);
    await new Promise((r) => setTimeout(r, 15));
    await cache.put('https://rockyweb.usgs.gov/b.laz', new Uint8Array(1000), 1);
    await cache.put('https://rockyweb.usgs.gov/c.laz', new Uint8Array(1000), 1);
    expect(await cache.get('https://rockyweb.usgs.gov/a.laz')).toBeNull();
    expect(await cache.get('https://rockyweb.usgs.gov/c.laz')).not.toBeNull();
  });

  it('the area job downloads each leaf-off tile of the area once', async () => {
    const { api, svc } = setup();
    const r = await svc.prefetchArea([HOUSE_POINT[0] - 0.006, HOUSE_POINT[1] - 0.004], [HOUSE_POINT[0] + 0.006, HOUSE_POINT[1] + 0.004]);
    expect(r).toEqual({ tiles: 1, failed: 0, none: {} });
    expect(api.calls.filter((c) => c.kind === 'size')).toHaveLength(1);
  });
});
