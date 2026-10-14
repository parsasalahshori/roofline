import { describe, expect, test } from 'vitest';
import type { Pools } from '@roofline/db';
import type { Config } from '../src/config.ts';
import { UnconfiguredAerial, UnconfiguredExactReports } from '../src/deps.ts';
import { AerialUnavailableError } from '../src/providers/aerial.ts';
import { ExactOrderUncertainError, ExactReportsUnavailableError } from '../src/providers/exact-reports.ts';
import { FakeAerialMeasure } from '../src/providers/fakes/aerial.ts';
import { FakeExactReports } from '../src/providers/fakes/exact-reports.ts';
import { FakeFootprintSource } from '../src/providers/fakes/footprints.ts';
import { MemoryObjectStore } from '../src/providers/fakes/object-store.ts';
import { createFootprintSource } from '../src/providers/footprints.ts';
import { createObjectStore, ObjectStoreUnavailableError } from '../src/providers/object-store.ts';

const input = { address: { street: '1 A St', city: 'Omaha', state: 'NE', zip: '68102' }, productId: 1, referenceId: 'r' };
const cfg = (o: object) => ({ NODE_ENV: 'test', ...o }) as unknown as Config;
const pools = undefined as unknown as Pools;
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('FakeFootprintSource', () => {
  /** The tile the six Omaha fixture buildings fall in. */
  const OMAHA = '021332333';
  test('the Omaha tile yields the fixture rings', async () => {
    const f = await collect(new FakeFootprintSource().features(OMAHA));
    expect(f).toHaveLength(6);
    expect(f[0]?.sourceRef).toBe('fake-ne-1');
    for (const x of f) expect(new Set(x.ring.map((p) => p.join(','))).size).toBeGreaterThanOrEqual(3);
  });
  test('another tile yields nothing and has no files', async () => {
    const s = new FakeFootprintSource();
    expect(await collect(s.features('021332332'))).toEqual([]);
    expect(await s.tileUrls('021332332')).toEqual([]);
  });
  test('tileUrls is stable', async () => {
    const s = new FakeFootprintSource();
    expect(await s.tileUrls(OMAHA)).toEqual([`https://fake.test/footprints/${OMAHA}.csv.gz`]);
    expect(await s.tileUrls(OMAHA)).toEqual(await s.tileUrls(OMAHA));
  });
  test('failNext(2) makes the next two iterations throw, then it works', async () => {
    const s = new FakeFootprintSource();
    s.failNext(2);
    await expect(collect(s.features(OMAHA))).rejects.toThrow('Fake footprints failure');
    await expect(collect(s.features(OMAHA))).rejects.toThrow('Fake footprints failure');
    expect(await collect(s.features(OMAHA))).toHaveLength(6);
    expect(s.calls).toHaveLength(3);
  });
});

describe('FakeAerialMeasure', () => {
  test('start gives req-1 then req-2', async () => {
    const a = new FakeAerialMeasure();
    expect(await a.start('x')).toEqual({ requestId: 'req-1' });
    expect(await a.start('y')).toEqual({ requestId: 'req-2' });
  });
  test('result is pending once then complete with 2480 sq ft at 7/12', async () => {
    const a = new FakeAerialMeasure();
    const { requestId } = await a.start('x');
    expect(await a.result(requestId)).toEqual({ status: 'pending' });
    expect(await a.result(requestId)).toEqual({
      status: 'complete',
      roofs: [{ areaSqFt: 2480, pitchX12: 7, structureIndex: 0 }],
    });
    await expect(a.result('nope')).rejects.toThrow();
  });
  test('an address matching /outage/i throws AerialUnavailableError', async () => {
    await expect(new FakeAerialMeasure().start('1 Outage Rd')).rejects.toBeInstanceOf(AerialUnavailableError);
  });
  test('failNext', async () => {
    const a = new FakeAerialMeasure();
    a.failNext();
    await expect(a.start('x')).rejects.toThrow('Fake aerial failure');
    expect(await a.start('x')).toEqual({ requestId: 'req-1' });
    expect(a.calls[0]).toEqual({ method: 'start', args: { address: 'x' } });
  });
});

describe('FakeExactReports', () => {
  test('price is 4200-6200 cents expiring in 10 minutes', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const p = await new FakeExactReports(() => now).price(input);
    expect(p.minCents).toBe(4200);
    expect(p.maxCents).toBe(6200);
    expect(p.expiresAt.toISOString()).toBe('2026-01-01T00:10:00.000Z');
  });
  test('order gives rep-1', async () => {
    expect(await new FakeExactReports().order(input)).toEqual({ reportId: 'rep-1' });
  });
  test('report is pending until complete(reportId), then the fixed report with cost 4500', async () => {
    const r = new FakeExactReports();
    const { reportId } = await r.order(input);
    expect(await r.report(reportId)).toEqual({ status: 'pending' });
    expect(await r.report('unknown')).toEqual({ status: 'pending' });
    r.complete(reportId);
    expect(await r.report(reportId)).toEqual({
      status: 'complete',
      report: { surfaceSqFt: 2612, pitchX12: 7, ridgeFt: 62, edgeFt: 188, valleyFt: 24, facets: 9, reportRef: reportId },
      costCents: 4500,
    });
  });
  test('orderUncertainNext makes exactly one order throw ExactOrderUncertainError', async () => {
    const r = new FakeExactReports();
    r.orderUncertainNext();
    await expect(r.order(input)).rejects.toBeInstanceOf(ExactOrderUncertainError);
    expect(await r.order(input)).toEqual({ reportId: 'rep-2' });
    expect(r.calls.filter((c) => c.method === 'order')).toHaveLength(2);
  });
  test('failNext', async () => {
    const r = new FakeExactReports();
    r.failNext();
    await expect(r.price(input)).rejects.toThrow('Fake exact reports failure');
    await expect(r.price(input)).resolves.toBeTruthy();
  });
});

describe('MemoryObjectStore', () => {
  test('put then get round-trips bytes and returns a copy', async () => {
    const s = new MemoryObjectStore();
    const bytes = new Uint8Array([1, 2, 3]);
    await s.put('k', bytes, 'application/pdf');
    bytes[0] = 9;
    const got = await s.get('k');
    expect(Array.from(got ?? [])).toEqual([1, 2, 3]);
    if (got) got[1] = 7;
    expect(Array.from((await s.get('k')) ?? [])).toEqual([1, 2, 3]);
    expect(s.calls[0]).toEqual({ method: 'put', key: 'k', contentType: 'application/pdf' });
  });
  test('get of a missing key is null', async () => {
    expect(await new MemoryObjectStore().get('x')).toBeNull();
  });
  test('failNext', async () => {
    const s = new MemoryObjectStore();
    s.failNext();
    await expect(s.put('k', new Uint8Array(), 'a/b')).rejects.toThrow('Fake object store failure');
    await expect(s.put('k', new Uint8Array(), 'a/b')).resolves.toBeUndefined();
  });
});

describe('factories', () => {
  test('unconfigured aerial and exact reports reject rather than throw', async () => {
    const a = new UnconfiguredAerial();
    expect(a.configured).toBe(false);
    await expect(a.start()).rejects.toBeInstanceOf(AerialUnavailableError);
    await expect(a.result()).rejects.toBeInstanceOf(AerialUnavailableError);
    const r = new UnconfiguredExactReports();
    expect(r.configured).toBe(false);
    await expect(r.price()).rejects.toBeInstanceOf(ExactReportsUnavailableError);
    await expect(r.order()).rejects.toBeInstanceOf(ExactReportsUnavailableError);
    await expect(r.report()).rejects.toBeInstanceOf(ExactReportsUnavailableError);
  });

  test('FAKE_PROVIDERS gives the fakes', () => {
    expect(createFootprintSource(cfg({ FAKE_PROVIDERS: true }))).toBeInstanceOf(FakeFootprintSource);
    expect(createObjectStore(cfg({ FAKE_PROVIDERS: true }), pools)).toBeInstanceOf(MemoryObjectStore);
  });
  test('production with nothing configured is unconfigured', async () => {
    const store = createObjectStore(cfg({ NODE_ENV: 'production', FAKE_PROVIDERS: false }), pools);
    expect(store.configured).toBe(false);
    await expect(store.put('k', new Uint8Array(), 'a/b')).rejects.toBeInstanceOf(ObjectStoreUnavailableError);
    await expect(store.get('k')).rejects.toBeInstanceOf(ObjectStoreUnavailableError);
  });
  test('footprints without FAKE_PROVIDERS is unconfigured', async () => {
    const src = createFootprintSource(cfg({ FAKE_PROVIDERS: false }));
    expect(src.configured).toBe(false);
    await expect(src.tileUrls('021332333')).rejects.toThrow("Building footprints aren't set up.");
  });
});
