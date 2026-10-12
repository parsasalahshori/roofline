import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  agentTasks,
  agentTaskSteps,
  createAppointment,
  createCustomer,
  createJob,
  createProperty,
  setPaused,
  type TenantContext,
} from '@roofline/db';
import { Actors, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');
const TUE_START = new Date('2026-10-13T15:00:00.000Z');
const TUE_END = new Date('2026-10-13T16:00:00.000Z');

let t: TestApp;
let who: Actors;
let seq = 0;
const A = () => t.seed.a.companyId;
const ctxA = (): TenantContext => ({ companyId: A(), userId: null, role: 'system', canApproveSpend: false });

async function seedVisit(first: string): Promise<string> {
  const ctx = ctxA();
  const now = t.clock.now();
  const n = seq++;
  return inCompany(t, A(), async (tx) => {
    const customer = await createCustomer(
      tx,
      ctx,
      { displayName: `${first} NoShow`, firstName: first, phones: [{ e164: `+1512556${String(1000 + n)}`, primary: true }] },
      { now },
    );
    const property = await createProperty(
      tx,
      ctx,
      { customerId: customer.id, addressLine: `${2000 + n} Elm St`, city: 'Austin', state: 'TX', zip: '78701' },
      { now },
    );
    const job = await createJob(tx, ctx, { customerId: customer.id, propertyId: property.id }, { now });
    const { row } = await createAppointment(
      tx,
      ctx,
      {
        kind: 'inspection',
        customerId: customer.id,
        propertyId: property.id,
        jobId: job.id,
        assignedUserId: t.seed.a.owner.userId,
        startsAt: TUE_START,
        endsAt: TUE_END,
      },
      now,
    );
    return row.id;
  });
}

const noShowJobs = () => t.jobs.sent.filter((s) => s.name === 'scheduler-no-show');

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
  await inCompany(t, A(), (tx) => setPaused(tx, ctxA(), 'scheduler', false, t.clock.now()));
});

describe('no-show trigger', () => {
  test('marking no-show sends the job and makes one task with two times', async () => {
    const owner = await who.as('owner');
    const appointmentId = await seedVisit('Ann');

    const res = await owner.post(`/api/appointments/${appointmentId}/no-show`).send({});
    expect(res.status).toBe(200);
    expect(noShowJobs()).toEqual([
      { name: 'scheduler-no-show', data: { companyId: A(), appointmentId }, singletonKey: appointmentId },
    ]);

    await t.jobs.drain(t.deps);

    const rows = await inCompany(t, A(), (tx) => tx.select().from(agentTasks).where(eq(agentTasks.agent, 'scheduler')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('no_show');
    expect(rows[0]!.subjectId).toBe(appointmentId);
    const steps = await inCompany(t, A(), (tx) => tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.taskId, rows[0]!.id)));
    expect(steps).toHaveLength(1);
    expect(steps[0]!.type).toBe('send_personal_texts');
  });

  test('cancel and complete send nothing', async () => {
    const owner = await who.as('owner');
    const one = await seedVisit('Bo');
    const two = await seedVisit('Cy');

    expect((await owner.post(`/api/appointments/${one}/cancel`).send({})).status).toBe(200);
    expect((await owner.post(`/api/appointments/${two}/complete`).send({})).status).toBe(200);
    expect(noShowJobs()).toEqual([]);
  });
});
