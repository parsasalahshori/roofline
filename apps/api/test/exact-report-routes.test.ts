import { beforeEach, describe, expect, it } from 'vitest';
import { createMeasurement, type TenantContext } from '@roofline/db';
import { instantEstimate } from '@roofline/shared';
import { UnconfiguredExactReports } from '../src/deps.ts';
import { Actors, inCompany, mustCreate, NO_UUID } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');
const RING: [number, number][] = [[-96, 41.25], [-95.9997, 41.25], [-95.9997, 41.2502], [-96, 41.2502], [-96, 41.25]];

let t: TestApp;
let actors: Actors;
let measurementId: string;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  actors = new Actors(t);
  measurementId = await measurementIn('a');
});

async function measurementIn(company: 'a' | 'b'): Promise<string> {
  const ctx: TenantContext = { companyId: t.seed[company].companyId, userId: null, role: 'system', canApproveSpend: false };
  const agent = await actors.as('owner', company);
  const property = await mustCreate(agent, '/api/properties', { addressLine: '101 Oak St', city: 'Omaha', state: 'NE', zip: '68102' });
  const m = await inCompany(t, ctx.companyId, (tx) =>
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
  return m.id;
}

describe('POST /api/measurements/:id/exact-report', () => {
  it('as owner -> 201 {taskId}', async () => {
    const res = await (await actors.as('owner')).post(`/api/measurements/${measurementId}/exact-report`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(typeof res.body.taskId).toBe('string');
  });

  it('as rep -> 403', async () => {
    const res = await (await actors.as('rep')).post(`/api/measurements/${measurementId}/exact-report`).send({});
    expect(res.status).toBe(403);
  });

  it('missing measurement -> 404', async () => {
    const res = await (await actors.as('owner')).post(`/api/measurements/${NO_UUID}/exact-report`).send({});
    expect(res.status).toBe(404);
  });

  it("not configured -> 503 \"Exact reports aren't set up yet.\"", async () => {
    t.deps.exactReports = new UnconfiguredExactReports();
    const res = await (await actors.as('owner')).post(`/api/measurements/${measurementId}/exact-report`).send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("Exact reports aren't set up yet.");
  });

  it("another company's measurement -> 404", async () => {
    const other = await measurementIn('b');
    const res = await (await actors.as('owner')).post(`/api/measurements/${other}/exact-report`).send({});
    expect(res.status).toBe(404);
  });
});
