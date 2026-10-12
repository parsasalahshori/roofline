import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createPools } from '../src/pools.ts';
import { countFrontDeskFollowUps, listFrontDeskFollowUps } from '../src/repos/agent-waiting.ts';
import { agentTasks, conversations, customers, jobs, properties } from '../src/schema/index.ts';
import { type TenantContext, withTenant } from '../src/tenant.ts';
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

const ownerCtx = (c: SeededCompany): TenantContext => ({ companyId: c.companyId, userId: c.owner.userId, role: 'owner', canApproveSpend: true });
const repCtx = (c: SeededCompany): TenantContext => ({ companyId: c.companyId, userId: c.rep.userId, role: 'rep', canApproveSpend: false });

type FollowUpSeed = {
  name: string;
  n: number;
  assignedUserId: string | null;
  nextStep: string | null;
  /** Outcomes of the customer's conversations, with when each last had a message. */
  conversations: { outcome: 'message' | 'transferred' | 'booked' | 'abandoned' | null; at: Date }[];
};

/** A customer, a house, a job with a next step, and the customer's conversations. Returns the job id. */
async function seedJob(c: SeededCompany, s: FollowUpSeed): Promise<string> {
  return withTenant(pools, ownerCtx(c), async (tx) => {
    const [cust] = await tx.insert(customers).values({ companyId: c.companyId, displayName: s.name, createdByUserId: c.owner.userId }).returning({ id: customers.id });
    const [prop] = await tx
      .insert(properties)
      .values({ companyId: c.companyId, customerId: cust!.id, addressLine: `${s.n} Elm St`, city: 'Omaha', state: 'NE', zip: '68102', addressKey: `elm${s.n}` })
      .returning({ id: properties.id });
    const [job] = await tx
      .insert(jobs)
      .values({
        companyId: c.companyId,
        customerId: cust!.id,
        propertyId: prop!.id,
        assignedUserId: s.assignedUserId,
        createdByUserId: c.owner.userId,
        nextStep: s.nextStep,
      })
      .returning({ id: jobs.id });
    for (const [i, cv] of s.conversations.entries()) {
      await tx.insert(conversations).values({
        companyId: c.companyId,
        channel: 'voice',
        customerId: cust!.id,
        phoneE164: `+14025551${String(s.n * 10 + i).padStart(3, '0')}`,
        companyNumberE164: '+14025550000',
        status: 'ended',
        outcome: cv.outcome,
        lastMessageAt: cv.at,
      });
    }
    return job!.id;
  });
}

const list = (c: SeededCompany, ctx = ownerCtx(c)) => withTenant(pools, ctx, (tx) => listFrontDeskFollowUps(tx, ctx, NOW));
const count = (c: SeededCompany, ctx = ownerCtx(c)) => withTenant(pools, ctx, (tx) => countFrontDeskFollowUps(tx, ctx, NOW));

const NOW = new Date('2026-10-12T15:00:00Z');
const earlier = new Date('2026-10-11T14:00:00Z');
const later = new Date('2026-10-12T09:30:00Z');

describe('Front Desk follow-ups', () => {
  const liveTask = (c: SeededCompany, jobId: string, status: 'needs_attention' | 'done') =>
    withTenant(pools, ownerCtx(c), (tx) =>
      tx.insert(agentTasks).values({ companyId: c.companyId, agent: 'front_desk', kind: 'call', title: 'Took a message', mode: 'live', status, subjectType: 'job', subjectId: jobId }),
    );

  test('skips a job that already has an open live Front Desk task', async () => {
    const c = seed.a;
    const jobId = await seedJob(c, { name: 'Dee', n: 20, assignedUserId: null, nextStep: 'Call Dee', conversations: [{ outcome: 'message', at: later }] });
    await liveTask(c, jobId, 'needs_attention');
    expect(await list(c)).toEqual([]);
    expect(await count(c)).toBe(0);
  });

  test('still lists a job whose live task is done', async () => {
    const c = seed.a;
    const jobId = await seedJob(c, { name: 'Eve', n: 21, assignedUserId: null, nextStep: 'Call Eve', conversations: [{ outcome: 'message', at: later }] });
    await liveTask(c, jobId, 'done');
    expect(await list(c)).toHaveLength(1);
    expect(await count(c)).toBe(1);
  });

  test('a job with a next step and a message conversation is one row with the assignee name and the conversation time', async () => {
    const c = seed.a;
    const jobId = await seedJob(c, { name: 'Ann', n: 1, assignedUserId: c.rep.userId, nextStep: 'Call Ann back', conversations: [{ outcome: 'message', at: later }] });
    const rows = await list(c);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId, nextStep: 'Call Ann back', assigneeName: expect.any(String), assignedUserId: c.rep.userId, outcome: 'message' });
    expect(rows[0]!.since.toISOString()).toBe(later.toISOString());
  });

  test('an unassigned job has a null assignee name', async () => {
    const c = seed.a;
    await seedJob(c, { name: 'Bo', n: 2, assignedUserId: null, nextStep: 'Ring Bo', conversations: [{ outcome: 'transferred', at: earlier }] });
    const rows = await list(c);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assigneeName: null, assignedUserId: null, outcome: 'transferred' });
  });

  test('a job with no next step is not a follow-up', async () => {
    const c = seed.a;
    await seedJob(c, { name: 'Cy', n: 3, assignedUserId: null, nextStep: null, conversations: [{ outcome: 'message', at: later }] });
    expect(await list(c)).toEqual([]);
  });

  test('booked, abandoned and unfinished conversations do not make a follow-up', async () => {
    const c = seed.a;
    await seedJob(c, {
      name: 'Di',
      n: 4,
      assignedUserId: null,
      nextStep: 'Send estimate',
      conversations: [
        { outcome: 'booked', at: later },
        { outcome: 'abandoned', at: later },
        { outcome: null, at: later },
      ],
    });
    expect(await list(c)).toEqual([]);
  });

  test('the most recent message or transfer conversation sets since and outcome', async () => {
    const c = seed.a;
    await seedJob(c, {
      name: 'Ed',
      n: 5,
      assignedUserId: null,
      nextStep: 'Call Ed',
      conversations: [
        { outcome: 'message', at: earlier },
        { outcome: 'transferred', at: later },
        { outcome: 'booked', at: new Date('2026-10-12T12:00:00Z') },
      ],
    });
    const rows = await list(c);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'transferred' });
    expect(rows[0]!.since.toISOString()).toBe(later.toISOString());
  });

  test('a conversation older than 30 days is not a follow-up', async () => {
    const c = seed.a;
    await seedJob(c, { name: 'Old', n: 8, assignedUserId: null, nextStep: 'Call Old', conversations: [{ outcome: 'message', at: new Date(NOW.getTime() - 40 * 86_400_000) }] });
    expect(await list(c)).toEqual([]);
    expect(await count(c)).toBe(0);
  });

  test('an old transfer is ignored and the newer message inside the window wins', async () => {
    const c = seed.a;
    const recent = new Date(NOW.getTime() - 2 * 86_400_000);
    await seedJob(c, {
      name: 'Mix',
      n: 9,
      assignedUserId: null,
      nextStep: 'Call Mix',
      conversations: [
        { outcome: 'transferred', at: new Date(NOW.getTime() - 40 * 86_400_000) },
        { outcome: 'message', at: recent },
      ],
    });
    const rows = await list(c);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'message' });
    expect(rows[0]!.since.toISOString()).toBe(recent.toISOString());
  });

  test('rows are oldest first', async () => {
    const c = seed.a;
    const newer = await seedJob(c, { name: 'Fay', n: 6, assignedUserId: null, nextStep: 'Call Fay', conversations: [{ outcome: 'message', at: later }] });
    const older = await seedJob(c, { name: 'Gus', n: 7, assignedUserId: null, nextStep: 'Call Gus', conversations: [{ outcome: 'message', at: earlier }] });
    expect((await list(c)).map((r) => r.jobId)).toEqual([older, newer]);
  });

  test('a rep sees only follow-ups on jobs in their scope; the owner sees all', async () => {
    const c = seed.a;
    const mine = await seedJob(c, { name: 'Hal', n: 8, assignedUserId: c.rep.userId, nextStep: 'Call Hal', conversations: [{ outcome: 'message', at: earlier }] });
    await seedJob(c, { name: 'Ivy', n: 9, assignedUserId: c.otherRep.userId, nextStep: 'Call Ivy', conversations: [{ outcome: 'message', at: later }] });
    expect((await list(c, repCtx(c))).map((r) => r.jobId)).toEqual([mine]);
    expect(await list(c)).toHaveLength(2);
    expect(await count(c, repCtx(c))).toBe(1);
  });

  test('company B follow-ups never appear for company A', async () => {
    await seedJob(seed.b, { name: 'Jo', n: 10, assignedUserId: null, nextStep: 'Call Jo', conversations: [{ outcome: 'message', at: later }] });
    expect(await list(seed.a)).toEqual([]);
    expect(await count(seed.a)).toBe(0);
    expect(await count(seed.b)).toBe(1);
  });

  test('the count equals the length of the list', async () => {
    const c = seed.a;
    await seedJob(c, { name: 'Kit', n: 11, assignedUserId: null, nextStep: 'Call Kit', conversations: [{ outcome: 'message', at: earlier }] });
    await seedJob(c, { name: 'Lee', n: 12, assignedUserId: c.rep.userId, nextStep: 'Call Lee', conversations: [{ outcome: 'transferred', at: later }] });
    await seedJob(c, { name: 'Max', n: 13, assignedUserId: null, nextStep: null, conversations: [{ outcome: 'message', at: later }] });
    expect(await count(c)).toBe((await list(c)).length);
    expect(await count(c)).toBe(2);
  });
});
