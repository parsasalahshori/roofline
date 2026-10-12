import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  agentTasks,
  agentTaskSteps,
  appointments,
  createAppointment,
  createCustomer,
  createJob,
  createProperty,
  customers,
  setPaused,
  type TenantContext,
} from '@roofline/db';
import { runNoShow } from '../src/agents/scheduler/no-show.ts';
import { LlmUnavailableError, type DraftTextsResult } from '../src/providers/llm.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/** 3 PM on Monday 2026-10-12 in Chicago (CDT, UTC-5). */
const THREE_PM = new Date('2026-10-12T20:00:00.000Z');
/** 10:00-11:00 Chicago the same morning (already past). */
const MORNING_START = new Date('2026-10-12T15:00:00.000Z');
const MORNING_END = new Date('2026-10-12T16:00:00.000Z');
const USAGE = { model: 'scripted', inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, totalMs: 2 };

let phoneSeq = 0;
let addrSeq = 0;
const nextPhone = (): string => `+1512555${String(1000 + phoneSeq++)}`;

let t: TestApp;
const A = () => t.seed.a.companyId;
const ctxA = (): TenantContext => ({ companyId: A(), userId: null, role: 'system', canApproveSpend: false });

async function seedMissed(o: { first?: string; phone?: boolean; status?: 'no_show' | 'scheduled' } = {}) {
  const ctx = ctxA();
  const now = t.clock.now();
  const first = o.first ?? 'Ann';
  return inCompany(t, A(), async (tx) => {
    const customer = await createCustomer(
      tx,
      ctx,
      { displayName: `${first} Missed`, firstName: first, phones: o.phone === false ? [] : [{ e164: nextPhone(), primary: true }] },
      { now },
    );
    const property = await createProperty(
      tx,
      ctx,
      { customerId: customer.id, addressLine: `${2000 + addrSeq++} Pine St`, city: 'Austin', state: 'TX', zip: '78701' },
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
        startsAt: MORNING_START,
        endsAt: MORNING_END,
      },
      now,
    );
    await tx
      .update(appointments)
      .set({ status: o.status ?? 'no_show' })
      .where(eq(appointments.id, row.id));
    return { customerId: customer.id, jobId: job.id, appointmentId: row.id, first };
  });
}

const agentOn = (paused: boolean) => inCompany(t, A(), (tx) => setPaused(tx, ctxA(), 'scheduler', paused, t.clock.now()));
const tasks = () => inCompany(t, A(), (tx) => tx.select().from(agentTasks).where(eq(agentTasks.agent, 'scheduler')));
const stepsOf = (taskId: string) => inCompany(t, A(), (tx) => tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.taskId, taskId)));

type Payload = {
  purpose: string;
  kind: string;
  dedupePrefix: string;
  messages: { customerId: string; jobId: string | null; body: string }[];
};

async function onlyTask() {
  const rows = await tasks();
  expect(rows).toHaveLength(1);
  const task = rows[0]!;
  const steps = await stepsOf(task.id);
  expect(steps).toHaveLength(1);
  expect(steps[0]!.type).toBe('send_personal_texts');
  return { task, payload: steps[0]!.payload as unknown as Payload };
}

describe('runNoShow', () => {
  beforeEach(async () => {
    t = await makeTestApp();
    t.clock.set(THREE_PM);
    await agentOn(false);
  });

  test('makes one needs-approval task with two times', async () => {
    const v = await seedMissed();
    await runNoShow(t.deps, A(), v.appointmentId);

    const { task, payload } = await onlyTask();
    expect(task.kind).toBe('no_show');
    expect(task.subjectType).toBe('appointment');
    expect(task.subjectId).toBe(v.appointmentId);
    expect(task.status).toBe('draft');
    expect(task.title).toBe("Reschedule Ann's inspection (missed)");
    expect(task.expiresAt?.toISOString()).toBe(new Date(THREE_PM.getTime() + 2 * 86_400_000).toISOString());
    expect(payload.purpose).toBe('informational');
    expect(payload.kind).toBe('no_show');
    expect(payload.dedupePrefix).toBe(`no_show:${v.appointmentId}`);
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]!.customerId).toBe(v.customerId);
    expect(payload.messages[0]!.body).toContain(' or ');
    expect(t.llm.draftCalls[0]!.instruction).toBe('no_show');
  });

  test('a second run for the same appointment makes nothing', async () => {
    const v = await seedMissed();
    await runNoShow(t.deps, A(), v.appointmentId);
    await runNoShow(t.deps, A(), v.appointmentId);
    expect(await tasks()).toHaveLength(1);
  });

  test('a drafted text is used when it passes the guards', async () => {
    const v = await seedMissed();
    const body = 'Hi Ann, sorry we missed you. Could we come by Tuesday 10 AM or Wednesday 2 PM?';
    const res: DraftTextsResult = { texts: [{ jobId: v.appointmentId, body }], refused: false, usage: USAGE };
    t.llm.scriptDraft(res);
    await runNoShow(t.deps, A(), v.appointmentId);
    const { task, payload } = await onlyTask();
    expect(payload.messages[0]!.body).toBe(body);
    expect(task.summary).toBe('Drafted for the missed visit.');
  });

  test('paused makes nothing', async () => {
    const v = await seedMissed();
    await agentOn(true);
    await runNoShow(t.deps, A(), v.appointmentId);
    expect(await tasks()).toHaveLength(0);
  });

  test('no phone makes nothing', async () => {
    const v = await seedMissed({ phone: false });
    await runNoShow(t.deps, A(), v.appointmentId);
    expect(await tasks()).toHaveLength(0);
  });

  test('do-not-contact makes nothing', async () => {
    const v = await seedMissed();
    await inCompany(t, A(), (tx) => tx.update(customers).set({ doNotContact: true }).where(eq(customers.id, v.customerId)));
    await runNoShow(t.deps, A(), v.appointmentId);
    expect(await tasks()).toHaveLength(0);
  });

  test('uses the template when the model is unavailable', async () => {
    const v = await seedMissed();
    t.llm.scriptDraft(new LlmUnavailableError('down'));
    await runNoShow(t.deps, A(), v.appointmentId);
    const { task, payload } = await onlyTask();
    const body = payload.messages[0]!.body;
    expect(body.startsWith("Hi Ann, it's ")).toBe(true);
    expect(body).toContain(`at ${t.seed.a.name}. Sorry we missed you today.`);
    expect(body).toContain(' or ');
    expect(body.endsWith('Reply with the one that works.')).toBe(true);
    expect(task.summary).toBe('Written from a template');
  });

  test('does nothing when the status changed back before the job ran', async () => {
    const v = await seedMissed({ status: 'scheduled' });
    await runNoShow(t.deps, A(), v.appointmentId);
    expect(await tasks()).toHaveLength(0);
  });
});
