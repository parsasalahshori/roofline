import type { GutterMeasurementView } from '@roofline/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { measurements, windowMeasurements } from '@roofline/db';
import { addressFor, Actors, inCompany, mustCreate, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(new Date('2026-10-15T15:00:00.000Z'));
});

// A 12 x 10 m house (a hip roof: four eave runs meeting at four outside corners), in Omaha.
const LNG0 = -95.9345;
const LAT0 = 41.2565;
const K = (Math.PI / 180) * 6371008.8;
const COS = Math.cos((LAT0 * Math.PI) / 180);
const HIP: [number, number][] = [[0, 0], [12, 0], [12, 10], [0, 10]].map(([x, y]) => [LNG0 + x! / (K * COS), LAT0 + y! / K]);
const ewkt = (ring: [number, number][]) => `SRID=4326;MULTIPOLYGON(((${[...ring, ring[0]!].map(([x, y]) => `${x} ${y}`).join(',')})))`;

/** A home with a measured outline, seen by `as` (a rep gets a job assigned to them). */
async function seed(as: 'owner' | 'rep' = 'owner', opts: { eaveHeightM?: number | null; stories?: number | null } = {}) {
  const owner = await who.as('owner');
  const customer = await mustCreate(owner, '/api/customers', { displayName: 'Molly Lindgren' });
  const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(0) });
  const job = await mustCreate(owner, '/api/jobs', {
    customerId: customer.id,
    propertyId: property.id,
    stage: 'inspection',
    ...(as === 'rep' ? { assignedUserId: who.user('rep').userId } : {}),
  });
  const companyId = t.seed.a.companyId;
  const [row] = await inCompany(t, companyId, (tx) =>
    tx
      .insert(measurements)
      .values({ companyId, propertyId: property.id, jobId: job.id, kind: 'estimate', method: 'outline', outline: ewkt(HIP), pitchX12: 6, overhangFt: 1 })
      .returning({ id: measurements.id }),
  );
  if (opts.eaveHeightM !== undefined || opts.stories !== undefined) {
    await inCompany(t, companyId, (tx) =>
      tx.insert(windowMeasurements).values({
        companyId,
        propertyId: property.id,
        address: '100 Oak St',
        center: HIP[0]!,
        tookMs: 10,
        stories: opts.stories ?? null,
        geometry: { ring: HIP, camera: null, eaveHeightM: opts.eaveHeightM ?? null, outlineSource: 'footprint' },
      }),
    );
  }
  return { agent: await who.as(as), id: row!.id, path: `/api/measurements/${row!.id}/gutters` };
}

describe('GET /api/measurements/:id/gutters', () => {
  test('runs along the eaves with downspouts, corners, size, totals and quotes', async () => {
    const { agent, path, id } = await seed();
    const res = await agent.get(path);
    expect(res.status).toBe(200);
    const v = res.body as GutterMeasurementView;
    expect(v.measurementId).toBe(id);
    expect(v.runs).toHaveLength(4);
    expect(v.runs[0]!.coords[0]).toHaveLength(2);
    expect(v.totals).toMatchObject({ runs: 4, downspouts: 4, outsideCorners: 4, insideCorners: 0, endCaps: 0, elbows: 12 });
    expect(v.size.recommended).toBe('5in');
    expect(v.size.reason).toMatch(/^5 in:/);
    expect(v.eave).toEqual({ heightFt: 10, floors: 1, source: 'assumed' });
    expect(v.totals.downspoutFt).toBe(40);
    expect(v.adjustments).toEqual({ excludedRunIds: [], downspouts: {}, size: null });
    expect(v.quotes?.map((q) => q.tier)).toEqual(['good', 'better', 'best']);
    expect(v.quotes![0]!.totalCents).toBeGreaterThan(0);
  });

  test("uses Google's eave height from a windows run at the same home", async () => {
    const { agent, path } = await seed('owner', { eaveHeightM: 5.8, stories: 2 });
    const v = (await agent.get(path)).body as GutterMeasurementView;
    expect(v.eave).toEqual({ heightFt: 19, floors: 2, source: 'google' });
    expect(v.totals.downspoutFt).toBe(4 * 19);
  });

  test('falls back to floors x 10 ft when only the floors are known', async () => {
    const { agent, path } = await seed('owner', { eaveHeightM: null, stories: 2 });
    expect(((await agent.get(path)).body as GutterMeasurementView).eave).toEqual({ heightFt: 20, floors: 2, source: 'floors' });
  });

  test('a rep sees the gutters but no prices', async () => {
    const { agent, path } = await seed('rep');
    const res = await agent.get(path);
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(4);
    expect(res.body.quotes).toBeNull();
  });

  test('a measurement the member may not see, or a malformed id, is a 404', async () => {
    const { path } = await seed();
    const rep = await who.as('rep');
    expect((await rep.get(path)).status).toBe(404);
    const owner = await who.as('owner');
    expect((await owner.get(`/api/measurements/${NO_UUID}/gutters`)).status).toBe(404);
    expect((await owner.get('/api/measurements/nope/gutters')).status).toBe(404);
    const other = await who.as('owner', 'b');
    expect((await other.get(path)).status).toBe(404);
  });
});

describe('PATCH /api/measurements/:id/gutters', () => {
  test('leaves a run out, sets downspouts and a size, keeps them, and merges later changes', async () => {
    const { agent, path } = await seed();
    const res = await agent.patch(path).send({ excludedRunIds: ['G1'], downspouts: { G2: 3 } });
    expect(res.status).toBe(200);
    const v = res.body as GutterMeasurementView;
    expect(v.adjustments).toEqual({ excludedRunIds: ['G1'], downspouts: { G2: 3 }, size: null });
    expect(v.totals.runs).toBe(3);
    expect(v.totals.outsideCorners).toBe(2);
    expect(v.totals.endCaps).toBe(2);
    expect(v.runs.find((r) => r.id === 'G2')!.downspouts).toHaveLength(3);

    const sized = await agent.patch(path).send({ size: '6in' });
    expect(sized.body.adjustments).toEqual({ excludedRunIds: ['G1'], downspouts: { G2: 3 }, size: '6in' });
    expect(sized.body.size).toMatchObject({ chosen: '6in', recommended: '5in', overridden: true, downspout: '3x4' });

    const again = (await agent.get(path)).body as GutterMeasurementView;
    expect(again.adjustments).toEqual({ excludedRunIds: ['G1'], downspouts: { G2: 3 }, size: '6in' });

    const reset = await agent.patch(path).send({ excludedRunIds: [], downspouts: {}, size: null });
    expect(reset.body.adjustments).toEqual({ excludedRunIds: [], downspouts: {}, size: null });
    expect(reset.body.totals.runs).toBe(4);
  });

  test('refuses unknown runs, bad counts, bad sizes and unknown fields', async () => {
    const { agent, path } = await seed();
    const unknownRun = await agent.patch(path).send({ excludedRunIds: ['G9'] });
    expect(unknownRun.status).toBe(400);
    expect(unknownRun.body.field).toBe('excludedRunIds');
    expect((await agent.patch(path).send({ downspouts: { G1: -1 } })).status).toBe(400);
    expect((await agent.patch(path).send({ downspouts: { G1: 1.5 } })).status).toBe(400);
    expect((await agent.patch(path).send({ downspouts: { G1: 99 } })).status).toBe(400);
    expect((await agent.patch(path).send({ downspouts: { G9: 1 } })).status).toBe(400);
    expect((await agent.patch(path).send({ size: '7in' })).status).toBe(400);
    expect((await agent.patch(path).send({ excludedRunIds: 'G1' })).status).toBe(400);
    expect((await agent.patch(path).send({ colour: 'white' })).status).toBe(400);
    expect((await agent.patch(path).send({})).status).toBe(400);
  });

  test('a rep changes gutters on their own measurement and still gets no prices; others get 404', async () => {
    const { agent, path } = await seed('rep');
    const res = await agent.patch(path).send({ excludedRunIds: ['G2'] });
    expect(res.status).toBe(200);
    expect(res.body.quotes).toBeNull();
    const other = await who.as('otherRep');
    const hidden = await other.patch(path).send({ excludedRunIds: [] });
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ error: NOT_FOUND });
  });
});
