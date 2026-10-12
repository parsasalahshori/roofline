import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  claims,
  companyPhoneNumbers,
  companySettings,
  encrypt,
  followUpLog,
  jobs,
  messages,
  properties,
  setPaused,
  textingRegistrations,
  type Tx,
  withTenant,
} from '@roofline/db';
import { CLAIMS_ACK_TEXT } from '../src/agents/claims/replies.ts';
import { ScriptedLlm } from '../src/providers/fakes/scripted-llm.ts';
import { LlmUnavailableError, type ClaimReplyFacts, type RouteDecision, type TurnUsage } from '../src/providers/llm.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from './helpers.ts';
import { addSmsCustomers, DAY, DAYTIME } from './sms-helpers.ts';

/*
 * Who answers a homeowner's reply to a claims text (spec 3.3, Ruling AV as amended, Ruling GX-V).
 * The text arrives through the real, signed /hooks/twilio/sms route; queued jobs are drained by hand.
 * - Fully answered (something noted, no question): the only answer is "Thanks, got it.".
 * - Anything else: the reply goes on to Front Desk, which answers it as usual.
 * The model is a ScriptedLlm and the provider a FakeSmsAdapter: nothing leaves the process.
 */

let t: TestApp;
let llm: ScriptedLlm;

const A_NUMBER = '+14025550100';
const NINA = '+14025550101';
const TOKEN = 'test-subaccount-token-a';
const BASE = 'https://app.roofline.test';
const SMS = '/hooks/twilio/sms';
const OPUS: RouteDecision = { intent: 'other', urgent: false, mood: 'calm', route: 'opus', fastReply: null };
const FRONT_DESK_REPLY = 'We can help with that.';
const USAGE: TurnUsage = { model: 'scripted', inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, totalMs: 2 };

const idA = () => t.seed.a.companyId;
const ctxA = () => ({ companyId: idA(), userId: null, role: 'system' as const, canApproveSpend: false });
let sidCounter = 0;
const nextSid = () => `SM${(sidCounter += 1).toString(16).padStart(32, '0')}`;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  llm = new ScriptedLlm([{ when: /./, route: OPUS, answer: [{ kind: 'text', text: FRONT_DESK_REPLY }] }]);
  (t.deps as unknown as { llm: ScriptedLlm }).llm = llm;
  await t.deps.pools.system.insert(companyPhoneNumbers).values({ companyId: idA(), e164: A_NUMBER, capabilities: ['sms'], providerSid: 'PN_A' });
  await t.deps.pools.system
    .update(textingRegistrations)
    .set({ subaccountAuthTokenEncrypted: encrypt(TOKEN, TEST_ENCRYPTION_KEY) })
    .where(eq(textingRegistrations.companyId, idA()));
  const settings = { frontDeskEnabled: true, frontDeskTexts: true };
  await withTenant(t.deps.pools, ctxA(), (tx) =>
    tx.insert(companySettings).values({ companyId: idA(), ...settings }).onConflictDoUpdate({ target: companySettings.companyId, set: settings }),
  );
  await claimsOn(true);
});

const claimsOn = (on: boolean) => withTenant(t.deps.pools, ctxA(), (tx) => setPaused(tx, ctxA(), 'claims', !on, t.clock.now()));

/** Nina with a filed claim on her job; `claimsTextDaysAgo` null means she never got a claims text. */
async function ninaWithClaim(claimsTextDaysAgo: number | null = 2): Promise<{ claimId: string }> {
  const [customerId] = await addSmsCustomers(t, 'a', [{ firstName: 'Nina', phone: NINA, consent: 'express' }]);
  const now = t.clock.now();
  return inCompany(t, idA(), async (tx: Tx) => {
    const [property] = await tx
      .insert(properties)
      .values({
        companyId: idA(),
        customerId: customerId!,
        addressLine: '12 Elm St',
        city: 'Omaha',
        state: 'NE',
        zip: '68102',
        addressKey: '12 elm st|68102',
        timezone: 'America/Chicago',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: properties.id });
    const [job] = await tx
      .insert(jobs)
      .values({ companyId: idA(), customerId: customerId!, propertyId: property!.id, createdAt: now, updatedAt: now })
      .returning({ id: jobs.id });
    const [claim] = await tx
      .insert(claims)
      .values({ companyId: idA(), jobId: job!.id, status: 'filed', statusChangedAt: now, createdAt: now, updatedAt: now })
      .returning({ id: claims.id });
    if (claimsTextDaysAgo !== null) {
      await tx.insert(followUpLog).values({
        companyId: idA(),
        customerId: customerId!,
        jobId: job!.id,
        kind: 'claims',
        n: 1,
        at: new Date(now.getTime() - claimsTextDaysAgo * DAY),
      });
    }
    return { claimId: claim!.id };
  });
}

/** POSTs Nina's text to A's number, signed as Twilio would, then runs every queued job. */
async function ninaTexts(body: string) {
  const fields = { MessageSid: nextSid(), AccountSid: `AC${'0'.repeat(32)}`, From: NINA, To: A_NUMBER, Body: body, NumMedia: '0' };
  const signature = twilio.getExpectedTwilioSignature(TOKEN, BASE + SMS, fields);
  const res = await request(t.app).post(SMS).type('form').set('X-Twilio-Signature', signature).send(fields);
  expect(res.status).toBe(200);
  await t.jobs.drain(t.deps);
  expect(t.jobs.errors).toEqual([]);
}

const outboundBodies = async () =>
  (
    await inCompany(t, idA(), (tx: Tx) =>
      tx.select({ body: messages.body }).from(messages).where(eq(messages.direction, 'out')).orderBy(asc(messages.createdAt), asc(messages.id)),
    )
  ).map((m) => m.body);
const claimRow = (claimId: string) => inCompany(t, idA(), async (tx: Tx) => (await tx.select().from(claims).where(eq(claims.id, claimId)))[0]!);
const frontDeskAnswers = () => llm.calls.filter((c) => c.kind === 'answer').length;
const extraction = (facts: ClaimReplyFacts) => ({ facts, usage: USAGE });

describe('a reply to a claims text', () => {
  test('fully answered: the claim is updated and the only answer is "Thanks, got it."', async () => {
    const { claimId } = await ninaWithClaim();
    llm.scriptExtraction(extraction({ claimNumber: '0451-22', insurer: 'Acme Mutual' }));

    await ninaTexts('My claim number is 0451-22 with Acme Mutual.');

    expect(await claimRow(claimId)).toMatchObject({ claimNumber: '0451-22', insurer: 'Acme Mutual' });
    expect(await outboundBodies()).toEqual([CLAIMS_ACK_TEXT]);
    expect(t.sms.sent.map((s) => s.body)).toEqual([CLAIMS_ACK_TEXT]);
    expect(frontDeskAnswers()).toBe(0);
  });

  test('after "Thanks, got it.", a question within two hours still gets Front Desk: the ack is not a person replying', async () => {
    await ninaWithClaim();
    llm.scriptExtraction(extraction({ claimNumber: '0451-22', insurer: 'Acme Mutual' }));
    await ninaTexts('My claim number is 0451-22 with Acme Mutual.');
    expect(await outboundBodies()).toEqual([CLAIMS_ACK_TEXT]);

    t.clock.advance(10 * 60_000);
    llm.scriptExtraction(extraction({}));
    await ninaTexts('When can you come out?');

    expect(await outboundBodies()).toEqual([CLAIMS_ACK_TEXT, FRONT_DESK_REPLY]);
    expect(frontDeskAnswers()).toBe(1);
  });

  test('a question as well as a fact: the claim is updated and Front Desk answers, with no "Thanks, got it."', async () => {
    const { claimId } = await ninaWithClaim();
    llm.scriptExtraction(extraction({ claimNumber: '0451-22' }));

    await ninaTexts('My claim number is 0451-22. When can you come out?');

    expect(await claimRow(claimId)).toMatchObject({ claimNumber: '0451-22' });
    expect(await outboundBodies()).toEqual([FRONT_DESK_REPLY]);
    expect(frontDeskAnswers()).toBe(1);
  });

  test('nothing to note: Front Desk answers', async () => {
    await ninaWithClaim();
    llm.scriptExtraction(extraction({}));

    await ninaTexts('Not yet, still waiting on them');

    expect(await outboundBodies()).toEqual([FRONT_DESK_REPLY]);
    expect(frontDeskAnswers()).toBe(1);
  });

  test('the model is unavailable: Front Desk answers', async () => {
    await ninaWithClaim();
    llm.scriptExtraction(new LlmUnavailableError('down'));

    await ninaTexts('My claim number is 0451-22.');

    expect(await outboundBodies()).toEqual([FRONT_DESK_REPLY]);
  });

  test('Claims is paused: nothing is extracted and Front Desk answers', async () => {
    await ninaWithClaim();
    await claimsOn(false);

    await ninaTexts('My claim number is 0451-22.');

    expect(llm.extractionCalls).toHaveLength(0);
    expect(await outboundBodies()).toEqual([FRONT_DESK_REPLY]);
  });

  test('no claims text in the last 7 days: Front Desk answers straight away and Claims never looks', async () => {
    await ninaWithClaim(8);

    await ninaTexts('My claim number is 0451-22.');

    expect(llm.extractionCalls).toHaveLength(0);
    expect(t.jobs.sent.some((j) => j.name === 'claims-reply')).toBe(false);
    expect(await outboundBodies()).toEqual([FRONT_DESK_REPLY]);
  });

  test('a second run of the claims job sends nothing more', async () => {
    await ninaWithClaim();
    llm.scriptExtraction(extraction({ claimNumber: '0451-22' }));
    await ninaTexts('Claim 0451-22.');
    const [job] = t.jobs.sent.filter((j) => j.name === 'claims-reply');

    llm.scriptExtraction(extraction({ claimNumber: '0451-22' }));
    await t.jobs.send('claims-reply', job!.data);
    await t.jobs.drain(t.deps);

    expect(await outboundBodies()).toEqual([CLAIMS_ACK_TEXT]);
    expect(frontDeskAnswers()).toBe(0);
  });
});
