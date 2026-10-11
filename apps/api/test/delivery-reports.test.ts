import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { beforeEach, describe, expect, test } from 'vitest';
import { companyPhoneNumbers, earlyDeliveryReports, encrypt, messages, textingRegistrations, webhookEvents } from '@roofline/db';
import type { SmsAdapter, SmsSendResult } from '@roofline/send-gate';
import { Actors, inCompany } from './crm-helpers.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from './helpers.ts';
import { addSmsCustomers, approvedBatch, DAYTIME, gate, rowFor, type SmsCustomer, stepMessages } from './sms-helpers.ts';

/*
 * Task 11: a delivery report that reaches /status before the send is saved is kept and applied
 * when the send is saved; a report with no From is routed by its messaging service; and delivery
 * reports no longer use webhook_events. Requests are signed the way Twilio signs them.
 */

let t: TestApp;
let actors: Actors;

/** Acme's texting number (company_phone_numbers). */
const A_NUMBER = '+14025550100';
const NINA = '+14025550101';
/** Not a secret: a test value for Acme's subaccount auth token. */
const TOKEN_A = 'test-subaccount-token-a';
const BASE = 'https://app.roofline.test';
const STATUS = '/hooks/twilio/status';
const CARRIER = "The carrier couldn't deliver this text.";

/** Holds every send until release(); then answers with the given SID. */
class ReleasableSmsAdapter implements SmsAdapter {
  private readonly gate = gate();

  constructor(private readonly sid: string) {}

  async send(): Promise<SmsSendResult> {
    await this.gate.opened;
    return { providerSid: this.sid, segments: 1 };
  }

  release(): void {
    this.gate.open();
  }
}

const SID = 'SM' + 'b'.repeat(32);
const SENT_SID = 'SM' + 'e'.repeat(32);
const MS_SID = 'MG' + 'c'.repeat(32);
const UNKNOWN_MS_SID = 'MG' + 'd'.repeat(32);

const idOf = (company: 'a' | 'b') => t.seed[company].companyId;

const NINA_CUSTOMER: SmsCustomer = { firstName: 'Nina', phone: NINA, consent: 'attested', state: 'NE', timezone: 'America/Chicago' };

/** A fresh app and database: Acme owns one texting number and has its own token. */
beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  actors = new Actors(t);
  await t.deps.pools.system.insert(companyPhoneNumbers).values([{ companyId: idOf('a'), e164: A_NUMBER, capabilities: ['sms'], providerSid: 'PN_A' }]);
  await t.deps.pools.system
    .update(textingRegistrations)
    .set({ subaccountAuthTokenEncrypted: encrypt(TOKEN_A, TEST_ENCRYPTION_KEY) })
    .where(eq(textingRegistrations.companyId, idOf('a')));
});

type Signing = { token?: string; signature?: string | null; url?: string };

/** POSTs the form, signed with `token` (Acme's by default) for the public URL, as Twilio would. */
function post(path: string, fields: Record<string, string>, signing: Signing = {}) {
  const signature =
    signing.signature !== undefined
      ? signing.signature
      : twilio.getExpectedTwilioSignature(signing.token ?? TOKEN_A, signing.url ?? BASE + path, fields);
  const req = request(t.app).post(path).type('form');
  if (signature !== null) req.set('X-Twilio-Signature', signature);
  return req.send(fields);
}
const status = (fields: Record<string, string>, signing?: Signing) => post(STATUS, fields, signing);

/** The fields of a status callback for one of Acme's texts, from Acme's number to Nina. */
function statusOf(messageSid: string, messageStatus: string, fields: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: messageSid,
    MessageStatus: messageStatus,
    AccountSid: `AC${'0'.repeat(32)}`,
    From: A_NUMBER,
    To: NINA,
    ...fields,
  };
}

/** The fields with one of them left out. */
function without(fields: Record<string, string>, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => key !== name));
}

/** An outbound text of Acme that went out (`sent`) with this provider id. */
async function sentText(providerSid: string): Promise<string> {
  const [row] = await inCompany(t, idOf('a'), (tx) =>
    tx
      .insert(messages)
      .values({
        companyId: idOf('a'),
        customerId: null,
        channel: 'sms',
        direction: 'out',
        purpose: 'informational',
        body: 'Your crew arrives at 9am.',
        status: 'sent',
        sentAt: DAYTIME,
        providerMessageSid: providerSid,
        toE164: NINA,
      })
      .returning(),
  );
  return row!.id;
}

const messageRow = (id: string) => inCompany(t, idOf('a'), async (tx) => (await tx.select().from(messages).where(eq(messages.id, id)))[0]!);
const reportRows = () =>
  inCompany(t, idOf('a'), (tx) => tx.select().from(earlyDeliveryReports).orderBy(asc(earlyDeliveryReports.receivedAt)));
const twilioStatusRows = () => t.deps.pools.system.select().from(webhookEvents).where(eq(webhookEvents.provider, 'twilio-status'));

/**
 * Starts a one-text send to Nina through `adapter`, without waiting for it: the test acts while
 * the provider is holding the text. Returns the send and the message's row id once it exists.
 */
async function startHeldSend(adapter: SmsAdapter) {
  const [nina] = await addSmsCustomers(t, 'a', [NINA_CUSTOMER]);
  const { stepId } = await approvedBatch(t, actors, [nina!]);
  const sending = t.queue.drain({ ...t.deps, sms: adapter });
  return {
    sending,
    async messageId(): Promise<string> {
      return rowFor(await stepMessages(t, 'a', stepId), nina!).id;
    },
  };
}

describe('POST /hooks/twilio/status: reports that arrive before the send is saved', () => {
  test('a delivered report that beats the saved SID is applied when the send is saved', async () => {
    const adapter = new ReleasableSmsAdapter(SID);
    const held = await startHeldSend(adapter);

    const early = await status(statusOf(SID, 'delivered'));
    expect(early.status).toBe(200);
    expect(early.text).toBe('');
    expect(await reportRows()).toMatchObject([{ providerMessageSid: SID, status: 'delivered', appliedAt: null }]);

    adapter.release();
    await held.sending;

    expect(await messageRow(await held.messageId())).toMatchObject({ status: 'delivered', providerMessageSid: SID });
    expect(await reportRows()).toMatchObject([{ providerMessageSid: SID, status: 'delivered' }]);
    expect((await reportRows())[0]!.appliedAt).not.toBeNull();
  });

  test('an early failed report fails the text', async () => {
    const adapter = new ReleasableSmsAdapter(SID);
    const held = await startHeldSend(adapter);

    expect((await status(statusOf(SID, 'failed', { ErrorCode: '30003' }))).status).toBe(200);
    adapter.release();
    await held.sending;

    expect(await messageRow(await held.messageId())).toMatchObject({
      status: 'failed',
      retryable: false,
      blockRule: null,
      blockReason: CARRIER,
    });
    expect(await reportRows()).toMatchObject([{ status: 'failed', reason: CARRIER, appliedAt: expect.any(Date) }]);
  });

  test('a repeated report changes nothing and stores nothing', async () => {
    const adapter = new ReleasableSmsAdapter(SID);
    const held = await startHeldSend(adapter);

    expect((await status(statusOf(SID, 'delivered'))).status).toBe(200);
    expect((await status(statusOf(SID, 'delivered'))).status).toBe(200);
    expect(await reportRows()).toHaveLength(1);

    adapter.release();
    await held.sending;
    const id = await held.messageId();
    expect(await messageRow(id)).toMatchObject({ status: 'delivered' });

    const again = await status(statusOf(SID, 'delivered'));
    expect(again.status).toBe(200);
    expect(again.text).toBe('');
    expect(await reportRows()).toHaveLength(1);
    expect(await messageRow(id)).toMatchObject({ status: 'delivered' });
  });

  test('a report for a number that is no longer active is applied', async () => {
    const text = await sentText(SENT_SID);
    await t.deps.pools.system.update(companyPhoneNumbers).set({ status: 'released' }).where(eq(companyPhoneNumbers.e164, A_NUMBER));

    const res = await status(statusOf(SENT_SID, 'delivered', { From: A_NUMBER }));

    expect(res.status).toBe(200);
    expect(await messageRow(text)).toMatchObject({ status: 'delivered' });
  });

  test('a report with no From is routed by its messaging service', async () => {
    await t.deps.pools.system
      .update(textingRegistrations)
      .set({ messagingServiceSid: MS_SID })
      .where(eq(textingRegistrations.companyId, idOf('a')));
    const text = await sentText(SENT_SID);

    const fields = { ...without(statusOf(SENT_SID, 'delivered'), 'From'), MessagingServiceSid: MS_SID };
    const res = await status(fields);

    expect(res.status).toBe(200);
    expect(await messageRow(text)).toMatchObject({ status: 'delivered' });

    const unknown = await status({ ...without(statusOf(SENT_SID, 'failed'), 'From'), MessagingServiceSid: UNKNOWN_MS_SID });
    expect(unknown.status).toBe(404);
    expect(unknown.text).toBe('');
    expect(await messageRow(text)).toMatchObject({ status: 'delivered' });
  });

  test('delivery reports no longer use webhook_events', async () => {
    const text = await sentText(SENT_SID);

    expect((await status(statusOf(SENT_SID, 'delivered'))).status).toBe(200);
    expect(await messageRow(text)).toMatchObject({ status: 'delivered' });
    expect((await status(statusOf(SID, 'delivered'))).status).toBe(200);
    expect(await reportRows()).toHaveLength(1);

    expect(await twilioStatusRows()).toEqual([]);
  });
});
