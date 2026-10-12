import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import type { Agent, TaskStatus } from '@roofline/shared';
import { createPools } from '../src/pools.ts';
import {
  agentCounts,
  agentSettingsInfo,
  breakdownByBaseline,
  dailyFinished,
  minutesByAgent,
  type MetricsWindow,
  recentTasks,
} from '../src/repos/agent-metrics.ts';
import { agentSettings, agentTaskSteps, agentTasks, customers, jobs, properties } from '../src/schema/index.ts';
import { type TenantContext, type Tx, withTenant } from '../src/tenant.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';

const urls = inject('dbUrls');
const pools = createPools({ tenant: urls.tenant, system: urls.system });

let seed: { a: SeededCompany; b: SeededCompany };

afterAll(async () => {
  await pools.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

function ctxFor(c: SeededCompany): TenantContext {
  return { companyId: c.companyId, userId: c.owner.userId, role: 'owner', canApproveSpend: true };
}

function repCtx(c: SeededCompany): TenantContext {
  return { companyId: c.companyId, userId: c.rep.userId, role: 'rep', canApproveSpend: false };
}

/** The window of Tuesday 12 October 2026 in Chicago (CDT, UTC-5), with the 30-day and month bounds. */
const w: MetricsWindow = {
  now: new Date('2026-10-12T17:00:00Z'),
  timeZone: 'America/Chicago',
  todayStart: new Date('2026-10-12T05:00:00Z'),
  tomorrowStart: new Date('2026-10-13T05:00:00Z'),
  since30: new Date('2026-09-12T12:00:00Z'),
  monthStart: new Date('2026-10-01T05:00:00Z'),
  chartStart: new Date('2026-09-29T05:00:00Z'),
};

const today = new Date('2026-10-12T15:00:00Z');
const monthRange = { from: w.monthStart, to: w.tomorrowStart };

type TaskSeed = {
  agent?: Agent;
  status: TaskStatus;
  updatedAt: Date;
  createdAt?: Date;
  expiresAt?: Date | null;
  mode?: 'needs_approval' | 'live';
  subjectType?: string | null;
  subjectId?: string | null;
  minutesSaved?: number | null;
};

/** Inserts one task as the owner of `c` (seeding ignores the rep scope). */
function seedTask(c: SeededCompany, t: TaskSeed): Promise<string> {
  return withTenant(pools, ctxFor(c), async (tx) => {
    const [row] = await tx
      .insert(agentTasks)
      .values({
        companyId: c.companyId,
        agent: t.agent ?? 'storm_scout',
        kind: 'test',
        title: 'Test task',
        subjectType: t.subjectType ?? null,
        subjectId: t.subjectId ?? null,
        mode: t.mode ?? 'needs_approval',
        status: t.status,
        minutesSaved: t.minutesSaved ?? null,
        expiresAt: t.expiresAt ?? null,
        createdAt: t.createdAt ?? t.updatedAt,
        updatedAt: t.updatedAt,
      })
      .returning({ id: agentTasks.id });
    return row!.id;
  });
}

type StepSeed = {
  position?: number;
  status: 'pending' | 'done' | 'failed';
  updatedAt: Date;
  baselineKey?: string | null;
  units?: number | null;
  minutesPerUnit?: number | null;
  minutesSaved?: number | null;
};

/** Inserts one step of a task with its snapshot columns set as given. */
function seedStep(c: SeededCompany, taskId: string, s: StepSeed): Promise<void> {
  return withTenant(pools, ctxFor(c), async (tx: Tx) => {
    await tx.insert(agentTaskSteps).values({
      companyId: c.companyId,
      taskId,
      position: s.position ?? 0,
      type: 'send_sms_batch',
      approvalClass: 'internal',
      enabled: true,
      version: 1,
      payload: {},
      preview: {},
      status: s.status,
      idempotencyKey: randomUUID(),
      attempts: 0,
      baselineKey: s.baselineKey ?? null,
      units: s.units ?? null,
      minutesPerUnit: s.minutesPerUnit ?? null,
      minutesSaved: s.minutesSaved ?? null,
      createdAt: s.updatedAt,
      updatedAt: s.updatedAt,
    });
  });
}

/** Counts, minutes and recent tasks for `ctx`, in one place so each test reads the same way. */
function readAll(c: SeededCompany, ctx: TenantContext = ctxFor(c)) {
  return withTenant(pools, ctx, async (tx) => ({
    counts: await agentCounts(tx, ctx, w),
    minutes: await minutesByAgent(tx, ctx, monthRange),
  }));
}

describe('agent metrics', () => {
  test('agentCounts counts finished today, 30-day inputs and waiting per agent', async () => {
    const c = seed.a;
    await seedTask(c, { status: 'done', updatedAt: new Date('2026-10-12T15:00:00Z') });
    await seedTask(c, { status: 'done', updatedAt: new Date('2026-10-12T16:00:00Z') });
    await seedTask(c, { status: 'partly_done', updatedAt: new Date('2026-10-12T17:00:00Z') });
    await seedTask(c, { status: 'done', updatedAt: new Date('2026-10-07T15:00:00Z') });
    await seedTask(c, { status: 'needs_attention', updatedAt: new Date('2026-10-10T12:00:00Z') });
    await seedTask(c, { status: 'draft', updatedAt: new Date('2026-10-12T09:00:00Z') });
    await seedTask(c, { status: 'awaiting_owner', updatedAt: new Date('2026-10-12T09:30:00Z') });
    await seedTask(c, { status: 'declined', updatedAt: new Date('2026-10-11T12:00:00Z') });
    await seedTask(c, { status: 'expired', updatedAt: new Date('2026-10-09T12:00:00Z') });

    const { counts } = await readAll(c);
    expect(counts.storm_scout).toEqual({
      finishedToday: 3,
      done30d: 3,
      partlyDone30d: 1,
      ran30d: 5,
      notApproved30d: 2,
      waitingCount: 3,
    });
  });

  test('waitingCount leaves out drafts that expired before now, like the waiting list', async () => {
    const c = seed.a;
    const updatedAt = new Date('2026-10-12T09:00:00Z');
    await seedTask(c, { status: 'draft', updatedAt, expiresAt: new Date('2026-10-12T16:00:00Z') });
    await seedTask(c, { status: 'draft', updatedAt, expiresAt: new Date('2026-10-12T18:00:00Z') });
    await seedTask(c, { status: 'draft', updatedAt, expiresAt: null });

    const { counts } = await readAll(c);
    expect(counts.storm_scout!.waitingCount).toBe(2);
  });

  test('a task finished at 03:00Z on Oct 13 counts for local Oct 12', async () => {
    const c = seed.a;
    await seedTask(c, { status: 'done', updatedAt: new Date('2026-10-13T03:00:00Z') });
    await seedTask(c, { status: 'partly_done', updatedAt: new Date('2026-10-10T16:00:00Z') });
    await seedTask(c, { status: 'done', updatedAt: new Date('2026-10-12T15:00:00Z') });

    const days = await withTenant(pools, ctxFor(c), (tx) => dailyFinished(tx, ctxFor(c), 'storm_scout', w));
    expect(days).toEqual([
      { date: '2026-10-10', finished: 1 },
      { date: '2026-10-12', finished: 2 },
    ]);
    // 03:00Z on Oct 13 is 22:00 on Oct 12 in Chicago, so that task is "today", not tomorrow.
    const counts = await withTenant(pools, ctxFor(c), (tx) => agentCounts(tx, ctxFor(c), w));
    expect(counts.storm_scout?.finishedToday).toBe(2);
  });

  test('minutesByAgent sums only done step snapshots in range', async () => {
    const c = seed.a;
    const taskId = await seedTask(c, { status: 'done', updatedAt: today });
    await seedStep(c, taskId, { position: 0, status: 'done', updatedAt: today, baselineKey: 'text_sent', units: 3, minutesPerUnit: 10, minutesSaved: 30 });
    await seedStep(c, taskId, { position: 1, status: 'failed', updatedAt: today, baselineKey: 'text_sent', units: 9, minutesPerUnit: 11, minutesSaved: 99 });
    await seedStep(c, taskId, { position: 2, status: 'done', updatedAt: new Date('2026-09-01T12:00:00Z'), baselineKey: 'text_sent', units: 5, minutesPerUnit: 10, minutesSaved: 50 });

    const { minutes } = await readAll(c);
    expect(minutes).toEqual({ storm_scout: 30 });
  });

  test('breakdownByBaseline groups by baseline_key, minutes descending', async () => {
    const c = seed.a;
    const storm = await seedTask(c, { status: 'done', updatedAt: today });
    await seedStep(c, storm, { position: 0, status: 'done', updatedAt: today, baselineKey: 'text_sent', units: 2, minutesPerUnit: 10, minutesSaved: 20 });
    await seedStep(c, storm, { position: 1, status: 'done', updatedAt: today, baselineKey: 'text_sent', units: 1, minutesPerUnit: 10, minutesSaved: 10 });
    await seedStep(c, storm, { position: 2, status: 'done', updatedAt: today, baselineKey: 'proposal_sent', units: 1, minutesPerUnit: 45, minutesSaved: 45 });
    await seedStep(c, storm, { position: 3, status: 'pending', updatedAt: today, baselineKey: 'text_sent', units: 7, minutesPerUnit: 10, minutesSaved: 70 });
    const estimate = await seedTask(c, { agent: 'estimator', status: 'done', updatedAt: today });
    await seedStep(c, estimate, { position: 0, status: 'done', updatedAt: today, baselineKey: 'text_sent', units: 5, minutesPerUnit: 10, minutesSaved: 50 });

    const rows = await withTenant(pools, ctxFor(c), (tx) => breakdownByBaseline(tx, ctxFor(c), 'storm_scout', monthRange));
    expect(rows).toEqual([
      { baseline: 'proposal_sent', units: 1, minutes: 45 },
      { baseline: 'text_sent', units: 3, minutes: 30 },
    ]);
  });

  test('rep scope: a rep sees only tasks on their jobs and customers', async () => {
    const c = seed.a;
    const owner = ctxFor(c);
    const { mineJob, theirsJob, customerId } = await withTenant(pools, owner, async (tx) => {
      const [cust] = await tx
        .insert(customers)
        .values({ companyId: c.companyId, displayName: 'Pat Customer', createdByUserId: c.owner.userId })
        .returning({ id: customers.id });
      const [prop1] = await tx
        .insert(properties)
        .values({ companyId: c.companyId, customerId: cust!.id, addressLine: '1 Main St', city: 'Omaha', state: 'NE', zip: '68102', addressKey: 'main1' })
        .returning({ id: properties.id });
      const [prop2] = await tx
        .insert(properties)
        .values({ companyId: c.companyId, customerId: cust!.id, addressLine: '2 Oak St', city: 'Omaha', state: 'NE', zip: '68102', addressKey: 'oak2' })
        .returning({ id: properties.id });
      const [mine] = await tx
        .insert(jobs)
        .values({ companyId: c.companyId, customerId: cust!.id, propertyId: prop1!.id, assignedUserId: c.rep.userId, createdByUserId: c.owner.userId })
        .returning({ id: jobs.id });
      const [theirs] = await tx
        .insert(jobs)
        .values({ companyId: c.companyId, customerId: cust!.id, propertyId: prop2!.id, assignedUserId: c.otherRep.userId, createdByUserId: c.owner.userId })
        .returning({ id: jobs.id });
      return { mineJob: mine!.id, theirsJob: theirs!.id, customerId: cust!.id };
    });

    const mineTask = await seedTask(c, { status: 'done', updatedAt: today, subjectType: 'job', subjectId: mineJob, minutesSaved: 30 });
    await seedStep(c, mineTask, { position: 0, status: 'done', updatedAt: today, baselineKey: 'text_sent', units: 3, minutesPerUnit: 10, minutesSaved: 30 });
    const theirsTask = await seedTask(c, { status: 'done', updatedAt: today, subjectType: 'job', subjectId: theirsJob, minutesSaved: 40 });
    await seedStep(c, theirsTask, { position: 0, status: 'done', updatedAt: today, baselineKey: 'text_sent', units: 4, minutesPerUnit: 10, minutesSaved: 40 });
    const noSubject = await seedTask(c, { status: 'done', updatedAt: today, minutesSaved: 50 });
    await seedStep(c, noSubject, { position: 0, status: 'done', updatedAt: today, baselineKey: 'text_sent', units: 5, minutesPerUnit: 10, minutesSaved: 50 });
    // A customer-subject task on the rep's own customer is visible: the customer has the rep's job.
    const customerTask = await seedTask(c, { status: 'needs_attention', updatedAt: today, subjectType: 'customer', subjectId: customerId });

    const rep = repCtx(c);
    const repView = await withTenant(pools, rep, async (tx) => ({
      counts: await agentCounts(tx, rep, w),
      minutes: await minutesByAgent(tx, rep, monthRange),
      recent: await recentTasks(tx, rep, 'storm_scout', 20),
    }));
    expect(repView.counts.storm_scout).toEqual({
      finishedToday: 1,
      done30d: 1,
      partlyDone30d: 0,
      ran30d: 2,
      notApproved30d: 0,
      waitingCount: 1,
    });
    expect(repView.minutes).toEqual({ storm_scout: 30 });
    expect(repView.recent.map((r) => r.id).sort()).toEqual([customerTask, mineTask].sort());

    const owner2 = await readAll(c);
    expect(owner2.counts.storm_scout).toEqual({
      finishedToday: 3,
      done30d: 3,
      partlyDone30d: 0,
      ran30d: 4,
      notApproved30d: 0,
      waitingCount: 1,
    });
    expect(owner2.minutes).toEqual({ storm_scout: 120 });
    const ownerRecent = await withTenant(pools, owner, (tx) => recentTasks(tx, owner, 'storm_scout', 20));
    expect(ownerRecent.map((r) => r.id)).toContain(theirsTask);
    expect(ownerRecent.map((r) => r.id)).toContain(noSubject);
  });

  test('company B data is never counted for company A', async () => {
    const a = seed.a;
    const aTask = await seedTask(a, { status: 'done', updatedAt: today });
    await seedStep(a, aTask, { position: 0, status: 'done', updatedAt: today, baselineKey: 'text_sent', units: 3, minutesPerUnit: 10, minutesSaved: 30 });
    const before = await readAll(a);

    const bTask = await seedTask(seed.b, { status: 'done', updatedAt: today });
    await seedStep(seed.b, bTask, { position: 0, status: 'done', updatedAt: today, baselineKey: 'text_sent', units: 50, minutesPerUnit: 10, minutesSaved: 500 });
    await seedTask(seed.b, { status: 'draft', updatedAt: today });

    const after = await readAll(a);
    expect(after).toEqual(before);
    expect(after.counts.storm_scout?.finishedToday).toBe(1);
    expect(after.minutes).toEqual({ storm_scout: 30 });

    const bView = await readAll(seed.b);
    expect(bView.counts.storm_scout).toMatchObject({ finishedToday: 1, waitingCount: 1 });
    expect(bView.minutes).toEqual({ storm_scout: 500 });

    const aRecent = await withTenant(pools, ctxFor(a), (tx) => recentTasks(tx, ctxFor(a), 'storm_scout', 20));
    expect(aRecent.map((r) => r.id)).toEqual([aTask]);
    expect(
      await withTenant(pools, ctxFor(a), (tx) => breakdownByBaseline(tx, ctxFor(a), 'storm_scout', monthRange)),
    ).toEqual([{ baseline: 'text_sent', units: 3, minutes: 30 }]);
  });

  test('recentTasks returns newest first and honours limit', async () => {
    const c = seed.a;
    const oldDraft = await seedTask(c, {
      status: 'draft',
      createdAt: new Date('2026-10-08T12:00:00Z'),
      updatedAt: new Date('2026-10-08T12:00:00Z'),
    });
    const doneTask = await seedTask(c, {
      status: 'done',
      createdAt: new Date('2026-10-10T12:00:00Z'),
      updatedAt: new Date('2026-10-10T13:30:00Z'),
      minutesSaved: 12.5,
    });
    const newDraft = await seedTask(c, {
      status: 'draft',
      mode: 'live',
      createdAt: new Date('2026-10-11T12:00:00Z'),
      updatedAt: new Date('2026-10-11T12:00:00Z'),
    });

    const two = await withTenant(pools, ctxFor(c), (tx) => recentTasks(tx, ctxFor(c), 'storm_scout', 2));
    expect(two.map((r) => r.id)).toEqual([newDraft, doneTask]);
    expect(two[0]).toMatchObject({ mode: 'live', status: 'draft', finishedAt: null, minutesSaved: null });
    expect(two[1]).toMatchObject({
      status: 'done',
      mode: 'needs_approval',
      finishedAt: new Date('2026-10-10T13:30:00Z'),
      minutesSaved: 12.5,
    });

    const all = await withTenant(pools, ctxFor(c), (tx) => recentTasks(tx, ctxFor(c), 'storm_scout', 100));
    expect(all.map((r) => r.id)).toEqual([newDraft, doneTask, oldDraft]);
  });

  test('agentSettingsInfo returns pausedAt and the pauser name', async () => {
    const c = seed.a;
    const pausedAt = new Date('2026-10-12T14:00:00Z');
    await withTenant(pools, ctxFor(c), (tx) =>
      tx.insert(agentSettings).values({
        companyId: c.companyId,
        agent: 'storm_scout',
        pausedAt,
        pausedBy: c.owner.userId,
        lastRunNowAt: null,
      }),
    );

    const rows = await withTenant(pools, ctxFor(c), (tx) => agentSettingsInfo(tx, ctxFor(c)));
    expect(rows).toEqual([{ agent: 'storm_scout', pausedAt, pausedByName: 'Acme Owner', lastRunNowAt: null }]);

    expect(await withTenant(pools, ctxFor(seed.b), (tx) => agentSettingsInfo(tx, ctxFor(seed.b)))).toEqual([]);
  });
});
