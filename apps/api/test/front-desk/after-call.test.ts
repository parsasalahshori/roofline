import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { beforeEach, describe, expect, inject, test } from 'vitest';
import {
  activities,
  calls,
  companyPhoneNumbers,
  companySettings,
  conversations,
  conversationTurns,
  customers,
  encrypt,
  findCallConversationId,
  lineLookups,
  listConversationInbox,
  messages,
  textingRegistrations,
  type ToolCallRecord,
  usageEvents,
} from '@roofline/db';
import { CONVERSATION_OUTCOMES, type ConversationOutcome } from '@roofline/shared';
import { createEngine } from '../../src/front-desk/engine.ts';
import { FRONT_DESK_HANDLERS } from '../../src/front-desk/tools/index.ts';
import { pickOutcome, runAfterCall } from '../../src/front-desk/after-call.ts';
import { dispatchDueMessages } from '../../src/jobs/scheduler/dispatch-messages.ts';
import { maybeTextBack, type TextBackInput, type TextBackResult } from '../../src/front-desk/text-back.ts';
import { ScriptedLlm } from '../../src/providers/fakes/scripted-llm.ts';
import { inCompany } from '../crm-helpers.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from '../helpers.ts';
import { DAY, DAYTIME } from '../sms-helpers.ts';

/*
 * D1 Task 13: after the call. The real runAfterCall and maybeTextBack run against the database, with a
 * ScriptedLlm, a FakeSmsAdapter and a FakeLineLookup: nothing leaves the process. Database-backed: CI runs it.
 */

let t: TestApp;
let llm: ScriptedLlm;

const A_NUMBER = '+14025550100';
const TOKEN = 'test-subaccount-token-a';
const TEST_CALLER = '+14025550123';
/** Numbers the fake line lookup calls mobile (+1555), landline (+1556) and voip (+1557). */
const MOBILE = '+15552010001';
const MOBILE_TWO = '+15552010002';
const LANDLINE = '+15562010001';
const VOIP = '+15572010001';
const OTHER_CALLER = '+14025550999';
const SUMMARY = 'Nina asked about hail damage and booked an inspection for Friday.';
const CALLER_WORDS = 'My roof leaks above the garage at 12 Elm Street';
/** 02:00 on Tuesday 13 October 2026 in Chicago (CDT, UTC-5): inside quiet hours. */
const QUIET_NIGHT = new Date('2026-10-13T07:00:00.000Z');
const BOOKING: ToolCallRecord = { name: 'book_inspection', input: {}, result: 'ok', ok: true };
const MESSAGE_TOOL: ToolCallRecord = { name: 'take_message', input: {}, result: 'ok', ok: true };

const idA = () => t.seed.a.companyId;

let sidCounter = 0;
const nextSid = (): string => `CA${String(++sidCounter).padStart(32, '0')}`;

beforeEach(async () => {
  t = await makeTestApp({ TWILIO_TEST_CALLER_NUMBER: TEST_CALLER });
  t.clock.set(DAYTIME);
  llm = new ScriptedLlm([], { summary: SUMMARY });
  (t.deps as unknown as { llm: ScriptedLlm }).llm = llm;
  await t.deps.pools.system
    .insert(companyPhoneNumbers)
    .values({ companyId: idA(), e164: A_NUMBER, capabilities: ['sms', 'voice'], providerSid: 'PN_A' });
  await t.deps.pools.system
    .update(textingRegistrations)
    .set({ subaccountAuthTokenEncrypted: encrypt(TOKEN, TEST_ENCRYPTION_KEY) })
    .where(eq(textingRegistrations.companyId, idA()));
  await setTextBack(true);
});

async function setTextBack(on: boolean) {
  await inCompany(t, idA(), (tx) =>
    tx
      .insert(companySettings)
      .values({ companyId: idA(), frontDeskEnabled: true, missedCallTextBack: on })
      .onConflictDoUpdate({ target: companySettings.companyId, set: { missedCallTextBack: on } }),
  );
}

type SeedCall = {
  from?: string;
  status?: 'ended' | 'failed' | 'transferred' | 'ringing';
  aiSeconds?: number;
  spamReason?: string | null;
  transcriptStored?: boolean;
  withConversation?: boolean;
  withCustomer?: boolean;
  /** Caller turns to store; each is one caller line. */
  turns?: string[];
  toolCalls?: ToolCallRecord[];
  startedAt?: Date;
  endedAt?: Date | null;
};

type Seeded = { callId: string; callSid: string; conversationId: string | null; customerId: string | null };

/** Seeds a call (and, by default, its conversation, turns and customer) of company A, as the relay would have left them. */
async function seedCall(o: SeedCall = {}): Promise<Seeded> {
  const from = o.from ?? OTHER_CALLER;
  const callSid = nextSid();
  const now = t.clock.now();
  return inCompany(t, idA(), async (tx) => {
    let customerId: string | null = null;
    if (o.withCustomer !== false && o.withConversation !== false) {
      const [c] = await tx
        .insert(customers)
        .values({ companyId: idA(), displayName: 'Nina Customer', firstName: 'Nina', phones: [{ e164: from, label: 'mobile', primary: true }] })
        .returning({ id: customers.id });
      customerId = c!.id;
    }
    let conversationId: string | null = null;
    if (o.withConversation !== false) {
      const [conv] = await tx
        .insert(conversations)
        .values({ companyId: idA(), channel: 'voice', customerId, phoneE164: from, companyNumberE164: A_NUMBER, status: 'active' })
        .returning({ id: conversations.id });
      conversationId = conv!.id;
    }
    const [call] = await tx
      .insert(calls)
      .values({
        companyId: idA(),
        callSid,
        fromE164: from,
        toE164: A_NUMBER,
        status: o.status ?? 'ended',
        conversationId,
        aiSeconds: o.aiSeconds ?? 0,
        spamReason: o.spamReason ?? null,
        transcriptStored: o.transcriptStored ?? false,
        startedAt: o.startedAt ?? now,
        endedAt: o.endedAt === undefined ? now : o.endedAt,
      })
      .returning({ id: calls.id });
    if (conversationId !== null) {
      const lines = o.turns ?? [];
      for (let i = 0; i < lines.length; i += 1) {
        await tx.insert(conversationTurns).values({
          companyId: idA(),
          conversationId,
          callId: call!.id,
          position: i * 2,
          speaker: 'caller',
          text: lines[i]!,
        });
        await tx.insert(conversationTurns).values({
          companyId: idA(),
          conversationId,
          callId: call!.id,
          position: i * 2 + 1,
          speaker: 'assistant',
          text: 'Thanks, one moment.',
          toolCalls: i === 0 && o.toolCalls !== undefined ? o.toolCalls : null,
        });
      }
    }
    return { callId: call!.id, callSid, conversationId, customerId };
  });
}

const run = (s: Seeded) => runAfterCall(t.deps, { companyId: idA(), callSid: s.callSid });

const ctxA = { companyId: '', userId: null, role: 'system' as const, canApproveSpend: false };
const tenantCtx = () => ({ ...ctxA, companyId: idA() });

const conversationOf = (id: string) =>
  inCompany(t, idA(), async (tx) => (await tx.select().from(conversations).where(eq(conversations.id, id)))[0]!);
const callOf = (id: string) => inCompany(t, idA(), async (tx) => (await tx.select().from(calls).where(eq(calls.id, id)))[0]!);
const usageRows = () => inCompany(t, idA(), (tx) => tx.select().from(usageEvents).where(eq(usageEvents.kind, 'ai_call_minute')));
const callActivities = () => inCompany(t, idA(), (tx) => tx.select().from(activities).where(eq(activities.kind, 'call')));
const outboundRows = () => inCompany(t, idA(), (tx) => tx.select().from(messages).where(eq(messages.direction, 'out')));
const summarizeCalls = () => llm.calls.filter((c) => c.kind === 'summarize');

describe('runAfterCall', () => {
  test('saves the summary on the conversation and closes it', async () => {
    const s = await seedCall({ aiSeconds: 90, transcriptStored: true, turns: [CALLER_WORDS, 'Friday works'], status: 'ended' });
    await run(s);
    const conv = await conversationOf(s.conversationId!);
    expect(conv.summary).toBe(SUMMARY);
    expect(conv.status).toBe('ended');
    expect(conv.outcome).toBe(CONVERSATION_OUTCOMES[0]);
    expect(summarizeCalls()).toHaveLength(1);
    expect((summarizeCalls()[0]!.request as { transcript: string }).transcript).toContain(CALLER_WORDS);
  });

  test('actions win over the model outcome when the job runs', async () => {
    // ScriptedLlm answers outcome "booked"; a take_message action must still decide "message".
    const s = await seedCall({ aiSeconds: 90, transcriptStored: true, turns: [CALLER_WORDS], toolCalls: [MESSAGE_TOOL] });
    await run(s);
    expect((await conversationOf(s.conversationId!)).outcome).toBe('message');
  });

  test('one usage event even if the job runs twice', async () => {
    const s = await seedCall({ aiSeconds: 61, turns: [CALLER_WORDS] });
    await run(s);
    await run(s);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'ai_call_minute', quantity: 2, refType: 'call', refId: s.callId });
    expect((await callOf(s.callId)).billedMinutes).toBe(2);
  });

  test('spam calls bill AI seconds only', async () => {
    const s = await seedCall({ aiSeconds: 30, spamReason: 'marked_by_team', turns: [CALLER_WORDS], transcriptStored: true });
    await run(s);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ quantity: 1, refId: s.callId });
    expect(summarizeCalls()).toHaveLength(0);
    expect((await conversationOf(s.conversationId!)).summary).toBeNull();
    expect(await callActivities()).toHaveLength(0);
    expect(await outboundRows()).toHaveLength(0);
    expect(t.sms.sent).toHaveLength(0);
  });

  test('forwarding-test calls are skipped', async () => {
    const s = await seedCall({ from: TEST_CALLER, withConversation: false, aiSeconds: 20, status: 'failed' });
    expect(s.conversationId).toBeNull();
    await run(s);
    expect(await usageRows()).toHaveLength(0);
    expect(await callActivities()).toHaveLength(0);
    expect(await outboundRows()).toHaveLength(0);
    expect(t.sms.sent).toHaveLength(0);
    expect(summarizeCalls()).toHaveLength(0);
    expect((await callOf(s.callId)).billedMinutes).toBe(0);
  });

  test('timeline card created', async () => {
    const s = await seedCall({ aiSeconds: 120, transcriptStored: true, turns: [CALLER_WORDS, 'Friday works'] });
    await run(s);
    await run(s);
    const rows = await inCompany(t, idA(), (tx) => tx.select().from(activities).where(eq(activities.subjectId, s.customerId!)));
    const cards = rows.filter((r) => r.kind === 'call');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ subjectType: 'customer', subjectId: s.customerId, kind: 'call' });
    expect((cards[0]!.data as { summary: string }).summary).toBe(SUMMARY);
  });

  test('no transcript stored: summary from actions only', async () => {
    const s = await seedCall({ aiSeconds: 90, transcriptStored: false, turns: [CALLER_WORDS], toolCalls: [BOOKING] });
    await run(s);
    const [call] = summarizeCalls();
    expect(summarizeCalls()).toHaveLength(1);
    const request = call!.request as { transcript: string; actions: string[] };
    expect(request.transcript).toBe('');
    expect(request.actions).toEqual(['book_inspection']);
    expect(JSON.stringify(call!.request)).not.toContain('leaks');
    expect((await conversationOf(s.conversationId!)).summary).toBe(SUMMARY);
    expect((await conversationOf(s.conversationId!)).outcome).toBe('booked');
  });

  test('the fd-after-call job does the same work from the queue', async () => {
    const s = await seedCall({ aiSeconds: 61, transcriptStored: true, turns: [CALLER_WORDS] });
    await t.jobs.send('fd-after-call', { companyId: idA(), callSid: s.callSid }, { singletonKey: `fd-after-call:${s.callSid}` });
    await t.jobs.drain(t.deps);
    expect(t.jobs.errors).toEqual([]);
    expect((await conversationOf(s.conversationId!)).summary).toBe(SUMMARY);
    expect(await usageRows()).toHaveLength(1);
  });

  test('a failed call with no conversation gets the missed-call text through the job', async () => {
    const s = await seedCall({
      from: MOBILE,
      withConversation: false,
      status: 'failed',
      aiSeconds: 0,
      startedAt: new Date(t.clock.now().getTime() - 40_000),
      endedAt: t.clock.now(),
    });
    await t.jobs.send('fd-after-call', { companyId: idA(), callSid: s.callSid }, { singletonKey: `fd-after-call:${s.callSid}` });
    await t.jobs.drain(t.deps);
    expect(t.jobs.errors).toEqual([]);
    expect(t.sms.sent).toHaveLength(1);
    expect((await callOf(s.callId)).textBackMessageId).not.toBeNull();
  });
});

describe('calls linked to conversations, finished calls only', () => {
  const convCount = () => inCompany(t, idA(), async (tx) => (await tx.select().from(conversations)).length);

  test('a voice call through engine.start, a booking tool, then after-call', async () => {
    const s = await seedCall({ withConversation: false, aiSeconds: 90, status: 'ended' });
    const engine = createEngine(t.deps, FRONT_DESK_HANDLERS);
    const first = await engine.start({ companyId: idA(), channel: 'voice', phone: OTHER_CALLER, callId: s.callId, companyNumber: A_NUMBER });
    const linked = await inCompany(t, idA(), (tx) => findCallConversationId(tx, tenantCtx(), s.callId));
    expect(linked).toBe(first.conversationId);
    expect((await callOf(s.callId)).conversationId).toBe(first.conversationId);
    const before = await convCount();
    const second = await engine.start({ companyId: idA(), channel: 'voice', phone: OTHER_CALLER, callId: s.callId, companyNumber: A_NUMBER });
    expect(second.conversationId).toBe(first.conversationId);
    expect(await convCount()).toBe(before);

    await inCompany(t, idA(), async (tx) => {
      await tx.insert(conversationTurns).values({
        companyId: idA(),
        conversationId: first.conversationId,
        callId: s.callId,
        position: 0,
        speaker: 'assistant',
        text: 'Booked.',
        toolCalls: [BOOKING],
      });
    });
    await run(s);
    const conv = await conversationOf(first.conversationId);
    expect(conv.status).toBe('ended');
    expect(conv.outcome).toBe('booked');
    expect(conv.summary).not.toBeNull();
  });

  test('a transferred call with no conversation gets outcome transferred', async () => {
    const s = await seedCall({ withConversation: false, status: 'transferred', aiSeconds: 30 });
    await run(s);
    expect((await callOf(s.callId)).status).toBe('transferred');
    expect(summarizeCalls()).toHaveLength(0);
    expect(t.sms.sent).toHaveLength(0);
    expect(await usageRows()).toHaveLength(1);
    expect(await convCount()).toBe(0);
  });

  test('the model-failure marker is written: a failing summary falls back to plain text', async () => {
    const s = await seedCall({ aiSeconds: 90, turns: [CALLER_WORDS], toolCalls: [BOOKING] });
    (t.deps.llm as unknown as { summarize: () => Promise<never> }).summarize = () => Promise.reject(new Error('model down'));
    await run(s);
    expect(await inCompany(t, idA(), (tx) => findCallConversationId(tx, tenantCtx(), s.callId))).toBe(s.conversationId);
    const conv = await conversationOf(s.conversationId!);
    expect(conv.summary).toBe('The caller booked an inspection.');
    expect(conv.outcome).toBe('booked');
  });

  test('after-call mid-transfer does nothing', async () => {
    const s = await seedCall({ status: 'ringing', aiSeconds: 60, turns: [CALLER_WORDS], transcriptStored: true });
    await inCompany(t, idA(), (tx) => tx.update(calls).set({ status: 'ringing_team' }).where(eq(calls.id, s.callId)));
    await run(s);
    expect(await usageRows()).toHaveLength(0);
    expect(await outboundRows()).toHaveLength(0);
    expect(t.sms.sent).toHaveLength(0);
    expect(summarizeCalls()).toHaveLength(0);
    expect((await conversationOf(s.conversationId!)).summary).toBeNull();
  });

  test('a terminal run records one ai_call_minute event for the total, even run twice', async () => {
    const s = await seedCall({ aiSeconds: 125, turns: [CALLER_WORDS] });
    await run(s);
    await run(s);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ quantity: Math.ceil(125 / 60), refId: s.callId });
  });
});

describe('pickOutcome', () => {
  test('outcome precedence: actions win over the model', () => {
    const order: [string, ConversationOutcome][] = [
      ['book_inspection', 'booked'],
      ['move_inspection', 'moved'],
      ['confirm_appointment', 'confirmed'],
      ['take_claim_details', 'claim'],
      ['transfer_to_person', 'transferred'],
      ['take_message', 'message'],
    ];
    for (const o of order) expect(CONVERSATION_OUTCOMES).toContain(o[1]);
    // Every action loses to the ones above it, in the order booked > moved > confirmed > claim > transferred > message.
    for (let i = 0; i < order.length; i += 1) {
      const rest = order.slice(i).map((o) => o[0]);
      expect(pickOutcome([...rest].reverse(), false, 'other')).toBe(order[i]![1]);
    }
    // A transfer that happened counts as "transferred" even without the tool.
    expect(pickOutcome([], true, 'other')).toBe('transferred');
    expect(pickOutcome(['take_message'], true, 'other')).toBe('transferred');
    // The model outcome loses to any action and is used only when there is none.
    expect(pickOutcome(['book_inspection'], false, 'message')).toBe('booked');
    expect(pickOutcome([], false, 'job_question')).toBe('job_question');
    expect(pickOutcome(['lookup_something_else'], false, 'abandoned')).toBe('abandoned');
  });
});

/** Seeds a call row for the number and asks for the missed-call text-back directly (the real gate runs). */
async function textBack(from: string, o: Partial<TextBackInput> = {}): Promise<{ result: TextBackResult; seeded: Seeded }> {
  const seeded = await seedCall({ from, withConversation: false });
  const result = await maybeTextBack(t.deps, tenantCtx(), {
    callId: seeded.callId,
    callSid: seeded.callSid,
    fromE164: from,
    toE164: A_NUMBER,
    conversationId: null,
    customerId: null,
    status: 'completed',
    callerTurns: 0,
    secondsInCall: 5,
    spam: false,
    ...o,
  });
  return { result, seeded };
}

describe('missed-call text-back through the gate', () => {
  test('a mobile caller who hung up before the first turn is texted back as informational with call consent', async () => {
    const { result, seeded } = await textBack(MOBILE);
    expect(result).toBe('sent');
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]).toMatchObject({ to: MOBILE });
    const out = await outboundRows();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ purpose: 'informational', dedupeKey: `fd-textback:${seeded.callId}`, toE164: MOBILE });
    const [customer] = await inCompany(t, idA(), (tx) =>
      tx.select().from(customers).where(and(eq(customers.companyId, idA()), eq(customers.displayName, MOBILE))),
    );
    expect(customer).toMatchObject({ smsConsentStatus: 'express', smsConsentSource: 'call' });
    expect((await callOf(seeded.callId)).textBackMessageId).toBe(out[0]!.id);
  });

  test.each([
    ['a landline', LANDLINE],
    ['a voip number', VOIP],
  ])('%s is skipped', async (_name, number) => {
    const { result } = await textBack(number);
    expect(result).toBe('skipped');
    expect(await outboundRows()).toHaveLength(0);
    expect(t.sms.sent).toHaveLength(0);
  });

  test('a spam call is skipped', async () => {
    const { result } = await textBack(MOBILE, { spam: true });
    expect(result).toBe('skipped');
    expect(await outboundRows()).toHaveLength(0);
    expect(t.sms.sent).toHaveLength(0);
  });

  test('the company setting off skips the text-back', async () => {
    await setTextBack(false);
    const { result } = await textBack(MOBILE);
    expect(result).toBe('skipped');
    expect(await outboundRows()).toHaveLength(0);
    expect(t.sms.sent).toHaveLength(0);
  });

  test('a second missed call from the same number within 24 hours is skipped', async () => {
    expect((await textBack(MOBILE)).result).toBe('sent');
    t.clock.advance(3 * 60 * 60 * 1000);
    expect((await textBack(MOBILE)).result).toBe('skipped');
    expect(t.sms.sent).toHaveLength(1);
    expect(await outboundRows()).toHaveLength(1);
  });

  test('a failed call of 40 seconds is texted back', async () => {
    const { result } = await textBack(MOBILE, { status: 'failed', callerTurns: 0, secondsInCall: 40 });
    expect(result).toBe('sent');
    expect(t.sms.sent).toHaveLength(1);
  });

  test('a completed call with 2 caller turns and 60 seconds is skipped', async () => {
    const { result } = await textBack(MOBILE, { status: 'completed', callerTurns: 2, secondsInCall: 60 });
    expect(result).toBe('skipped');
    expect(t.sms.sent).toHaveLength(0);
    expect(await outboundRows()).toHaveLength(0);
  });

  test('two text-backs at once for one new number: one customer, one text (the second waits, then sees the first)', async () => {
    const one = await seedCall({ from: MOBILE, withConversation: false });
    const two = await seedCall({ from: MOBILE, withConversation: false });
    const input = (s: Seeded): TextBackInput => ({
      callId: s.callId,
      callSid: s.callSid,
      fromE164: MOBILE,
      toE164: A_NUMBER,
      conversationId: null,
      customerId: null,
      status: 'completed',
      callerTurns: 0,
      secondsInCall: 5,
      spam: false,
    });
    // Hold the number's lock (the one customer saves take) so both jobs line up behind it.
    const holder = new pg.Client({ connectionString: inject('dbUrls').owner });
    await holder.connect();
    let waiting = 0;
    let results: TextBackResult[];
    try {
      await holder.query('begin');
      await holder.query(`select pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`, [idA(), MOBILE]);
      const both = Promise.all([maybeTextBack(t.deps, tenantCtx(), input(one)), maybeTextBack(t.deps, tenantCtx(), input(two))]);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { rows } = await holder.query<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted");
        waiting = rows[0]!.n;
        if (waiting >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await holder.query('commit');
      results = await both;
    } finally {
      await holder.end();
    }
    expect(waiting).toBe(2);
    expect([...results].sort()).toEqual(['sent', 'skipped']);
    const made = await inCompany(t, idA(), (tx) =>
      tx.select().from(customers).where(sql`${customers.phones} @> ${JSON.stringify([{ e164: MOBILE }])}::jsonb`),
    );
    expect(made).toHaveLength(1);
    expect(t.sms.sent).toHaveLength(1);
    expect(await outboundRows()).toHaveLength(1);
  });

  test('a known customer calling from their second number is texted back on that number', async () => {
    const [cust] = await inCompany(t, idA(), (tx) =>
      tx
        .insert(customers)
        .values({
          companyId: idA(),
          displayName: 'Nina Customer',
          firstName: 'Nina',
          phones: [
            { e164: MOBILE_TWO, label: 'mobile', primary: true },
            { e164: MOBILE, label: 'mobile' },
          ],
        })
        .returning({ id: customers.id }),
    );
    const { result } = await textBack(MOBILE, { customerId: cust!.id });
    expect(result).toBe('sent');
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]).toMatchObject({ to: MOBILE });
    const out = await outboundRows();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ customerId: cust!.id, toE164: MOBILE });
  });

  test('during quiet hours the text waits: scheduled, not sent', async () => {
    t.clock.set(QUIET_NIGHT);
    const { result } = await textBack(MOBILE);
    expect(result).toBe('scheduled');
    const out = await outboundRows();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: 'scheduled', purpose: 'informational' });
    expect(t.sms.sent).toHaveLength(0);
  });

  /** Nina, whose primary number is MOBILE_TWO, misses a call from her second number MOBILE at 02:00. */
  async function quietTextBackToSecondNumber() {
    const [cust] = await inCompany(t, idA(), (tx) =>
      tx
        .insert(customers)
        .values({
          companyId: idA(),
          displayName: 'Nina Customer',
          firstName: 'Nina',
          smsConsentStatus: 'express',
          smsConsentSource: 'call',
          phones: [
            { e164: MOBILE_TWO, label: 'mobile', primary: true },
            { e164: MOBILE, label: 'mobile' },
          ],
        })
        .returning({ id: customers.id }),
    );
    t.clock.set(QUIET_NIGHT);
    const { result } = await textBack(MOBILE, { customerId: cust!.id });
    expect(result).toBe('scheduled');
    const [row] = await outboundRows();
    expect(row).toMatchObject({ status: 'scheduled', customerId: cust!.id, toE164: MOBILE });
    expect(row!.scheduledFor).not.toBeNull();
    return { customerId: cust!.id, dueAt: new Date(row!.scheduledFor!.getTime() + 60_000) };
  }

  test('a quiet-hours text-back to the second number goes to that number when dispatched in the morning', async () => {
    const { dueAt } = await quietTextBackToSecondNumber();
    t.clock.set(dueAt);
    expect(await dispatchDueMessages(t.deps, t.clock.now())).toMatchObject({ sent: 1 });
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]).toMatchObject({ to: MOBILE });
    expect((await outboundRows())[0]).toMatchObject({ status: 'sent', toE164: MOBILE });
  });

  test('if that number left the customer overnight, the morning dispatch falls back to the primary number', async () => {
    const { customerId, dueAt } = await quietTextBackToSecondNumber();
    await inCompany(t, idA(), (tx) =>
      tx
        .update(customers)
        .set({ phones: [{ e164: MOBILE_TWO, label: 'mobile', primary: true }] })
        .where(eq(customers.id, customerId)),
    );
    t.clock.set(dueAt);
    expect(await dispatchDueMessages(t.deps, t.clock.now())).toMatchObject({ sent: 1 });
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]).toMatchObject({ to: MOBILE_TWO });
    expect((await outboundRows())[0]).toMatchObject({ status: 'sent', toE164: MOBILE_TWO });
  });
});

describe('line lookup cache', () => {
  test('lookup cached: two calls from the same mobile number look it up once', async () => {
    expect((await textBack(MOBILE)).result).toBe('sent');
    t.clock.advance(2 * DAY);
    expect((await textBack(MOBILE)).result).toBe('sent');
    expect(t.lineLookup.lookups.filter((n) => n === MOBILE)).toHaveLength(1);
    expect(t.sms.sent).toHaveLength(2);
    const rows = await t.deps.pools.system.select().from(lineLookups).where(eq(lineLookups.e164, MOBILE));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ e164: MOBILE, lineType: 'mobile' });
  });

  test('another number is looked up on its own', async () => {
    await textBack(MOBILE);
    await textBack(MOBILE_TWO);
    expect(t.lineLookup.lookups).toEqual([MOBILE, MOBILE_TWO]);
  });

  test('an unknown answer is not cached: the number is looked up again next time', async () => {
    expect((await textBack(OTHER_CALLER)).result).toBe('skipped');
    t.clock.advance(2 * DAY);
    expect((await textBack(OTHER_CALLER)).result).toBe('skipped');
    expect(t.lineLookup.lookups.filter((n) => n === OTHER_CALLER)).toHaveLength(2);
    const rows = await t.deps.pools.system.select().from(lineLookups).where(eq(lineLookups.e164, OTHER_CALLER));
    expect(rows).toHaveLength(0);
  });
});

describe('SMS conversation after-call', () => {
  async function seedSms(): Promise<{ conversationId: string; customerId: string }> {
    return inCompany(t, idA(), async (tx) => {
      const [c] = await tx
        .insert(customers)
        .values({ companyId: idA(), displayName: 'Sam Texter', firstName: 'Sam', phones: [{ e164: OTHER_CALLER, label: 'mobile', primary: true }] })
        .returning({ id: customers.id });
      const [conv] = await tx
        .insert(conversations)
        .values({ companyId: idA(), channel: 'sms', customerId: c!.id, phoneE164: OTHER_CALLER, companyNumberE164: A_NUMBER, status: 'active' })
        .returning({ id: conversations.id });
      const lines: [string, string][] = [['caller', CALLER_WORDS], ['assistant', 'Thanks, we will look at it.']];
      for (let i = 0; i < lines.length; i += 1) {
        await tx.insert(conversationTurns).values({
          companyId: idA(),
          conversationId: conv!.id,
          position: i,
          speaker: lines[i]![0] as 'caller' | 'assistant',
          text: lines[i]![1],
        });
      }
      return { conversationId: conv!.id, customerId: c!.id };
    });
  }
  const textActivities = () => inCompany(t, idA(), (tx) => tx.select().from(activities).where(eq(activities.kind, 'text_conversation')));
  const anyUsage = () => inCompany(t, idA(), (tx) => tx.select().from(usageEvents));

  test('summarizes, ends the conversation, logs one activity, and is idempotent', async () => {
    const s = await seedSms();
    await runAfterCall(t.deps, { companyId: idA(), conversationId: s.conversationId });
    const conv = await conversationOf(s.conversationId);
    expect(conv.status).toBe('ended');
    expect(conv.summary).toBe(SUMMARY);
    expect((summarizeCalls()[0]!.request as { transcript: string }).transcript).toContain(CALLER_WORDS);
    const acts = await textActivities();
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ subjectId: s.customerId });
    expect(await anyUsage()).toHaveLength(0);
    expect(await outboundRows()).toHaveLength(0);
    expect(t.sms.sent).toHaveLength(0);

    await runAfterCall(t.deps, { companyId: idA(), conversationId: s.conversationId });
    expect(await textActivities()).toHaveLength(1);
    expect(summarizeCalls()).toHaveLength(1);
  });
});

describe('voice needs attention', () => {
  test('a booked call leaves the conversation unread and listed under needs_attention', async () => {
    const s = await seedCall({ aiSeconds: 90, transcriptStored: true, turns: [CALLER_WORDS], toolCalls: [BOOKING] });
    await run(s);
    const conv = await conversationOf(s.conversationId!);
    expect(conv.unreadCount).toBeGreaterThanOrEqual(1);
    const page = await inCompany(t, idA(), (tx) =>
      listConversationInbox(tx, tenantCtx(), { onCall: true }, { filter: 'needs_attention', cursor: null }),
    );
    const item = page.items.find((i) => i.id === s.conversationId);
    expect(item).toBeDefined();
    expect(item!.needsAttention).toBe(true);
  });

  test('an other-outcome call stays read', async () => {
    (llm as unknown as { summarize: unknown }).summarize = async () => ({ summary: SUMMARY, outcome: 'other', followUps: [] });
    const s = await seedCall({ aiSeconds: 30, transcriptStored: true, turns: [CALLER_WORDS] });
    await run(s);
    const conv = await conversationOf(s.conversationId!);
    expect(conv.outcome).toBe('other');
    expect(conv.unreadCount).toBe(0);
  });
});
