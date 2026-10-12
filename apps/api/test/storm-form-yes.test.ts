import { eq } from 'drizzle-orm';
import pg from 'pg';
import request from 'supertest';
import twilio from 'twilio';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { companyPhoneNumbers, customers, encrypt, textingRegistrations } from '@roofline/db';
import { insertOmahaStorm, type Query } from '@roofline/db/testing';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from './helpers.ts';
import { addSmsCustomers, DAYTIME } from './sms-helpers.ts';

/*
 * Ruling BF: a storm form request never gives SMS consent. A Twilio-signed YES from the same phone,
 * within 14 days of a request that asked to be texted, makes the customer express (source web_form).
 * Through the real Twilio inbound hook. Needs Docker; CI only.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const A_NUMBER = '+14025550100';
const MARIA = '+14025550111';
const OTHER = '+14025550122';
const TOKEN = 'test-subaccount-token-a';
const BASE = 'https://app.roofline.test';
const SMS = '/hooks/twilio/sms';

let owner: pg.Pool;
let t: TestApp;
let customerId: string;
let pageId: string;
let sid = 0;

const q: Query = async (text, values) => (await owner.query(text, values)).rows;
const companyId = () => t.seed.a.companyId;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  await t.deps.pools.system
    .insert(companyPhoneNumbers)
    .values({ companyId: companyId(), e164: A_NUMBER, capabilities: ['sms'], providerSid: 'PN_A' });
  await t.deps.pools.system
    .update(textingRegistrations)
    .set({ subaccountAuthTokenEncrypted: encrypt(TOKEN, TEST_ENCRYPTION_KEY) })
    .where(eq(textingRegistrations.companyId, companyId()));
  [customerId] = await addSmsCustomers(t, 'a', [{ firstName: 'Maria', phone: MARIA, consent: 'none', state: 'NE' }]);
  const stormId = await insertOmahaStorm(q, '2026-10-10');
  const [cs] = await q('insert into company_storms (company_id, storm_id, max_in) values ($1, $2, 1.5) returning id', [companyId(), stormId]);
  const [page] = await q(
    'insert into storm_pages (company_id, company_storm_id, code, active_until) values ($1, $2, $3, $4) returning id',
    [companyId(), cs!.id, 'k7m2p5qa', new Date(DAYTIME.getTime() + 30 * DAY_MS)],
  );
  pageId = page!.id as string;
});

/** A storm request from `phone`, made `ageMs` before now, which did (or did not) tick the box. */
async function formRequest(phone: string, ageMs: number, smsConsent = true): Promise<string> {
  const at = new Date(DAYTIME.getTime() - ageMs);
  const [row] = await q(
    `insert into storm_requests (company_id, storm_page_id, name, phone_e164, address, sms_consent, consent_text, consent_at, customer_id, created_at, updated_at)
     values ($1, $2, 'Maria', $3, '1 Elm St', $4, $5, $6, $7, $8, $8) returning id`,
    [companyId(), pageId, phone, smsConsent, smsConsent ? 'Yes, text me.' : null, smsConsent ? at : null, customerId, at],
  );
  return row!.id as string;
}

/** `from` texts `body` to A's number, signed as Twilio would. */
async function text(from: string, body: string): Promise<string> {
  sid += 1;
  const messageSid = `SM${sid.toString(16).padStart(32, '0')}`;
  const fields = { MessageSid: messageSid, From: from, To: A_NUMBER, Body: body, NumMedia: '0' };
  const signature = twilio.getExpectedTwilioSignature(TOKEN, BASE + SMS, fields);
  const res = await request(t.app).post(SMS).type('form').set('X-Twilio-Signature', signature).send(fields);
  expect(res.status).toBe(200);
  return messageSid;
}

const maria = async () => (await inCompany(t, companyId(), (tx) => tx.select().from(customers).where(eq(customers.id, customerId))))[0]!;
const consentAudit = () => q("select * from audit_log where company_id = $1 and action = 'customer.consent_confirmed'", [companyId()]);

describe('a YES from the phone that asked on the storm form', () => {
  test('within 14 days makes the customer express, source web_form, with the request and reply as evidence, and audits it', async () => {
    const requestId = await formRequest(MARIA, 2 * DAY_MS);
    await text(MARIA, 'Yes');
    const row = await maria();
    expect(row.smsConsentStatus).toBe('express');
    expect(row.smsConsentSource).toBe('web_form');
    expect(row.smsConsentEvidence).toMatchObject({ source: 'web_form', stormRequestId: requestId, consentText: 'Yes, text me.' });
    const messageRows = await q("select id from messages where company_id = $1 and direction = 'in'", [companyId()]);
    expect((row.smsConsentEvidence as { replyMessageId: string }).replyMessageId).toBe(messageRows[0]!.id);
    expect(await consentAudit()).toHaveLength(1);
  });

  test('after 14 days changes nothing', async () => {
    await formRequest(MARIA, 15 * DAY_MS);
    await text(MARIA, 'YES');
    expect((await maria()).smsConsentStatus).toBe('none');
    expect(await consentAudit()).toHaveLength(0);
  });

  test('a request that did not ask to be texted changes nothing', async () => {
    await formRequest(MARIA, DAY_MS, false);
    await text(MARIA, 'YES');
    expect((await maria()).smsConsentStatus).toBe('none');
  });

  test('a YES from another number changes nothing', async () => {
    await formRequest(MARIA, DAY_MS);
    await text(OTHER, 'YES');
    expect((await maria()).smsConsentStatus).toBe('none');
    expect(await consentAudit()).toHaveLength(0);
  });

  test('a reply that is not a YES changes nothing', async () => {
    await formRequest(MARIA, DAY_MS);
    await text(MARIA, 'Maybe later');
    expect((await maria()).smsConsentStatus).toBe('none');
  });

  test('STOP keeps its precedence: the customer is revoked, and a later YES does not restore it', async () => {
    await formRequest(MARIA, DAY_MS);
    await text(MARIA, 'STOP');
    await text(MARIA, 'YES');
    expect((await maria()).smsConsentStatus).toBe('revoked');
    expect(await consentAudit()).toHaveLength(0);
  });

  test('do-not-contact and existing express consent are left as they are', async () => {
    await formRequest(MARIA, DAY_MS);
    await q('update customers set do_not_contact = true where id = $1', [customerId]);
    await text(MARIA, 'YES');
    expect((await maria()).smsConsentStatus).toBe('none');
    await q("update customers set do_not_contact = false, sms_consent_status = 'express', sms_consent_source = 'manual' where id = $1", [customerId]);
    await text(MARIA, 'yes');
    expect((await maria()).smsConsentSource).toBe('manual');
    expect(await consentAudit()).toHaveLength(0);
  });
});
