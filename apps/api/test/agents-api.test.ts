import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { agentSettings, agentTasks, agentTaskSteps } from '@roofline/db';
import type { Agent, AgentCard, AgentsOverview, TaskStatus } from '@roofline/shared';
import { Actors, addressFor, type CompanyKey, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

/*
 * GET /api/agents and GET /api/agents/:agent (A1 Task 5). Database-backed: CI runs it (no Docker
 * here). "Now" is 2026-10-12T18:00Z, which is 13:00 on Monday in America/Chicago (CDT, UTC-5), so
 * today runs 05:00Z to 05:00Z the next day, the week starts today, the month starts 2026-10-01 05:00Z,
 * the last 30 days start 2026-09-12 18:00Z, and last90 starts 2026-07-15 05:00Z.
 */

const NOW = '2026-10-12T18:00:00.000Z';
const CHART = [
  '2026-09-29',
  '2026-09-30',
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
  '2026-10-08',
  '2026-10-09',
  '2026-10-10',
  '2026-10-11',
  '2026-10-12',
];
const SCREEN = ['storm_scout', 'estimator', 'front_desk', 'claims', 'scheduler', 'follow_up'];
const G1 = ['claims', 'scheduler', 'follow_up'];
const NOT_FOUND = "We couldn't find that.";
const BAD_PERIOD = 'Please pick today, week, month or last90.';
const ESTIMATOR_RULE = 'When you type an address, I measure the roof and draft a three-option proposal. I order exact reports only when you approve.';

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(new Date(NOW));
  who = new Actors(t);
});

type Company = CompanyKey;

/** A chart series with the given days filled in and every other day of the 14 zero. */
function series(counts: Record<string, number>) {
  return CHART.map((date) => ({ date, finished: counts[date] ?? 0 }));
}

type StepSeed = { minutes: number; baseline: string; units: number };
type TaskSeed = {
  agent?: Agent;
  kind?: string;
  status?: TaskStatus;
  subject?: { type: 'job' | 'customer'; id: string };
  /** When the task was last updated (its finish time, or a draft's last change). */
  at: string;
  createdAt?: string;
  steps?: StepSeed[];
};

/** Inserts one agent task, plus its done steps (each step's time is the task's time). Returns the task id. */
async function seedTask(s: TaskSeed, company: Company = 'a'): Promise<string> {
  const companyId = t.seed[company].companyId;
  const steps = s.steps ?? [];
  return inCompany(t, companyId, async (tx) => {
    const [row] = await tx
      .insert(agentTasks)
      .values({
        companyId,
        agent: s.agent ?? 'storm_scout',
        kind: 'storm_plan',
        title: 'Storm plan',
        mode: 'needs_approval',
        status: s.status ?? 'done',
        minutesSaved: steps.length > 0 ? steps.reduce((sum, step) => sum + step.minutes, 0) : null,
        subjectType: s.subject?.type ?? null,
        subjectId: s.subject?.id ?? null,
        createdAt: new Date(s.createdAt ?? s.at),
        updatedAt: new Date(s.at),
      })
      .returning({ id: agentTasks.id });
    const taskId = row!.id;
    if (steps.length > 0) {
      await tx.insert(agentTaskSteps).values(
        steps.map((step, i) => ({
          companyId,
          taskId,
          position: i + 1,
          type: 'send_sms_batch',
          approvalClass: 'message' as const,
          status: 'done' as const,
          baselineKey: step.baseline,
          units: step.units,
          minutesPerUnit: step.minutes / step.units,
          minutesSaved: step.minutes,
          idempotencyKey: randomUUID(),
          createdAt: new Date(s.at),
          updatedAt: new Date(s.at),
        })),
      );
    }
    return taskId;
  });
}

/** A finished run: a done (or partly done) task with its snapshot steps. */
const finished = (s: TaskSeed, company: Company = 'a') => seedTask({ status: 'done', ...s }, company);

async function setSettings(
  agent: Agent,
  values: { pausedAt?: string; pausedBy?: string; lastRunNowAt?: string },
  company: Company = 'a',
): Promise<void> {
  const companyId = t.seed[company].companyId;
  await inCompany(t, companyId, (tx) =>
    tx.insert(agentSettings).values({
      companyId,
      agent,
      pausedAt: values.pausedAt === undefined ? null : new Date(values.pausedAt),
      pausedBy: values.pausedBy ?? null,
      lastRunNowAt: values.lastRunNowAt === undefined ? null : new Date(values.lastRunNowAt),
    }),
  );
}

async function overview(agent: SuperAgent): Promise<AgentsOverview> {
  const res = await agent.get('/api/agents');
  expect(res.status).toBe(200);
  return res.body as AgentsOverview;
}

const cardOf = (body: AgentsOverview, agent: string): AgentCard => body.cards.find((c) => c.agent === agent)!;

describe('GET /api/agents (overview)', () => {
  test('GET /api/agents returns six cards in order', async () => {
    const body = await overview(await who.as('owner'));
    expect(body.cards.map((c) => c.agent)).toEqual(SCREEN);
    expect(body.hourlyRateCents).toBe(2800);
    expect(body.minutesThisMonth).toBe(0);
  });

  test('an empty company shows every launch agent as on, with a zero-filled 14-day chart', async () => {
    const body = await overview(await who.as('owner'));
    for (const agent of ['storm_scout', 'estimator', 'front_desk']) {
      const card = cardOf(body, agent);
      expect(card.status, agent).toBe('on');
      expect(card.finishedToday).toBe(0);
      expect(card.successRate).toBeNull();
      expect(card.last14Days).toEqual(series({}));
    }
  });

  test('numbers come from seeded tasks and snapshots', async () => {
    // Done today: 3 finished (two done, one partly done) at 10:00, 11:00 and 12:00 Chicago time.
    await finished({ at: '2026-10-12T15:00:00.000Z', steps: [{ minutes: 30, baseline: 'text_sent', units: 20 }] });
    await finished({ at: '2026-10-12T16:00:00.000Z' });
    await finished({ at: '2026-10-12T17:00:00.000Z', status: 'partly_done', steps: [{ minutes: 15, baseline: 'email_sent', units: 30 }] });
    // Earlier this month: two done, one with a 45-minute snapshot.
    await finished({ at: '2026-10-05T15:00:00.000Z', steps: [{ minutes: 45, baseline: 'route_built', units: 1 }] });
    await finished({ at: '2026-10-06T15:00:00.000Z' });
    // Last month, inside the last 30 days: two done, one with a 60-minute snapshot (not this month).
    await finished({ at: '2026-09-20T15:00:00.000Z', steps: [{ minutes: 60, baseline: 'route_built', units: 1 }] });
    await finished({ at: '2026-09-25T15:00:00.000Z' });
    // Not approved: declined and expired. Waiting: one draft.
    await seedTask({ status: 'declined', at: '2026-10-10T15:00:00.000Z' });
    await seedTask({ status: 'expired', at: '2026-10-09T15:00:00.000Z' });
    await seedTask({ status: 'draft', at: '2026-10-12T12:00:00.000Z' });

    const owner = await who.as('owner');
    const body = await overview(owner);
    const card = cardOf(body, 'storm_scout');
    expect(card.status).toBe('waiting');
    expect(card.finishedToday).toBe(3);
    expect(card.notApproved30d).toBe(2);
    expect(card.waitingCount).toBe(1);
    expect(card.minutesThisMonth).toBe(90);
    expect(body.minutesThisMonth).toBe(90);
    // Done 6 (2 today, 2 this month, 2 in September), partly done 1, ran 7 (no needs_attention).
    expect(card.successRate).toBeCloseTo((6 + 0.5 * 1) / 7, 10);
    expect(card.last14Days).toHaveLength(14);
    expect(card.last14Days).toEqual(series({ '2026-10-05': 1, '2026-10-06': 1, '2026-10-12': 3 }));
    expect(card.last14Days[13]).toEqual({ date: '2026-10-12', finished: 3 });

    const detail = await owner.get('/api/agents/storm_scout?period=month');
    expect(detail.status).toBe(200);
    expect(detail.body.card).toEqual(card);
    expect(detail.body.minutesInPeriod).toBe(90);
  });

  test('successRate is null under five runs', async () => {
    for (let i = 0; i < 4; i++) await finished({ at: `2026-10-12T1${i}:00:00.000Z` });
    const owner = await who.as('owner');
    expect(cardOf(await overview(owner), 'storm_scout').successRate).toBeNull();
    await finished({ at: '2026-10-12T15:00:00.000Z' });
    expect(cardOf(await overview(owner), 'storm_scout').successRate).toBe(1);
  });

  test('status is paused when agent_settings.paused_at is set (paused wins over waiting)', async () => {
    const owner = await who.as('owner');
    await setSettings('estimator', { pausedAt: '2026-10-11T12:00:00.000Z', pausedBy: who.user('owner').userId });
    await seedTask({ agent: 'estimator', status: 'draft', at: '2026-10-12T12:00:00.000Z' });
    const body = await overview(owner);
    expect(cardOf(body, 'estimator').status).toBe('paused');
    expect(cardOf(body, 'estimator').waitingCount).toBe(1);
    expect(cardOf(body, 'storm_scout').status).toBe('on');

    const detail = await owner.get('/api/agents/estimator');
    expect(detail.body.paused).toEqual({ at: '2026-10-11T12:00:00.000Z', byName: 'Acme Owner' });
    expect((await owner.get('/api/agents/storm_scout')).body.paused).toBeNull();
  });

  test('G1 agents are coming_soon with zeros and an empty series, even with seeded work', async () => {
    await finished({ agent: 'claims', at: '2026-10-12T15:00:00.000Z', steps: [{ minutes: 10, baseline: 'text_sent', units: 1 }] });
    await seedTask({ agent: 'scheduler', status: 'draft', at: '2026-10-12T12:00:00.000Z' });
    const owner = await who.as('owner');
    const body = await overview(owner);
    for (const agent of G1) {
      const card = cardOf(body, agent);
      expect(card, agent).toEqual({
        agent,
        status: 'coming_soon',
        finishedToday: 0,
        successRate: null,
        notApproved30d: 0,
        minutesThisMonth: 0,
        last14Days: [],
        waitingCount: 0,
      });
      const detail = await owner.get(`/api/agents/${agent}`);
      expect(detail.status).toBe(200);
      expect(detail.body.runNow).toEqual({ kind: 'coming_soon' });
      expect(detail.body.card.status).toBe('coming_soon');
      expect(detail.body.minutesInPeriod).toBe(0);
      expect(detail.body.breakdown).toEqual([]);
      expect(detail.body.recentTasks).toEqual([]);
    }
  });
});

describe('GET /api/agents/:agent (detail)', () => {
  test('detail returns breakdown and minutesInPeriod per period', async () => {
    await finished({ at: '2026-10-12T15:00:00.000Z', steps: [{ minutes: 6, baseline: 'text_sent', units: 4 }] }); // today
    await finished({ at: '2026-10-11T23:00:00.000Z', steps: [{ minutes: 5, baseline: 'email_sent', units: 10 }] }); // Sunday, this month
    await finished({ at: '2026-10-11T04:00:00.000Z', steps: [{ minutes: 3, baseline: 'text_sent', units: 2 }] }); // Oct 10 at 23:00 local, this month
    await finished({ at: '2026-10-05T15:00:00.000Z', steps: [{ minutes: 45, baseline: 'route_built', units: 1 }] }); // this month
    await finished({ at: '2026-07-20T15:00:00.000Z', steps: [{ minutes: 1.5, baseline: 'text_sent', units: 1 }] }); // last90 only
    await finished({ at: '2026-07-14T15:00:00.000Z', steps: [{ minutes: 1, baseline: 'email_sent', units: 2 }] }); // outside last90
    const owner = await who.as('owner');

    const today = (await owner.get('/api/agents/storm_scout?period=today')).body;
    expect(today.period).toBe('today');
    expect(today.minutesInPeriod).toBe(6);
    expect(today.breakdown).toEqual([{ baseline: 'text_sent', units: 4, minutes: 6 }]);

    const week = (await owner.get('/api/agents/storm_scout?period=week')).body;
    expect(week.period).toBe('week');
    expect(week.minutesInPeriod).toBe(6);
    expect(week.breakdown).toEqual([{ baseline: 'text_sent', units: 4, minutes: 6 }]);

    const month = (await owner.get('/api/agents/storm_scout?period=month')).body;
    expect(month.period).toBe('month');
    expect(month.minutesInPeriod).toBe(59);
    expect(month.breakdown).toEqual([
      { baseline: 'route_built', units: 1, minutes: 45 },
      { baseline: 'text_sent', units: 6, minutes: 9 },
      { baseline: 'email_sent', units: 10, minutes: 5 },
    ]);

    const last90 = (await owner.get('/api/agents/storm_scout?period=last90')).body;
    expect(last90.period).toBe('last90');
    expect(last90.minutesInPeriod).toBe(60.5);
    expect(last90.breakdown).toEqual([
      { baseline: 'route_built', units: 1, minutes: 45 },
      { baseline: 'text_sent', units: 7, minutes: 10.5 },
      { baseline: 'email_sent', units: 10, minutes: 5 },
    ]);
    expect(last90.card.minutesThisMonth).toBe(59);
    expect(last90.hourlyRateCents).toBe(2800);
  });

  test('default period is month', async () => {
    const res = await (await who.as('owner')).get('/api/agents/storm_scout');
    expect(res.status).toBe(200);
    expect(res.body.period).toBe('month');
  });

  test('detail runNow per agent', async () => {
    const owner = await who.as('owner');
    const storm = await owner.get('/api/agents/storm_scout');
    expect(storm.body.runNow).toEqual({ kind: 'available', nextAllowedAt: null });
    expect((await owner.get('/api/agents/estimator')).body.runNow).toEqual({ kind: 'works_when_asked' });
    expect((await owner.get('/api/agents/front_desk')).body.runNow).toEqual({ kind: 'answers_calls' });

    await setSettings('storm_scout', { lastRunNowAt: '2026-10-12T17:00:00.000Z' });
    const after = await owner.get('/api/agents/storm_scout');
    expect(after.body.runNow).toEqual({ kind: 'available', nextAllowedAt: '2026-10-12T17:05:00.000Z' });
  });

  test('detail rules: estimator has its sentence; storm and front desk have none on this base (AX-K)', async () => {
    const owner = await who.as('owner');
    expect((await owner.get('/api/agents/estimator')).body.rules).toEqual([{ text: ESTIMATOR_RULE, links: [] }]);
    expect((await owner.get('/api/agents/storm_scout')).body.rules).toEqual([]);
    expect((await owner.get('/api/agents/front_desk')).body.rules).toEqual([]);
  });

  test('recentTasks is the last 20, newest first', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const minute = String(i).padStart(2, '0');
      ids.push(await seedTask({ agent: 'estimator', status: 'draft', at: `2026-10-12T10:${minute}:00.000Z`, createdAt: `2026-10-12T10:${minute}:00.000Z` }));
    }
    const body = (await (await who.as('owner')).get('/api/agents/estimator')).body;
    expect(body.recentTasks).toHaveLength(20);
    expect(body.recentTasks.map((r: { id: string }) => r.id)).toEqual([...ids].reverse().slice(0, 20));
    expect(body.recentTasks[0]).toMatchObject({ kind: 'storm_plan', status: 'draft', mode: 'needs_approval', finishedAt: null, minutesSaved: null });
  });

  test('a finished recent task carries its finish time and minutes', async () => {
    const id = await finished({ agent: 'storm_scout', at: '2026-10-12T15:00:00.000Z', steps: [{ minutes: 12, baseline: 'text_sent', units: 8 }] });
    const body = (await (await who.as('owner')).get('/api/agents/storm_scout')).body;
    expect(body.recentTasks).toEqual([
      {
        id,
        kind: 'storm_plan',
        status: 'done',
        mode: 'needs_approval',
        createdAt: '2026-10-12T15:00:00.000Z',
        finishedAt: '2026-10-12T15:00:00.000Z',
        minutesSaved: 12,
      },
    ]);
  });

  test('unknown agent is 404 and system is 404', async () => {
    const owner = await who.as('owner');
    for (const name of ['nope', 'system']) {
      const res = await owner.get(`/api/agents/${name}`);
      expect(res.status, name).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    }
  });

  test('sibling paths are not captured by /:agent: /feed is 404, not a 400 from the agent route', async () => {
    const res = await (await who.as('owner')).get('/api/agents/feed?period=bogus');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
  });

  test('bad period is 400', async () => {
    const owner = await who.as('owner');
    for (const period of ['year', 'MONTH', '']) {
      const res = await owner.get(`/api/agents/storm_scout?period=${period}`);
      expect(res.status, period).toBe(400);
      expect(res.body.error).toBe(BAD_PERIOD);
    }
  });

  test('a signed-out request is refused with 401', async () => {
    const res = await request(t.app).get('/api/agents');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Please sign in.' });
    expect((await request(t.app).get('/api/agents/storm_scout')).status).toBe(401);
  });
});

describe('role scope and company isolation', () => {
  test('rep scope (AX-J): a rep sees only tasks on their own jobs and customers', async () => {
    const owner = await who.as('owner');
    const rep = await who.as('rep');
    const repId = who.user('rep').userId;
    const otherRepId = who.user('otherRep').userId;
    const customer = (agent: typeof owner, displayName: string) => mustCreate(agent, '/api/customers', { displayName });
    const house = (agent: typeof owner, n: number, customerId: string) =>
      mustCreate(agent, '/api/properties', { customerId, ...addressFor(n) });
    const job = (agent: typeof owner, customerId: string, propertyId: string, extra: Record<string, unknown>) =>
      mustCreate(agent, '/api/jobs', { customerId, propertyId, stage: 'inspection', ...extra });

    const repJobCustomer = await customer(owner, 'Assigned Customer');
    const repJob = await job(owner, repJobCustomer.id, (await house(owner, 1, repJobCustomer.id)).id, { assignedUserId: repId });
    const otherJobCustomer = await customer(owner, 'Other Customer');
    const otherJob = await job(owner, otherJobCustomer.id, (await house(owner, 2, otherJobCustomer.id)).id, {
      assignedUserId: otherRepId,
    });
    const repCustomer = await customer(rep, 'Rep Customer');
    const ownerCustomer = await customer(owner, 'Owner Customer');

    const at = '2026-10-12T15:00:00.000Z';
    const steps = [{ minutes: 10, baseline: 'text_sent', units: 1 }];
    const repJobRun = await finished({ at, subject: { type: 'job', id: repJob.id }, steps });
    await finished({ at, subject: { type: 'job', id: otherJob.id }, steps });
    await finished({ at, steps }); // no subject
    const repCustomerRun = await finished({ at, subject: { type: 'customer', id: repCustomer.id }, steps });
    await finished({ at, subject: { type: 'customer', id: ownerCustomer.id }, steps });
    const repDraft = await seedTask({ status: 'draft', subject: { type: 'job', id: repJob.id }, at: '2026-10-12T12:00:00.000Z' });
    await seedTask({ status: 'draft', at: '2026-10-12T12:00:00.000Z' });

    // The owner sees everything: five finished runs, two waiting, 50 minutes.
    const ownerBody = await overview(owner);
    expect(cardOf(ownerBody, 'storm_scout').finishedToday).toBe(5);
    expect(cardOf(ownerBody, 'storm_scout').waitingCount).toBe(2);
    expect(cardOf(ownerBody, 'storm_scout').minutesThisMonth).toBe(50);
    expect((await owner.get('/api/agents/storm_scout')).body.recentTasks).toHaveLength(7);

    // The rep sees the job they are on and the customer they made: two finished, one waiting, 20 minutes.
    const repBody = await overview(rep);
    expect(cardOf(repBody, 'storm_scout').finishedToday).toBe(2);
    expect(cardOf(repBody, 'storm_scout').waitingCount).toBe(1);
    expect(cardOf(repBody, 'storm_scout').minutesThisMonth).toBe(20);
    expect(repBody.minutesThisMonth).toBe(20);
    const repDetail = (await rep.get('/api/agents/storm_scout')).body;
    expect(repDetail.minutesInPeriod).toBe(20);
    expect(repDetail.breakdown).toEqual([{ baseline: 'text_sent', units: 2, minutes: 20 }]);
    expect(repDetail.recentTasks.map((r: { id: string }) => r.id).sort()).toEqual([repJobRun, repCustomerRun, repDraft].sort());
  });

  test('company B isolation: cross-tenant data is never counted; unknown agent is 404 for both', async () => {
    await finished({ at: '2026-10-12T15:00:00.000Z', steps: [{ minutes: 10, baseline: 'text_sent', units: 1 }] }, 'a');
    await finished({ at: '2026-10-12T15:00:00.000Z', steps: [{ minutes: 99, baseline: 'route_built', units: 1 }] }, 'b');
    await seedTask({ status: 'draft', at: '2026-10-12T12:00:00.000Z' }, 'b');

    const ownerA = await who.as('owner', 'a');
    const ownerB = await who.as('owner', 'b');
    const bodyA = await overview(ownerA);
    const bodyB = await overview(ownerB);
    expect(cardOf(bodyA, 'storm_scout')).toMatchObject({ finishedToday: 1, minutesThisMonth: 10, waitingCount: 0 });
    expect(cardOf(bodyB, 'storm_scout')).toMatchObject({ finishedToday: 1, minutesThisMonth: 99, waitingCount: 1 });
    expect(bodyA.minutesThisMonth).toBe(10);
    expect(bodyB.minutesThisMonth).toBe(99);

    const detailA = (await ownerA.get('/api/agents/storm_scout')).body;
    expect(detailA.breakdown).toEqual([{ baseline: 'text_sent', units: 1, minutes: 10 }]);
    expect(detailA.recentTasks).toHaveLength(1);
    const detailB = (await ownerB.get('/api/agents/storm_scout')).body;
    expect(detailB.breakdown).toEqual([{ baseline: 'route_built', units: 1, minutes: 99 }]);
    expect(detailB.recentTasks).toHaveLength(2);

    expect((await ownerA.get('/api/agents/nope')).status).toBe(404);
    expect((await ownerB.get('/api/agents/nope')).status).toBe(404);
  });
});
