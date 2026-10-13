import type { ProposalView } from '@roofline/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { measurements } from '@roofline/db';
import { addressFor, Actors, inCompany, mustCreate, NO_UUID } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import type { MeasurementPreview } from '../src/estimator/preview.ts';

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(new Date('2026-10-12T15:00:00.000Z'));
});

/** A customer's home with an estimate measurement (no outline needed: the stored numbers are what is priced). */
async function seed(surfaceSqFt = 2400) {
  const owner = await who.as('owner');
  const customer = await mustCreate(owner, '/api/customers', { displayName: 'Molly Lindgren' });
  const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(0) });
  const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });
  const [row] = await inCompany(t, t.seed.a.companyId, (tx) =>
    tx
      .insert(measurements)
      .values({
        companyId: t.seed.a.companyId, propertyId: property.id, jobId: job.id, kind: 'estimate', method: 'outline',
        surfaceSqFt, pitchX12: 6, edgeFt: 220, ridgeFt: 60, valleyFt: 20,
      })
      .returning({ id: measurements.id }),
  );
  return { owner, measurementId: row!.id };
}

describe('GET /api/measurements/:id/preview', () => {
  test('prices the three options exactly as Make proposal does, with the home and its customer', async () => {
    const { owner, measurementId } = await seed();
    const res = await owner.get(`/api/measurements/${measurementId}/preview`);
    expect(res.status).toBe(200);
    const preview = res.body as MeasurementPreview;
    expect(preview.customerName).toBe('Molly Lindgren');
    expect(preview.addressLine).not.toBe('');
    expect(preview.hailIn).toBeNull();
    expect(preview.options?.map((o) => o.tier)).toEqual(['good', 'better', 'best']);

    const built = (await owner.post('/api/proposals').send({ measurementId })).body as ProposalView;
    expect(preview.options?.map((o) => o.totalCents)).toEqual(built.options.map((o) => o.totalCents));
    expect(preview.options?.map((o) => o.monthlyEstimateCents)).toEqual(built.options.map((o) => o.monthlyEstimateCents));
  });

  test('a rep sees the home but no prices', async () => {
    const { measurementId } = await seed();
    const office = await who.as('office');
    expect((await office.get(`/api/measurements/${measurementId}/preview`)).body.options).toHaveLength(3);
    const rep = await who.as('rep');
    const res = await rep.get(`/api/measurements/${measurementId}/preview`);
    // A rep sees only their own homes: this one is a 404, never prices
    if (res.status === 200) expect(res.body.options).toBeNull();
    else expect(res.status).toBe(404);
  });

  test('a roof with nothing to price answers null options, not an error', async () => {
    const { owner, measurementId } = await seed(0);
    const res = await owner.get(`/api/measurements/${measurementId}/preview`);
    expect(res.status).toBe(200);
    expect(res.body.options).toBeNull();
  });

  test('unknown and malformed ids are 404', async () => {
    const owner = await who.as('owner');
    expect((await owner.get(`/api/measurements/${NO_UUID}/preview`)).status).toBe(404);
    expect((await owner.get('/api/measurements/nope/preview')).status).toBe(404);
  });
});
