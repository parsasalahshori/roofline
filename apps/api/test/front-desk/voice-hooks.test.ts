import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { calls, companyPhoneNumbers, companySettings, encrypt, memberships, textingRegistrations, withTenant, type TenantContext } from '@roofline/db';
import { disclosureGreeting } from '@roofline/shared';
import { escapeXml } from '../../src/hooks/twilio.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from '../helpers.ts';

/* The screening rules arrive in Task 15 (the real one allows everything today): tests steer the verdict. */
const screen = vi.hoisted(() => ({ verdict: { action: 'allow', reason: null } as { action: 'allow' | 'reject'; reason: string | null } }));
vi.mock('../../src/providers/call-screen.ts', () => ({ screenCall: () => screen.verdict }));

/*
 * Task 10: the voice webhooks. Requests are signed the way Twilio signs them, with each company's
 * subaccount token.
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
const VOICE = '/hooks/twilio/voice';
const VOICE_STATUS = '/hooks/twilio/voice-status';

const idOf = (company: 'a' | 'b') => t.seed[company].companyId;
const ctxOf = (c: 'a' | 'b'): TenantContext => ({ companyId: idOf(c), role: 'system', userId: null, canApproveSpend: false });

beforeEach(async () => {
  screen.verdict = { action: 'allow', reason: null };
  t = await makeTestApp();
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

function post(path: string, fields: Record<string, string>, signing: Signing = {}) {
  const signature = signing.signature !== undefined ? signing.signature : twilio.getExpectedTwilioSignature(signing.token ?? TOKEN_A, BASE + path, fields);
  const req = request(t.app).post(path).type('form');
  if (signature !== null) req.set('X-Twilio-Signature', signature);
  return req.send(fields);
}

let sidCounter = 0;
const incoming = (to = A_NUMBER, extra: Record<string, string> = {}) => ({ CallSid: `CA${String(++sidCounter).padStart(32, '0')}`, From: CALLER, To: to, ...extra });

const setSettings = (company: 'a' | 'b', patch: Partial<typeof companySettings.$inferInsert>) =>
  withTenant(t.deps.pools, ctxOf(company), (tx) => tx.update(companySettings).set(patch).where(eq(companySettings.companyId, idOf(company))));

/** Acme's two team members get a transfer phone and ring order. */
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

const callRows = (company: 'a' | 'b') => withTenant(t.deps.pools, ctxOf(company), (tx) => tx.select().from(calls).where(eq(calls.companyId, idOf(company))));

describe('POST /hooks/twilio/voice', () => {
  test('unsigned voice call is 403', async () => {
    const res = await post(VOICE, incoming(), { signature: null });
    expect(res.status).toBe(403);
    expect(await callRows('a')).toHaveLength(0);
  });

  test('unknown number is 404', async () => {
    const res = await post(VOICE, incoming('+14025550888'));
    expect(res.status).toBe(404);
  });

  test('relay TwiML has the disclosure greeting, non-interruptible, callId parameter', async () => {
    await setSettings('a', { frontDeskEnabled: true, ringTeamFirstSeconds: 0 });
    const res = await post(VOICE, incoming());
    expect(res.status).toBe(200);
    const [row] = await callRows('a');
    expect(res.text).toContain('<ConversationRelay');
    expect(res.text).toContain(`welcomeGreeting="${escapeXml(disclosureGreeting(t.seed.a.name))}"`);
    expect(res.text).toContain('welcomeGreetingInterruptible="none"');
    expect(res.text).toContain('interruptible="speech"');
    expect(res.text).toContain(`<Parameter name="callId" value="${row!.id}"/>`);
    expect(res.text).toContain('/hooks/twilio/voice-transfer/after-relay');
  });

  test('ring-first dials the team then falls to the voice-transfer after-dial', async () => {
    await setSettings('a', { frontDeskEnabled: true, ringTeamFirstSeconds: 15 });
    await seedTeam();
    const res = await post(VOICE, incoming());
    expect(res.text).toContain('<Dial timeout="15"');
    expect(res.text).toContain('/hooks/twilio/voice-transfer/after-dial?mode=ring_first');
    expect(res.text).toContain(`<Number>${TEAM_1}</Number>`);
    expect(res.text).toContain(`<Number>${TEAM_2}</Number>`);
    expect(res.text).not.toContain('<ConversationRelay');
  });

  test('Front Desk off dials the team then records voicemail', async () => {
    await setSettings('a', { frontDeskEnabled: false });
    await seedTeam();
    const res = await post(VOICE, incoming());
    expect(res.text).toContain('<Dial timeout="20"');
    expect(res.text).toContain('after-dial?mode=voicemail');
    expect(res.text).toContain(`<Number>${TEAM_1}</Number>`);
    expect(res.text).not.toContain('<Record');
    expect(res.text).not.toContain('<ConversationRelay');
  });

  test('a withheld caller id (anonymous) is still answered and saved', async () => {
    const before = (await callRows('a')).length;
    const res = await post(VOICE, incoming(A_NUMBER, { From: 'anonymous' }));
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/xml');
    const rows = await callRows('a');
    expect(rows).toHaveLength(before + 1);
    expect(rows.filter((r) => r.fromE164 === 'anonymous')).toHaveLength(1);
  });

  test('a missing From is answered and saved as anonymous', async () => {
    const fields: Record<string, string> = incoming();
    delete fields.From;
    const res = await post(VOICE, fields);
    expect(res.status).toBe(200);
    expect((await callRows('a')).filter((r) => r.fromE164 === 'anonymous')).toHaveLength(1);
  });

  test('over the company cap goes to voicemail path', async () => {
    await setSettings('a', { frontDeskEnabled: true, maxConcurrentAiCalls: 1 });
    await withTenant(t.deps.pools, ctxOf('a'), (tx) =>
      tx.insert(calls).values({ companyId: idOf('a'), callSid: 'CA' + 'e'.repeat(32), fromE164: CALLER, toE164: A_NUMBER, status: 'ai' }),
    );
    const res = await post(VOICE, incoming());
    expect(res.text).toContain('<Record maxLength="120" playBeep="true"/>');
    expect(res.text).not.toContain('<ConversationRelay');
  });

  test('over the global cap (relaySessions.size) goes to voicemail path', async () => {
    await setSettings('a', { frontDeskEnabled: true });
    for (let i = 0; i < t.deps.config.FRONT_DESK_MAX_CALLS; i += 1) t.deps.relaySessions.add(`CAlive${String(i)}`);
    const res = await post(VOICE, incoming());
    expect(res.text).toContain('<Record maxLength="120" playBeep="true"/>');
    expect(res.text).not.toContain('<ConversationRelay');
  });

  test('a screened call is rejected and the row is rejected', async () => {
    await setSettings('a', { frontDeskEnabled: true });
    screen.verdict = { action: 'reject', reason: 'blocked' };
    const fields = incoming();
    const res = await post(VOICE, fields);
    expect(res.text).toContain('<Reject/>');
    const [row] = await callRows('a');
    expect(row!.callSid).toBe(fields.CallSid);
    expect(row!.status).toBe('rejected');
    expect(row!.spamReason).toBe('blocked');
    expect(row!.endedAt).not.toBeNull();
  });

  test('status callback updates the call', async () => {
    await setSettings('a', { frontDeskEnabled: true });
    const fields = incoming();
    await post(VOICE, fields);
    const res = await post(VOICE_STATUS, { CallSid: fields.CallSid, CallStatus: 'completed', From: CALLER, To: A_NUMBER });
    expect(res.status).toBe(204);
    const [row] = await callRows('a');
    expect(row!.status).toBe('ended');
    expect(row!.endedAt).not.toBeNull();
  });

  test("company B's number never routes to company A", async () => {
    await setSettings('b', { frontDeskEnabled: true });
    const fields = incoming(B_NUMBER);
    const res = await post(VOICE, fields, { token: TOKEN_B });
    expect(res.status).toBe(200);
    expect(await callRows('a')).toHaveLength(0);
    const rows = await callRows('b');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.companyId).toBe(idOf('b'));
    // and A's token cannot sign B's number
    const bad = await post(VOICE, incoming(B_NUMBER), { token: TOKEN_A });
    expect(bad.status).toBe(403);
  });
});
