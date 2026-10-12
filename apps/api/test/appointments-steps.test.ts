import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  appointments,
  calendarBusyBlocks,
  calendarConnections,
  claimEvents,
  claims,
  customers,
  jobs,
  properties,
  type StepRow,
  withTenant,
} from '@roofline/db';
import type { ClaimStatus, StepType } from '@roofline/shared';
import { createAppointmentStep } from '../src/agents/appointments-steps.ts';
import { createTask } from '../src/tasks/service.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { DAY, DAYTIME } from './sms-helpers.ts';
import { agentCtx, dbSteps } from './task-helpers.ts';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
});

const idOf = () => t.seed.a.companyId;
const repId = () => t.seed.a.rep.userId;
/** Thursday 15 October 2026, 10:00 to 11:00 in Chicago. */
const START = new Date(DAYTIME.getTime() + 2 * DAY);
const END = new Date(START.getTime() + 60 * 60 * 1000);
const NOT_FREE = "That time isn't free any more.";

/** A customer, a home and a job, with a claim in the given status when one is asked for. */
let jobSeq = 0;
async function aJob(claimStatus?: ClaimStatus): Promise<{ jobId: string; customerId: string; claimId: string | null }> {
  const companyId = idOf();
  const now = t.clock.now();
  const house = 301 + jobSeq++;
  return inCompany(t, companyId, async (tx) => {
    const [customer] = await tx
      .insert(customers)
      .values({ companyId, displayName: 'Ann Customer', firstName: 'Ann', createdAt: now, updatedAt: now })
      .returning({ id: customers.id });
    const customerId = customer!.id;
    const [property] = await tx
      .insert(properties)
      .values({
        companyId,
        customerId,
        addressLine: `${house} Oak St`,
        city: 'Omaha',
        state: 'NE',
        zip: '68102',
        addressKey: `${house} oak st|68102`,
        timezone: 'America/Chicago',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: properties.id });
    const [job] = await tx
      .insert(jobs)
      .values({ companyId, customerId, propertyId: property!.id, createdAt: now, updatedAt: now })
      .returning({ id: jobs.id });
    let claimId: string | null = null;
    if (claimStatus !== undefined) {
      const [claim] = await tx
        .insert(claims)
        .values({ companyId, jobId: job!.id, status: claimStatus, statusChangedAt: now, createdAt: now, updatedAt: now })
        .returning({ id: claims.id });
      claimId = claim!.id;
    }
    return { jobId: job!.id, customerId, claimId };
  });
}

/** A task with one `create_appointment` step, made the way the Claims agent makes it; returns the step as the runner would hand it over. */
async function bookingStep(jobId: string, over: Record<string, unknown> = {}): Promise<{ taskId: string; step: () => Promise<StepRow> }> {
  const ctx = agentCtx(idOf());
  const payload = {
    jobId,
    kind: 'adjuster',
    start: START.toISOString(),
    end: END.toISOString(),
    userId: repId(),
    note: "From the homeowner's text",
    ...over,
  };
  const { taskId } = await withTenant(t.deps.pools, ctx, (tx) =>
    createTask(
      tx,
      ctx,
      {
        agent: 'claims',
        kind: 'claims_adjuster_visit',
        title: 'Book the adjuster visit',
        steps: [{ type: 'create_appointment' as StepType, payload }],
      },
      { now: t.clock.now(), allowInternalStepTypes: true },
    ),
  );
  return { taskId, step: async () => (await dbSteps(t, 'a', taskId))[0]! };
}

const run = async (b: { step: () => Promise<StepRow> }) => createAppointmentStep(t.deps, agentCtx(idOf()), await b.step());
const allAppointments = () => inCompany(t, idOf(), (tx) => tx.select().from(appointments).orderBy(appointments.createdAt, appointments.id));
const claimRow = (id: string) => inCompany(t, idOf(), async (tx) => (await tx.select().from(claims).where(eq(claims.id, id)))[0]!);

describe('the create_appointment step', () => {
  test('creates the appointment, assigned to the user, source scheduler, result created 1', async () => {
    const { jobId, customerId } = await aJob('filed');
    const out = await run(await bookingStep(jobId));

    expect(out).toEqual({ status: 'done', result: { created: 1 } });
    const rows = await allAppointments();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      jobId,
      customerId,
      kind: 'adjuster',
      assignedUserId: repId(),
      source: 'scheduler',
      status: 'scheduled',
      notes: "From the homeowner's text",
    });
    expect(rows[0]!.startsAt).toEqual(START);
    expect(rows[0]!.endsAt).toEqual(END);
  });

  test('pushes calendar-push with singletonKey = appointment id', async () => {
    const { jobId } = await aJob('filed');
    await run(await bookingStep(jobId));

    const [row] = await allAppointments();
    expect(t.jobs.sent).toEqual([
      { name: 'calendar-push', data: { companyId: idOf(), appointmentId: row!.id }, singletonKey: row!.id },
    ]);
  });

  test('sets claims.adjuster_appointment_id and moves not_filed/filed to adjuster_scheduled with an agent claim event', async () => {
    for (const from of ['not_filed', 'filed'] as const) {
      const { jobId, claimId } = await aJob(from);
      await run(await bookingStep(jobId, { start: new Date(START.getTime() + (from === 'filed' ? 3 * DAY : 0)).toISOString(), end: new Date(END.getTime() + (from === 'filed' ? 3 * DAY : 0)).toISOString() }));

      const claim = await claimRow(claimId!);
      expect(claim.status).toBe('adjuster_scheduled');
      const appt = (await allAppointments()).find((a) => a.jobId === jobId)!;
      expect(claim.adjusterAppointmentId).toBe(appt.id);
      const events = await inCompany(t, idOf(), (tx) => tx.select().from(claimEvents).where(eq(claimEvents.claimId, claimId!)));
      expect(events.find((e) => e.toStatus === 'adjuster_scheduled')).toMatchObject({ fromStatus: from, by: 'agent', byUserId: null });
    }
  });

  test('does not move a claim already approved', async () => {
    const { jobId, claimId } = await aJob('approved');
    const out = await run(await bookingStep(jobId));

    expect(out.status).toBe('done');
    const claim = await claimRow(claimId!);
    expect(claim.status).toBe('approved');
    // The visit is still linked to the claim.
    expect(claim.adjusterAppointmentId).toBe((await allAppointments())[0]!.id);
    const events = await inCompany(t, idOf(), (tx) => tx.select().from(claimEvents).where(eq(claimEvents.claimId, claimId!)));
    expect(events.filter((e) => e.by === 'agent')).toHaveLength(0);
  });

  test('a job with no claim gets the visit and no claim', async () => {
    const { jobId } = await aJob();
    const out = await run(await bookingStep(jobId));

    expect(out).toEqual({ status: 'done', result: { created: 1 } });
    expect(await inCompany(t, idOf(), (tx) => tx.select().from(claims))).toHaveLength(0);
  });

  test('refuses a busy slot: overlapping appointment for that user => failed with errorPlain "That time isn\'t free any more." and no appointment created', async () => {
    const first = await aJob('filed');
    await run(await bookingStep(first.jobId));
    const before = await allAppointments();
    expect(before).toHaveLength(1);

    // The same person, half an hour into the first visit.
    const second = await aJob('filed');
    const start = new Date(START.getTime() + 30 * 60 * 1000);
    const out = await run(await bookingStep(second.jobId, { start: start.toISOString(), end: new Date(start.getTime() + 60 * 60 * 1000).toISOString() }));

    expect(out).toEqual({ status: 'failed', result: {}, errorPlain: NOT_FREE });
    expect(await allAppointments()).toHaveLength(1);
    expect((await claimRow(second.claimId!)).status).toBe('filed');
  });

  test('refuses a slot covered by a calendar busy block', async () => {
    const { jobId } = await aJob('filed');
    await inCompany(t, idOf(), async (tx) => {
      const [connection] = await tx
        .insert(calendarConnections)
        .values({
          companyId: idOf(),
          userId: repId(),
          provider: 'google',
          accountEmail: 'rep@example.test',
          calendarId: 'primary',
          calendarName: 'Work',
          encryptedCredentials: Buffer.from('not-a-real-token'),
        })
        .returning({ id: calendarConnections.id });
      await tx.insert(calendarBusyBlocks).values({
        companyId: idOf(),
        connectionId: connection!.id,
        userId: repId(),
        providerEventId: 'event-1',
        startsAt: new Date(START.getTime() - 30 * 60 * 1000),
        endsAt: new Date(START.getTime() + 15 * 60 * 1000),
      });
    });

    const out = await run(await bookingStep(jobId));

    expect(out).toEqual({ status: 'failed', result: {}, errorPlain: NOT_FREE });
    expect(await allAppointments()).toHaveLength(0);
    expect(t.jobs.sent).toHaveLength(0);
  });

  test('rerun creates nothing new (same appointment id, one row)', async () => {
    const { jobId, claimId } = await aJob('filed');
    const booking = await bookingStep(jobId);

    expect(await run(booking)).toEqual({ status: 'done', result: { created: 1 } });
    const [first] = await allAppointments();
    const again = await run(booking);

    expect(again).toEqual({ status: 'done', result: { created: 0 } });
    const rows = await allAppointments();
    expect(rows.map((r) => r.id)).toEqual([first!.id]);
    expect((await claimRow(claimId!)).adjusterAppointmentId).toBe(first!.id);
    // Both runs asked for the same push, so the queue holds it once.
    expect(t.jobs.sent.every((s) => s.name === 'calendar-push' && s.singletonKey === first!.id)).toBe(true);
  });

  test('bad payload => needs_attention', async () => {
    const { jobId } = await aJob('filed');
    const booking = await bookingStep(jobId);
    const step = await booking.step();

    const out = await createAppointmentStep(t.deps, agentCtx(idOf()), { ...step, payload: { jobId, kind: 'install' } });

    expect(out).toEqual({ status: 'needs_attention', result: {}, errorPlain: "We couldn't read this booking. Please make this plan again." });
    expect(await allAppointments()).toHaveLength(0);
  });
});
