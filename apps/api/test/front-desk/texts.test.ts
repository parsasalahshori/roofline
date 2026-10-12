import { and, asc, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  activities,
  appointments,
  blockNumber,
  companies,
  companyPhoneNumbers,
  companySettings,
  conversations,
  customers,
  encrypt,
  insertTurn,
  listTurns,
  messages,
  textingRegistrations,
  type Tx,
  withTenant,
} from '@roofline/db';
import { TEXT_CHANNEL_TOOLS } from '@roofline/shared';
import { createEngine } from '../../src/front-desk/engine.ts';
import type { Engine } from '../../src/front-desk/engine-types.ts';
import { queueFrontDeskText, runFrontDeskText, SMS_HANDOFF_REPLY, SMS_MAX_AI_TURNS, TEXT_HANDOFF_SUBJECT } from '../../src/front-desk/texts.ts';
import { findInspectionTimes } from '../../src/front-desk/tools/times.ts';
import { newConversationState } from '../../src/front-desk/state.ts';
import { NOTHING_TO_CONFIRM } from '../../src/front-desk/tools/confirm.ts';
import { VERIFY_LOCKED } from '../../src/front-desk/tools/caller.ts';
import { ScriptedLlm } from '../../src/providers/fakes/scripted-llm.ts';
import type { RouteDecision } from '../../src/providers/llm.ts';
import { inCompany } from '../crm-helpers.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from '../helpers.ts';
import { addSmsCustomers, DAYTIME, HOUR, MINUTE } from '../sms-helpers.ts';

/*
 * D1 Task 14: the text channel. Inbound texts arrive through the real /hooks/twilio/sms route (signed
 * the way Twilio signs them); the debounced `fd-text` job is drained by hand (InlineJobs ignores the
 * delay). The model is a ScriptedLlm and the provider a FakeSmsAdapter: nothing leaves the process.
 */

let t: TestApp;

const A_NUMBER = '+14025550100';
const NINA = '+14025550101';
const TOKEN = 'test-subaccount-token-a';
const BASE = 'https://app.roofline.test';
const SMS = '/hooks/twilio/sms';
const OPUS: RouteDecision = { intent: 'other', urgent: false, mood: 'calm', route: 'opus', fastReply: null };
/** 23:00 on Tuesday 13 October 2026 in Chicago (CDT, UTC-5): inside quiet hours. */
const NIGHT = new Date('2026-10-14T04:00:00.000Z');

const idA = () => t.seed.a.companyId;

let sidCounter = 0;
const nextSid = () => `SM${(sidCounter += 1).toString(16).padStart(32, '0')}`;

async function setup(script: ConstructorParameters<typeof ScriptedLlm>[0] = [{ when: /./, route: OPUS, answer: [{ kind: 'text', text: 'We can help with that.' }] }]) {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  const llm = new ScriptedLlm(script);
  (t.deps as unknown as { llm: ScriptedLlm }).llm = llm;
  await t.deps.pools.system
    .insert(companyPhoneNumbers)
    .values({ companyId: idA(), e164: A_NUMBER, capabilities: ['sms'], providerSid: 'PN_A' });
  await t.deps.pools.system
    .update(textingRegistrations)
    .set({ subaccountAuthTokenEncrypted: encrypt(TOKEN, TEST_ENCRYPTION_KEY) })
    .where(eq(textingRegistrations.companyId, idA()));
  await setFrontDesk({ frontDeskEnabled: true, frontDeskTexts: true });
  return llm;
}

async function setFrontDesk(values: {
  frontDeskEnabled: boolean;
  frontDeskTexts: boolean;
  frontDeskCanMove?: boolean;
  frontDeskCanCancel?: boolean;
}) {
  const ctx = { companyId: idA(), userId: null, role: 'system' as const, canApproveSpend: false };
  await withTenant(t.deps.pools, ctx, (tx) =>
    tx
      .insert(companySettings)
      .values({ companyId: idA(), ...values })
      .onConflictDoUpdate({ target: companySettings.companyId, set: values }),
  );
}

/** POSTs an inbound text from Nina to A's number, signed as Twilio would. */
async function inboundText(body: string, from = NINA) {
  const fields = { MessageSid: nextSid(), AccountSid: `AC${'0'.repeat(32)}`, From: from, To: A_NUMBER, Body: body, NumMedia: '0' };
  const signature = twilio.getExpectedTwilioSignature(TOKEN, BASE + SMS, fields);
  const res = await request(t.app).post(SMS).type('form').set('X-Twilio-Signature', signature).send(fields);
  expect(res.status).toBe(200);
  // The conversation row's created_at is the database's clock; the thread limit reads it against the test clock, so a
  // brand-new conversation (one message) starts when its first text arrived.
  await inCompany(t, idA(), (tx: Tx) =>
    tx.execute(sql`update conversations c set created_at = (select min(m.created_at) from messages m where m.conversation_id = c.id)
      where (select count(*) from messages m where m.conversation_id = c.id) = 1`),
  );
}

const nina = (overrides = {}) => ({ firstName: 'Nina', phone: NINA, consent: 'express' as const, ...overrides });

const outbound = () =>
  inCompany(t, idA(), (tx: Tx) =>
    tx.select().from(messages).where(eq(messages.direction, 'out')).orderBy(asc(messages.createdAt), asc(messages.id)),
  );
const conversationRows = () => inCompany(t, idA(), (tx: Tx) => tx.select().from(conversations));
const answerCalls = (llm: ScriptedLlm) => llm.calls.filter((c) => c.kind === 'answer');
const fdTextJobs = () => t.jobs.sent.filter((j) => j.name === 'fd-text');

/** Puts a person's (non-assistant) outbound text in the conversation, `ago` ms before now. */
async function teamReply(conversationId: string, customerId: string, ago: number) {
  await inCompany(t, idA(), (tx: Tx) =>
    tx.insert(messages).values({
      companyId: idA(),
      customerId,
      conversationId,
      channel: 'sms',
      direction: 'out',
      purpose: 'informational',
      body: 'Hi, this is Sam from the office.',
      status: 'sent',
      toE164: NINA,
      createdAt: new Date(t.clock.now().getTime() - ago),
      updatedAt: new Date(t.clock.now().getTime() - ago),
    }),
  );
}

const sysCtx = () => ({ companyId: idA(), userId: null, role: 'system' as const, canApproveSpend: false });
const storedTurns = (conversationId: string) => withTenant(t.deps.pools, sysCtx(), (tx) => listTurns(tx, sysCtx(), conversationId));
const drainAll = async () => {
  for (let i = 0; i < 3; i += 1) await t.jobs.drain(t.deps);
};
/** Makes the conversation look as if it started a minute ago. */
async function startedJustNow(conversationId: string) {
  await inCompany(t, idA(), (tx: Tx) =>
    tx.update(conversations).set({ createdAt: new Date(t.clock.now().getTime() - MINUTE) }).where(eq(conversations.id, conversationId)),
  );
}

describe('Front Desk texts', () => {
  let llm: ScriptedLlm;
  beforeEach(async () => {
    llm = await setup();
  });

  test('three quick texts produce one reply', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('Hi there');
    t.clock.advance(3_000);
    await inboundText('I think I have hail damage');
    t.clock.advance(3_000);
    await inboundText('Can someone come look?');
    await t.jobs.drain(t.deps);
    const out = await outbound();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ channel: 'sms', purpose: 'informational', status: 'sent', body: 'We can help with that.' });
    expect(t.sms.sent).toHaveLength(1);
    expect(answerCalls(llm)).toHaveLength(1);
  });

  const answerToolNames = () => {
    const call = llm.calls.find((c) => c.kind === 'answer');
    expect(call).toBeDefined();
    return ((call!.request as { tools?: (string | { name: string })[] }).tools ?? []).map((x) => (typeof x === 'string' ? x : x.name));
  };

  test('the text runner offers move and cancel when the settings allow them', async () => {
    await setFrontDesk({ frontDeskEnabled: true, frontDeskTexts: true, frontDeskCanMove: true, frontDeskCanCancel: true });
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('Hi there');
    await runFrontDeskText(t.deps, { companyId: idA(), conversationId: (await conversationRows())[0]!.id }, createEngine(t.deps, {}));
    const names = answerToolNames();
    expect(names).toContain('move_inspection');
    expect(names).toContain('cancel_inspection');
  });

  test('the text runner hides move and cancel when the settings turn them off', async () => {
    await setFrontDesk({ frontDeskEnabled: true, frontDeskTexts: true, frontDeskCanMove: false, frontDeskCanCancel: false });
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('Hi there');
    await runFrontDeskText(t.deps, { companyId: idA(), conversationId: (await conversationRows())[0]!.id }, createEngine(t.deps, {}));
    const names = answerToolNames();
    expect(names).not.toContain('move_inspection');
    expect(names).not.toContain('cancel_inspection');
  });

  /** An engine that lets a second text arrive just before the real turn runs; `quiet` makes the turn produce nothing. */
  function engineWithMidTurnText(quiet: boolean): Engine {
    const real = createEngine(t.deps, {});
    let injected = false;
    return {
      start: (i) => real.start(i),
      interrupted: (s, x) => real.interrupted(s, x),
      note: (s, n) => real.note(s, n),
      turn: async function* (state, text, signal) {
        if (!injected) {
          injected = true;
          t.clock.advance(MINUTE);
          await inboundText('Second question');
          t.clock.advance(MINUTE);
        }
        if (!quiet) yield* real.turn(state, text, signal);
      },
    };
  }

  test('a text that arrives mid-turn with nothing stored is requeued and answered once for both texts', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('First question');
    t.jobs.sent.length = 0;
    await runFrontDeskText(t.deps, { companyId: idA(), conversationId: (await conversationRows())[0]!.id }, engineWithMidTurnText(true));
    expect(t.sms.sent).toHaveLength(0);
    await t.jobs.drain(t.deps);
    expect(t.sms.sent).toHaveLength(1);
    const calls = answerCalls(llm);
    const prompt = JSON.stringify(calls[calls.length - 1]!.request);
    expect(prompt).toContain('First question');
    expect(prompt).toContain('Second question');
  });

  test('a text that arrives mid-turn after an assistant turn was stored still sends the first reply and queues the second', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('First question');
    t.jobs.sent.length = 0;
    const conversationId = (await conversationRows())[0]!.id;
    await runFrontDeskText(t.deps, { companyId: idA(), conversationId }, engineWithMidTurnText(false));
    // The first reply is not dropped, and a job is queued for the newer text.
    expect(t.sms.sent).toHaveLength(1);
    expect(fdTextJobs().length).toBeGreaterThan(0);
    const unanswered = await withTenant(t.deps.pools, sysCtx(), async (tx) => {
      const { listUnansweredInbound } = await import('@roofline/db');
      return listUnansweredInbound(tx, sysCtx(), conversationId);
    });
    expect(unanswered.map((u) => u.body)).toEqual(['Second question']);
    await t.jobs.drain(t.deps);
    expect(t.sms.sent).toHaveLength(2);
    expect((await storedTurns(conversationId)).map((x) => x.speaker)).toEqual(['caller', 'assistant', 'caller', 'assistant']);
  });

  test('three SMS exchanges store 6 turns at positions 0..5', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    for (const text of ['One', 'Two', 'Three']) {
      await inboundText(text);
      t.clock.advance(MINUTE);
      await t.jobs.drain(t.deps);
      t.clock.advance(MINUTE);
    }
    const turns = await storedTurns((await conversationRows())[0]!.id);
    expect(turns.map((x) => x.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(turns.map((x) => x.speaker)).toEqual(['caller', 'assistant', 'caller', 'assistant', 'caller', 'assistant']);
  });

  test('the engine sees earlier turns on the second exchange', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('First question');
    t.clock.advance(MINUTE);
    await t.jobs.drain(t.deps);
    t.clock.advance(MINUTE);
    await inboundText('Second question');
    t.clock.advance(MINUTE);
    await t.jobs.drain(t.deps);
    const calls = answerCalls(llm);
    expect(calls).toHaveLength(2);
    const history = (calls[1]!.request as { history: { role: string }[] }).history;
    expect(history.map((h) => h.role)).toEqual(['user', 'assistant', 'user']);
  });

  /** Gives the conversation `exchanges` stored caller/assistant turn pairs. */
  async function storeExchanges(conversationId: string, exchanges: number) {
    await withTenant(t.deps.pools, sysCtx(), async (tx) => {
      for (let i = 0; i < exchanges; i += 1) {
        await insertTurn(tx, sysCtx(), { conversationId, speaker: 'caller', text: `Question ${i}` });
        await insertTurn(tx, sysCtx(), { conversationId, speaker: 'assistant', text: `Answer ${i}` });
      }
    });
  }

  test('turnLimit trips for SMS', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('Hello');
    const conversationId = (await conversationRows())[0]!.id;
    await storeExchanges(conversationId, SMS_MAX_AI_TURNS);
    await t.jobs.drain(t.deps);
    expect(llm.calls).toHaveLength(0);
    expect(t.sms.sent).toHaveLength(0);
  });

  test('a thread under the cap still answers', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('Hello');
    const conversationId = (await conversationRows())[0]!.id;
    await storeExchanges(conversationId, SMS_MAX_AI_TURNS - 1);
    await t.jobs.drain(t.deps);
    expect(answerCalls(llm)).toHaveLength(1);
    expect(t.sms.sent).toHaveLength(1);
  });

  test('a blocked number gets no AI turn', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await withTenant(t.deps.pools, sysCtx(), (tx) => blockNumber(tx, sysCtx(), { e164: NINA, reason: null, blockedBy: null }));
    await inboundText('Hello');
    await t.jobs.drain(t.deps);
    expect(llm.calls).toHaveLength(0);
    expect(t.sms.sent).toHaveLength(0);
  });

  test('an unknown texter with no booking gets the reply and is linked to a new customer', async () => {
    await inboundText('Hello', '+14025550177');
    await t.jobs.drain(t.deps);
    expect(answerCalls(llm)).toHaveLength(1);
    const [row] = await conversationRows();
    const rows = await inCompany(t, idA(), (tx: Tx) => tx.select().from(customers));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.phones)).toContain('+14025550177');
    expect(rows[0]!.smsConsentStatus).toBe('express');
    expect(rows[0]!.smsConsentSource).toBe('text');
    expect(row).toMatchObject({ identity: 'unknown' });
    expect(row!.customerId).not.toBeNull();
    expect(row!.customerId).toBe(rows[0]!.id);
    expect(await storedTurns(row!.id)).toHaveLength(2);
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]).toMatchObject({ to: '+14025550177' });
  });

  test('an unknown texter who books gets the reply and the conversation is linked to the new customer', async () => {
    const UNKNOWN = '+14025550177';
    const book = {
      kind: 'tool' as const,
      name: 'book_inspection' as const,
      input: {
        slotStart: '',
        slotUserId: '',
        propertyId: null,
        address: '123 Elm St, Omaha, NE 68102',
        firstName: 'Rita',
        lastName: 'Gomez',
        notes: 'Leak over the garage',
      },
    };
    const find = {
      kind: 'tool' as const,
      name: 'find_inspection_times' as const,
      input: { propertyId: null, address: '123 Elm St, Omaha, NE 68102', fromDate: '2026-10-14', partOfDay: 'morning' as const },
    };
    llm = await setup([{ when: /book me/i, route: OPUS, answer: [find, book] }]);
    // The slot the tool will really offer first (the engine only books what it showed).
    const probe = newConversationState({ companyId: idA(), conversationId: 'probe', channel: 'sms', phone: UNKNOWN, callId: null, companyBlock: '', repName: null, startedAt: t.clock.now() });
    const offered = await findInspectionTimes({ deps: t.deps, companyId: idA(), conversation: probe, now: t.clock.now() }, find.input);
    const slot = /slotStart (\S+), slotUserId ([0-9a-f-]{36})/.exec(offered.forModel)!;
    book.input.slotStart = slot[1]!;
    book.input.slotUserId = slot[2]!;
    await inboundText('Please book me an inspection', UNKNOWN);
    await t.jobs.drain(t.deps);
    const rows = await inCompany(t, idA(), (tx: Tx) => tx.select().from(customers));
    expect(rows).toHaveLength(1);
    const [row] = await conversationRows();
    expect(row!.customerId).toBe(rows[0]!.id);
    // The booking's own confirmation text goes to the texter; it also counts as the answer to the inbound text, so the
    // engine's closing words are not sent on top of it.
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]).toMatchObject({ to: UNKNOWN });
    expect(t.sms.sent[0]!.body).toContain("You're booked");
  });

  test('a phone-matched texter ends up with identity matched in the row', async () => {
    const [customerId] = await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('Hello');
    await t.jobs.drain(t.deps);
    const [row] = await conversationRows();
    expect(row).toMatchObject({ identity: 'matched', customerId });
  });

  describe('an SMS handoff', () => {
    const badTake = (id: string) => ({ kind: 'tool' as const, name: 'take_message' as const, input: { banana: true }, id });
    async function onCall(): Promise<string[]> {
      const { owner, office } = t.seed.a;
      const q = t.deps.pools.system.$client;
      await q.query('update memberships set on_call_order = 0 where company_id = $1 and user_id = $2', [idA(), owner.userId]);
      await q.query('update memberships set on_call_order = 1 where company_id = $1 and user_id = $2', [idA(), office.userId]);
      return [owner.email, office.email];
    }

    test('an unknown texter handoff still texts the fixed copy and notifies the team', async () => {
      llm = await setup([{ when: /./, route: OPUS, answer: [badTake('b1'), badTake('b2')] }]);
      const emails = await onCall();
      await inboundText('Hello', '+14025550177');
      await t.jobs.drain(t.deps);
      expect(t.sms.sent).toHaveLength(1);
      expect(t.sms.sent[0]).toMatchObject({ to: '+14025550177' });
      expect(t.sms.sent[0]!.body).toContain(SMS_HANDOFF_REPLY);
      const [row] = await conversationRows();
      expect(row).toMatchObject({ handledBy: 'team' });
      expect(row!.customerId).not.toBeNull();
      expect(t.mailer.sent.map((m) => m.to).sort()).toEqual([...emails].sort());
      const acts = await inCompany(t, idA(), (tx: Tx) =>
        tx.select().from(activities).where(and(eq(activities.subjectId, row!.customerId!), eq(activities.kind, 'front_desk_message'))),
      );
      expect(acts).toHaveLength(1);
    });

    test('texts the fixed copy and notifies the team', async () => {
      llm = await setup([{ when: /./, route: OPUS, answer: [badTake('b1'), badTake('b2')] }]);
      const emails = await onCall();
      const [customerId] = await addSmsCustomers(t, 'a', [nina()]);
      await inboundText('Hello');
      await t.jobs.drain(t.deps);
      expect(t.sms.sent).toHaveLength(1);
      expect(t.sms.sent[0]!.body).toContain(SMS_HANDOFF_REPLY);
      const [row] = await conversationRows();
      expect(row).toMatchObject({ handledBy: 'team' });
      expect(t.mailer.sent.map((m) => m.to).sort()).toEqual([...emails].sort());
      expect(t.mailer.sent[0]!.subject).toBe(TEXT_HANDOFF_SUBJECT);
      const acts = await inCompany(t, idA(), (tx: Tx) =>
        tx.select().from(activities).where(and(eq(activities.subjectId, customerId!), eq(activities.kind, 'front_desk_message'))),
      );
      expect(acts).toHaveLength(1);
      // A later text is silent: the team has the conversation.
      t.clock.advance(MINUTE);
      await inboundText('Anyone?');
      await t.jobs.drain(t.deps);
      expect(t.sms.sent).toHaveLength(1);
      expect(t.mailer.sent).toHaveLength(emails.length);
    });

    test('keeps what the model said and still adds the fixed copy', async () => {
      llm = await setup([{ when: /./, route: OPUS, answer: [{ kind: 'text', text: 'Let me check on that.' }, badTake('b1'), badTake('b2')] }]);
      await addSmsCustomers(t, 'a', [nina()]);
      await inboundText('Hello');
      await t.jobs.drain(t.deps);
      expect(t.sms.sent).toHaveLength(1);
      expect(t.sms.sent[0]!.body).toBe(`Let me check on that. ${SMS_HANDOFF_REPLY}`);
    });
  });

  test('a 2-hour-old SMS thread still gets a reply, and the 41st AI turn does not', async () => {
    expect(SMS_MAX_AI_TURNS).toBe(40);
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('Hello');
    const conversationId = (await conversationRows())[0]!.id;
    await inCompany(t, idA(), (tx: Tx) =>
      tx.update(conversations).set({ createdAt: new Date(t.clock.now().getTime() - 2 * HOUR) }).where(eq(conversations.id, conversationId)),
    );
    await t.jobs.drain(t.deps);
    expect(t.sms.sent).toHaveLength(1);
    await storeExchanges(conversationId, SMS_MAX_AI_TURNS);
    t.clock.advance(MINUTE);
    const before = llm.calls.length;
    await inboundText('Again');
    await t.jobs.drain(t.deps);
    expect(llm.calls).toHaveLength(before);
    expect(t.sms.sent).toHaveLength(1);
  });

  test('unanswered texts are still joined with a newline into one caller turn', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('first');
    t.clock.advance(3_000);
    await inboundText('second');
    await t.jobs.drain(t.deps);
    const turns = await storedTurns((await conversationRows())[0]!.id);
    expect(turns[0]).toMatchObject({ speaker: 'caller', text: 'first\nsecond' });
  });

  test('a texter whose number matches exactly one customer is identified and answered', async () => {
    await addSmsCustomers(t, 'a', [nina({ phone: '+14025550177' })]);
    await inboundText('Anyone there?', '+14025550177');
    await t.jobs.drain(t.deps);
    expect(answerCalls(llm)).toHaveLength(1);
    expect(t.sms.sent).toHaveLength(1);
    const [row] = await conversationRows();
    expect(row).toMatchObject({ identity: 'matched' });
    expect(row!.customerId).not.toBeNull();
  });

  test('the reply is sent to the number that texted', async () => {
    const SECOND = '+14025550199';
    const [customerId] = await addSmsCustomers(t, 'a', [nina()]);
    await inCompany(t, idA(), (tx: Tx) =>
      tx
        .update(customers)
        .set({ phones: [{ e164: NINA, label: 'mobile', primary: true }, { e164: SECOND, label: 'work', primary: false }] })
        .where(eq(customers.id, customerId!)),
    );
    await inboundText('Hello', SECOND);
    await t.jobs.drain(t.deps);
    const [row] = await outbound();
    expect(row).toMatchObject({ toE164: SECOND });
    expect(t.sms.sent).toHaveLength(1);
  });

  test('identity and failure count survive the next text', async () => {
    const bad = { name: 'Nobody Here', street: '1 Nowhere Rd' };
    const tool = (id: string) => ({ kind: 'tool' as const, name: 'verify_caller' as const, input: bad, id });
    llm = await setup([
      { when: /first/i, route: OPUS, answer: [tool('v1'), tool('v2')] },
      { when: /second/i, route: OPUS, answer: [tool('v3'), tool('v4')] },
    ]);
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('first try');
    t.clock.advance(MINUTE);
    await drainAll();
    t.clock.advance(MINUTE);
    await inboundText('second try');
    t.clock.advance(MINUTE);
    await drainAll();
    // The third failure says so, the fourth hits the lock: the count of 2 came back from the stored turns.
    expect(JSON.stringify(llm.calls.filter((c) => c.kind === 'answer').map((c) => c.request))).toContain(JSON.stringify(VERIFY_LOCKED).slice(1, -1));
    const [row] = await conversationRows();
    expect(row).toMatchObject({ identity: 'matched' });
  });

  test('a team reply silences the assistant for 2 hours', async () => {
    const [customerId] = await addSmsCustomers(t, 'a', [nina()]);
    t.clock.set(new Date(DAYTIME.getTime() - HOUR));
    await inboundText('First question');
    const [conv] = await conversationRows();
    // The team texted 1h59m before the second inbound is handled.
    t.clock.set(DAYTIME);
    await teamReply(conv!.id, customerId!, HOUR + 59 * MINUTE);
    await inboundText('Second question');
    await t.jobs.drain(t.deps);
    expect(t.sms.sent).toHaveLength(0);
    expect(answerCalls(llm)).toHaveLength(0);
  });

  test('a team reply older than 2 hours does not silence it', async () => {
    const [customerId] = await addSmsCustomers(t, 'a', [nina()]);
    t.clock.set(new Date(DAYTIME.getTime() - 3 * HOUR));
    await inboundText('First question');
    const [conv] = await conversationRows();
    t.clock.set(DAYTIME);
    await startedJustNow(conv!.id);
    await teamReply(conv!.id, customerId!, 2 * HOUR + MINUTE);
    t.clock.advance(MINUTE);
    await inboundText('Second question');
    await t.jobs.drain(t.deps);
    expect(t.sms.sent).toHaveLength(1);
    expect(answerCalls(llm)).toHaveLength(1);
  });

  test('handled_by team is silent', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('Hello');
    const [conv] = await conversationRows();
    await inCompany(t, idA(), (tx: Tx) =>
      tx.update(conversations).set({ handledBy: 'team' }).where(and(eq(conversations.id, conv!.id))),
    );
    await t.jobs.drain(t.deps);
    expect(t.sms.sent).toHaveLength(0);
    expect(answerCalls(llm)).toHaveLength(0);
  });

  test('a team reply with handledBy team and a past teamUntil does not silence the assistant after 2 hours', async () => {
    const [customerId] = await addSmsCustomers(t, 'a', [nina()]);
    t.clock.set(new Date(DAYTIME.getTime() - 3 * HOUR));
    await inboundText('First question');
    const [conv] = await conversationRows();
    t.clock.set(DAYTIME);
    await startedJustNow(conv!.id);
    await teamReply(conv!.id, customerId!, 2 * HOUR + MINUTE);
    await inCompany(t, idA(), (tx: Tx) =>
      tx.update(conversations).set({ handledBy: 'team', teamUntil: new Date(DAYTIME.getTime() - HOUR) }).where(eq(conversations.id, conv!.id)),
    );
    t.clock.advance(MINUTE);
    await inboundText('Second question');
    await t.jobs.drain(t.deps);
    expect(t.sms.sent).toHaveLength(1);
    expect(answerCalls(llm)).toHaveLength(1);
  });

  test('STOP never reaches Front Desk', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('STOP');
    await t.jobs.drain(t.deps);
    expect(await conversationRows()).toEqual([]);
    expect(fdTextJobs()).toEqual([]);
    expect(t.sms.sent).toHaveLength(0);
  });

  test('a message marked consumed is not answered', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('Hello');
    const [conv] = await conversationRows();
    const [inbound] = await inCompany(t, idA(), (tx: Tx) =>
      tx.select({ id: messages.id }).from(messages).where(and(eq(messages.companyId, idA()), eq(messages.direction, 'in'))),
    );
    t.jobs.sent.length = 0;
    await withTenant(t.deps.pools, { companyId: idA(), userId: null, role: 'system', canApproveSpend: false }, (tx) =>
      queueFrontDeskText(tx, { id: inbound!.id, conversationId: conv!.id, companyId: idA() }, { jobs: t.jobs, consumed: true }),
    );
    expect(fdTextJobs()).toEqual([]);
  });

  test('queueFrontDeskText is idempotent per message', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('Hello');
    const [conv] = await conversationRows();
    const [inbound] = await inCompany(t, idA(), (tx: Tx) =>
      tx.select({ id: messages.id }).from(messages).where(and(eq(messages.companyId, idA()), eq(messages.direction, 'in'))),
    );
    const ctx = { companyId: idA(), userId: null, role: 'system' as const, canApproveSpend: false };
    const message = { id: inbound!.id, conversationId: conv!.id, companyId: idA() };
    await withTenant(t.deps.pools, ctx, async (tx) => {
      await queueFrontDeskText(tx, message, { jobs: t.jobs });
      await queueFrontDeskText(tx, message, { jobs: t.jobs });
    });
    await t.jobs.drain(t.deps);
    expect(t.sms.sent).toHaveLength(1);
    expect(answerCalls(llm)).toHaveLength(1);
    await withTenant(t.deps.pools, ctx, (tx) => queueFrontDeskText(tx, message, { jobs: t.jobs }));
    await t.jobs.drain(t.deps);
    expect(t.sms.sent).toHaveLength(1);
    expect(answerCalls(llm)).toHaveLength(1);
  });

  test('the reply goes through the gate as informational', async () => {
    const [customerId] = await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('Hello');
    await t.jobs.drain(t.deps);
    const [sent] = await outbound();
    expect(sent).toMatchObject({ purpose: 'informational', status: 'sent', customerId });
    expect(t.sms.sent).toHaveLength(1);
  });

  test('an opted-out customer gets a blocked reply and nothing is sent', async () => {
    await addSmsCustomers(t, 'a', [nina({ optedOut: true })]);
    await inboundText('Hello');
    await t.jobs.drain(t.deps);
    const [row] = await outbound();
    expect(row).toMatchObject({ purpose: 'informational', status: 'blocked' });
    expect(t.sms.sent).toHaveLength(0);
  });

  test.each(['trial_ended', 'canceled'] as const)('a read-only company (%s) gets no AI turn on an inbound text', async (status) => {
    await t.deps.pools.system.update(companies).set({ status }).where(eq(companies.id, idA()));
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('Hi there');
    await t.jobs.drain(t.deps);
    expect(fdTextJobs()).toHaveLength(0);
    expect(answerCalls(llm)).toHaveLength(0);
    expect(t.sms.sent).toHaveLength(0);
  });

  test('guard applied to texts', async () => {
    llm = await setup([{ when: /./, route: OPUS, answer: [{ kind: 'text', text: 'The repair will cost $500 total.' }] }]);
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('How much is a repair?');
    await t.jobs.drain(t.deps);
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]!.body).not.toMatch(/\$|500/);
  });

  test('a spam text gets no reply and ends the conversation', async () => {
    const spamRoute: RouteDecision = { intent: 'spam', urgent: false, mood: 'calm', route: 'end', fastReply: null };
    llm = await setup([{ when: /./, route: spamRoute }]);
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('Lower your business loan rate today, reply YES');
    await t.jobs.drain(t.deps);
    expect(t.sms.sent).toHaveLength(0);
    expect(await outbound()).toHaveLength(0);
    expect(await conversationRows()).toEqual([expect.objectContaining({ outcome: 'spam', status: 'ended' })]);
  });

  test('the C / confirm shortcut is answered by the confirm helper, not the engine', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('C');
    await t.jobs.drain(t.deps);
    // Nina has no upcoming visit, so the helper says so (the booking tests cover a real confirmation).
    expect(answerCalls(llm)).toHaveLength(0);
    expect(t.sms.sent).toHaveLength(1);
    expect((await outbound())[0]).toMatchObject({ body: NOTHING_TO_CONFIRM });
  });

  test('C confirms the next visit and the reply says which one', async () => {
    const [ninaId] = await addSmsCustomers(t, 'a', [nina()]);
    const startsAt = new Date(DAYTIME.getTime() + 24 * HOUR);
    await inCompany(t, idA(), (tx: Tx) =>
      tx.insert(appointments).values({
        companyId: idA(),
        kind: 'inspection',
        customerId: ninaId!,
        assignedUserId: t.seed.a.owner.userId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR),
        status: 'scheduled',
        source: 'front_desk',
      }),
    );
    await inboundText('confirm');
    await t.jobs.drain(t.deps);
    expect(answerCalls(llm)).toHaveLength(0);
    expect((await outbound())[0]).toMatchObject({ body: 'Thanks, your inspection on Wed Oct 14, 10:00 AM is confirmed.' });
    const rows = await inCompany(t, idA(), (tx: Tx) => tx.select().from(appointments));
    expect(rows[0]).toMatchObject({ confirmedVia: 'text' });
    expect(rows[0]!.confirmedAt).not.toBeNull();
  });

  test('a reply within 10 minutes of the customer text sends at 23:00 company time despite quiet hours', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    t.clock.set(NIGHT);
    await inboundText('Is anyone there?');
    t.clock.advance(5 * MINUTE);
    await t.jobs.drain(t.deps);
    const [row] = await outbound();
    expect(row).toMatchObject({ status: 'sent' });
    expect(t.sms.sent).toHaveLength(1);
  });

  test('the engine is offered TEXT_CHANNEL_TOOLS only', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('Hello');
    await runFrontDeskText(t.deps, { companyId: idA(), conversationId: (await conversationRows())[0]!.id }, createEngine(t.deps, {}));
    const [call] = answerCalls(llm);
    expect([...(call!.request as { tools: string[] }).tools].sort()).toEqual([...TEXT_CHANNEL_TOOLS].sort());
  });
});
