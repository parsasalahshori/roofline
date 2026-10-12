import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  blockedNumbers,
  calls,
  companyPhoneNumbers,
  companySettings,
  conversations,
  customers,
  encrypt,
  textingRegistrations,
  withTenant,
  type TenantContext,
} from '@roofline/db';
import { loginAs, makeTestApp, TEST_ENCRYPTION_KEY, type SuperAgent, type TestApp } from '../helpers.ts';

/*
 * Task 15: spam. The real screenCall runs here (no mock): a blocked number is rejected before the
 * relay, a repeat STIR-failed caller is rejected after more than 3 calls in an hour, a known
 * customer is never rejected by STIR, and the owner or the office can mark a call as spam and
 * unmark a number. Database-backed: CI runs it.
 */

const ROLE_MESSAGE = "Your role can't do that. Ask the owner.";
const NOT_FOUND = "We couldn't find that.";

let t: TestApp;
const A_NUMBER = '+14025550200';
const B_NUMBER = '+14025550300';
const CALLER = '+14025550999';
const OTHER_CALLER = '+14025550888';
const KNOWN_CALLER = '+14025550777';
const TOKEN_A = 'test-subaccount-token-a';
const TOKEN_B = 'test-subaccount-token-b';
const BASE = 'https://app.roofline.test';
const VOICE = '/hooks/twilio/voice';
const STIR_FAILED = 'TN-Validation-Failed-A';
const NO_UUID_ID = 'not-a-uuid';
const ZERO_UUID = '00000000-0000-4000-8000-000000000000';

const idOf = (company: 'a' | 'b') => t.seed[company].companyId;
const ctxOf = (c: 'a' | 'b'): TenantContext => ({ companyId: idOf(c), role: 'system', userId: null, canApproveSpend: false });

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(new Date());
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
  await withTenant(t.deps.pools, ctxOf('a'), (tx) =>
    tx.update(companySettings).set({ frontDeskEnabled: true, ringTeamFirstSeconds: 0 }).where(eq(companySettings.companyId, idOf('a'))),
  );
});

let sidCounter = 0;
const nextSid = (): string => `CB${String(++sidCounter).padStart(32, '0')}`;

type Signing = { token?: string; signature?: string | null };

/** A Twilio voice webhook, signed the way Twilio signs it (with the company's subaccount token). */
function postVoice(fields: Record<string, string>, signing: Signing = {}) {
  const path = VOICE;
  const signature =
    signing.signature !== undefined ? signing.signature : twilio.getExpectedTwilioSignature(signing.token ?? TOKEN_A, BASE + path, fields);
  const req = request(t.app).post(path).type('form');
  if (signature !== null) req.set('X-Twilio-Signature', signature);
  return req.send(fields);
}

const incoming = (from: string, extra: Record<string, string> = {}) => ({
  CallSid: nextSid(),
  From: from,
  To: A_NUMBER,
  ...extra,
});

/** Seeds a call (and its conversation) of company A from a number, as the voice webhook would have stored it. */
async function seedCall(from: string, opts: { startedAt?: Date; withConversation?: boolean } = {}): Promise<{ callId: string; conversationId: string | null; callSid: string }> {
  const callSid = nextSid();
  return withTenant(t.deps.pools, ctxOf('a'), async (tx) => {
    let conversationId: string | null = null;
    if (opts.withConversation !== false) {
      const [conv] = await tx
        .insert(conversations)
        .values({ companyId: idOf('a'), channel: 'voice', phoneE164: from, companyNumberE164: A_NUMBER, status: 'ended' })
        .returning({ id: conversations.id });
      conversationId = conv!.id;
    }
    const [call] = await tx
      .insert(calls)
      .values({
        companyId: idOf('a'),
        callSid,
        fromE164: from,
        toE164: A_NUMBER,
        status: 'ended',
        startedAt: opts.startedAt ?? new Date(),
        conversationId,
      })
      .returning({ id: calls.id });
    return { callId: call!.id, conversationId, callSid };
  });
}

const callRow = (callSid: string) =>
  withTenant(t.deps.pools, ctxOf('a'), async (tx) => {
    const [row] = await tx.select().from(calls).where(eq(calls.callSid, callSid));
    return row;
  });

const blockedRows = (company: 'a' | 'b', e164: string) =>
  withTenant(t.deps.pools, ctxOf(company), (tx) =>
    tx.select().from(blockedNumbers).where(and(eq(blockedNumbers.companyId, idOf(company)), eq(blockedNumbers.e164, e164))),
  );

const conversationOf = (id: string) =>
  withTenant(t.deps.pools, ctxOf('a'), async (tx) => {
    const [row] = await tx.select().from(conversations).where(eq(conversations.id, id));
    return row;
  });

async function agentFor(user: 'owner' | 'office' | 'rep', company: 'a' | 'b' = 'a'): Promise<SuperAgent> {
  return loginAs(t.app, t.seed[company][user]);
}

describe('POST /api/calls/:id/spam', () => {
  test('marking a call as spam blocks the number, sets the call spam reason and the conversation outcome', async () => {
    const { callId, conversationId } = await seedCall(CALLER);
    const agent = await agentFor('owner');
    const res = await agent.post(`/api/calls/${callId}/spam`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: callId, spam: true, blockedNumberId: expect.any(String) });

    const rows = await blockedRows('a', CALLER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(res.body.blockedNumberId);

    const call = await callRowsOf(callId);
    expect(call!.spamReason).toBe('marked_by_team');
    expect(await conversationOf(conversationId!)).toMatchObject({ outcome: 'spam' });
  });

  test('a blocked number is rejected before the relay with no ai seconds', async () => {
    const { callId } = await seedCall(CALLER);
    const agent = await agentFor('owner');
    expect((await agent.post(`/api/calls/${callId}/spam`)).status).toBe(200);

    const fields = incoming(CALLER);
    const res = await postVoice(fields);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Reject/>');
    expect(res.text).not.toContain('<ConversationRelay');

    const row = await callRow(fields.CallSid);
    expect(row).toMatchObject({ status: 'rejected', spamReason: 'blocked_number', aiSeconds: 0 });
    expect(row!.endedAt).not.toBeNull();
  });

  test('marking the same call twice is idempotent', async () => {
    const { callId } = await seedCall(CALLER);
    const agent = await agentFor('owner');
    const first = await agent.post(`/api/calls/${callId}/spam`);
    const second = await agent.post(`/api/calls/${callId}/spam`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.blockedNumberId).toBe(first.body.blockedNumberId);
    expect(await blockedRows('a', CALLER)).toHaveLength(1);
  });

  test('the office can mark a call as spam', async () => {
    const { callId } = await seedCall(OTHER_CALLER);
    const agent = await agentFor('office');
    expect((await agent.post(`/api/calls/${callId}/spam`)).status).toBe(200);
    expect(await blockedRows('a', OTHER_CALLER)).toHaveLength(1);
  });

  test('a rep cannot mark spam (403)', async () => {
    const { callId } = await seedCall(CALLER);
    const agent = await agentFor('rep');
    const res = await agent.post(`/api/calls/${callId}/spam`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: ROLE_MESSAGE });
    expect(await blockedRows('a', CALLER)).toHaveLength(0);
  });

  test('cross-tenant call ids are 404 and company A rows are untouched', async () => {
    const { callId, conversationId } = await seedCall(CALLER);
    const agent = await agentFor('owner', 'b');
    const res = await agent.post(`/api/calls/${callId}/spam`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
    expect(await blockedRows('a', CALLER)).toHaveLength(0);
    expect(await blockedRows('b', CALLER)).toHaveLength(0);
    const row = await callRowsOf(callId);
    expect(row!.spamReason).toBeNull();
    expect(await conversationOf(conversationId!)).toMatchObject({ outcome: null });
  });

  test('a non-UUID call id is 404', async () => {
    const agent = await agentFor('owner');
    const res = await agent.post(`/api/calls/${NO_UUID_ID}/spam`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
  });

  test('an unknown call id is 404', async () => {
    const agent = await agentFor('owner');
    expect((await agent.post(`/api/calls/${ZERO_UUID}/spam`)).status).toBe(404);
  });
});

describe('DELETE /api/blocked-numbers/:id', () => {
  test('unmarking returns 204 and the next call from that number is no longer rejected', async () => {
    const { callId } = await seedCall(CALLER);
    const agent = await agentFor('owner');
    const marked = await agent.post(`/api/calls/${callId}/spam`);
    expect(marked.status).toBe(200);

    const blocked = await postVoice(incoming(CALLER));
    expect(blocked.text).toContain('<Reject/>');

    const res = await agent.delete(`/api/blocked-numbers/${marked.body.blockedNumberId}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await blockedRows('a', CALLER)).toHaveLength(0);

    const next = await postVoice(incoming(CALLER));
    expect(next.status).toBe(200);
    expect(next.text).not.toContain('<Reject/>');
    expect(next.text).toContain('<ConversationRelay');
  });

  test('a rep cannot unblock (403) and the number stays blocked', async () => {
    const { callId } = await seedCall(CALLER);
    const owner = await agentFor('owner');
    const marked = await owner.post(`/api/calls/${callId}/spam`);
    const rep = await agentFor('rep');
    const res = await rep.delete(`/api/blocked-numbers/${marked.body.blockedNumberId}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: ROLE_MESSAGE });
    expect(await blockedRows('a', CALLER)).toHaveLength(1);
  });

  test('cross-tenant blocked-number ids are 404 and company A rows are untouched', async () => {
    const { callId } = await seedCall(CALLER);
    const owner = await agentFor('owner');
    const marked = await owner.post(`/api/calls/${callId}/spam`);
    const other = await agentFor('owner', 'b');
    const res = await other.delete(`/api/blocked-numbers/${marked.body.blockedNumberId}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
    expect(await blockedRows('a', CALLER)).toHaveLength(1);
  });

  test('a non-UUID blocked-number id is 404', async () => {
    const agent = await agentFor('owner');
    const res = await agent.delete(`/api/blocked-numbers/${NO_UUID_ID}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
  });
});

describe('STIR/SHAKEN screening on the voice webhook', () => {
  test('STIR failure from an unknown number rejects only after more than 3 calls in an hour', async () => {
    const recent = new Date(Date.now() - 10 * 60 * 1000);
    for (let i = 0; i < 3; i += 1) await seedCall(OTHER_CALLER, { startedAt: recent, withConversation: false });

    const fourth = incoming(OTHER_CALLER, { StirVerstat: STIR_FAILED });
    const res = await postVoice(fourth);
    expect(res.text).toContain('<Reject/>');
    expect(await callRow(fourth.CallSid)).toMatchObject({ status: 'rejected', spamReason: 'stir_failed_repeat' });
  });

  test('STIR failure with at most 3 calls in an hour is not rejected', async () => {
    const recent = new Date(Date.now() - 10 * 60 * 1000);
    for (let i = 0; i < 2; i += 1) await seedCall(OTHER_CALLER, { startedAt: recent, withConversation: false });

    const third = incoming(OTHER_CALLER, { StirVerstat: STIR_FAILED });
    const res = await postVoice(third);
    expect(res.text).not.toContain('<Reject/>');
    expect(res.text).toContain('<ConversationRelay');
  });

  test('a known customer is never rejected by the STIR rule', async () => {
    await withTenant(t.deps.pools, ctxOf('a'), (tx) =>
      tx.insert(customers).values({ companyId: idOf('a'), displayName: 'Known Customer', phones: [{ e164: KNOWN_CALLER, primary: true }] }),
    );
    const recent = new Date(Date.now() - 10 * 60 * 1000);
    for (let i = 0; i < 5; i += 1) await seedCall(KNOWN_CALLER, { startedAt: recent, withConversation: false });

    const fields = incoming(KNOWN_CALLER, { StirVerstat: STIR_FAILED });
    const res = await postVoice(fields);
    expect(res.text).not.toContain('<Reject/>');
    expect(res.text).toContain('<ConversationRelay');
    expect((await callRow(fields.CallSid))!.spamReason).toBeNull();
  });
});

/** The call row by id, for the cross-tenant test (it needs the sid to read back). */
async function callRowsOf(callId: string) {
  return withTenant(t.deps.pools, ctxOf('a'), async (tx) => {
    const [row] = await tx.select().from(calls).where(eq(calls.id, callId));
    return row;
  });
}
