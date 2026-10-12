import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  agentSettings,
  agentTaskEvents,
  agentTasks,
  calls,
  companyPhoneNumbers,
  companySettings,
  conversations,
  conversationTurns,
  customers,
  encrypt,
  jobs,
  messages,
  textingRegistrations,
  type ToolCallRecord,
  type Tx,
  withTenant,
} from '@roofline/db';
import { runAfterCall } from '../src/front-desk/after-call.ts';
import { ScriptedLlm } from '../src/providers/fakes/scripted-llm.ts';
import { Actors, addressFor, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from './helpers.ts';
import { addSmsCustomers, DAYTIME } from './sms-helpers.ts';
import type { RouteDecision } from '../src/providers/llm.ts';

/*
 * A1 Task 22: combined fixes (AI-handled calls only, pause covers queued texts, archive closes the live task).
 * Modelled on A1 Task 4's live-task tests. The real runAfterCall runs against the database with a
 * ScriptedLlm. Database-backed: CI runs it.
 */

let t: TestApp;
let who: Actors;
let sidCounter = 0;

const A_NUMBER = '+14025550100';
const B_NUMBER = '+14025550200';
const CALLER = '+14025550999';
const idA = () => t.seed.a.companyId;
const idB = () => t.seed.b.companyId;
const nextSid = (): string => `CA${String(++sidCounter).padStart(32, '0')}`;

const MESSAGE_TOOL: ToolCallRecord = { name: 'take_message', input: {}, result: 'ok', ok: true };

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  who = new Actors(t);
  (t.deps as unknown as { llm: ScriptedLlm }).llm = new ScriptedLlm([], { summary: 'The caller asked about a leak.' });
});

type Seed = { noConversation?: boolean; aiSeconds?: number; aiStarted?: boolean; spam?: boolean; toolCalls?: ToolCallRecord[]; company?: 'a' | 'b' };
type Seeded = { callId: string; callSid: string; customerId: string | null; companyId: string };

/** A finished call (with its conversation, customer and one caller turn) as the relay would have left it. */
async function seedCall(o: Seed = {}): Promise<Seeded> {
  const companyId = o.company === 'b' ? idB() : idA();
  const callSid = nextSid();
  return inCompany(t, companyId, async (tx) => {
    let customerId: string | null = null;
    let conversationId: string | null = null;
    if (o.spam !== true && o.noConversation !== true) {
      const [c] = await tx
        .insert(customers)
        .values({ companyId, displayName: 'Nina Customer', firstName: 'Nina', phones: [{ e164: CALLER, label: 'mobile', primary: true }] })
        .returning({ id: customers.id });
      customerId = c!.id;
      const [conv] = await tx
        .insert(conversations)
        .values({ companyId, channel: 'voice', customerId, phoneE164: CALLER, companyNumberE164: A_NUMBER, status: 'active' })
        .returning({ id: conversations.id });
      conversationId = conv!.id;
    }
    const [call] = await tx
      .insert(calls)
      .values({
        companyId,
        callSid,
        fromE164: CALLER,
        toE164: o.company === 'b' ? B_NUMBER : A_NUMBER,
        status: 'ended',
        conversationId,
        aiSeconds: o.aiSeconds ?? 0,
        aiStartedAt: o.aiStarted === true ? t.clock.now() : null,
        spamReason: o.spam === true ? 'robocall' : null,
        transcriptStored: false,
        startedAt: t.clock.now(),
        endedAt: t.clock.now(),
      })
      .returning({ id: calls.id });
    if (conversationId !== null) {
      await tx.insert(conversationTurns).values({ companyId, conversationId, callId: call!.id, position: 0, speaker: 'caller', text: 'Hello' });
      await tx.insert(conversationTurns).values({
        companyId,
        conversationId,
        callId: call!.id,
        position: 1,
        speaker: 'assistant',
        text: 'One moment.',
        toolCalls: o.toolCalls ?? null,
      });
    }
    return { callId: call!.id, callSid, customerId, companyId };
  });
}

const run = (s: Seeded) => runAfterCall(t.deps, { companyId: s.companyId, callSid: s.callSid });

const liveTasks = (companyId: string = idA()) =>
  inCompany(t, companyId, (tx) => tx.select().from(agentTasks).where(and(eq(agentTasks.kind, 'call'), eq(agentTasks.mode, 'live'))));
const eventKinds = (taskId: string, companyId: string = idA()) =>
  inCompany(t, companyId, async (tx) =>
    (await tx.select().from(agentTaskEvents).where(eq(agentTaskEvents.taskId, taskId))).map((e) => e.kind),
  );


/** Gives the seeded customer a job with a next step, through the API. */
async function jobWithNextStep(customerId: string, nextStep: string | null = 'Call Nina back') {
  const owner = await who.as('owner');
  const property = await mustCreate(owner, '/api/properties', { customerId, ...addressFor(0) });
  const job = await mustCreate(owner, '/api/jobs', { customerId, propertyId: property.id });
  if (nextStep !== null) {
    await inCompany(t, idA(), (tx) => tx.update(jobs).set({ nextStep }).where(eq(jobs.id, job.id)));
  }
  return job;
}

const NINA = '+14025550101';
const TOKEN = 'test-subaccount-token-a';
const BASE = 'https://app.roofline.test';
const SMS = '/hooks/twilio/sms';
const OPUS: RouteDecision = { intent: 'other', urgent: false, mood: 'calm', route: 'opus', fastReply: null };
let smsCounter = 0;

async function inboundText(text: string) {
  const sid = `SM${(smsCounter += 1).toString(16).padStart(32, '0')}`;
  const fields = { MessageSid: sid, AccountSid: `AC${'0'.repeat(32)}`, From: NINA, To: A_NUMBER, Body: text, NumMedia: '0' };
  const signature = twilio.getExpectedTwilioSignature(TOKEN, BASE + SMS, fields);
  const res = await request(t.app).post(SMS).type('form').set('X-Twilio-Signature', signature).send(fields);
  expect(res.status).toBe(200);
}

const allTasks = (companyId: string = idA()) => inCompany(t, companyId, (tx: Tx) => tx.select().from(agentTasks));

describe('Front Desk combined fixes', () => {
  test('a paused call with no conversation and no AI seconds creates no live task', async () => {
    const s = await seedCall({ noConversation: true, aiSeconds: 0 });
    await run(s);
    expect(await liveTasks()).toHaveLength(0);
  });

  test('an AI-answered call whose AI seconds are not recorded yet still creates its live task', async () => {
    // The relay sets ai_started_at when the AI picks up, but adds ai_seconds only after the call settles,
    // which can be after the after-call job ran; nothing links calls.conversation_id on this base.
    const s = await seedCall({ noConversation: true, aiStarted: true, aiSeconds: 0 });
    await run(s);
    expect(await liveTasks()).toHaveLength(1);
  });

  test('a spam call still creates its live task', async () => {
    const s = await seedCall({ spam: true, aiSeconds: 0 });
    await run(s);
    const rows = await liveTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Spam call blocked');
  });

  test('a queued Front Desk text does not reply once the agent is paused', async () => {
    (t.deps as unknown as { llm: ScriptedLlm }).llm = new ScriptedLlm([
      { when: /./, route: OPUS, answer: [{ kind: 'text', text: 'We can help with that.' }] },
    ]);
    await t.deps.pools.system
      .insert(companyPhoneNumbers)
      .values({ companyId: idA(), e164: A_NUMBER, capabilities: ['sms'], providerSid: 'PN_A' });
    await t.deps.pools.system
      .update(textingRegistrations)
      .set({ subaccountAuthTokenEncrypted: encrypt(TOKEN, TEST_ENCRYPTION_KEY) })
      .where(eq(textingRegistrations.companyId, idA()));
    const ctx = { companyId: idA(), userId: null, role: 'system' as const, canApproveSpend: false };
    const values = { frontDeskEnabled: true, frontDeskTexts: true };
    await withTenant(t.deps.pools, ctx, (tx) =>
      tx.insert(companySettings).values({ companyId: idA(), ...values }).onConflictDoUpdate({ target: companySettings.companyId, set: values }),
    );
    await addSmsCustomers(t, 'a', [{ firstName: 'Nina', phone: NINA, consent: 'express' as const }]);

    await inboundText('Hi, I think I have hail damage');
    await withTenant(t.deps.pools, ctx, (tx) => tx.insert(agentSettings).values({ companyId: idA(), agent: 'front_desk', pausedAt: new Date() }));
    await t.jobs.drain(t.deps);

    expect(t.sms.sent).toHaveLength(0);
    const out = await inCompany(t, idA(), (tx: Tx) => tx.select({ id: messages.id }).from(messages).where(eq(messages.direction, 'out')));
    expect(out).toHaveLength(0);
    expect(await allTasks()).toHaveLength(0);
  });

  test('archiving a job closes its open live Front Desk task with one finished event', async () => {
    const s = await seedCall({ aiSeconds: 90, toolCalls: [MESSAGE_TOOL] });
    const job = await jobWithNextStep(s.customerId!);
    await run(s);
    const before = await liveTasks();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ status: 'needs_attention', subjectType: 'job', subjectId: job.id });

    const owner = await who.as('owner');
    const res = await owner.post(`/api/jobs/${job.id}/archive`);
    expect(res.status).toBe(200);

    const [after] = await liveTasks();
    expect(after!.status).toBe('done');
    expect((await eventKinds(after!.id)).filter((k) => k === 'finished')).toHaveLength(1);
  });
});
