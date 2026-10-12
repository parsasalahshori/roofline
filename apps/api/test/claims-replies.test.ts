import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { agentTasks, claimEvents, claims, customers, followUpLog, jobs, messages, properties, setPaused, withTenant } from '@roofline/db';
import type { ClaimStatus } from '@roofline/shared';
import { onClaimsReply, runClaimsReply } from '../src/agents/claims/replies.ts';
import { LlmUnavailableError, type ClaimReplyFacts, type TurnUsage } from '../src/providers/llm.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { DAY, DAYTIME } from './sms-helpers.ts';
import { dbSteps } from './task-helpers.ts';

let t: TestApp;
let houses = 0;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  houses = 0;
  // Claims starts paused (Ruling GX-E): these tests are about a company with Claims on.
  const ctx = { companyId: t.seed.a.companyId, userId: null, role: 'system' as const, canApproveSpend: false };
  await withTenant(t.deps.pools, ctx, (tx) => setPaused(tx, ctx, 'claims', false, t.clock.now()));
});

const idOf = () => t.seed.a.companyId;
const USAGE: TurnUsage = { model: 'scripted', inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, totalMs: 2 };
const ago = (days: number) => new Date(DAYTIME.getTime() - days * DAY);
const extraction = (facts: ClaimReplyFacts) => ({ facts, usage: USAGE });

type CaseSpec = {
  status?: ClaimStatus;
  claimNumber?: string | null;
  insurer?: string | null;
  /** How many days ago the customer got a claims text; null for none. */
  claimsTextDaysAgo?: number | null;
  repUserId?: string | null;
};

/** A customer with a job and a claim, an optional claims follow-up log row, and an inbound text. */
async function replyCase(spec: CaseSpec = {}) {
  houses += 1;
  const companyId = idOf();
  const now = t.clock.now();
  return inCompany(t, companyId, async (tx) => {
    const [customer] = await tx
      .insert(customers)
      .values({
        companyId,
        displayName: `Customer ${houses}`,
        firstName: `Cust${houses}`,
        phones: [{ e164: `+1402555${String(2000 + houses)}`, label: 'mobile', primary: true }],
        smsConsentStatus: 'express',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: customers.id });
    const customerId = customer!.id;
    const [property] = await tx
      .insert(properties)
      .values({
        companyId,
        customerId,
        addressLine: `${200 + houses} Oak St`,
        city: 'Omaha',
        state: 'NE',
        zip: '68102',
        addressKey: `${200 + houses} oak st|68102`,
        timezone: 'America/Chicago',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: properties.id });
    const [job] = await tx
      .insert(jobs)
      .values({ companyId, customerId, propertyId: property!.id, assignedUserId: spec.repUserId ?? null, createdAt: now, updatedAt: now })
      .returning({ id: jobs.id });
    const jobId = job!.id;
    const [claim] = await tx
      .insert(claims)
      .values({
        companyId,
        jobId,
        status: spec.status ?? 'filed',
        claimNumber: spec.claimNumber ?? null,
        insurer: spec.insurer ?? null,
        statusChangedAt: ago(10),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: claims.id });
    if (spec.claimsTextDaysAgo !== null) {
      await tx.insert(followUpLog).values({
        companyId,
        customerId,
        jobId,
        kind: 'claims',
        n: 1,
        at: ago(spec.claimsTextDaysAgo ?? 2),
      });
    }
    const [message] = await tx
      .insert(messages)
      .values({
        companyId,
        customerId,
        channel: 'sms',
        direction: 'in',
        body: 'Thanks, here is the information you asked for.',
        status: 'received',
        fromE164: `+1402555${String(2000 + houses)}`,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: messages.id });
    return { customerId, jobId, claimId: claim!.id, messageId: message!.id };
  });
}

type Case = Awaited<ReturnType<typeof replyCase>>;

const hook = (c: Case) =>
  inCompany(t, idOf(), (tx) =>
    onClaimsReply(tx, t.deps, { companyId: idOf(), customerId: c.customerId, messageId: c.messageId, body: 'ignored', receivedAt: t.clock.now() }),
  );

const runJob = (c: Case) => runClaimsReply(t.deps, idOf(), c.messageId);
const claimRow = (c: Case) => inCompany(t, idOf(), async (tx) => (await tx.select().from(claims).where(eq(claims.id, c.claimId)))[0]!);
const claimsTasks = () =>
  inCompany(t, idOf(), (tx) => tx.select().from(agentTasks).where(eq(agentTasks.agent, 'claims')).orderBy(agentTasks.createdAt, agentTasks.id));
const outboundCount = () =>
  inCompany(t, idOf(), async (tx) => (await tx.select({ id: messages.id }).from(messages).where(eq(messages.direction, 'out'))).length);

describe('onClaimsReply (the hook)', () => {
  test('hook sends claims-reply job only when claims text within 7 days and open claim', async () => {
    const recent = await replyCase({ claimsTextDaysAgo: 2 });
    expect(await hook(recent)).toEqual({ consumed: false });
    expect(t.jobs.sent).toEqual([
      { name: 'claims-reply', data: { companyId: idOf(), messageId: recent.messageId }, singletonKey: recent.messageId, startAfter: 5 },
    ]);

    const old = await replyCase({ claimsTextDaysAgo: 8 });
    expect(await hook(old)).toEqual({ consumed: false });

    const closed = await replyCase({ claimsTextDaysAgo: 2, status: 'closed' });
    expect(await hook(closed)).toEqual({ consumed: false });

    const noText = await replyCase({ claimsTextDaysAgo: null });
    expect(await hook(noText)).toEqual({ consumed: false });

    // Only the first customer got a job.
    expect(t.jobs.sent).toHaveLength(1);
  });
});

describe('runClaimsReply (the job)', () => {
  test('job saves claim number and insurer, events by agent, and makes a live note task', async () => {
    const c = await replyCase({ status: 'filed' });
    t.llm.scriptExtraction(extraction({ claimNumber: '0451-22', insurer: 'Acme Mutual', decision: 'approved' }));

    await runJob(c);

    expect(await claimRow(c)).toMatchObject({ claimNumber: '0451-22', insurer: 'Acme Mutual', status: 'approved' });
    const events = await inCompany(t, idOf(), (tx) => tx.select().from(claimEvents).where(and(eq(claimEvents.claimId, c.claimId), eq(claimEvents.by, 'agent'))));
    expect(events.map((e) => [e.fromStatus, e.toStatus, e.byUserId])).toEqual([['filed', 'approved', null]]);

    const tasks = await claimsTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      kind: 'claims_reply_noted',
      mode: 'live',
      status: 'done',
      title: 'Claims noted claim number 0451-22',
      subjectType: 'message',
      subjectId: c.messageId,
    });
    expect((await dbSteps(t, 'a', tasks[0]!.id)).map((s) => [s.type, s.status])).toEqual([['demo_noop', 'done']]);

    // A rerun of the job for the same message adds nothing.
    t.llm.scriptExtraction(extraction({ claimNumber: '0451-22', insurer: 'Acme Mutual', decision: 'approved' }));
    await runJob(c);
    expect(await claimsTasks()).toHaveLength(1);
  });

  test('a fact the claim already has changes nothing', async () => {
    const c = await replyCase({ status: 'filed', claimNumber: '0451-22', insurer: 'Acme Mutual' });
    t.llm.scriptExtraction(extraction({ claimNumber: '0451-22', insurer: 'Acme Mutual' }));

    await runJob(c);

    expect(await claimsTasks()).toHaveLength(0);
  });

  test('decision approved moves status only when canMoveClaim allows', async () => {
    const filed = await replyCase({ status: 'filed' });
    t.llm.scriptExtraction(extraction({ decision: 'approved' }));
    await runJob(filed);
    expect((await claimRow(filed)).status).toBe('approved');
    expect((await claimsTasks()).map((task) => task.title)).toEqual(['Claims noted the claim was approved']);

    // not_filed cannot jump to approved: the status stays, and with nothing else to record there is no note.
    const notFiled = await replyCase({ status: 'not_filed' });
    t.llm.scriptExtraction(extraction({ decision: 'approved' }));
    await runJob(notFiled);
    expect((await claimRow(notFiled)).status).toBe('not_filed');
    expect(await claimsTasks()).toHaveLength(1);
  });

  test('adjusterAt drafts a needs-approval create_appointment task with 60 minute end and the rep as userId', async () => {
    const repId = t.seed.a.rep.userId;
    const withRep = await replyCase({ repUserId: repId });
    const visit = new Date(DAYTIME.getTime() + 2 * DAY);
    t.llm.scriptExtraction(extraction({ adjusterAt: visit.toISOString() }));

    await runJob(withRep);

    const tasks = (await claimsTasks()).sort((a, b) => a.kind.localeCompare(b.kind));
    expect(tasks.map((task) => [task.kind, task.mode, task.title])).toEqual([
      ['claims_adjuster_visit', 'needs_approval', 'Book the adjuster visit'],
      ['claims_reply_noted', 'live', 'Claims noted the adjuster visit'],
    ]);
    const draft = tasks[0]!;
    expect(draft.status).toBe('draft');
    const [step] = await dbSteps(t, 'a', draft.id);
    expect(step).toMatchObject({ type: 'create_appointment', approvalClass: 'internal', status: 'pending' });
    expect(step!.payload).toEqual({
      jobId: withRep.jobId,
      kind: 'adjuster',
      start: visit.toISOString(),
      end: new Date(visit.getTime() + 60 * 60 * 1000).toISOString(),
      userId: repId,
      note: "From the homeowner's text",
    });

    // A job with no rep falls back to the company owner.
    const noRep = await replyCase();
    t.llm.scriptExtraction(extraction({ adjusterAt: visit.toISOString() }));
    await runJob(noRep);
    const ownerTask = (await claimsTasks()).find((task) => task.kind === 'claims_adjuster_visit' && task.subjectId === noRep.messageId)!;
    const [ownerStep] = await dbSteps(t, 'a', ownerTask.id);
    expect(ownerStep!.payload).toMatchObject({ jobId: noRep.jobId, userId: t.seed.a.owner.userId });

    // A date in the past drafts nothing.
    const past = await replyCase();
    t.llm.scriptExtraction(extraction({ adjusterAt: ago(1).toISOString() }));
    await runJob(past);
    expect((await claimsTasks()).filter((task) => task.subjectId === past.messageId)).toHaveLength(0);
  });

  test('unavailable extraction (ScriptedLlm throws LlmUnavailableError) changes nothing', async () => {
    const c = await replyCase({ status: 'filed' });
    t.llm.scriptExtraction(new LlmUnavailableError('down'));

    await runJob(c);

    expect(await claimRow(c)).toMatchObject({ status: 'filed', claimNumber: null, insurer: null });
    expect(await claimsTasks()).toHaveLength(0);
  });

  test('empty facts change nothing and make no task', async () => {
    const c = await replyCase({ status: 'filed' });
    t.llm.scriptExtraction(extraction({}));

    await runJob(c);

    expect(await claimRow(c)).toMatchObject({ status: 'filed', claimNumber: null, insurer: null });
    expect(await claimsTasks()).toHaveLength(0);
  });

  test('no text is sent by the job', async () => {
    const c = await replyCase({ status: 'filed' });
    t.llm.scriptExtraction(extraction({ claimNumber: '0451-22', adjusterAt: new Date(DAYTIME.getTime() + 2 * DAY).toISOString() }));

    // The whole path: the hook sends the job and the queue runs it.
    expect(await hook(c)).toEqual({ consumed: false });
    await t.jobs.drain(t.deps);

    expect(await claimRow(c)).toMatchObject({ claimNumber: '0451-22' });
    expect(t.sms.sent).toHaveLength(0);
    expect(await outboundCount()).toBe(0);
    expect(t.jobs.errors).toEqual([]);
  });
});
