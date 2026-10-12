import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  agentTasks,
  agentTaskSteps,
  appointments,
  companies,
  createAppointment,
  createCustomer,
  createJob,
  createProperty,
  setPaused,
  users,
  type ReminderCandidate,
  type TenantContext,
} from '@roofline/db';
import type { AppointmentKind } from '@roofline/shared';
import { reminderWindow, runReminders } from '../src/agents/scheduler/reminders.ts';
import type { JobMeta } from '../src/jobs/queue.ts';
import { LlmUnavailableError, type DraftTextsResult } from '../src/providers/llm.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const META: JobMeta = { attempt: 1, lastAttempt: false };
/** 3 PM on Monday 2026-10-12 in Chicago (CDT, UTC-5). */
const THREE_PM = new Date('2026-10-12T20:00:00.000Z');
/** 10:00-11:00 and 12:00-13:00 Chicago on Tuesday 2026-10-13. */
const TUE_10 = new Date('2026-10-13T15:00:00.000Z');
const TUE_11 = new Date('2026-10-13T16:00:00.000Z');
const TUE_12 = new Date('2026-10-13T17:00:00.000Z');
const TUE_13 = new Date('2026-10-13T18:00:00.000Z');
/** 4 PM today, Chicago. */
const TODAY_4PM = new Date('2026-10-12T21:00:00.000Z');
const TODAY_5PM = new Date('2026-10-12T22:00:00.000Z');
const USAGE = { model: 'scripted', inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, totalMs: 2 };

/** Each customer needs its own number (phones are unique within a company). */
let phoneSeq = 0;
const nextPhone = (): string => `+1512555${String(1000 + phoneSeq++)}`;

let t: TestApp;
const A = () => t.seed.a.companyId;
const ctxA = (): TenantContext => ({ companyId: A(), userId: null, role: 'system', canApproveSpend: false });

type Visit = {
  first: string;
  kind?: AppointmentKind;
  startsAt?: Date;
  endsAt?: Date;
  phone?: boolean;
  canceled?: boolean;
  address?: string;
};

/** A customer with a house and a job, and an appointment for the seeded owner. Returns the ids. */
async function seedVisit(v: Visit): Promise<{ customerId: string; jobId: string; appointmentId: string }> {
  const ctx = ctxA();
  const now = t.clock.now();
  return inCompany(t, A(), async (tx) => {
    const customer = await createCustomer(
      tx,
      ctx,
      {
        displayName: `${v.first} Reminder`,
        firstName: v.first,
        phones: v.phone === false ? [] : [{ e164: nextPhone(), primary: true }],
      },
      { now },
    );
    const property = await createProperty(
      tx,
      ctx,
      { customerId: customer.id, addressLine: v.address ?? `${1000 + phoneSeq} Oak St`, city: 'Austin', state: 'TX', zip: '78701' },
      { now },
    );
    const job = await createJob(tx, ctx, { customerId: customer.id, propertyId: property.id }, { now });
    const { row } = await createAppointment(
      tx,
      ctx,
      {
        kind: v.kind ?? 'inspection',
        customerId: customer.id,
        propertyId: property.id,
        jobId: job.id,
        assignedUserId: t.seed.a.owner.userId,
        startsAt: v.startsAt ?? TUE_10,
        endsAt: v.endsAt ?? TUE_11,
      },
      now,
    );
    if (v.canceled) await tx.update(appointments).set({ status: 'canceled' }).where(eq(appointments.id, row.id));
    return { customerId: customer.id, jobId: job.id, appointmentId: row.id };
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

async function repFirstName(): Promise<string> {
  const [u] = await t.deps.pools.system.select({ name: users.name }).from(users).where(eq(users.id, t.seed.a.owner.userId));
  return u!.name.trim().split(/\s+/)[0]!;
}

describe('reminderWindow', () => {
  const base: ReminderCandidate = {
    appointmentId: 'a',
    jobId: null,
    customerId: 'c',
    kind: 'inspection',
    startsAt: TUE_10,
    endsAt: TUE_11,
    allDay: false,
    customerFirstName: 'Ann',
    repFirstName: null,
    addressLine: null,
  };
  const CHI = 'America/Chicago';

  test('a whole-hour visit reads as 10 to 11', () => {
    expect(reminderWindow(base, CHI)).toMatchObject({ start: '10', end: '11', allDay: false });
  });

  test('half hours keep their minutes', () => {
    const c = { ...base, startsAt: new Date('2026-10-13T14:30:00.000Z'), endsAt: new Date('2026-10-13T15:30:00.000Z') };
    expect(reminderWindow(c, CHI)).toMatchObject({ start: '9:30', end: '10:30', allDay: false });
  });

  test('an install is all day', () => {
    expect(reminderWindow({ ...base, kind: 'install' }, CHI).allDay).toBe(true);
  });
});

describe('runReminders', () => {
  beforeEach(async () => {
    t = await makeTestApp();
    t.clock.set(THREE_PM);
    await agentOn(false);
  });

  test("texts tomorrow's inspection, install and adjuster visits only", async () => {
    const insp = await seedVisit({ first: 'Ann', kind: 'inspection' });
    const inst = await seedVisit({ first: 'Bo', kind: 'install', startsAt: TUE_10, endsAt: TUE_13 });
    const adj = await seedVisit({ first: 'Cy', kind: 'adjuster', startsAt: TUE_12, endsAt: TUE_13 });
    await seedVisit({ first: 'Dee', startsAt: TODAY_4PM, endsAt: TODAY_5PM });
    await seedVisit({ first: 'Eve', canceled: true });
    await seedVisit({ first: 'Fay', kind: 'other' });
    await seedVisit({ first: 'Gus', phone: false });

    await runReminders(t.deps, A(), META);

    const { task, payload } = await onlyTask();
    expect(task.agent).toBe('scheduler');
    expect(task.kind).toBe('reminders');
    expect(task.title).toBe('Reminders for tomorrow (3 texts)');
    expect(payload.purpose).toBe('informational');
    expect(payload.kind).toBe('reminder');
    expect(payload.messages).toHaveLength(3);
    expect(payload.messages.map((m) => m.customerId).sort()).toEqual([insp.customerId, inst.customerId, adj.customerId].sort());
  });

  test('more than 25 customers: every one is texted, none dropped', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 26; i++) {
      const v = await seedVisit({ first: `Cust${i}`, startsAt: TUE_10, endsAt: TUE_11 });
      ids.push(v.customerId);
    }
    t.llm.scriptDraft(new LlmUnavailableError('down'));

    await runReminders(t.deps, A(), META);

    const rows = await tasks();
    expect(rows).toHaveLength(1);
    const task = rows[0]!;
    expect(task.title).toBe('Reminders for tomorrow (26 texts)');
    const steps = (await stepsOf(task.id)).filter((s) => s.type === 'send_personal_texts');
    const messages = steps.flatMap((s) => (s.payload as unknown as Payload).messages);
    expect(messages).toHaveLength(26);
    expect(messages.map((m) => m.customerId).sort()).toEqual([...ids].sort());
  });

  test('paused: no agent_settings row makes nothing', async () => {
    // A fresh app has no row; the beforeEach turned the agent on, so pause it again.
    await agentOn(true);
    await seedVisit({ first: 'Ann' });
    await runReminders(t.deps, A(), META);
    expect(await tasks()).toHaveLength(0);
  });

  test('paused row (setPaused true) makes nothing', async () => {
    await agentOn(true);
    await seedVisit({ first: 'Ann' });
    await runReminders(t.deps, A(), META);
    expect(await tasks()).toHaveLength(0);
  });

  test('inactive company (status trial_ended) makes nothing', async () => {
    await seedVisit({ first: 'Ann' });
    await t.deps.pools.system.update(companies).set({ status: 'trial_ended' }).where(eq(companies.id, A()));
    await runReminders(t.deps, A(), META);
    expect(await tasks()).toHaveLength(0);
  });

  test('runs once per local day', async () => {
    await seedVisit({ first: 'Ann' });
    await runReminders(t.deps, A(), META);
    await runReminders(t.deps, A(), META);
    expect(await tasks()).toHaveLength(1);
  });

  test('the step carries the dedupe prefix for tomorrow', async () => {
    await seedVisit({ first: 'Ann' });
    await runReminders(t.deps, A(), META);
    const { payload } = await onlyTask();
    expect(payload.dedupePrefix).toBe('reminder:2026-10-13');
  });

  test('the plan expires at 9 PM local today', async () => {
    await seedVisit({ first: 'Ann' });
    await runReminders(t.deps, A(), META);
    const { task } = await onlyTask();
    expect(task.expiresAt?.toISOString()).toBe('2026-10-13T02:00:00.000Z');
  });

  test('template fallback when the model is unavailable', async () => {
    await seedVisit({ first: 'Ann', address: '12 Oak St' });
    await seedVisit({ first: 'Bo', kind: 'install', startsAt: TUE_10, endsAt: TUE_13, address: '40 Elm Ave' });
    t.llm.scriptDraft(new LlmUnavailableError('down'));

    await runReminders(t.deps, A(), META);

    const { task, payload } = await onlyTask();
    const rep = await repFirstName();
    const company = t.seed.a.name;
    const bodies = payload.messages.map((m) => m.body);
    expect(bodies).toContain(
      `Hi Ann, reminder: ${rep} from ${company} will be at 12 Oak St tomorrow between 10 and 11. Reply C to confirm or call us to change.`,
    );
    const install = bodies.find((b) => b.startsWith('Hi Bo,'));
    expect(install).toBe(
      `Hi Bo, reminder: ${rep} from ${company} will be at 40 Elm Ave tomorrow for your roof install. Reply C to confirm or call us to change.`,
    );
    expect(task.summary).toBe('Written from a template');
  });

  test('a drafted text is used when it passes the guards', async () => {
    const v = await seedVisit({ first: 'Ann' });
    const body = 'Hi Ann, Sam is stopping by tomorrow between 10 and 11. Reply C to confirm.';
    const res: DraftTextsResult = { texts: [{ jobId: v.jobId, body }], refused: false, usage: USAGE };
    t.llm.scriptDraft(res);

    await runReminders(t.deps, A(), META);

    const { task, payload } = await onlyTask();
    expect(payload.messages.map((m) => m.body)).toEqual([body]);
    expect(task.summary).not.toBe('Written from a template');
    expect(t.llm.draftCalls).toHaveLength(1);
    expect(t.llm.draftCalls[0]!.instruction).toBe('reminder');
  });

  test('a draft that mentions a price falls back to the template', async () => {
    const v = await seedVisit({ first: 'Ann', address: '12 Oak St' });
    const body = 'Hi Ann, see you tomorrow between 10 and 11. Your total is $5,000. Reply C to confirm.';
    t.llm.scriptDraft({ texts: [{ jobId: v.jobId, body }], refused: false, usage: USAGE });

    await runReminders(t.deps, A(), META);

    const { payload } = await onlyTask();
    const rep = await repFirstName();
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]!.body).not.toContain('$');
    expect(payload.messages[0]!.body).toBe(
      `Hi Ann, reminder: ${rep} from ${t.seed.a.name} will be at 12 Oak St tomorrow between 10 and 11. Reply C to confirm or call us to change.`,
    );
  });
});
