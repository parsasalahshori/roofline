import { EMPTY_GUTTER_ADJUSTMENTS, type GutterMeasurementView } from '@roofline/shared';
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
async function seed(
  as: 'owner' | 'rep' = 'owner',
  opts: { eaveHeightM?: number | null; stories?: number | null; eagleview?: { eaveFt: number | null } } = {},
) {
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
      .values({
        companyId,
        propertyId: property.id,
        jobId: job.id,
        kind: opts.eagleview ? 'exact' : 'estimate',
        method: opts.eagleview ? 'eagleview' : 'outline',
        outline: ewkt(HIP),
        pitchX12: 6,
        overhangFt: 1,
        eaveFt: opts.eagleview?.eaveFt ?? null,
      })
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
    expect(v.totals).toMatchObject({ runs: 4, downspouts: 4, outsideCorners: 4, insideCorners: 0, endCaps: 0, elbows: 12, lengthSource: 'measured' });
    expect(v.confidence).toBe('estimate');
    expect(v.reportEaveFt).toBeNull();
    expect(v.addedRuns).toEqual([]);
    expect(v.size.recommended).toBe('5in');
    // A hip roof: gutters all round the outline, nothing to check
    expect(v.check.reasons).toEqual([]);
    expect(v.check.share).toBeCloseTo(1, 1);
    expect(v.check.perimeterFt).toBeGreaterThan(130);
    expect(v.size.reason).toMatch(/^5 in:/);
    expect(v.eave).toEqual({ heightFt: 10, floors: 1, source: 'assumed' });
    expect(v.totals.downspoutFt).toBe(40);
    expect(v.adjustments).toEqual(EMPTY_GUTTER_ADJUSTMENTS);
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

  test("an EagleView measurement's eave length is the gutter total, and it is not flagged", async () => {
    const { agent, path } = await seed('owner', { eagleview: { eaveFt: 212.5 } });
    const v = (await agent.get(path)).body as GutterMeasurementView;
    expect(v.reportEaveFt).toBe(212.5);
    expect(v.totals).toMatchObject({ gutterFt: 212.5, lengthSource: 'eagleview' });
    expect(v.confidence).toBe('exact');
    expect(v.check.reasons).toEqual([]);
    expect(v.quotes![0]!.lines.find((l) => l.kind === 'gutter')!.quantity).toBe(212.5);
  });

  test('an EagleView measurement with no eave length falls back to the measured runs', async () => {
    const { agent, path } = await seed('owner', { eagleview: { eaveFt: null } });
    const v = (await agent.get(path)).body as GutterMeasurementView;
    expect(v.reportEaveFt).toBeNull();
    expect(v.totals.lengthSource).toBe('measured');
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
    expect(v.adjustments).toMatchObject({ excludedRunIds: ['G1'], downspouts: { G2: 3 }, size: null, addedRuns: [], totalFt: null });
    expect(v.adjustments.adjustedBy).toEqual({ name: expect.stringMatching(/\S/), at: '2026-10-15T15:00:00.000Z' });
    expect(v.totals.runs).toBe(3);
    expect(v.totals.outsideCorners).toBe(2);
    expect(v.totals.endCaps).toBe(2);
    expect(v.runs.find((r) => r.id === 'G2')!.downspouts).toHaveLength(3);

    const sized = await agent.patch(path).send({ size: '6in' });
    expect(sized.body.adjustments).toMatchObject({ excludedRunIds: ['G1'], downspouts: { G2: 3 }, size: '6in' });
    expect(sized.body.size).toMatchObject({ chosen: '6in', recommended: '5in', overridden: true, downspout: '3x4' });

    const again = (await agent.get(path)).body as GutterMeasurementView;
    expect(again.adjustments).toMatchObject({ excludedRunIds: ['G1'], downspouts: { G2: 3 }, size: '6in' });
    expect(again.adjustments.adjustedBy).not.toBeNull();

    // Everything put back: nothing is adjusted, so no one is named
    const reset = await agent.patch(path).send({ excludedRunIds: [], downspouts: {}, size: null });
    expect(reset.body.adjustments).toEqual(EMPTY_GUTTER_ADJUSTMENTS);
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
    // Who changed it is the server's to write
    expect((await agent.patch(path).send({ adjustedBy: { name: 'Mallory', at: '2020-01-01' } })).status).toBe(400);
  });

  test('adds runs by hand and types a total; both are priced, kept, and stamped with who did it', async () => {
    const { agent, path } = await seed();
    const base = (await agent.get(path)).body as GutterMeasurementView;
    const res = await agent.patch(path).send({ addedRuns: [{ id: 'A1', label: ' Upper floor, back ', lengthFt: 40 }], downspouts: { A1: 2 } });
    expect(res.status).toBe(200);
    const v = res.body as GutterMeasurementView;
    expect(v.adjustments.addedRuns).toEqual([{ id: 'A1', label: 'Upper floor, back', lengthFt: 40 }]);
    expect(v.addedRuns[0]).toMatchObject({ id: 'A1', downspouts: 2, downspoutsSet: true });
    expect(v.totals.gutterFt).toBeCloseTo(base.totals.gutterFt + 40, 1);
    expect(v.confidence).toBe('adjusted');
    expect(v.quotes![0]!.totalCents).toBeGreaterThan(base.quotes![0]!.totalCents);
    expect(v.adjustments.adjustedBy?.name).toMatch(/\S/);

    const typed = await agent.patch(path).send({ totalFt: 260 });
    expect(typed.status).toBe(200);
    expect(typed.body.totals).toMatchObject({ gutterFt: 260, lengthSource: 'override' });
    expect(typed.body.adjustments).toMatchObject({ totalFt: 260, addedRuns: [{ id: 'A1' }] });
    expect(typed.body.quotes[0].lines.find((l: { kind: string }) => l.kind === 'gutter').quantity).toBe(260);

    const again = (await agent.get(path)).body as GutterMeasurementView;
    expect(again.adjustments).toMatchObject({ totalFt: 260, addedRuns: [{ id: 'A1', label: 'Upper floor, back', lengthFt: 40 }], downspouts: { A1: 2 } });

    // Removing the added run drops its typed downspouts; null goes back to the runs
    const cleared = await agent.patch(path).send({ addedRuns: [], totalFt: null });
    expect(cleared.body.adjustments).toEqual(EMPTY_GUTTER_ADJUSTMENTS);
    expect(cleared.body.totals.lengthSource).toBe('measured');
  });

  test('refuses bad added runs and totals', async () => {
    const { agent, path } = await seed();
    const bad = async (body: Record<string, unknown>) => {
      const res = await agent.patch(path).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      return res;
    };
    expect((await bad({ addedRuns: [{ id: 'A1', label: 'x', lengthFt: 0 }] })).body.field).toBe('addedRuns');
    await bad({ addedRuns: [{ id: 'A1', label: 'x', lengthFt: 501 }] });
    await bad({ addedRuns: [{ id: 'G1', label: 'x', lengthFt: 20 }] });
    await bad({ addedRuns: [{ id: 'A1', label: 'x'.repeat(41), lengthFt: 20 }] });
    await bad({ addedRuns: [{ id: 'A1', label: 'a\u0000b', lengthFt: 20 }] });
    await bad({ addedRuns: [{ id: 'A1', label: 'x', lengthFt: 20, colour: 'white' }] });
    await bad({ addedRuns: [{ id: 'A1', label: 'x', lengthFt: 20 }, { id: 'A1', label: 'y', lengthFt: 30 }] });
    await bad({ addedRuns: Array.from({ length: 21 }, (_, i) => ({ id: `A${i + 1}`, label: '', lengthFt: 10 })) });
    await bad({ addedRuns: 'A1' });
    expect((await bad({ totalFt: 0 })).body.field).toBe('totalFt');
    await bad({ totalFt: 5001 });
    await bad({ totalFt: '200' });
    // Downspouts only for runs that exist: an added run must be on the (new) list
    expect((await bad({ downspouts: { A1: 1 } })).body.field).toBe('downspouts');
    expect((await agent.patch(path).send({ addedRuns: [{ id: 'A1', label: '', lengthFt: 20 }], downspouts: { A1: 1 } })).status).toBe(200);
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
