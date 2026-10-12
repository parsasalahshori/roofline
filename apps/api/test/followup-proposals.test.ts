import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  agentSettings,
  agentTasks,
  companies,
  companySettings,
  customers,
  followUpLog,
  jobs,
  measurements,
  messages,
  properties,
  proposalOptions,
  proposals,
} from '@roofline/db';
import { pickTwoSlots } from '../src/agents/followup/draft.ts';
import { runFollowUps } from '../src/agents/followup/daily.ts';
import { DEFAULT_WORK_HOURS } from '@roofline/shared';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { dbSteps } from './task-helpers.ts';

let t: TestApp;

const DAY = 86_400_000;
/** Tuesday 13 October 2026, 9:00 AM in Chicago (CDT). */
const NINE_AM = new Date('2026-10-13T14:00:00.000Z');
const META = { attempt: 1, lastAttempt: false };
const USAGE = { model: 'scripted', inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, totalMs: 1 };
const GOOD = 'Hi Pat, just checking in on your roof proposal. Any questions for us?';

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NINE_AM);
  await setAgent();
});

const companyId = () => t.seed.a.companyId;
const run = () => runFollowUps(t.deps, companyId(), META);

/** The follow_up agent row, unpaused (app_tenant has no DELETE; Ruling GX-E: a missing row means off). */
async function setAgent() {
  await inCompany(t, companyId(), async (tx) => {
    await tx
      .insert(agentSettings)
      .values({ companyId: companyId(), agent: 'follow_up', pausedAt: null })
      .onConflictDoUpdate({ target: [agentSettings.companyId, agentSettings.agent], set: { pausedAt: null } });
  });
}

async function setSettings(set: { followupProposals?: boolean; followupDays?: number[] }) {
  await inCompany(t, companyId(), (tx) =>
    tx
      .insert(companySettings)
      .values({ companyId: companyId(), ...set })
      .onConflictDoUpdate({ target: companySettings.companyId, set }),
  );
}

let seq = 0;

type Seed = {
  sentDaysAgo?: number;
  status?: (typeof proposals.$inferInsert)['status'];
  viewedDaysAgo?: number;
  stage?: 'lead' | 'proposal' | 'lost';
  createdDaysAgo?: number;
  nextStep?: string;
  withProposal?: boolean;
};

/** A customer, property and job, and (unless `withProposal` is false) a sent proposal with one option. */
async function seed(o: Seed = {}) {
  const now = t.clock.now();
  const n = ++seq;
  return inCompany(t, companyId(), async (tx) => {
    const [cust] = await tx
      .insert(customers)
      .values({
        companyId: companyId(),
        displayName: 'Pat Customer',
        firstName: 'Pat',
        phones: [{ e164: `+1402555${String(1000 + n)}`, label: 'mobile', primary: true }],
        smsConsentStatus: 'express',
      })
      .returning({ id: customers.id });
    const [prop] = await tx
      .insert(properties)
      .values({ companyId: companyId(), customerId: cust!.id, addressLine: `${n} Oak St`, city: 'Omaha', state: 'NE', zip: '68102', addressKey: `fp${n}` })
      .returning({ id: properties.id });
    const [job] = await tx
      .insert(jobs)
      .values({
        companyId: companyId(),
        customerId: cust!.id,
        propertyId: prop!.id,
        stage: o.stage ?? 'proposal',
        createdAt: new Date(now.getTime() - (o.createdDaysAgo ?? 20) * DAY),
        stageChangedAt: new Date(now.getTime() - (o.createdDaysAgo ?? 20) * DAY),
        nextStep: o.nextStep ?? null,
        ...(o.stage === 'lost' && { lostReason: 'Went elsewhere' }),
      })
      .returning({ id: jobs.id });
    let proposalId: string | null = null;
    if (o.withProposal !== false) {
      const [m] = await tx
        .insert(measurements)
        .values({ companyId: companyId(), propertyId: prop!.id, jobId: job!.id, kind: 'estimate', method: 'outline', surfaceSqFt: 2400, pitchX12: 6 })
        .returning({ id: measurements.id });
      const [p] = await tx
        .insert(proposals)
        .values({
          companyId: companyId(),
          jobId: job!.id,
          customerId: cust!.id,
          propertyId: prop!.id,
          measurementId: m!.id,
          number: `P-${String(n).padStart(4, '0')}`,
          status: o.status ?? 'sent',
          validUntil: '2026-12-31',
          linkTokenHash: randomBytes(32),
          linkTokenEncrypted: randomBytes(16),
          sentAt: new Date(now.getTime() - (o.sentDaysAgo ?? 3) * DAY),
          lastViewedAt: o.viewedDaysAgo === undefined ? null : new Date(now.getTime() - o.viewedDaysAgo * DAY),
          estimateBasis: 'estimate',
        })
        .returning({ id: proposals.id, number: proposals.number });
      proposalId = p!.id;
      await tx.insert(proposalOptions).values({
        companyId: companyId(),
        proposalId: p!.id,
        tier: 'good',
        position: 1,
        name: 'Good',
        scope: {},
        prices: {},
        addOns: [],
        calculation: {},
        totalCents: 1_100_000,
      });
    }
    return { customerId: cust!.id, jobId: job!.id, proposalId: proposalId!, number: `P-${String(n).padStart(4, '0')}` };
  });
}

const logProposal = (s: { customerId: string; jobId: string }, n: number, daysAgo: number, kind: 'proposal' | 'claims' = 'proposal', jobId: string | null = s.jobId) =>
  inCompany(t, companyId(), (tx) =>
    tx.insert(followUpLog).values({ companyId: companyId(), customerId: s.customerId, jobId, kind, n, messageId: null, at: new Date(NINE_AM.getTime() - daysAgo * DAY) }),
  );

const tasksOf = (kind: string) =>
  inCompany(t, companyId(), (tx) => tx.select().from(agentTasks).where(and(eq(agentTasks.agent, 'follow_up'), eq(agentTasks.kind, kind))));

const jobRow = (id: string) => inCompany(t, companyId(), async (tx) => (await tx.select().from(jobs).where(eq(jobs.id, id)))[0]!);

type Payload = { kind: string; purpose: string; dedupePrefix: string; messages: { customerId: string; jobId: string; body: string }[] };
const payloads = async (taskId: string) => (await dbSteps(t, 'a', taskId)).map((s) => s.payload as Payload);

function scriptGood(jobIds: string[]) {
  t.llm.scriptDraft({ texts: jobIds.map((jobId) => ({ jobId, body: GOOD })), refused: false, usage: USAGE });
}

describe('unsigned proposal follow-ups', () => {
  test('a proposal sent 3 days ago gets a text in the daily task', async () => {
    const s = await seed({ sentDaysAgo: 3 });
    scriptGood([s.jobId]);
    await run();

    const tasks = await tasksOf('follow_ups');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'Follow-ups for today (1)', mode: 'needs_approval' });
    expect(tasks[0]!.summary).toContain('1 proposal follow-up');
    const ps = await payloads(tasks[0]!.id);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ kind: 'proposal', purpose: 'informational', dedupePrefix: 'followup-proposal:2026-10-13' });
    expect(ps[0]!.messages).toEqual([{ customerId: s.customerId, jobId: s.jobId, body: GOOD }]);
    expect(t.llm.draftCalls[0]?.instruction).toBe('proposal_follow_up');
  });

  test('a proposal sent 2 days ago waits, unless it was viewed 2 days ago', async () => {
    const quiet = await seed({ sentDaysAgo: 2 });
    scriptGood([quiet.jobId]);
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);

    const viewed = await seed({ sentDaysAgo: 2, status: 'viewed', viewedDaysAgo: 2 });
    scriptGood([viewed.jobId]);
    await run();
    const tasks = await tasksOf('follow_ups');
    expect(tasks).toHaveLength(1);
    const ps = await payloads(tasks[0]!.id);
    expect(ps[0]!.messages.map((m) => m.jobId)).toEqual([viewed.jobId]);
  });

  test.each(['signed', 'declined', 'replaced', 'expired', 'draft', 'ready'] as const)('a %s proposal is never followed up', async (status) => {
    const s = await seed({ sentDaysAgo: 5, status });
    scriptGood([s.jobId]);
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);
    expect(await tasksOf('proposal_call_rep')).toHaveLength(0);
  });

  test('the second text goes 4 days after the first, not 3', async () => {
    const early = await seed({ sentDaysAgo: 10 });
    await logProposal(early, 1, 3);
    scriptGood([early.jobId]);
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);

    const due = await seed({ sentDaysAgo: 10 });
    await logProposal(due, 1, 4);
    scriptGood([due.jobId]);
    await run();
    const tasks = await tasksOf('follow_ups');
    expect(tasks).toHaveLength(1);
    expect((await payloads(tasks[0]!.id))[0]!.messages.map((m) => m.jobId)).toEqual([due.jobId]);
  });

  test('after two texts the rep is asked to call once, and no third text is sent', async () => {
    const s = await seed({ sentDaysAgo: 12 });
    await logProposal(s, 1, 8);
    await logProposal(s, 2, 4);
    await run();

    expect(await tasksOf('follow_ups')).toHaveLength(0);
    expect((await jobRow(s.jobId)).nextStep).toBe(`Call Pat Customer about proposal ${s.number}: two texts, no answer.`);
    expect((await jobRow(s.jobId)).nextStepOn).toBe('2026-10-13');
    const notes = await tasksOf('proposal_call_rep');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ subjectType: 'proposal', subjectId: s.proposalId, mode: 'live' });
    expect(notes[0]!.title).not.toContain('Pat');

    t.clock.set(new Date(NINE_AM.getTime() + DAY));
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);
    expect(await tasksOf('proposal_call_rep')).toHaveLength(1);
    expect(t.llm.draftCalls).toHaveLength(0);
  });

  test('a job with its own next step keeps it, and the ask is still recorded', async () => {
    const s = await seed({ sentDaysAgo: 12, nextStep: 'Measure the garage' });
    await logProposal(s, 1, 8);
    await logProposal(s, 2, 4);
    await run();
    expect((await jobRow(s.jobId)).nextStep).toBe('Measure the garage');
    expect(await tasksOf('proposal_call_rep')).toHaveLength(1);
  });

  test('a customer who texted yesterday is skipped', async () => {
    const s = await seed({ sentDaysAgo: 5 });
    await inCompany(t, companyId(), (tx) =>
      tx.insert(messages).values({
        companyId: companyId(),
        customerId: s.customerId,
        channel: 'sms',
        direction: 'in',
        body: 'Hello',
        status: 'received',
        createdAt: new Date(NINE_AM.getTime() - DAY),
        updatedAt: new Date(NINE_AM.getTime() - DAY),
      }),
    );
    scriptGood([s.jobId]);
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);
  });

  test('a claims text 2 days ago blocks the follow-up (spacing)', async () => {
    const s = await seed({ sentDaysAgo: 5 });
    await logProposal(s, 1, 2, 'claims', null);
    scriptGood([s.jobId]);
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);
  });

  test('an unavailable Llm gives the exact template and says so', async () => {
    const s = await seed({ sentDaysAgo: 3 });
    await run();
    const [co] = await inCompany(t, companyId(), (tx) => tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId())));
    const tasks = await tasksOf('follow_ups');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.summary).toContain('Written from a template');
    const body = (await payloads(tasks[0]!.id))[0]!.messages[0]!.body;
    expect(body).toBe(
      `Hi Pat, it's a member of our team at ${co!.name}. Just checking you got the roof proposal we sent. Happy to answer any questions — reply here or call us.`,
    );
    expect(s.jobId).toBeDefined();
  });

  test('followup_proposals off makes no proposal step, but a lead still gets its own', async () => {
    await setSettings({ followupProposals: false });
    const s = await seed({ sentDaysAgo: 5 });
    const lead = await seed({ stage: 'lead', createdDaysAgo: 2, withProposal: false });
    const [a, b] = pickTwoSlots({ workHours: DEFAULT_WORK_HOURS, busy: [], propertyId: null, timeZone: 'America/Chicago', now: NINE_AM })!;
    t.llm.scriptDraft({ texts: [{ jobId: lead.jobId, body: `Hi Pat, we can look at your roof ${a} or ${b}. Which works?` }], refused: false, usage: USAGE });
    await run();
    const tasks = await tasksOf('follow_ups');
    expect(tasks).toHaveLength(1);
    const ps = await payloads(tasks[0]!.id);
    expect(ps.map((p) => p.kind)).toEqual(['lead']);
    expect(tasks[0]!.title).toBe('Follow-ups for today (1)');
    expect(s.jobId).toBeDefined();
  });

  test('running twice on the same day makes one task', async () => {
    const s = await seed({ sentDaysAgo: 3 });
    scriptGood([s.jobId]);
    scriptGood([s.jobId]);
    await run();
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(1);
  });

  test('a lost job is skipped', async () => {
    const s = await seed({ sentDaysAgo: 5, stage: 'lost' });
    scriptGood([s.jobId]);
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);
  });

  test('a lead text and a proposal text make one task with two steps', async () => {
    const s = await seed({ sentDaysAgo: 3 });
    const lead = await seed({ stage: 'lead', createdDaysAgo: 2, withProposal: false });
    const [a, b] = pickTwoSlots({ workHours: DEFAULT_WORK_HOURS, busy: [], propertyId: null, timeZone: 'America/Chicago', now: NINE_AM })!;
    t.llm.scriptDraft({ texts: [{ jobId: lead.jobId, body: `Hi Pat, we can look at your roof ${a} or ${b}. Which works?` }], refused: false, usage: USAGE });
    scriptGood([s.jobId]);
    await run();

    const tasks = await tasksOf('follow_ups');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('Follow-ups for today (2)');
    const ps = await payloads(tasks[0]!.id);
    expect(ps.map((p) => p.kind)).toEqual(['lead', 'proposal']);
    expect(ps[0]).toMatchObject({ dedupePrefix: 'followup:2026-10-13' });
    expect(ps[1]).toMatchObject({ dedupePrefix: 'followup-proposal:2026-10-13' });
  });
});
