import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { calls, companies, companyPhoneNumbers, companySettings, encrypt, memberships, textingRegistrations, withTenant, type TenantContext } from '@roofline/db';
import { disclosureGreeting } from '@roofline/shared';
import { escapeXml } from '../../src/hooks/twilio.ts';
import { fdHealth } from '../../src/jobs/scheduler/fd-health.ts';
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

  test.each(['trial_ended', 'canceled'] as const)('a read-only company (%s) with Front Desk on gets voicemail TwiML and no relay TwiML', async (status) => {
    await setSettings('a', { frontDeskEnabled: true, ringTeamFirstSeconds: 0 });
    await t.deps.pools.system.update(companies).set({ status }).where(eq(companies.id, idOf('a')));
    const res = await post(VOICE, incoming());
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Record maxLength="120" playBeep="true"/>');
    expect(res.text).not.toContain('<ConversationRelay');
  });

  test('the cap decision counts ringing and ai calls from the last 35 minutes', async () => {
    await setSettings('a', { frontDeskEnabled: true, maxConcurrentAiCalls: 1, ringTeamFirstSeconds: 0 });
    const now = t.deps.clock.now();
    const seed = (sid: string, minutesAgo: number) =>
      withTenant(t.deps.pools, ctxOf('a'), (tx) =>
        tx.insert(calls).values({
          companyId: idOf('a'),
          callSid: sid,
          fromE164: CALLER,
          toE164: A_NUMBER,
          status: 'ai',
          startedAt: new Date(now.getTime() - minutesAgo * 60_000),
        }),
      );
    await seed('CA' + 'd'.repeat(32), 10);
    const full = await post(VOICE, incoming());
    expect(full.text).toContain('<Record maxLength="120" playBeep="true"/>');
    expect(full.text).not.toContain('<ConversationRelay');

    await withTenant(t.deps.pools, ctxOf('a'), (tx) => tx.update(calls).set({ status: 'ended' }).where(eq(calls.companyId, idOf('a'))));
    await seed('CA' + 'f'.repeat(32), 40);
    const stale = await post(VOICE, incoming());
    expect(stale.text).toContain('<ConversationRelay');
  });

  test('non-AI paths are marked ringing_team and never hold an AI slot (ring first, Front Desk off, over the cap)', async () => {
    // Ring the team first: the call is the team's, not the AI's.
    await seedTeam();
    await setSettings('a', { frontDeskEnabled: true, maxConcurrentAiCalls: 1, ringTeamFirstSeconds: 20 });
    const ringFirst = await post(VOICE, incoming(A_NUMBER, { CallSid: 'CA' + '3'.repeat(32) }));
    expect(ringFirst.text).not.toContain('<ConversationRelay');
    expect((await callRows('a')).find((r) => r.callSid === 'CA' + '3'.repeat(32))!.status).toBe('ringing_team');

    // With that call still live at the team, an AI call still gets the one AI slot.
    await setSettings('a', { frontDeskEnabled: true, maxConcurrentAiCalls: 1, ringTeamFirstSeconds: 0 });
    const ai = await post(VOICE, incoming(A_NUMBER, { CallSid: 'CA' + '4'.repeat(32) }));
    expect(ai.text).toContain('<ConversationRelay');
    expect((await callRows('a')).find((r) => r.callSid === 'CA' + '4'.repeat(32))!.status).toBe('ringing');

    // The next call is over the cap: voicemail, marked ringing_team, and it does not count either.
    const over = await post(VOICE, incoming(A_NUMBER, { CallSid: 'CA' + '5'.repeat(32) }));
    expect(over.text).not.toContain('<ConversationRelay');
    expect((await callRows('a')).find((r) => r.callSid === 'CA' + '5'.repeat(32))!.status).toBe('ringing_team');

    // Front Desk off: the team, then voicemail, marked ringing_team.
    await setSettings('a', { frontDeskEnabled: false });
    await post(VOICE, incoming(A_NUMBER, { CallSid: 'CA' + '6'.repeat(32) }));
    expect((await callRows('a')).find((r) => r.callSid === 'CA' + '6'.repeat(32))!.status).toBe('ringing_team');

    // Once the AI call ends, the slot is free again even though three team calls are still live.
    await withTenant(t.deps.pools, ctxOf('a'), (tx) => tx.update(calls).set({ status: 'ended' }).where(eq(calls.callSid, 'CA' + '4'.repeat(32))));
    await setSettings('a', { frontDeskEnabled: true, maxConcurrentAiCalls: 1, ringTeamFirstSeconds: 0 });
    const again = await post(VOICE, incoming(A_NUMBER, { CallSid: 'CA' + '7'.repeat(32) }));
    expect(again.text).toContain('<ConversationRelay');
  });

  test('a ring_first call whose ring times out takes the cap like a new AI call: voicemail when the slot is taken (final review RC-3)', async () => {
    await seedTeam();
    await setSettings('a', { frontDeskEnabled: true, maxConcurrentAiCalls: 1, ringTeamFirstSeconds: 20 });
    const ringSid = 'CA' + '3'.repeat(32);
    await post(VOICE, incoming(A_NUMBER, { CallSid: ringSid }));
    expect((await callRows('a')).find((r) => r.callSid === ringSid)!.status).toBe('ringing_team');

    // A new AI call takes the one slot while the team is being rung.
    await setSettings('a', { ringTeamFirstSeconds: 0 });
    const ai = await post(VOICE, incoming(A_NUMBER, { CallSid: 'CA' + '4'.repeat(32) }));
    expect(ai.text).toContain('<ConversationRelay');

    // The ring times out: the slot is taken, so voicemail, not a second AI call.
    const afterDial = '/hooks/twilio/voice-transfer/after-dial?mode=ring_first';
    const timedOut = { CallSid: ringSid, From: CALLER, To: A_NUMBER, DialCallStatus: 'no-answer' };
    const full = await post(afterDial, timedOut);
    expect(full.text).toContain('<Record maxLength="120" playBeep="true"/>');
    expect(full.text).not.toContain('<ConversationRelay');
    expect((await callRows('a')).find((r) => r.callSid === ringSid)!.status).toBe('ringing_team');

    // With the slot free again, a timed-out ring goes to the AI and is counted as relay-bound ('ringing').
    await withTenant(t.deps.pools, ctxOf('a'), (tx) => tx.update(calls).set({ status: 'ended' }).where(eq(calls.callSid, 'CA' + '4'.repeat(32))));
    const free = await post(afterDial, timedOut);
    expect(free.text).toContain('<ConversationRelay');
    expect((await callRows('a')).find((r) => r.callSid === ringSid)!.status).toBe('ringing');
    const next = await post(VOICE, incoming(A_NUMBER, { CallSid: 'CA' + '5'.repeat(32) }));
    expect(next.text).not.toContain('<ConversationRelay');
  });

  test('a timed-out ring_first call gets voicemail when the Front Desk was turned off meanwhile', async () => {
    await seedTeam();
    await setSettings('a', { frontDeskEnabled: true, maxConcurrentAiCalls: 2, ringTeamFirstSeconds: 20 });
    const ringSid = 'CA' + '3'.repeat(32);
    await post(VOICE, incoming(A_NUMBER, { CallSid: ringSid }));
    await setSettings('a', { frontDeskEnabled: false });
    const res = await post('/hooks/twilio/voice-transfer/after-dial?mode=ring_first', { CallSid: ringSid, From: CALLER, To: A_NUMBER, DialCallStatus: 'busy' });
    expect(res.text).toContain('<Record maxLength="120" playBeep="true"/>');
    expect(res.text).not.toContain('<ConversationRelay');
  });

  test('ring first with no team numbers goes straight to the AI, marked ringing and counted under the cap', async () => {
    await setSettings('a', { frontDeskEnabled: true, maxConcurrentAiCalls: 1, ringTeamFirstSeconds: 20 });
    const first = await post(VOICE, incoming(A_NUMBER, { CallSid: 'CA' + '3'.repeat(32) }));
    expect(first.text).toContain('<ConversationRelay');
    expect((await callRows('a')).find((r) => r.callSid === 'CA' + '3'.repeat(32))!.status).toBe('ringing');
    const second = await post(VOICE, incoming(A_NUMBER, { CallSid: 'CA' + '4'.repeat(32) }));
    expect(second.text).not.toContain('<ConversationRelay');
    expect(second.text).toContain('<Record maxLength="120" playBeep="true"/>');
    expect((await callRows('a')).find((r) => r.callSid === 'CA' + '4'.repeat(32))!.status).toBe('ringing_team');
  });

  test('fd-health ends an ai call stuck for 40 minutes and dial calls over 4 hours, per company, and leaves a connected ring_first call alone (Ruling BJ; CV#3)', async () => {
    const now = t.deps.clock.now();
    const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
    const aiStuck = 'CA' + '1'.repeat(32);
    const aiFresh = 'CA' + '2'.repeat(32);
    const ringFirst = 'CA' + '3'.repeat(32);
    const teamFirst = 'CA' + '4'.repeat(32);
    const dialOld = 'CA' + '5'.repeat(32);
    const bStuck = 'CA' + '6'.repeat(32);
    const row = (company: 'a' | 'b', callSid: string, status: 'ai' | 'ringing' | 'ringing_team', startedAt: Date) => ({
      companyId: idOf(company),
      callSid,
      fromE164: CALLER,
      toE164: company === 'a' ? A_NUMBER : B_NUMBER,
      status,
      startedAt,
    });
    await withTenant(t.deps.pools, ctxOf('a'), (tx) =>
      tx.insert(calls).values([
        row('a', aiStuck, 'ai', ago(40)),
        row('a', aiFresh, 'ai', ago(5)),
        // A ring_first call answered by staff keeps 'ringing' for the whole bridged call.
        row('a', ringFirst, 'ringing', ago(40)),
        row('a', teamFirst, 'ringing_team', ago(40)),
        row('a', dialOld, 'ringing', ago(4 * 60 + 1)),
      ]),
    );
    await withTenant(t.deps.pools, ctxOf('b'), (tx) => tx.insert(calls).values([row('b', bStuck, 'ai', ago(40))]));
    t.jobs.sent.length = 0;
    await fdHealth(t.deps, now);
    const status = async (c: 'a' | 'b', sid: string) => (await callRows(c)).find((r) => r.callSid === sid)!;
    for (const sid of [aiStuck, dialOld]) {
      expect((await status('a', sid)).status, sid).toBe('ended');
      expect((await status('a', sid)).endedAt, sid).not.toBeNull();
    }
    expect((await status('b', bStuck)).status).toBe('ended');
    expect((await status('a', aiFresh)).status).toBe('ai');
    expect((await status('a', ringFirst)).status).toBe('ringing');
    expect((await status('a', ringFirst)).endedAt).toBeNull();
    expect((await status('a', teamFirst)).status).toBe('ringing_team');
    const queued = t.jobs.sent.filter((j) => j.name === 'fd-after-call');
    expect(queued.map((j) => j.data.callSid).sort()).toEqual([aiStuck, dialOld, bStuck].sort());
    for (const j of queued) {
      expect(j.data.swept).toBe(true);
      expect(j.singletonKey).toBe(`fd-after-call:${j.data.callSid!}`);
      expect(j.data.companyId).toBe(j.data.callSid === bStuck ? idOf('b') : idOf('a'));
    }
  });

  test('the stuck-call sweep updates on the tenant pool only: app_system cannot UPDATE calls (Ruling BJ)', async () => {
    const sid = 'CA' + '7'.repeat(32);
    await withTenant(t.deps.pools, ctxOf('a'), (tx) =>
      tx.insert(calls).values({ companyId: idOf('a'), callSid: sid, fromE164: CALLER, toE164: A_NUMBER, status: 'ai', startedAt: new Date(t.deps.clock.now().getTime() - 40 * 60_000) }),
    );
    const err = await t.deps.pools.system
      .update(calls)
      .set({ status: 'ended' })
      .where(eq(calls.callSid, sid))
      .then(() => null, (e: unknown) => e as { code?: string; cause?: { code?: string } });
    expect(err?.code ?? err?.cause?.code).toBe('42501');
    await fdHealth(t.deps, t.deps.clock.now());
    expect((await callRows('a')).find((r) => r.callSid === sid)!.status).toBe('ended');
  });

  test('over the global cap (relaySessions.size) goes to voicemail path', async () => {
    await setSettings('a', { frontDeskEnabled: true });
    for (let i = 0; i < t.deps.config.FRONT_DESK_MAX_CALLS; i += 1) t.deps.relaySessions.add(`CAlive${String(i)}`);
    const res = await post(VOICE, incoming());
    expect(res.text).toContain('<Record maxLength="120" playBeep="true"/>');
    expect(res.text).not.toContain('<ConversationRelay');
  });

  test('a read-only company (trial ended or canceled) gets the team then voicemail, never the AI (Ruling BG)', async () => {
    await setSettings('a', { frontDeskEnabled: true, ringTeamFirstSeconds: 15 });
    await seedTeam();
    for (const status of ['trial_ended', 'canceled'] as const) {
      await t.deps.pools.system.update(companies).set({ status }).where(eq(companies.id, idOf('a')));
      const res = await post(VOICE, incoming());
      expect(res.status, status).toBe(200);
      expect(res.text, status).toContain('after-dial?mode=voicemail');
      expect(res.text, status).not.toContain('mode=ring_first');
      expect(res.text, status).not.toContain('<ConversationRelay');
    }
  });

  test('the LLM health check reads the injected clock (pre-review #40)', async () => {
    await setSettings('a', { frontDeskEnabled: true, ringTeamFirstSeconds: 0 });
    const start = new Date('2030-01-01T12:00:00Z');
    t.clock.set(start);
    for (let i = 0; i < 3; i += 1) t.deps.relaySessions.recordLlmFailure(start);
    const tripped = await post(VOICE, incoming());
    expect(tripped.text).not.toContain('<ConversationRelay');
    // 61 s later on the app's clock the breaker has reset, whatever the wall clock says.
    t.clock.advance(61_000);
    const healed = await post(VOICE, incoming());
    expect(healed.text).toContain('<ConversationRelay');
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

  test('a replayed signed /voice for an ended call answers Hangup', async () => {
    await setSettings('a', { frontDeskEnabled: true, ringTeamFirstSeconds: 0 });
    const fields = incoming();
    const first = await post(VOICE, fields);
    expect(first.text).toContain('<ConversationRelay');
    await withTenant(t.deps.pools, ctxOf('a'), (tx) => tx.update(calls).set({ status: 'ended' }).where(eq(calls.callSid, fields.CallSid)));
    const replay = await post(VOICE, fields);
    expect(replay.status).toBe(200);
    expect(replay.text).toContain('<Response><Hangup/></Response>');
    expect(replay.text).not.toContain('<ConversationRelay');
  });

  test('a replayed /voice for a call in progress (status ai) answers Hangup', async () => {
    await setSettings('a', { frontDeskEnabled: true, ringTeamFirstSeconds: 0 });
    const fields = incoming();
    await post(VOICE, fields);
    await withTenant(t.deps.pools, ctxOf('a'), (tx) => tx.update(calls).set({ status: 'ai' }).where(eq(calls.callSid, fields.CallSid)));
    const replay = await post(VOICE, fields);
    expect(replay.status).toBe(200);
    expect(replay.text).toContain('<Response><Hangup/></Response>');
    expect(replay.text).not.toContain('<ConversationRelay');
  });

  test('a malformed CallSid is 400', async () => {
    const res = await post(VOICE, { ...incoming(), CallSid: 'CA123' });
    expect(res.status).toBe(400);
    expect(res.text).toBe('');
    expect(await callRows('a')).toHaveLength(0);
  });

  test('an unsigned /voice-status is 403', async () => {
    const res = await post(VOICE_STATUS, { CallSid: incoming().CallSid, CallStatus: 'completed', From: CALLER, To: A_NUMBER }, { signature: null });
    expect(res.status).toBe(403);
  });

  test('a malformed CallSid on /voice-status is 400', async () => {
    const res = await post(VOICE_STATUS, { CallSid: 'CA123', CallStatus: 'completed', From: CALLER, To: A_NUMBER });
    expect(res.status).toBe(400);
  });

  test.each(['whisper', 'whisper-result'])('a tampered ?company= on /voice-transfer/%s is 403', async (leg) => {
    const fields = { CallSid: incoming().CallSid, To: TEAM_1, From: A_NUMBER };
    const signedPath = `/hooks/twilio/voice-transfer/${leg}?company=${idOf('a')}&call=x&name=Acme`;
    const signature = twilio.getExpectedTwilioSignature(TOKEN_A, BASE + signedPath, fields);
    const tamperedPath = signedPath.replace(idOf('a'), idOf('b'));
    const res = await post(tamperedPath, fields, { signature });
    expect(res.status).toBe(403);
  });

  test('a malformed CallSid on /voice-transfer/after-dial is 400', async () => {
    const res = await post('/hooks/twilio/voice-transfer/after-dial?mode=voicemail', { CallSid: 'CA123', To: A_NUMBER, From: CALLER, DialCallStatus: 'no-answer' });
    expect(res.status).toBe(400);
  });
});
