import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { agentSettings, agentTasks, appointments, customers, followUpLog, jobs, messages, properties } from '@roofline/db';
import { DEFAULT_DURATION_MINUTES, DEFAULT_WORK_HOURS, findSlots } from '@roofline/shared';
import { pickTwoSlots } from '../src/agents/followup/draft.ts';
import { runFollowUps } from '../src/agents/followup/daily.ts';
import { LlmUnavailableError } from '../src/providers/llm.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { dbSteps } from './task-helpers.ts';

let t: TestApp;

const DAY = 86_400_000;
/** Tuesday 13 October 2026, 9:00 AM in Chicago (CDT). */
const NINE_AM = new Date('2026-10-13T14:00:00.000Z');
const META = { attempt: 1, lastAttempt: false };
const USAGE = { model: 'scripted', inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, totalMs: 1 };

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NINE_AM);
  await setAgent({ paused: false });
});

const companyId = () => t.seed.a.companyId;
const run = () => runFollowUps(t.deps, companyId(), META);

/** The follow_up agent row: paused or unpaused (app_tenant has no DELETE; Ruling GX-E: a missing row means off). */
async function setAgent(o: { paused: boolean }) {
  await inCompany(t, companyId(), async (tx) => {
    const pausedAt = o.paused ? NINE_AM : null;
    await tx
      .insert(agentSettings)
      .values({ companyId: companyId(), agent: 'follow_up', pausedAt })
      .onConflictDoUpdate({ target: [agentSettings.companyId, agentSettings.agent], set: { pausedAt } });
  });
}

let addrN = 0;

type JobSeed = {
  stage?: 'lead' | 'proposal' | 'lost';
  createdDaysAgo?: number;
  stageDaysAgo?: number;
  assigned?: boolean;
  nextStep?: string;
  lostReason?: string;
};

async function seedJob(o: JobSeed = {}) {
  const now = t.clock.now();
  return inCompany(t, companyId(), async (tx) => {
    const [cust] = await tx
      .insert(customers)
      .values({
        companyId: companyId(),
        displayName: 'Pat Customer',
        firstName: 'Pat',
        phones: [{ e164: '+14025550101', label: 'mobile', primary: true }],
        smsConsentStatus: 'express',
      })
      .returning({ id: customers.id });
    const [prop] = await tx
      .insert(properties)
      .values({ companyId: companyId(), customerId: cust!.id, addressLine: `${++addrN} Elm St`, city: 'Omaha', state: 'NE', zip: '68102', addressKey: `fu${addrN}` })
      .returning({ id: properties.id });
    const [job] = await tx
      .insert(jobs)
      .values({
        companyId: companyId(),
        customerId: cust!.id,
        propertyId: prop!.id,
        stage: o.stage ?? 'lead',
        ...(o.lostReason !== undefined && { lostReason: o.lostReason }),
        createdAt: new Date(now.getTime() - (o.createdDaysAgo ?? 2) * DAY),
        stageChangedAt: new Date(now.getTime() - (o.stageDaysAgo ?? o.createdDaysAgo ?? 2) * DAY),
        assignedUserId: o.assigned === true ? t.seed.a.owner.userId : null,
        nextStep: o.nextStep ?? null,
      })
      .returning({ id: jobs.id });
    return { customerId: cust!.id, jobId: job!.id, propertyId: prop!.id };
  });
}

const tasksOf = (kind: string) =>
  inCompany(t, companyId(), (tx) => tx.select().from(agentTasks).where(and(eq(agentTasks.agent, 'follow_up'), eq(agentTasks.kind, kind))));

const slotsNow = () => pickTwoSlots({ workHours: DEFAULT_WORK_HOURS, busy: [], propertyId: null, timeZone: 'America/Chicago', now: t.clock.now() })!;

/** Scripts the Llm to write a good text for these jobs, using the two times it is shown. */
function scriptGood(jobIds: string[]) {
  const [a, b] = slotsNow();
  t.llm.scriptDraft({
    texts: jobIds.map((jobId) => ({ jobId, body: `Hi Pat, we can look at your roof ${a} or ${b}. Which works?` })),
    refused: false,
    usage: USAGE,
  });
  return [a, b] as const;
}

const stepPayload = async (taskId: string) => (await dbSteps(t, 'a', taskId))[0]!.payload as { kind: string; purpose: string; dedupePrefix: string; messages: { customerId: string; jobId: string; body: string }[] };

describe('lead follow-ups', () => {
  test('a lead 2 days old with no appointment gets one plan with two inspection times', async () => {
    const lead = await seedJob({ createdDaysAgo: 2 });
    const [a, b] = scriptGood([lead.jobId]);
    await run();

    const tasks = await tasksOf('follow_ups');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'Follow-ups for today (1)', mode: 'needs_approval', summary: null });
    const payload = await stepPayload(tasks[0]!.id);
    expect(payload).toMatchObject({ kind: 'lead', purpose: 'informational', dedupePrefix: 'followup:2026-10-13' });
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]).toMatchObject({ customerId: lead.customerId, jobId: lead.jobId });
    expect(payload.messages[0]!.body).toContain(a);
    expect(payload.messages[0]!.body).toContain(b);
    expect(t.llm.draftCalls[0]?.instruction).toBe('lead_follow_up');
    // Expires at 6 PM Chicago the same day (23:00Z).
    expect(tasks[0]!.expiresAt?.toISOString()).toBe('2026-10-13T23:00:00.000Z');
  });

  test('a Run now after 6 PM local makes a plan that is still open (it expires at the end of the local day)', async () => {
    t.clock.set(new Date('2026-10-13T23:30:00.000Z')); // 6:30 PM Chicago
    const lead = await seedJob({ createdDaysAgo: 2 });
    scriptGood([lead.jobId]);
    await run();

    const tasks = await tasksOf('follow_ups');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.expiresAt?.toISOString()).toBe('2026-10-14T05:00:00.000Z');
    expect(tasks[0]!.expiresAt!.getTime()).toBeGreaterThan(t.clock.now().getTime());
  });

  test('a lead with an assigned rep is offered times when the rep is free', async () => {
    const lead = await seedJob({ createdDaysAgo: 2, assigned: true });
    const repId = t.seed.a.owner.userId;
    const now = t.clock.now();
    const query = {
      workHours: DEFAULT_WORK_HOURS,
      propertyId: null,
      durationMinutes: DEFAULT_DURATION_MINUTES.inspection,
      bufferMinutes: 0,
      minNoticeMinutes: 240,
      from: now,
      to: new Date(now.getTime() + 5 * DAY),
      timeZone: 'America/Chicago',
      now,
    };
    const [defaultFirst] = slotsNow();
    const firstStart = findSlots({ ...query, busy: [] })[0]!.start;
    const other = await seedJob({ createdDaysAgo: 3 });
    const startsAt = new Date(firstStart.getTime() - 30 * 60_000);
    const endsAt = new Date(firstStart.getTime() + 90 * 60_000);
    await inCompany(t, companyId(), (tx) =>
      tx.insert(appointments).values({
        companyId: companyId(),
        kind: 'inspection',
        jobId: other.jobId,
        customerId: other.customerId,
        propertyId: other.propertyId,
        assignedUserId: repId,
        startsAt,
        endsAt,
        status: 'scheduled',
        source: 'manual',
      }),
    );
    const [a, b] = pickTwoSlots({
      workHours: DEFAULT_WORK_HOURS,
      busy: [{ start: startsAt, end: endsAt, propertyId: other.propertyId }],
      propertyId: lead.propertyId,
      timeZone: 'America/Chicago',
      now,
    })!;
    expect(a).not.toBe(defaultFirst);
    t.llm.scriptDraft({
      texts: [{ jobId: lead.jobId, body: `Hi Pat, we can look at your roof ${a} or ${b}. Which works?` }],
      refused: false,
      usage: USAGE,
    });
    await run();
    const tasks = await tasksOf('follow_ups');
    expect(tasks).toHaveLength(1);
    const payload = await stepPayload(tasks[0]!.id);
    const body = payload.messages.find((m) => m.jobId === lead.jobId)!.body;
    expect(body).toContain(a);
    expect(body).not.toContain(defaultFirst);
  });

  test('a lead who texted yesterday, a lead with an appointment and a lost job make no plan', async () => {
    const replied = await seedJob({ createdDaysAgo: 5 });
    await inCompany(t, companyId(), (tx) =>
      tx.insert(messages).values({
        companyId: companyId(),
        customerId: replied.customerId,
        channel: 'sms',
        direction: 'in',
        body: 'Hello',
        status: 'received',
        createdAt: new Date(NINE_AM.getTime() - DAY),
        updatedAt: new Date(NINE_AM.getTime() - DAY),
      }),
    );
    const booked = await seedJob({ createdDaysAgo: 5 });
    await inCompany(t, companyId(), (tx) =>
      tx.insert(appointments).values({
        companyId: companyId(),
        kind: 'inspection',
        jobId: booked.jobId,
        customerId: booked.customerId,
        propertyId: booked.propertyId,
        startsAt: new Date(NINE_AM.getTime() + DAY),
        endsAt: new Date(NINE_AM.getTime() + DAY + 3_600_000),
      }),
    );
    await seedJob({ stage: 'lost', lostReason: 'Went elsewhere', createdDaysAgo: 5 });
    scriptGood([]);
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);
  });

  test('a claims text 2 days ago blocks the lead (spacing across agents)', async () => {
    const lead = await seedJob({ createdDaysAgo: 4 });
    await inCompany(t, companyId(), (tx) =>
      tx.insert(followUpLog).values({ companyId: companyId(), customerId: lead.customerId, jobId: null, kind: 'claims', n: 1, messageId: null, at: new Date(NINE_AM.getTime() - 2 * DAY) }),
    );
    scriptGood([lead.jobId]);
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);
  });

  test('paused makes nothing; unpaused makes the plan', async () => {
    const lead = await seedJob({ createdDaysAgo: 3 });
    scriptGood([lead.jobId]);
    await setAgent({ paused: true });
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);
    await setAgent({ paused: false });
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(1);
  });

  test('running twice on the same day makes one plan', async () => {
    const lead = await seedJob({ createdDaysAgo: 3 });
    scriptGood([lead.jobId]);
    scriptGood([lead.jobId]);
    await run();
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(1);
  });

  test('an unavailable Llm gives the template and says so', async () => {
    const lead = await seedJob({ createdDaysAgo: 3 });
    t.llm.scriptDraft(new LlmUnavailableError('down'));
    await run();
    const tasks = await tasksOf('follow_ups');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.summary).toBe('Written from a template');
    const [a, b] = slotsNow();
    const body = (await stepPayload(tasks[0]!.id)).messages[0]!.body;
    expect(body).toMatch(new RegExp(`^Hi Pat, it's .+ at .+\\. We can come look at your roof ${a} or ${b}\\. Reply with the one that works\\.$`));
    expect(lead.jobId).toBeDefined();
  });
});

describe('stuck jobs', () => {
  const jobRow = (id: string) => inCompany(t, companyId(), async (tx) => (await tx.select().from(jobs).where(eq(jobs.id, id)))[0]!);

  test('a stuck job gets a next step and one live task; the next day changes nothing', async () => {
    const job = await seedJob({ stage: 'proposal', createdDaysAgo: 30, stageDaysAgo: 20, assigned: true });
    await run();

    const row = await jobRow(job.jobId);
    expect(row.nextStep).toBe('No activity on the Pat Customer job for 20 days.');
    expect(row.nextStepOn).toBe('2026-10-13');
    const tasks = await tasksOf('stuck_nudges');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'Nudged reps about 1 quiet jobs', mode: 'live', status: 'done' });

    t.clock.set(new Date(NINE_AM.getTime() + DAY));
    await run();
    const again = await jobRow(job.jobId);
    expect(again.nextStep).toBe(row.nextStep);
    expect(again.nextStepOn).toBe('2026-10-13');
    expect(await tasksOf('stuck_nudges')).toHaveLength(1);
  });

  test('a stuck job with its own next step is left alone', async () => {
    const job = await seedJob({ stage: 'proposal', createdDaysAgo: 30, stageDaysAgo: 20, assigned: true, nextStep: 'Call about the quote' });
    await run();
    expect((await jobRow(job.jobId)).nextStep).toBe('Call about the quote');
    expect(await tasksOf('stuck_nudges')).toHaveLength(0);
  });
});
