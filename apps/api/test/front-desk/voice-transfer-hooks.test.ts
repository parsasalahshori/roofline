import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { beforeEach, describe, expect, test } from 'vitest';
import { calls, companyPhoneNumbers, companySettings, encrypt, memberships, textingRegistrations, withTenant, type TenantContext } from '@roofline/db';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from '../helpers.ts';

/*
 * Task 10: the transfer hooks (after-relay, whisper, after-dial). Requests are signed the way Twilio
 * signs them, over the public URL including the query string.
 */

let t: TestApp;
const A_NUMBER = '+14025550200';
const B_NUMBER = '+14025550300';
const CALLER = '+14025550999';
const TEAM_1 = '+14025550111';
const TEAM_2 = '+14025550122';
const TOKEN_A = 'test-subaccount-token-a';
const TOKEN_B = 'test-subaccount-token-b';
const BASE = 'https://app.roofline.test';
const PREFIX = '/hooks/twilio/voice-transfer';
const CALL_SID = 'CA' + 'a'.repeat(32);
/** A Tuesday afternoon in every US time zone, and the small hours of the next day. */
const IN_HOURS = new Date('2026-10-13T18:00:00.000Z');
const AFTER_HOURS = new Date('2026-10-14T09:00:00.000Z');
const MESSAGE_GREETING = "Nobody could pick up right now. I'll take a message.";

const idOf = (company: 'a' | 'b') => t.seed[company].companyId;
const ctxOf = (c: 'a' | 'b'): TenantContext => ({ companyId: idOf(c), role: 'system', userId: null, canApproveSpend: false });

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(IN_HOURS);
  const { system } = t.deps.pools;
  await system.insert(companyPhoneNumbers).values([
    { companyId: idOf('a'), e164: A_NUMBER, capabilities: ['sms', 'voice'], providerSid: 'PN_A' },
    { companyId: idOf('b'), e164: B_NUMBER, capabilities: ['sms', 'voice'], providerSid: 'PN_B' },
  ]);
  for (const [company, token] of [['a', TOKEN_A], ['b', TOKEN_B]] as const) {
    await system
      .update(textingRegistrations)
      .set({ subaccountAuthTokenEncrypted: encrypt(token, TEST_ENCRYPTION_KEY) })
      .where(eq(textingRegistrations.companyId, idOf(company)));
  }
});

type Signing = { token?: string; signature?: string | null };

/** POSTs the form to `path` (query included), signed over the public URL like Twilio does. */
function post(path: string, fields: Record<string, string>, signing: Signing = {}) {
  const signature =
    signing.signature !== undefined ? signing.signature : twilio.getExpectedTwilioSignature(signing.token ?? TOKEN_A, BASE + path, fields);
  const req = request(t.app).post(path).type('form');
  if (signature !== null) req.set('X-Twilio-Signature', signature);
  return req.send(fields);
}

/** Gives Acme's owner and office a transfer phone and ring order (owner first). */
async function seedTeam(): Promise<void> {
  const { system } = t.deps.pools;
  await system
    .update(memberships)
    .set({ transferPhoneE164: TEAM_1, onCallOrder: 1 })
    .where(and(eq(memberships.companyId, idOf('a')), eq(memberships.userId, t.seed.a.owner.userId)));
  await system
    .update(memberships)
    .set({ transferPhoneE164: TEAM_2, onCallOrder: 2 })
    .where(and(eq(memberships.companyId, idOf('a')), eq(memberships.userId, t.seed.a.office.userId)));
}

/** A call of the company that is with the Front Desk. */
async function seedCall(company: 'a' | 'b' = 'a', status: 'ai' | 'ringing' = 'ai') {
  const [row] = await withTenant(t.deps.pools, ctxOf(company), (tx) =>
    tx
      .insert(calls)
      .values({
        companyId: idOf(company),
        callSid: CALL_SID,
        fromE164: CALLER,
        toE164: company === 'a' ? A_NUMBER : B_NUMBER,
        status,
      })
      .returning(),
  );
  return row!;
}

const callRow = async (company: 'a' | 'b' = 'a') =>
  (await withTenant(t.deps.pools, ctxOf(company), (tx) => tx.select().from(calls).where(eq(calls.callSid, CALL_SID))))[0]!;

const handoff = (kind: 'transfer' | 'end', reason = 'asked') => JSON.stringify({ kind, reason, summary: 'Roof is leaking.' });
const relayFields = (data: string | null, to = A_NUMBER): Record<string, string> => ({
  CallSid: CALL_SID,
  From: CALLER,
  To: to,
  ...(data === null ? {} : { HandoffData: data }),
});

describe('POST /hooks/twilio/voice-transfer/after-relay', () => {
  test('after-relay with a transfer in work hours dials every on-call member with a whisper URL', async () => {
    await seedTeam();
    const call = await seedCall();
    const res = await post(`${PREFIX}/after-relay`, relayFields(handoff('transfer')));
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Dial timeout="20"');
    expect(res.text).toContain(`${BASE}${PREFIX}/after-dial?mode=transfer`);
    expect(res.text).toMatch(new RegExp(`<Number url="[^"]*/voice-transfer/whisper\\?company=${idOf('a')}[^"]*">\\${TEAM_1}</Number>`));
    expect(res.text).toMatch(new RegExp(`<Number url="[^"]*/voice-transfer/whisper\\?company=${idOf('a')}[^"]*">\\${TEAM_2}</Number>`));
    expect(res.text).toContain(`call=${call.id}`);
    expect(res.text).not.toContain('rest=');
    expect((await callRow()).status).toBe('ringing_team');
  });

  test('after-relay urgent out of hours rings each member in turn', async () => {
    t.clock.set(AFTER_HOURS);
    await seedTeam();
    await seedCall();
    const res = await post(`${PREFIX}/after-relay`, relayFields(handoff('transfer', 'leak')));
    expect(res.status).toBe(200);
    expect(res.text).toContain(`>${TEAM_1}</Number>`);
    expect(res.text).not.toContain(TEAM_2);
    expect(res.text).toContain(`rest=${t.seed.a.office.userId}`);
    expect((await callRow()).status).toBe('ringing_team');
  });

  test('after-relay out of hours: an urgent person-ask rings on-call staff, a non-urgent one takes a message', async () => {
    t.clock.set(AFTER_HOURS);
    await seedTeam();
    await seedCall();
    const urgent = await post(`${PREFIX}/after-relay`, relayFields(JSON.stringify({ kind: 'transfer', reason: 'asked', urgent: true })));
    expect(urgent.status).toBe(200);
    expect(urgent.text).toContain('<Dial');
    expect(urgent.text).toContain(`>${TEAM_1}</Number>`);
    const calm = await post(`${PREFIX}/after-relay`, relayFields(JSON.stringify({ kind: 'transfer', reason: 'asked', urgent: false })));
    expect(calm.text).not.toContain('<Dial');
    expect(calm.text).toContain('name="mode" value="message_only"');
    const missing = await post(`${PREFIX}/after-relay`, relayFields(JSON.stringify({ kind: 'transfer', reason: 'asked' })));
    expect(missing.text).toContain('name="mode" value="message_only"');
    const stringy = await post(`${PREFIX}/after-relay`, relayFields(JSON.stringify({ kind: 'transfer', reason: 'asked', urgent: 'true' })));
    expect(stringy.text).toContain('name="mode" value="message_only"');
  });

  test('after-relay with no on-call members goes to message mode', async () => {
    await seedCall();
    const res = await post(`${PREFIX}/after-relay`, relayFields(handoff('transfer')));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<Dial');
    expect(res.text).toContain('<ConversationRelay');
    expect(res.text).toContain('name="mode" value="message_only"');
    expect(res.text).toContain(`welcomeGreeting="Nobody could pick up right now. I&apos;ll take a message."`);
  });

  test('after-relay end hangs up and ends the call', async () => {
    await seedTeam();
    await seedCall();
    const res = await post(`${PREFIX}/after-relay`, relayFields(handoff('end')));
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response><Hangup/></Response>');
    const row = await callRow();
    expect(row.status).toBe('ended');
    expect(row.transferResult).toBeNull();
  });

  test('unsigned after-relay is 403', async () => {
    await seedCall();
    const res = await post(`${PREFIX}/after-relay`, relayFields(handoff('transfer')), { signature: null });
    expect(res.status).toBe(403);
    expect((await callRow()).status).toBe('ai');
  });

  test('unknown number is 404', async () => {
    const res = await post(`${PREFIX}/after-relay`, relayFields(handoff('transfer'), '+14025550888'));
    expect(res.status).toBe(404);
  });

  test('company B number never reaches company A members', async () => {
    await seedTeam();
    await seedCall('b');
    const res = await post(`${PREFIX}/after-relay`, relayFields(handoff('transfer'), B_NUMBER), { token: TOKEN_B });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(TEAM_1);
    expect(res.text).not.toContain(TEAM_2);
    expect(res.text).not.toContain('<Dial');
    const wrongToken = await post(`${PREFIX}/after-relay`, relayFields(handoff('transfer'), B_NUMBER), { token: TOKEN_A });
    expect(wrongToken.status).toBe(403);
  });
});

describe('POST /hooks/twilio/voice-transfer/whisper', () => {
  const whisperPath = () => `${PREFIX}/whisper?company=${idOf('a')}&call=${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}&name=Acme%20Roofing`;

  test('whisper asks to press 1 with numDigits 1 timeout 8', async () => {
    const res = await post(whisperPath(), { CallSid: 'CA' + 'b'.repeat(32), To: TEAM_1, From: A_NUMBER });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Gather numDigits="1" timeout="8"');
    expect(res.text).toContain('Roofline call from Acme Roofing. Press 1 to take it.');
    expect(res.text).toContain(`/whisper-result?company=${idOf('a')}`);
  });

  test('whisper with no digit hangs up that leg only', async () => {
    const res = await post(whisperPath(), { CallSid: 'CA' + 'b'.repeat(32), To: TEAM_1, From: A_NUMBER });
    expect(res.text).toMatch(/<\/Gather><Hangup\/><\/Response>/);
  });

  test('whisper-result takes the call on 1 and hangs up that leg otherwise', async () => {
    const path = `${PREFIX}/whisper-result?company=${idOf('a')}`;
    const taken = await post(path, { Digits: '1', To: TEAM_1 });
    expect(taken.text).toContain('<Response/>');
    const refused = await post(path, { Digits: '2', To: TEAM_1 });
    expect(refused.text).toContain('<Response><Hangup/></Response>');
  });

  test('whisper without a company is 404 and unsigned is 403', async () => {
    expect((await post(`${PREFIX}/whisper`, { To: TEAM_1 })).status).toBe(404);
    expect((await post(whisperPath(), { To: TEAM_1 }, { signature: null })).status).toBe(403);
  });
});

describe('POST /hooks/twilio/voice-transfer/after-dial', () => {
  const dialFields = (status: string): Record<string, string> => ({ CallSid: CALL_SID, From: CALLER, To: A_NUMBER, DialCallStatus: status });

  test('after-dial answered ends the call as answered', async () => {
    await seedCall();
    const res = await post(`${PREFIX}/after-dial?mode=transfer`, dialFields('completed'));
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>');
    const row = await callRow();
    expect(row.status).toBe('ended');
    expect(row.transferResult).toBe('answered');
  });

  test('after-dial answered queues fd-after-call once', async () => {
    await seedCall();
    t.jobs.sent.length = 0;
    await post(`${PREFIX}/after-dial?mode=transfer`, dialFields('completed'));
    const queued = t.jobs.sent.filter((j) => j.name === 'fd-after-call');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ data: { companyId: idOf('a'), callSid: CALL_SID }, singletonKey: `fd-after-call:${CALL_SID}`, startAfter: 5 });
  });

  test('after-dial no answer returns to the relay in message_only mode', async () => {
    const call = await seedCall();
    const res = await post(`${PREFIX}/after-dial?mode=transfer`, dialFields('no-answer'));
    expect(res.status).toBe(200);
    expect(res.text).toContain('<ConversationRelay');
    expect(res.text).toContain('name="mode" value="message_only"');
    expect(res.text).toContain(`<Parameter name="callId" value="${call.id}"/>`);
    expect(res.text).toContain('welcomeGreeting="Nobody could pick up right now. I&apos;ll take a message."');
    expect(MESSAGE_GREETING).toContain('Nobody could pick up right now.');
    expect((await callRow()).transferResult).toBe('no_answer');
  });

  test('after-dial no answer with members left dials the next one', async () => {
    await seedTeam();
    await seedCall();
    const rest = t.seed.a.office.userId;
    const res = await post(`${PREFIX}/after-dial?mode=transfer&rest=${rest}`, dialFields('no-answer'));
    expect(res.text).toContain(`>${TEAM_2}</Number>`);
    expect(res.text).not.toContain('<ConversationRelay');
  });

  test('after-dial voicemail mode, not answered, records a message', async () => {
    const res = await post(`${PREFIX}/after-dial?mode=voicemail`, dialFields('no-answer'));
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Record maxLength="120" playBeep="true"/>');
  });

  test('after-dial voicemail mode, answered, just ends', async () => {
    const res = await post(`${PREFIX}/after-dial?mode=voicemail`, dialFields('completed'));
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>');
    expect(res.text).not.toContain('<Record');
  });

  test('after-dial ring-first no answer hands the call to the Front Desk with the disclosure', async () => {
    await seedCall();
    await withTenant(t.deps.pools, ctxOf('a'), (tx) =>
      tx.update(companySettings).set({ frontDeskEnabled: true }).where(eq(companySettings.companyId, idOf('a'))),
    );
    const res = await post(`${PREFIX}/after-dial?mode=ring_first`, dialFields('busy'));
    expect(res.text).toContain('<ConversationRelay');
    expect(res.text).toContain('welcomeGreetingInterruptible="none"');
    expect(res.text).not.toContain('message_only');
  });
});
