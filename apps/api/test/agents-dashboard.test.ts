import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { agentTaskEvents, agentTasks, agentTaskSteps } from '@roofline/db';
import type { Agent } from '@roofline/shared';
import { Actors, addressFor, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * GET /api/agents/dashboard. Database-backed: CI runs it. "Now" is 2026-10-12T18:00Z, which is 13:00 on
 * Monday in America/Chicago (CDT, UTC-5): today runs 05:00Z to 05:00Z the next day and the week starts today.
 */

const NOW = '2026-10-12T18:00:00.000Z';
const hoursAgo = (h: number) => new Date(new Date(NOW).getTime() - h * 3_600_000).toISOString();

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(new Date(NOW));
  who = new Actors(t);
});

type Seed = { agent: Agent; at: string; created?: string; job?: string; minutes?: number; title?: string };

/** A finished task with one done step (and a finished event so it reaches the feed). Company A unless given. */
async function finished(s: Seed, company: 'a' | 'b' = 'a'): Promise<string> {
  const companyId = t.seed[company].companyId;
  return inCompany(t, companyId, async (tx) => {
    const [row] = await tx
      .insert(agentTasks)
      .values({
        companyId,
        agent: s.agent,
        kind: 'storm_plan',
        title: s.title ?? 'Storm plan',
        mode: 'live',
        status: 'done',
        minutesSaved: s.minutes ?? null,
        subjectType: s.job ? 'job' : null,
        subjectId: s.job ?? null,
        createdAt: new Date(s.created ?? s.at),
        updatedAt: new Date(s.at),
      })
      .returning({ id: agentTasks.id });
    const taskId = row!.id;
    await tx.insert(agentTaskSteps).values({
      companyId,
      taskId,
      position: 1,
      type: 'send_sms_batch',
      approvalClass: 'message' as const,
      status: 'done' as const,
      baselineKey: s.minutes === undefined ? null : 'text_sent',
      units: s.minutes === undefined ? null : 1,
      minutesPerUnit: s.minutes ?? null,
      minutesSaved: s.minutes ?? null,
      idempotencyKey: randomUUID(),
      createdAt: new Date(s.at),
      updatedAt: new Date(s.at),
    });
    await tx.insert(agentTaskEvents).values({ companyId, taskId, kind: 'finished', actorType: 'system', data: { steps: 1 }, at: new Date(s.at) });
    return taskId;
  });
}

async function jobAt(n: number): Promise<{ id: string; address: string }> {
  const owner = await who.as('owner');
  const customer = await mustCreate(owner, '/api/customers', { displayName: `Customer ${n}` });
  const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(n) });
  const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id, stage: 'inspection', assignedUserId: who.user('rep').userId });
  return { id: job.id, address: addressFor(n).addressLine };
}

describe('GET /api/agents/dashboard', () => {
  test('an empty company has zeros, twelve empty hours and no handoffs', async () => {
    const res = await (await who.as('owner')).get('/api/agents/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.tasksToday).toBe(0);
    expect(res.body.minutesThisWeek).toBe(0);
    expect(res.body.hourlyRateCents).toBe(2800);
    expect(res.body.tasksPerHour).toEqual(new Array(12).fill(0));
    expect(res.body.handoffsToday).toBe(0);
    expect(res.body.handoffs).toEqual([]);
    expect(res.body.agents.map((a: { agent: string }) => a.agent)).toEqual(['storm_scout', 'estimator', 'front_desk', 'claims', 'scheduler', 'follow_up']);
    for (const a of res.body.agents) expect(a.latest).toBeNull();
  });

  test('tiles, hourly series, week minutes and latest action come from real tasks', async () => {
    await finished({ agent: 'storm_scout', at: hoursAgo(0.5), minutes: 60, title: 'Storm plan for Elkhorn' });
    await finished({ agent: 'front_desk', at: hoursAgo(0.25), minutes: 30 });
    await finished({ agent: 'front_desk', at: hoursAgo(1.5), minutes: 30 });
    await finished({ agent: 'estimator', at: hoursAgo(11.5) });
    // Older than 12 hours but still today (05:00Z start, now 18:00Z): counts as today, not in the series.
    await finished({ agent: 'estimator', at: hoursAgo(12.5) });
    // Earlier this week is not possible on a Monday; yesterday is last week.
    await finished({ agent: 'storm_scout', at: hoursAgo(30), minutes: 600 });

    const res = await (await who.as('owner')).get('/api/agents/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.tasksToday).toBe(5);
    expect(res.body.minutesThisWeek).toBe(120);
    // Index 11 is the hour ending now.
    expect(res.body.tasksPerHour).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
    const scout = res.body.agents.find((a: { agent: string }) => a.agent === 'storm_scout');
    expect(scout.minutesThisWeek).toBe(60);
    expect(scout.latest.text).toBe('Finished: Storm plan for Elkhorn');
    expect(scout.latest.at).toBe(hoursAgo(0.5));
    expect(res.body.agents.find((a: { agent: string }) => a.agent === 'claims').latest).toBeNull();
  });

  test('a handoff is one job worked by two agents in turn today', async () => {
    const a = await jobAt(1);
    const b = await jobAt(2);
    const c = await jobAt(3);
    // Job A: Storm Scout, then Front Desk, then Estimator = two handoffs. Job B: one agent twice = none.
    await finished({ agent: 'storm_scout', at: hoursAgo(5), job: a.id });
    await finished({ agent: 'front_desk', at: hoursAgo(3), job: a.id });
    await finished({ agent: 'estimator', at: hoursAgo(1), job: a.id });
    await finished({ agent: 'claims', at: hoursAgo(4), job: b.id });
    await finished({ agent: 'claims', at: hoursAgo(2), job: b.id });
    // Job C: the first task was yesterday, so today's task is not a handoff.
    await finished({ agent: 'storm_scout', at: hoursAgo(40), job: c.id });
    await finished({ agent: 'scheduler', at: hoursAgo(2), job: c.id });

    const res = await (await who.as('owner')).get('/api/agents/dashboard');
    expect(res.body.handoffsToday).toBe(2);
    expect(res.body.handoffs).toEqual([
      { from: 'front_desk', to: 'estimator', label: a.address, at: hoursAgo(1) },
      { from: 'storm_scout', to: 'front_desk', label: a.address, at: hoursAgo(3) },
    ]);
  });

  test('a rep sees only their own jobs, other companies never show, and the rate hides without money access', async () => {
    const mine = await jobAt(4);
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Someone Else' });
    const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(5) });
    const theirs = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id, stage: 'inspection', assignedUserId: who.user('otherRep').userId });
    await finished({ agent: 'storm_scout', at: hoursAgo(3), job: mine.id, minutes: 10 });
    await finished({ agent: 'front_desk', at: hoursAgo(2), job: mine.id, minutes: 10 });
    await finished({ agent: 'storm_scout', at: hoursAgo(3), job: theirs.id, minutes: 10 });
    await finished({ agent: 'front_desk', at: hoursAgo(2), job: theirs.id, minutes: 10 });
    await finished({ agent: 'estimator', at: hoursAgo(1), minutes: 10 }, 'b');

    const ownerBody = (await owner.get('/api/agents/dashboard')).body;
    expect(ownerBody.tasksToday).toBe(4);
    expect(ownerBody.handoffsToday).toBe(2);

    const rep = await who.as('rep');
    const repBody = (await rep.get('/api/agents/dashboard')).body;
    expect(repBody.tasksToday).toBe(2);
    expect(repBody.minutesThisWeek).toBe(20);
    expect(repBody.handoffsToday).toBe(1);
    expect(repBody.handoffs.map((h: { label: string }) => h.label)).toEqual([mine.address]);
    expect(repBody.hourlyRateCents).toBeNull();
  });
});
