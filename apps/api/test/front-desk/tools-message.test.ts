import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  activities,
  conversations,
  createCustomer,
  createJob,
  createProperty,
  insertTurn,
  jobs,
  type TenantContext,
  updateJob,
} from '@roofline/db';
import { localDate } from '@roofline/shared';
import { takeMessage } from '../../src/front-desk/tools/message.ts';
import type { ConversationState } from '../../src/front-desk/engine-types.ts';
import { inCompany } from '../crm-helpers.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';

/* D1 Task 9: take_message against the database. Database-backed: CI runs it. */

let t: TestApp;
const idA = () => t.seed.a.companyId;
const sys = (): TenantContext => ({ companyId: idA(), userId: null, role: 'system', canApproveSpend: false });

beforeEach(async () => {
  t = await makeTestApp();
});

const INPUT = { reason: 'Leak over the garage', urgent: false, callbackWhen: 'after 5pm', name: null };

async function customerWithJob(assignedUserId: string | null) {
  return inCompany(t, idA(), async (tx) => {
    const c = await createCustomer(tx, sys(), { displayName: 'Nina Test' }, { now: t.clock.now() });
    const p = await createProperty(
      tx,
      sys(),
      { customerId: c.id, addressLine: '12 Elm Street', city: 'Omaha', state: 'NE', zip: '68102' },
      { now: t.clock.now() },
    );
    const job = await createJob(tx, sys(), { customerId: c.id, propertyId: p.id }, { now: t.clock.now() });
    if (assignedUserId !== null) await updateJob(tx, sys(), job.id, { assignedUserId }, { now: t.clock.now() });
    return { customerId: c.id, jobId: job.id };
  });
}

async function makeConversation(customerId: string | null): Promise<ConversationState> {
  const conversationId = await inCompany(t, idA(), async (tx) => {
    const [row] = await tx
      .insert(conversations)
      .values({
        companyId: idA(),
        channel: 'voice',
        customerId,
        phoneE164: '+14025550777',
        companyNumberE164: '+14025550100',
        status: 'active',
      })
      .returning({ id: conversations.id });
    return row!.id;
  });
  return {
    companyId: idA(),
    conversationId,
    channel: 'voice',
    phone: '+14025550777',
    callId: null,
    identity: customerId === null ? 'unknown' : 'verified',
    customerId,
    shownIds: new Set<string>(),
    history: [],
    companyBlock: '',
    repName: null,
    startedAt: t.clock.now(),
    turns: 0,
    failedUnderstanding: 0,
    askedForPersonCount: 0,
    taskInProgress: false,
    nextPosition: 0,
    mode: 'normal',
    modelErrors: 0,
  } as ConversationState;
}

const run = (conversation: ConversationState, input = INPUT) =>
  takeMessage({ deps: t.deps, companyId: idA(), conversation, now: t.clock.now() }, input);

const getJobRow = (id: string) =>
  inCompany(t, idA(), async (tx) => (await tx.select().from(jobs).where(eq(jobs.id, id)))[0]!);

async function putOnCall(): Promise<string[]> {
  const { owner, office } = t.seed.a;
  const q = t.deps.pools.system.$client;
  await q.query('update memberships set on_call_order = 0 where company_id = $1 and user_id = $2', [idA(), owner.userId]);
  await q.query('update memberships set on_call_order = 1 where company_id = $1 and user_id = $2', [idA(), office.userId]);
  return [owner.email, office.email];
}

describe('take_message', () => {
  test("message sets the assigned rep's job next step due today and writes a front_desk_message activity with { conversationId, urgent, reason }", async () => {
    const { customerId, jobId } = await customerWithJob(t.seed.a.rep.userId);
    const conv = await makeConversation(customerId);
    const res = await run(conv);
    expect(res.ok).toBe(true);
    const job = await getJobRow(jobId);
    expect(job.assignedUserId).toBe(t.seed.a.rep.userId);
    expect(job.nextStep).toBe('Call back: Leak over the garage');
    expect(job.nextStepOn).toBe(localDate(t.clock.now(), 'America/Chicago'));
    const acts = await inCompany(t, idA(), (tx) =>
      tx.select().from(activities).where(and(eq(activities.subjectId, jobId), eq(activities.kind, 'front_desk_message'))),
    );
    expect(acts).toHaveLength(1);
    expect(acts[0]!.data).toEqual({ conversationId: conv.conversationId, urgent: false, reason: INPUT.reason });
  });

  test('a phone-matched caller does not change the job next step; the activity goes on the customer', async () => {
    const { customerId, jobId } = await customerWithJob(null);
    const conv = { ...(await makeConversation(customerId)), identity: 'matched' as const };
    const res = await run(conv);
    expect(res.ok).toBe(true);
    const job = await getJobRow(jobId);
    expect(job.nextStep).toBeNull();
    expect(job.nextStepOn).toBeNull();
    const onJob = await inCompany(t, idA(), (tx) =>
      tx.select().from(activities).where(and(eq(activities.subjectId, jobId), eq(activities.kind, 'front_desk_message'))),
    );
    expect(onJob).toHaveLength(0);
    const onCustomer = await inCompany(t, idA(), (tx) =>
      tx.select().from(activities).where(and(eq(activities.subjectId, customerId), eq(activities.kind, 'front_desk_message'))),
    );
    expect(onCustomer).toHaveLength(1);
    expect(onCustomer[0]!.subjectType).toBe('customer');
  });

  test('unassigned job keeps assignee null (office)', async () => {
    const { customerId, jobId } = await customerWithJob(null);
    await run(await makeConversation(customerId));
    const job = await getJobRow(jobId);
    expect(job.assignedUserId).toBeNull();
    expect(job.nextStep).toBe('Call back: Leak over the garage');
  });

  test('urgent message emails each on-call member once, a second urgent message in the same conversation sends none', async () => {
    const emails = await putOnCall();
    const { customerId } = await customerWithJob(null);
    const conv = await makeConversation(customerId);
    const urgent = { ...INPUT, urgent: true };
    await run(conv, urgent);
    expect(t.mailer.sent.map((m) => m.to).sort()).toEqual([...emails].sort());
    expect(t.mailer.sent[0]!.subject).toBe('Urgent message from Front Desk');
    const before = t.mailer.sent.length;
    await run(conv, urgent);
    expect(t.mailer.sent).toHaveLength(before);
  });

  test('non-urgent message sends no email', async () => {
    await putOnCall();
    const { customerId } = await customerWithJob(null);
    await run(await makeConversation(customerId));
    expect(t.mailer.sent).toHaveLength(0);
  });

  test('two urgent take_message calls in one conversation send one email', async () => {
    const emails = await putOnCall();
    const { customerId } = await customerWithJob(null);
    const conv = await makeConversation(customerId);
    const urgent = { ...INPUT, urgent: true };
    await run(conv, urgent);
    await run(conv, urgent);
    expect(t.mailer.sent.map((m) => m.to).sort()).toEqual([...emails].sort());
    expect(conv.urgentNoticeSent).toBe(true);
  });

  test('with no customer the state flag dedupes; a different conversation still emails', async () => {
    const emails = await putOnCall();
    const conv = await makeConversation(null);
    const urgent = { ...INPUT, urgent: true };
    await run(conv, urgent);
    await run(conv, urgent);
    expect(t.mailer.sent).toHaveLength(emails.length);
    expect(conv.urgentNoticeSent).toBe(true);
    const other = await makeConversation(null);
    await run(other, urgent);
    expect(t.mailer.sent).toHaveLength(emails.length * 2);
    expect(other.urgentNoticeSent).toBe(true);
  });

  test('two state objects over one conversation: the second sends nothing and sets its flag', async () => {
    const emails = await putOnCall();
    const { customerId } = await customerWithJob(null);
    const first = await makeConversation(customerId);
    const second = { ...first };
    const urgent = { ...INPUT, urgent: true };
    await run(first, urgent);
    await run(second, urgent);
    expect(t.mailer.sent).toHaveLength(emails.length);
    expect(second.urgentNoticeSent).toBe(true);
  });

  test('no customer, separate states (two texts or a second relay session): the earlier urgent turn dedupes', async () => {
    const emails = await putOnCall();
    const first = await makeConversation(null);
    const urgent = { ...INPUT, urgent: true };
    await run(first, urgent);
    // The engine stores the turn with the tool call it ran; the next text builds a fresh state.
    await inCompany(t, idA(), (tx) =>
      insertTurn(tx, sys(), {
        conversationId: first.conversationId,
        position: 0,
        speaker: 'assistant',
        text: 'I passed that on as urgent.',
        toolCalls: [{ name: 'take_message', input: urgent, result: 'ok', ok: true }],
        at: t.clock.now(),
      }),
    );
    const second: ConversationState = { ...first, urgentNoticeSent: undefined };
    await run(second, urgent);
    expect(t.mailer.sent).toHaveLength(emails.length);
    expect(second.urgentNoticeSent).toBe(true);
  });

  test('a non-urgent message never sets the flag and never emails', async () => {
    await putOnCall();
    const conv = await makeConversation(null);
    await run(conv);
    expect(conv.urgentNoticeSent).toBeUndefined();
    expect(t.mailer.sent).toHaveLength(0);
  });

  test('no job: conversation outcome is message and nothing throws', async () => {
    const conv = await makeConversation(null);
    const res = await run(conv);
    expect(res.ok).toBe(true);
    const [row] = await inCompany(t, idA(), (tx) =>
      tx.select().from(conversations).where(eq(conversations.id, conv.conversationId)),
    );
    expect(row!.outcome).toBe('message');
    expect(row!.summary).toBeNull();
  });

  test('the message text is in the activity, not in any summary', async () => {
    const { customerId } = await customerWithJob(null);
    const conv = await makeConversation(customerId);
    await run(conv);
    const [row] = await inCompany(t, idA(), (tx) =>
      tx.select().from(conversations).where(eq(conversations.id, conv.conversationId)),
    );
    expect(row!.summary).toBeNull();
    const acts = await inCompany(t, idA(), (tx) => tx.select().from(activities).where(eq(activities.kind, 'front_desk_message')));
    expect(JSON.stringify(acts.map((a) => a.data))).toContain(INPUT.reason);
  });
});
