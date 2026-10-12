import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  type FeedCursor,
  type FeedRow,
  feedRank,
  insertAgentEvent,
  listFeedPage,
  type NewAgentEvent,
  type TenantContext,
  withTenant,
} from '@roofline/db';
import type { Agent } from '@roofline/shared';
import { registerStepHandler } from '../src/tasks/runner.ts';
import { Actors, addressFor, type CompanyKey, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { agentCtx, dbSteps, newCustomers, newTask, seenOf, smsStep, STOP_BODY } from './task-helpers.ts';

/*
 * The feed read side (packages/db/src/repos/agent-feed.ts), tested through the repository with a
 * tenant context. Rows are written directly with insertAgentEvent at fixed times so the order is known.
 */

const NOW = new Date('2026-10-12T15:00:00.000Z');
const at = (minute: number) => new Date(Date.UTC(2026, 9, 12, 15, minute));

let t: TestApp;
let actors: Actors;
const restores: (() => void)[] = [];

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  actors = new Actors(t);
});

afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

type Who = 'owner' | 'office' | 'rep' | 'otherRep';

/** A reader's tenant context: owner and office see everything; reps and the other rep are scoped. */
function ctxFor(company: CompanyKey, who: Who): TenantContext {
  const user = t.seed[company][who];
  return {
    companyId: t.seed[company].companyId,
    userId: user.userId,
    role: who === 'otherRep' ? 'rep' : who,
    canApproveSpend: false,
  };
}

const feed = (ctx: TenantContext, options: { agent?: Agent; cursor?: FeedCursor | null; limit?: number } = {}) =>
  withTenant(t.deps.pools, ctx, (tx) => listFeedPage(tx, ctx, { limit: 200, ...options }));

const ownerFeed = (options: { agent?: Agent; cursor?: FeedCursor | null; limit?: number } = {}) =>
  feed(ctxFor('a', 'owner'), options);

/** Writes one event for a task of company A, at a fixed time. */
const addEvent = (taskId: string, kind: NewAgentEvent['kind'], when: Date, extra: Partial<NewAgentEvent> = {}) =>
  inCompany(t, t.seed.a.companyId, (tx) =>
    insertAgentEvent(tx, agentCtx(t.seed.a.companyId), {
      taskId,
      kind,
      actorType: 'agent',
      at: when,
      ...extra,
    }),
  );

/** The events sorted the way the feed must order them: at desc, then id desc. */
const newestFirst = <T extends { id: string; at: Date }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

const approveAs = async (who: 'owner' | 'office', taskId: string) => {
  const steps = await dbSteps(t, 'a', taskId);
  const res = await (await actors.as(who)).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
  expect(res.status).toBe(200);
};

const userName = (userId: string) =>
  inCompany(t, t.seed.a.companyId, async (tx) => ((await tx.execute(sql`select name from company_members where user_id = ${userId} limit 1`)).rows[0]!.name as string));

describe('agents feed repo', () => {
  test('newest first by at then id', async () => {
    t.clock.set(at(0));
    const { taskId } = await newTask(t, 'a');
    const e1 = await addEvent(taskId, 'step_done', at(5), { data: { units: 1 } });
    const e2 = await addEvent(taskId, 'step_done', at(5), { data: { units: 1 } });
    const e3 = await addEvent(taskId, 'approved', at(3), { actorType: 'user', actorUserId: t.seed.a.owner.userId });

    const rows = await ownerFeed();
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(newestFirst(rows).map((r) => r.id));

    // The two events at the same minute: the larger id comes first.
    const [hi, lo] = e1.id > e2.id ? [e1, e2] : [e2, e1];
    expect(ids.slice(0, 2)).toEqual([hi.id, lo.id]);
    expect(ids[2]).toBe(e3.id);
    expect(rows).toHaveLength(4);
    expect(rows[3]!.kind).toBe('created');
  });

  test('events at the same time rank approved, then finished, then step events, and paging visits each once', async () => {
    t.clock.set(at(0));
    const { taskId } = await newTask(t, 'a');
    await addEvent(taskId, 'step_done', at(9), { data: { units: 1 } });
    await addEvent(taskId, 'finished', at(9), { data: { status: 'done' } });
    await addEvent(taskId, 'approved', at(9), { actorType: 'user', actorUserId: t.seed.a.owner.userId });

    const top = (await ownerFeed()).slice(0, 3).map((r) => r.kind);
    expect(top).toEqual(['approved', 'finished', 'step_done']);

    const paged: string[] = [];
    let cursor: FeedCursor | null = null;
    for (let i = 0; i < 3; i += 1) {
      const page: FeedRow[] = await ownerFeed({ limit: 1, cursor });
      expect(page).toHaveLength(1);
      paged.push(page[0]!.kind);
      cursor = { at: page[0]!.at, rank: feedRank(page[0]!.kind), id: page[0]!.id };
    }
    expect(paged).toEqual(['approved', 'finished', 'step_done']);
  });

  test('cursor pages without gaps or repeats (limit 2 over 5 events)', async () => {
    t.clock.set(at(0));
    const { taskId } = await newTask(t, 'a');
    await addEvent(taskId, 'step_done', at(1));
    await addEvent(taskId, 'step_done', at(2));
    await addEvent(taskId, 'step_done', at(2));
    await addEvent(taskId, 'step_done', at(3));

    const paged: string[] = [];
    let cursor: FeedCursor | null = null;
    let pages = 0;
    for (;;) {
      const page: FeedRow[] = await ownerFeed({ limit: 2, cursor });
      if (page.length === 0) break;
      expect(page.length).toBeLessThanOrEqual(2);
      pages += 1;
      paged.push(...page.map((r) => r.id));
      const last = page[page.length - 1]!;
      cursor = { at: last.at, rank: feedRank(last.kind), id: last.id };
      expect(pages).toBeLessThan(10);
    }

    expect(pages).toBe(3);
    expect(paged).toHaveLength(5);
    expect(new Set(paged).size).toBe(5);
    expect(paged).toEqual((await ownerFeed({ limit: 200 })).map((r) => r.id));
  });

  test('agent filter keeps only that agent', async () => {
    const storm = await newTask(t, 'a', { agent: 'storm_scout', title: 'Storm plan' });
    const estimate = await newTask(t, 'a', { agent: 'estimator', kind: 'estimate', title: 'Estimate' });
    await addEvent(estimate.taskId, 'step_done', at(4));

    const all = await ownerFeed();
    expect(new Set(all.map((r) => r.agent))).toEqual(new Set(['storm_scout', 'estimator']));

    const onlyEstimator = await ownerFeed({ agent: 'estimator' });
    expect(onlyEstimator.length).toBeGreaterThan(0);
    expect(onlyEstimator.every((r) => r.agent === 'estimator')).toBe(true);
    expect(onlyEstimator.every((r) => r.taskId === estimate.taskId)).toBe(true);

    const onlyStorm = await ownerFeed({ agent: 'storm_scout' });
    expect(onlyStorm.map((r) => r.taskId)).toEqual([storm.taskId]);
  });

  test('rep sees only events of tasks on jobs inside jobScope and customers inside customerScope, and none of tasks with no subject', async () => {
    const w = await scopeWorld();
    const repIds = new Set((await feed(ctxFor('a', 'rep'))).map((r) => r.taskId));
    expect(repIds).toEqual(new Set([w.taskJob.taskId, w.taskCustomer.taskId]));
    expect(repIds.has(w.taskJobHidden.taskId)).toBe(false);
    expect(repIds.has(w.taskCustomerHidden.taskId)).toBe(false);
    expect(repIds.has(w.taskNone.taskId)).toBe(false);
  });

  test('owner sees all', async () => {
    const w = await scopeWorld();
    const ownerIds = new Set((await feed(ctxFor('a', 'owner'))).map((r) => r.taskId));
    expect(ownerIds).toEqual(new Set([w.taskJob.taskId, w.taskCustomer.taskId, w.taskJobHidden.taskId, w.taskCustomerHidden.taskId, w.taskNone.taskId]));
    const officeIds = new Set((await feed(ctxFor('a', 'office'))).map((r) => r.taskId));
    expect(officeIds).toEqual(ownerIds);
  });

  test('company B events never appear for company A', async () => {
    const mine = await newTask(t, 'a', { title: 'Company A plan' });
    const theirs = await newTask(t, 'b', { title: 'Company B plan' });
    await inCompany(t, t.seed.b.companyId, (tx) =>
      insertAgentEvent(tx, agentCtx(t.seed.b.companyId), { taskId: theirs.taskId, kind: 'step_done', actorType: 'agent', at: at(9) }),
    );

    const aRows = await ownerFeed();
    expect(aRows.map((r) => r.taskId)).toEqual([mine.taskId]);
    expect(aRows.some((r) => r.taskId === theirs.taskId)).toBe(false);

    const bRows = await feed(ctxFor('b', 'owner'));
    expect(new Set(bRows.map((r) => r.taskId))).toEqual(new Set([theirs.taskId]));
  });

  test('row data never contains message text', async () => {
    restores.push(registerStepHandler('send_sms_batch', async () => ({ status: 'done', result: { sent: 3 } })));
    const ids = await newCustomers(t, 'a', ['Ann', 'Ben', 'Cy']);
    const { taskId } = await newTask(t, 'a', { title: 'Texts', steps: [smsStep(ids)] });
    await approveAs('owner', taskId);
    await t.queue.drain(t.deps);

    const rows = (await ownerFeed()).filter((r) => r.taskId === taskId);
    expect(rows.some((r) => r.kind === 'step_done')).toBe(true);
    expect(rows.find((r) => r.kind === 'step_done')).toMatchObject({ stepType: 'send_sms_batch', stepResult: { sent: 3 } });

    const serialized = JSON.stringify(await ownerFeed());
    expect(serialized).not.toContain(STOP_BODY);
    expect(serialized).not.toContain('Free roof check');
    expect(serialized).not.toContain('Reply STOP');
  });

  test('actorName and customerFirstName are joined; a rep sees names only inside scope', async () => {
    const w = await scopeWorld();
    await approveAs('owner', w.taskJob.taskId);
    const ownerName = await userName(t.seed.a.owner.userId);

    const ownerRows = await ownerFeed();
    const approved = ownerRows.find((r) => r.taskId === w.taskJob.taskId && r.kind === 'approved');
    expect(approved).toMatchObject({ actorName: ownerName, customerFirstName: 'Dana' });
    expect(ownerRows.find((r) => r.taskId === w.taskJobHidden.taskId)).toMatchObject({ customerFirstName: 'Hal' });
    expect(ownerRows.find((r) => r.taskId === w.taskNone.taskId)).toMatchObject({ customerFirstName: null, actorName: null });

    // A rep sees the job's customer name on the job they may see, and nothing about the other job.
    const repRows = await feed(ctxFor('a', 'rep'));
    for (const row of repRows.filter((r) => r.taskId === w.taskJob.taskId)) {
      expect(row.customerFirstName).toBe('Dana');
    }
    expect(repRows.find((r) => r.taskId === w.taskJob.taskId && r.kind === 'approved')).toMatchObject({ actorName: ownerName });
    expect(repRows.some((r) => r.taskId === w.taskJobHidden.taskId)).toBe(false);
  });
});

/**
 * Company A with one rep and one other rep. Customers: Dana (job assigned to the rep, so in the rep's
 * scope), Hal (job assigned to the other rep, outside it), Nora (no job, not made by the rep, outside
 * it). Tasks: on Dana's job, on Hal's job, on Dana, on Nora, and with no subject.
 */
async function scopeWorld() {
  const owner = await actors.as('owner');
  const [dana, hal, nora] = await newCustomers(t, 'a', ['Dana', 'Hal', 'Nora']);
  const house = (n: number, customerId: string) => mustCreate(owner, '/api/properties', { customerId, ...addressFor(n) });
  const job = (customerId: string, propertyId: string, assignedUserId: string) =>
    mustCreate(owner, '/api/jobs', { customerId, propertyId, stage: 'inspection', assignedUserId, valueCents: 100 });

  const jobDana = await job(dana!, (await house(1, dana!)).id, t.seed.a.rep.userId);
  const jobHal = await job(hal!, (await house(2, hal!)).id, t.seed.a.otherRep.userId);

  const taskJob = await newTask(t, 'a', { title: 'Dana job', subjectType: 'job', subjectId: jobDana.id });
  const taskJobHidden = await newTask(t, 'a', { title: 'Hal job', subjectType: 'job', subjectId: jobHal.id });
  const taskCustomer = await newTask(t, 'a', { title: 'Dana customer', subjectType: 'customer', subjectId: dana! });
  const taskCustomerHidden = await newTask(t, 'a', { title: 'Nora customer', subjectType: 'customer', subjectId: nora! });
  const taskNone = await newTask(t, 'a', { title: 'No subject' });
  return { taskJob, taskJobHidden, taskCustomer, taskCustomerHidden, taskNone };
}
