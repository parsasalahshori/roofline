import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMeasurement, measurements, type TenantContext } from '@roofline/db';
import { instantEstimate, type MeasurementView } from '@roofline/shared';
import { UnconfiguredAerial } from '../src/deps.ts';
import { aerialTiming } from '../src/estimator/aerial.ts';
import { Actors, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');
const FALLBACK = 'Aerial measure is taking longer than usual. Try again in a minute.';
const RING: [number, number][] = [[-96, 41.25], [-95.9997, 41.25], [-95.9997, 41.2502], [-96, 41.2502], [-96, 41.25]];

let t: TestApp;
let actors: Actors;
let ctx: TenantContext;

beforeEach(async () => {
  aerialTiming.intervalMs = 0;
  t = await makeTestApp();
  t.clock.set(NOW);
  actors = new Actors(t);
  ctx = { companyId: t.seed.a.companyId, userId: null, role: 'system', canApproveSpend: false };
});

async function setAerial(on: boolean) {
  const owner = await actors.as('owner');
  const res = await owner.put('/api/estimator/settings').send({ aerialMeasure: on });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function source(addressLine = '101 Oak St'): Promise<MeasurementView> {
  const owner = await actors.as('owner');
  const property = await mustCreate(owner, '/api/properties', { addressLine, city: 'Omaha', state: 'NE', zip: '68102' });
  return inCompany(t, ctx.companyId, (tx) =>
    createMeasurement(
      tx,
      ctx,
      {
        propertyId: property.id,
        kind: 'estimate',
        method: 'outline',
        outline: [RING],
        structures: [{ footprintId: 'fp-1', included: true, areaSqFt: 2000, ring: RING }],
        estimate: instantEstimate({ outline: [RING], pitchX12: 6, overhangFt: 1 }),
        overhangFt: 1,
        center: [-95.99985, 41.2501],
      },
      NOW,
    ),
  );
}

const resultCalls = () => t.aerial.calls.filter((c) => c.method === 'result');

describe('POST /api/measurements/:id/aerial', () => {
  it('aerial off -> 403', async () => {
    const m = await source();
    const res = await (await actors.as('owner')).post(`/api/measurements/${m.id}/aerial`).send({});
    expect(res.status).toBe(403);
    expect(t.aerial.calls).toHaveLength(0);
  });

  it('aerial on: fake pending then complete -> 201 with method aerial, surfaceSqFt 2480, pitchX12 7', async () => {
    await setAerial(true);
    const m = await source();
    const res = await (await actors.as('owner')).post(`/api/measurements/${m.id}/aerial`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const view = res.body as MeasurementView;
    expect(view.method).toBe('aerial');
    // The view recomputes its estimate from the outline; the aerial area is the stored column.
    const [row] = await inCompany(t, ctx.companyId, (tx) => tx.select().from(measurements).where(eq(measurements.id, view.id)));
    expect(row!.surfaceSqFt).toBe(2480);
    expect(view.estimate.pitchX12).toBe(7);
    expect(resultCalls().length).toBeGreaterThanOrEqual(2);
  });

  it('the source measurement is unchanged and the new one has a different id', async () => {
    await setAerial(true);
    const m = await source();
    const owner = await actors.as('owner');
    const res = await owner.post(`/api/measurements/${m.id}/aerial`).send({});
    expect(res.status).toBe(201);
    const view = res.body as MeasurementView;
    expect(view.id).not.toBe(m.id);
    expect(view.propertyId).toBe(m.propertyId);
    const again = await owner.get(`/api/measurements/${m.id}`);
    expect(again.body).toEqual(m);
  });

  it('outage address -> 503 with the fallback message', async () => {
    await setAerial(true);
    const m = await source('9 Outage Rd');
    const res = await (await actors.as('owner')).post(`/api/measurements/${m.id}/aerial`).send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(FALLBACK);
  });

  it('aerial not configured -> 403', async () => {
    const m = await source();
    t.deps.aerial = new UnconfiguredAerial();
    const res = await (await actors.as('owner')).post(`/api/measurements/${m.id}/aerial`).send({});
    expect(res.status).toBe(403);
  });
});
