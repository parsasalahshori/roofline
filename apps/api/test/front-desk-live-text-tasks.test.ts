import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  agentTaskEvents,
  agentTasks,
  agentTaskSteps,
  companyPhoneNumbers,
  companySettings,
  conversations,
  encrypt,
  textingRegistrations,
  type Tx,
  withTenant,
} from '@roofline/db';
import { ScriptedLlm } from '../src/providers/fakes/scripted-llm.ts';
import type { RouteDecision } from '../src/providers/llm.ts';
import { Actors, inCompany } from './crm-helpers.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from './helpers.ts';
import { addSmsCustomers, DAY, DAYTIME, MINUTE } from './sms-helpers.ts';

/*
 * A1 Task 4: Front Desk text conversations become live agent tasks (one per conversation per company-local day).
 * Inbound texts go through the real /hooks/twilio/sms route; the fd-text job is drained by hand.
 */

let t: TestApp;
let actors: Actors;

const A_NUMBER = '+14025550100';
const NINA = '+14025550101';
const TOKEN = 'test-subaccount-token-a';
const BASE = 'https://app.roofline.test';
const SMS = '/hooks/twilio/sms';
const OPUS: RouteDecision = { intent: 'other', urgent: false, mood: 'calm', route: 'opus', fastReply: null };

const idA = () => t.seed.a.companyId;
const idB = () => t.seed.b.companyId;

let sidCounter = 0;
const nextSid = () => `SM${(sidCounter += 1).toString(16).padStart(32, '0')}`;

async function inboundText(body: string) {
  const fields = { MessageSid: nextSid(), AccountSid: `AC${'0'.repeat(32)}`, From: NINA, To: A_NUMBER, Body: body, NumMedia: '0' };
  const signature = twilio.getExpectedTwilioSignature(TOKEN, BASE + SMS, fields);
  const res = await request(t.app).post(SMS).type('form').set('X-Twilio-Signature', signature).send(fields);
  expect(res.status).toBe(200);
}

const tasksOf = (companyId: string) => inCompany(t, companyId, (tx: Tx) => tx.select().from(agentTasks).orderBy(asc(agentTasks.createdAt)));
const stepsOf = (companyId: string) => inCompany(t, companyId, (tx: Tx) => tx.select().from(agentTaskSteps));
const eventsOf = (companyId: string, taskId: string) =>
  inCompany(t, companyId, (tx: Tx) => tx.select().from(agentTaskEvents).where(eq(agentTaskEvents.taskId, taskId)));

/** Texts in, drains the debounced job: one reply goes out. */
async function exchange(question: string) {
  await inboundText(question);
  await t.jobs.drain(t.deps);
}

describe('Front Desk live text tasks', () => {
  beforeEach(async () => {
    t = await makeTestApp();
    actors = new Actors(t);
    t.clock.set(DAYTIME);
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
    const values = { frontDeskEnabled: true, frontDeskTexts: true };
    const ctx = { companyId: idA(), userId: null, role: 'system' as const, canApproveSpend: false };
    await withTenant(t.deps.pools, ctx, (tx) =>
      tx.insert(companySettings).values({ companyId: idA(), ...values }).onConflictDoUpdate({ target: companySettings.companyId, set: values }),
    );
    await addSmsCustomers(t, 'a', [{ firstName: 'Nina', phone: NINA, consent: 'express' as const }]);
  });

  test('a Front Desk text reply makes one live front_desk text_conversation task with a front_desk_texts step (result replies 1)', async () => {
    await exchange('Hi, I think I have hail damage');
    expect(t.sms.sent).toHaveLength(1);
    const tasks = await tasksOf(idA());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ agent: 'front_desk', kind: 'text_conversation', mode: 'live' });
    const steps = await stepsOf(idA());
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: 'front_desk_texts', status: 'done' });
    expect(steps[0]!.result).toMatchObject({ replies: 1, bookings: 0 });
  });

  test('a second reply in the same conversation on the same local day does not add a task', async () => {
    await exchange('First question');
    t.clock.advance(10 * MINUTE);
    await exchange('Second question');
    expect(t.sms.sent).toHaveLength(2);
    expect(await tasksOf(idA())).toHaveLength(1);
    expect(await stepsOf(idA())).toHaveLength(1);
    const [step] = await stepsOf(idA());
    expect(step!.result).toMatchObject({ replies: 2, bookings: 0 });
    const [task] = await tasksOf(idA());
    expect(Number(task!.minutesSaved)).toBe(4);
  });

  test('a reply the next local day (advance the test clock 24h+) makes a new task', async () => {
    await exchange('First question');
    t.clock.advance(DAY + 2 * 60 * MINUTE);
    await exchange('Question the next day');
    expect(t.sms.sent).toHaveLength(2);
    expect(await tasksOf(idA())).toHaveLength(2);
  });

  test('the text task is mode live, status done, one finished event', async () => {
    await exchange('Hello there');
    const [task] = await tasksOf(idA());
    expect(task).toMatchObject({ mode: 'live', status: 'done' });
    const events = await eventsOf(idA(), task!.id);
    expect(events.filter((e) => e.kind === 'finished')).toHaveLength(1);
  });

  test('text tasks never appear in GET /api/approvals', async () => {
    await exchange('Hello there');
    expect(await tasksOf(idA())).toHaveLength(1);
    const res = await (await actors.as('owner')).get('/api/approvals');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  test('company B cannot see company A text task', async () => {
    await exchange('Hello there');
    expect(await tasksOf(idA())).toHaveLength(1);
    expect(await tasksOf(idB())).toHaveLength(0);
    expect(await stepsOf(idB())).toHaveLength(0);
    const tasksA = await tasksOf(idA());
    expect(await eventsOf(idB(), tasksA[0]!.id)).toHaveLength(0);
    const convs = await inCompany(t, idB(), (tx: Tx) => tx.select().from(conversations));
    expect(convs).toHaveLength(0);
  });
});
