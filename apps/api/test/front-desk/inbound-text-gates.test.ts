import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { beforeEach, describe, expect, test } from 'vitest';
import { blockedNumbers, companies, companyPhoneNumbers, companySettings, encrypt, messages, textingRegistrations, type Tx, withTenant } from '@roofline/db';
import { inCompany } from '../crm-helpers.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from '../helpers.ts';
import { addSmsCustomers, DAYTIME } from '../sms-helpers.ts';

/*
 * Pre-review #25 and Ruling BG: the inbound SMS hook stores every text, but queues no Front Desk text
 * work for a blocked sender or for a read-only company (trial ended, plan canceled).
 */

let t: TestApp;

const A_NUMBER = '+14025550100';
const NINA = '+14025550101';
const TOKEN = 'test-subaccount-token-a';
const BASE = 'https://app.roofline.test';
const SMS = '/hooks/twilio/sms';

const idA = () => t.seed.a.companyId;
const ctxA = () => ({ companyId: idA(), userId: null, role: 'system' as const, canApproveSpend: false });

let sidCounter = 0;
const nextSid = () => `SM${(sidCounter += 1).toString(16).padStart(32, '0')}`;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  await t.deps.pools.system.insert(companyPhoneNumbers).values({ companyId: idA(), e164: A_NUMBER, capabilities: ['sms'], providerSid: 'PN_A' });
  await t.deps.pools.system
    .update(textingRegistrations)
    .set({ subaccountAuthTokenEncrypted: encrypt(TOKEN, TEST_ENCRYPTION_KEY) })
    .where(eq(textingRegistrations.companyId, idA()));
  const values = { frontDeskEnabled: true, frontDeskTexts: true };
  await withTenant(t.deps.pools, ctxA(), (tx) =>
    tx.insert(companySettings).values({ companyId: idA(), ...values }).onConflictDoUpdate({ target: companySettings.companyId, set: values }),
  );
  await addSmsCustomers(t, 'a', [{ firstName: 'Nina', phone: NINA, consent: 'express' as const }]);
});

async function inboundText(body: string) {
  const fields = { MessageSid: nextSid(), AccountSid: `AC${'0'.repeat(32)}`, From: NINA, To: A_NUMBER, Body: body, NumMedia: '0' };
  const signature = twilio.getExpectedTwilioSignature(TOKEN, BASE + SMS, fields);
  const res = await request(t.app).post(SMS).type('form').set('X-Twilio-Signature', signature).send(fields);
  expect(res.status).toBe(200);
}

const fdTextJobs = () => t.jobs.sent.filter((j) => j.name === 'fd-text');
const inboundRows = () =>
  inCompany(t, idA(), (tx: Tx) => tx.select({ id: messages.id }).from(messages).where(and(eq(messages.companyId, idA()), eq(messages.direction, 'in'))));

describe('inbound SMS: who gets Front Desk text work', () => {
  test('a normal text queues Front Desk work (control)', async () => {
    await inboundText('Can someone look at my roof?');
    expect(await inboundRows()).toHaveLength(1);
    expect(fdTextJobs()).toHaveLength(1);
  });

  test('a text from a blocked number is stored but gets no Front Desk work (pre-review #25)', async () => {
    await withTenant(t.deps.pools, ctxA(), (tx) => tx.insert(blockedNumbers).values({ companyId: idA(), e164: NINA, reason: 'spam' }));
    await inboundText('Can someone look at my roof?');
    expect(await inboundRows()).toHaveLength(1);
    expect(fdTextJobs()).toEqual([]);
  });

  test.each(['trial_ended', 'canceled'] as const)('a %s company stores the text but gets no Front Desk work (Ruling BG)', async (status) => {
    await t.deps.pools.system.update(companies).set({ status }).where(eq(companies.id, idA()));
    await inboundText('Can someone look at my roof?');
    expect(await inboundRows()).toHaveLength(1);
    expect(fdTextJobs()).toEqual([]);
  });
});
