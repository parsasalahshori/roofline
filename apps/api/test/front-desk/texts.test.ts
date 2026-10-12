import { and, asc, eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  companyPhoneNumbers,
  companySettings,
  conversations,
  encrypt,
  messages,
  textingRegistrations,
  type Tx,
  withTenant,
} from '@roofline/db';
import { TEXT_CHANNEL_TOOLS } from '@roofline/shared';
import { createEngine } from '../../src/front-desk/engine.ts';
import type { Engine } from '../../src/front-desk/engine-types.ts';
import { queueFrontDeskText, runFrontDeskText } from '../../src/front-desk/texts.ts';
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

async function setFrontDesk(values: { frontDeskEnabled: boolean; frontDeskTexts: boolean }) {
  await t.deps.pools.system
    .insert(companySettings)
    .values({ companyId: idA(), ...values })
    .onConflictDoUpdate({ target: companySettings.companyId, set: values });
}

/** POSTs an inbound text from Nina to A's number, signed as Twilio would. */
async function inboundText(body: string, from = NINA) {
  const fields = { MessageSid: nextSid(), AccountSid: `AC${'0'.repeat(32)}`, From: from, To: A_NUMBER, Body: body, NumMedia: '0' };
  const signature = twilio.getExpectedTwilioSignature(TOKEN, BASE + SMS, fields);
  const res = await request(t.app).post(SMS).type('form').set('X-Twilio-Signature', signature).send(fields);
  expect(res.status).toBe(200);
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

  test('a text that arrives while the engine runs gets its own reply', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('First question');
    t.jobs.sent.length = 0;
    const real = createEngine(t.deps, {});
    let injected = false;
    const engine: Engine = {
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
        yield* real.turn(state, text, signal);
      },
    };
    await runFrontDeskText(t.deps, { companyId: idA(), conversationId: (await conversationRows())[0]!.id }, engine);
    expect(t.sms.sent).toHaveLength(0);
    await t.jobs.drain(t.deps);
    expect(t.sms.sent).toHaveLength(1);
    const calls = answerCalls(llm);
    const prompt = JSON.stringify(calls[calls.length - 1]!.request);
    expect(prompt).toContain('First question');
    expect(prompt).toContain('Second question');
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

  test('guard applied to texts', async () => {
    llm = await setup([{ when: /./, route: OPUS, answer: [{ kind: 'text', text: 'The repair will cost $500 total.' }] }]);
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('How much is a repair?');
    await t.jobs.drain(t.deps);
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]!.body).not.toMatch(/\$|500/);
  });

  test('the C / confirm shortcut is routed through the engine for now', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    await inboundText('C');
    await t.jobs.drain(t.deps);
    // TODO(Task 8): this becomes the confirm helper's reply once it exists.
    expect(answerCalls(llm)).toHaveLength(1);
    expect(t.sms.sent).toHaveLength(1);
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
    expect((call!.request as { tools: string[] }).tools).toEqual([...TEXT_CHANNEL_TOOLS]);
  });
});
