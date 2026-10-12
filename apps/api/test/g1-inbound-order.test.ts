import { eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { companyPhoneNumbers, encrypt, messages, textingRegistrations } from '@roofline/db';
import { onClaimsReply } from '../src/agents/claims/replies.ts';
import { type CompanyKey, inCompany } from './crm-helpers.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from './helpers.ts';
import { addSmsCustomers, DAYTIME } from './sms-helpers.ts';

vi.mock('../src/agents/claims/replies.ts', () => ({ onClaimsReply: vi.fn(async () => ({ consumed: false })) }));

/*
 * G1 Task 3: the order of an inbound text (Ruling GX-A). A reply from a known customer goes to the
 * Claims agent after the message is stored; STOP/HELP/START, unknown senders and repeats never do.
 */

let t: TestApp;

const A_NUMBER = '+14025550100';
/** Not a secret: a test value for the subaccount auth token. */
const TOKEN_A = 'test-subaccount-token-a';
const BASE = 'https://app.roofline.test';
const SMS = '/hooks/twilio/sms';
const NINA = '+14025550101';
const STRANGER = '+14025550177';
const EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

const idOf = (company: CompanyKey) => t.seed[company].companyId;

beforeEach(async () => {
  vi.mocked(onClaimsReply).mockReset();
  vi.mocked(onClaimsReply).mockImplementation(async () => ({ consumed: false }));
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  await t.deps.pools.system
    .insert(companyPhoneNumbers)
    .values([{ companyId: idOf('a'), e164: A_NUMBER, capabilities: ['sms'], providerSid: 'PN_A' }]);
  await t.deps.pools.system
    .update(textingRegistrations)
    .set({ subaccountAuthTokenEncrypted: encrypt(TOKEN_A, TEST_ENCRYPTION_KEY) })
    .where(eq(textingRegistrations.companyId, idOf('a')));
});

let sidCounter = 0;
const nextSid = () => `SM${(sidCounter += 1).toString(16).padStart(32, '0')}`;

function inbound(fields: Record<string, string> = {}): Record<string, string> {
  return { MessageSid: nextSid(), AccountSid: `AC${'0'.repeat(32)}`, From: NINA, To: A_NUMBER, Body: 'Is the claim moving?', NumMedia: '0', ...fields };
}

function sms(fields: Record<string, string>) {
  const signature = twilio.getExpectedTwilioSignature(TOKEN_A, BASE + SMS, fields);
  return request(t.app).post(SMS).type('form').set('X-Twilio-Signature', signature).send(fields);
}

const inboundRows = () => inCompany(t, idOf('a'), (tx) => tx.select().from(messages).where(eq(messages.direction, 'in')));

describe('inbound text order: Claims agent first', () => {
  test('an inbound text from a known customer calls onClaimsReply once, after the message row exists', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [{ firstName: 'Nina', phone: NINA, consent: 'express' }]);
    const fields = inbound();
    let rowExisted = false;
    vi.mocked(onClaimsReply).mockImplementation(async () => {
      const rows = await inboundRows();
      rowExisted = rows.some((r) => r.providerMessageSid === fields.MessageSid);
      return { consumed: false };
    });

    const res = await sms(fields);

    expect(res.status).toBe(200);
    expect(onClaimsReply).toHaveBeenCalledTimes(1);
    expect(onClaimsReply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: idOf('a'),
        customerId: c1,
        messageId: expect.any(String),
        body: 'Is the claim moving?',
        receivedAt: expect.any(Date),
      }),
    );
    expect(rowExisted).toBe(true);
  });

  test('when onClaimsReply consumes the reply the hook answers 200 with no TwiML message body', async () => {
    await addSmsCustomers(t, 'a', [{ firstName: 'Nina', phone: NINA, consent: 'express' }]);
    vi.mocked(onClaimsReply).mockResolvedValueOnce({ consumed: true });

    const res = await sms(inbound());

    expect(res.status).toBe(200);
    expect(res.text).toBe(EMPTY);
    expect(await inboundRows()).toMatchObject([{ body: 'Is the claim moving?' }]);
  });

  test.each(['STOP', 'HELP', 'START'])('%s from a known customer never reaches onClaimsReply', async (word) => {
    await addSmsCustomers(t, 'a', [{ firstName: 'Nina', phone: NINA, consent: 'express' }]);

    const res = await sms(inbound({ Body: word }));

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<Message>/);
    expect(onClaimsReply).not.toHaveBeenCalled();
  });

  test('an unknown sender never reaches it, and the message is stored', async () => {
    const res = await sms(inbound({ From: STRANGER }));

    expect(res.status).toBe(200);
    expect(onClaimsReply).not.toHaveBeenCalled();
    expect(await inboundRows()).toMatchObject([{ customerId: null, fromE164: STRANGER }]);
  });

  test('a duplicate delivery of the same MessageSid does not call it twice', async () => {
    await addSmsCustomers(t, 'a', [{ firstName: 'Nina', phone: NINA, consent: 'express' }]);
    const fields = inbound();

    expect((await sms(fields)).status).toBe(200);
    expect((await sms(fields)).status).toBe(200);

    expect(onClaimsReply).toHaveBeenCalledTimes(1);
    expect(await inboundRows()).toHaveLength(1);
  });
});
