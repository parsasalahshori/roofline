import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { describe, expect, test } from 'vitest';
import { companyPhoneNumbers, companySettings, conversations, conversationTurns, encrypt, insertCall, textingRegistrations, type Tx, withTenant } from '@roofline/db';
import { createEngine } from '../../src/front-desk/engine.ts';
import { SMS_PHOTO_ONLY } from '../../src/front-desk/texts.ts';
import { MAX_FAILURES, VERIFY_LOCKED, verifyCaller } from '../../src/front-desk/tools/caller.ts';
import type { EngineEvent } from '../../src/front-desk/engine-types.ts';
import { type Script, ScriptedLlm } from '../../src/providers/fakes/scripted-llm.ts';
import type { AnswerInput, LlmEvent, RouteDecision } from '../../src/providers/llm.ts';
import { inCompany } from '../crm-helpers.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from '../helpers.ts';
import { addSmsCustomers, DAYTIME, HOUR, MINUTE } from '../sms-helpers.ts';

/*
 * RC-1 review regression tests (each failed on d1-rc1 77dc775; written by the E1 lead's reviewer):
 * 1. an SMS thread older than 30 minutes is still answered;
 * 2. the "Team is handling" switch (teamUntil in the future, as POST /:id/handling sets it) silences the assistant;
 * 3. interrupt, interrupt before any speech, reply: no model request carries `system` followed by `user` (note 7);
 * 4. an unoffered transfer_to_person over SMS does not end the turn (F5): the model is told it is not available,
 *    answers again, and the texter gets a reply.
 */

const OPUS: RouteDecision = { intent: 'other', urgent: false, mood: 'calm', route: 'opus', fastReply: null };

// ---------- SMS rig (as in texts.test.ts) ----------

let t: TestApp;
const A_NUMBER = '+14025550100';
const NINA = '+14025550101';
const TOKEN = 'test-subaccount-token-a';
const BASE = 'https://app.roofline.test';
const SMS = '/hooks/twilio/sms';
const idA = () => t.seed.a.companyId;
let sidCounter = 0;
const nextSid = () => `SM${(sidCounter += 1).toString(16).padStart(32, '0')}`;

async function smsSetup(script: Script = [{ when: /./, route: OPUS, answer: [{ kind: 'text', text: 'We can help with that.' }] }]) {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  const llm = new ScriptedLlm(script);
  (t.deps as unknown as { llm: ScriptedLlm }).llm = llm;
  await t.deps.pools.system.insert(companyPhoneNumbers).values({ companyId: idA(), e164: A_NUMBER, capabilities: ['sms'], providerSid: 'PN_A' });
  await t.deps.pools.system
    .update(textingRegistrations)
    .set({ subaccountAuthTokenEncrypted: encrypt(TOKEN, TEST_ENCRYPTION_KEY) })
    .where(eq(textingRegistrations.companyId, idA()));
  const values = { frontDeskEnabled: true, frontDeskTexts: true };
  const ctx = { companyId: idA(), userId: null, role: 'system' as const, canApproveSpend: false };
  await withTenant(t.deps.pools, ctx, (tx) =>
    tx.insert(companySettings).values({ companyId: idA(), ...values }).onConflictDoUpdate({ target: companySettings.companyId, set: values }),
  );
  await addSmsCustomers(t, 'a', [{ firstName: 'Nina', phone: NINA, consent: 'express' as const }]);
  return llm;
}

/** POSTs an inbound text from Nina, signed as Twilio would; a brand-new conversation starts when its first text arrived. */
async function inboundText(body: string, media: Record<string, string> = { NumMedia: '0' }, from = NINA) {
  const fields = { MessageSid: nextSid(), AccountSid: `AC${'0'.repeat(32)}`, From: from, To: A_NUMBER, Body: body, ...media };
  const signature = twilio.getExpectedTwilioSignature(TOKEN, BASE + SMS, fields);
  const res = await request(t.app).post(SMS).type('form').set('X-Twilio-Signature', signature).send(fields);
  expect(res.status).toBe(200);
  await inCompany(t, idA(), (tx: Tx) =>
    tx.execute(sql`update conversations c set created_at = (select min(m.created_at) from messages m where m.conversation_id = c.id)
      where (select count(*) from messages m where m.conversation_id = c.id) = 1`),
  );
}

const conversationRows = () => inCompany(t, idA(), (tx: Tx) => tx.select().from(conversations));
const answerCalls = (llm: ScriptedLlm) => llm.calls.filter((c) => c.kind === 'answer');

// ---------- engine rig (as in engine.test.ts) ----------

/** Remembers the roles of the history of every answer call. */
class HistoryLlm extends ScriptedLlm {
  histories: string[][] = [];
  override answer(i: AnswerInput): AsyncIterable<LlmEvent> {
    this.histories.push(i.history.map((m) => m.role as string));
    return super.answer(i);
  }
}

describe('RC-1 review regressions', () => {
  test('an SMS thread is still answered 40 minutes after its first text', async () => {
    await smsSetup();
    await inboundText('First question');
    await t.jobs.drain(t.deps);
    expect(t.sms.sent).toHaveLength(1);
    t.clock.advance(40 * MINUTE);
    await inboundText('Second question');
    await t.jobs.drain(t.deps);
    expect(t.sms.sent).toHaveLength(2);
  });

  test('the "Team is handling" switch (teamUntil in the future) keeps the assistant quiet', async () => {
    const llm = await smsSetup();
    await inboundText('Hello');
    const [conv] = await conversationRows();
    // What POST /api/conversations/:id/handling { by: 'team' } writes: handled_by 'team', team_until now + 2 h.
    await inCompany(t, idA(), (tx: Tx) =>
      tx
        .update(conversations)
        .set({ handledBy: 'team', teamUntil: new Date(t.clock.now().getTime() + 2 * HOUR) })
        .where(eq(conversations.id, conv!.id)),
    );
    await t.jobs.drain(t.deps);
    expect(answerCalls(llm)).toHaveLength(0);
    expect(t.sms.sent).toHaveLength(0);
  });

  test('interrupt, interrupt before any speech, reply: no request has a system entry followed by a user entry', async () => {
    const app = await makeTestApp();
    const llm = new HistoryLlm([
      { when: /roof/, route: OPUS, answer: [{ kind: 'text', text: 'First sentence. ' }, { kind: 'text', text: 'Second sentence. ' }] },
      { when: /./, route: OPUS, answer: [{ kind: 'text', text: 'Okay.' }] },
    ]);
    const engine = createEngine({ ...app.deps, llm }, {});
    const state = await engine.start({ companyId: app.seed.a.companyId, channel: 'voice', phone: '+14025550123' });
    const drain = async (it: AsyncIterable<EngineEvent>, onSay?: () => void) => {
      for await (const e of it) if (e.type === 'say') onSay?.();
    };

    // 1. The caller cuts in after the first sentence: the assistant's partial words and an interrupt note are kept.
    const first = new AbortController();
    await drain(engine.turn(state, 'my roof leaks', first.signal), () => first.abort());
    // 2. The caller cuts in again before the assistant says anything.
    const second = new AbortController();
    second.abort();
    await drain(engine.turn(state, 'wait', second.signal));
    // 3. A normal reply.
    await drain(engine.turn(state, 'go on', new AbortController().signal));

    const bad = llm.histories.filter((h) => h.some((role, i) => role === 'system' && h[i + 1] === 'user')).map((h) => h.join(','));
    expect(bad).toEqual([]);
  });

  test('an unoffered transfer_to_person over SMS does not end the turn: the texter still gets a reply', async () => {
    const llm = await smsSetup([
      // After the tool result, ScriptedLlm answers its continuation text ('Done.').
      { when: /./, route: OPUS, answer: [{ kind: 'tool', name: 'transfer_to_person', input: { reason: 'asked', summary: 'Wants a person' }, id: 'tu1' }] },
    ]);
    await inboundText('Can I talk to someone?');
    await t.jobs.drain(t.deps);
    const [conv] = await conversationRows();
    expect({ handledBy: conv!.handledBy, answers: answerCalls(llm).length, sent: t.sms.sent.length }).toEqual({
      handledBy: 'assistant',
      answers: 2,
      sent: 1,
    });
  });
  test('a photo-only text is stored as the [photo] caller line, never an empty one', async () => {
    await smsSetup();
    await inboundText('', { NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM1/Media/ME1', MediaContentType0: 'image/jpeg' });
    await t.jobs.drain(t.deps);
    const turns = await inCompany(t, idA(), (tx: Tx) => tx.select().from(conversationTurns));
    const caller = turns.filter((r) => r.speaker === 'caller').map((r) => r.text);
    expect(caller).toEqual([SMS_PHOTO_ONLY]);
  });

  test('a number shared by two customers is never promoted to matched', async () => {
    await smsSetup();
    await addSmsCustomers(t, 'a', [{ firstName: 'Nate', phone: NINA, consent: 'express' as const }]);
    await inboundText('Hi there');
    await t.jobs.drain(t.deps);
    const [conv] = await conversationRows();
    expect(conv!.identity).toBe('unknown');
  });
  test('verify_caller failures in one relay segment lock the next segment of the same call, even with the transcript off', async () => {
    const app = await makeTestApp();
    const bad = { name: 'Nobody Here', street: '9 Elm St' };
    const llm = new ScriptedLlm([
      { when: /./, route: OPUS, answer: [{ kind: 'tool', name: 'verify_caller', input: bad, id: 'tv' }] },
    ]);
    const engine = createEngine({ ...app.deps, llm }, { verify_caller: verifyCaller });
    // A customer owns the number, so each wrong name and street is a real mismatch.
    await addSmsCustomers(app, 'a', [{ firstName: 'Nina', phone: '+14025550123', consent: 'express' as const }]);
    const ctx = { companyId: app.seed.a.companyId, userId: null, role: 'system' as const, canApproveSpend: false };
    const call = await withTenant(app.deps.pools, ctx, (tx) =>
      insertCall(tx, ctx, { callSid: 'CA' + 'd'.repeat(32), fromE164: '+14025550123', toE164: app.seed.a.phoneE164, forwardedFrom: null, stirVerstat: null, now: app.clock.now() }),
    );
    const start = () => engine.start({ companyId: app.seed.a.companyId, channel: 'voice', phone: '+14025550123', callId: call.id });
    const drain = async (it: AsyncIterable<EngineEvent>) => {
      for await (const e of it) void e;
    };

    const first = await start();
    // The caller objected to recording: stored tool calls keep only their name and outcome.
    first.transcriptOff = true;
    for (let i = 0; i < MAX_FAILURES; i++) await drain(engine.turn(first, `I am at 9 Elm St, try ${i}`, new AbortController().signal));
    expect(first.verifyFailures).toBe(MAX_FAILURES);

    const second = await start();
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.verifyFailures).toBe(MAX_FAILURES);
    const res = await verifyCaller({ deps: app.deps, companyId: second.companyId, conversation: second, now: app.clock.now() }, bad);
    expect(res).toEqual({ ok: false, forModel: VERIFY_LOCKED });
  });
});
