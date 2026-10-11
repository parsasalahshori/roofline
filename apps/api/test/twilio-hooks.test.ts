import { asc, eq } from 'drizzle-orm';
import pg from 'pg';
import request from 'supertest';
import twilio from 'twilio';
import { afterAll, afterEach, beforeEach, describe, expect, inject, test, vi } from 'vitest';
import {
  activities,
  auditLog,
  companies,
  companyPhoneNumbers,
  customers,
  encrypt,
  ensureOptOuts,
  lockRecipient,
  messages,
  optOuts,
  textingRegistrations,
  webhookEvents,
  withTenant,
} from '@roofline/db';
import type { Config } from '../src/config.ts';
import { escapeXml } from '../src/hooks/twilio.ts';
import { dispatchDueMessages } from '../src/jobs/scheduler/dispatch-messages.ts';
import { Actors, type CompanyKey, dbCustomer, inCompany, timeline } from './crm-helpers.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from './helpers.ts';
import {
  addSmsCustomers,
  approvedBatch,
  BATCH_AT,
  BRIEF_FIVE,
  DAYTIME,
  gate,
  HOUR,
  MINUTE,
  NEXT_MORNING_NY,
  OPTED_OUT,
  rowFor,
  type SmsCustomer,
  stepMessages,
} from './sms-helpers.ts';

/*
 * Task 18: Twilio's inbound-text and delivery-status webhooks (spec 4.5), with R22/R24.
 * Requests are signed the way Twilio signs them (`getExpectedTwilioSignature` over the public URL
 * and the form fields), with each company's own subaccount token, stored encrypted.
 */

let t: TestApp;

/** The texting numbers (company_phone_numbers) of A and B. Not the profile phone (`companies.phone_e164`). */
const A_NUMBER = '+14025550100';
const B_NUMBER = '+14025550200';
/** Not secrets: test values for the subaccount auth tokens and the platform's fallback token. */
const TOKEN = { a: 'test-subaccount-token-a', b: 'test-subaccount-token-b' } as const;
const MASTER_TOKEN = 'test-master-token';
const BASE = 'https://app.roofline.test';
const SMS = '/hooks/twilio/sms';
const STATUS = '/hooks/twilio/status';

const NINA = '+14025550101';
const STRANGER = '+14025550177';

const EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
const UNSUBSCRIBED = "You're unsubscribed from Acme Roofing texts. No more messages will be sent. Reply START to resubscribe.";
const RESUBSCRIBED = "You're resubscribed to Acme Roofing texts. Reply STOP to opt out.";
const HELP_REPLY = 'Acme Roofing: call us at (402) 555-0199. Reply STOP to opt out.';
const STOP_LINE = 'Texted STOP. Texting is turned off.';
const START_LINE = 'Texted START. Updates are back on.';
const POSSIBLE = 'Possible opt-out. Please check this message.';
const CARRIER = "The carrier couldn't deliver this text.";

const idOf = (company: CompanyKey) => t.seed[company].companyId;

async function setToken(company: CompanyKey, token: string | null) {
  await t.deps.pools.system
    .update(textingRegistrations)
    .set({ subaccountAuthTokenEncrypted: token === null ? null : encrypt(token, TEST_ENCRYPTION_KEY) })
    .where(eq(textingRegistrations.companyId, idOf(company)));
}

/** A fresh app and database: A and B each own one texting number and have their own token. */
async function setup(overrides: Partial<Config> = {}) {
  t = await makeTestApp(overrides);
  t.clock.set(DAYTIME);
  await t.deps.pools.system.insert(companyPhoneNumbers).values([
    { companyId: idOf('a'), e164: A_NUMBER, capabilities: ['sms'], providerSid: 'PN_A' },
    { companyId: idOf('b'), e164: B_NUMBER, capabilities: ['sms'], providerSid: 'PN_B' },
  ]);
  await setToken('a', TOKEN.a);
  await setToken('b', TOKEN.b);
}

beforeEach(async () => {
  await setup();
});

let sidCounter = 0;
/** A fresh MessageSid in Twilio's format: SM and 32 lowercase hex digits. */
const nextSid = () => `SM${(sidCounter += 1).toString(16).padStart(32, '0')}`;
/** The provider ids of A's (or B's) outbound texts in the status tests. */
const OUT = (n: number) => `SM${'ab'.repeat(15)}${n.toString(16).padStart(2, '0')}`;
const IN_SID = `SM${'cd'.repeat(16)}`;

/** The fields Twilio posts for an inbound text, to A's number from Nina unless overridden. */
function inbound(fields: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: nextSid(),
    AccountSid: `AC${'0'.repeat(32)}`,
    From: NINA,
    To: A_NUMBER,
    Body: 'STOP',
    NumMedia: '0',
    ...fields,
  };
}

/** The fields of a status callback for one of A's outbound texts. */
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

type Signing = { token?: string; signature?: string | null; url?: string };

/** POSTs the form, signed with `token` (A's by default) for the public URL, as Twilio would. */
function post(path: string, fields: Record<string, string>, signing: Signing = {}) {
  const signature =
    signing.signature !== undefined
      ? signing.signature
      : twilio.getExpectedTwilioSignature(signing.token ?? TOKEN.a, signing.url ?? BASE + path, fields);
  const req = request(t.app).post(path).type('form');
  if (signature !== null) req.set('X-Twilio-Signature', signature);
  return req.send(fields);
}
const sms = (fields: Record<string, string>, signing?: Signing) => post(SMS, fields, signing);
const status = (fields: Record<string, string>, signing?: Signing) => post(STATUS, fields, signing);

/** The text of the TwiML reply's <Message>, with XML entities decoded; null when there is none. */
function messageOf(xml: string): string | null {
  const m = /^<\?xml version="1\.0" encoding="UTF-8"\?><Response><Message>([^<]*)<\/Message><\/Response>$/.exec(xml);
  if (!m) return null;
  return m[1]!
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

const inboundRows = (company: CompanyKey) =>
  inCompany(t, idOf(company), (tx) =>
    tx.select().from(messages).where(eq(messages.direction, 'in')).orderBy(asc(messages.createdAt), asc(messages.id)),
  );
const optOutRows = (company: CompanyKey) => inCompany(t, idOf(company), (tx) => tx.select().from(optOuts));
const auditRows = (company: CompanyKey, action: string) =>
  inCompany(t, idOf(company), (tx) => tx.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(asc(auditLog.targetId)));
const activityRows = (company: CompanyKey, kind: string) =>
  inCompany(t, idOf(company), (tx) => tx.select().from(activities).where(eq(activities.kind, kind)));
const webhookRows = () => t.deps.pools.system.select().from(webhookEvents);

/** Customers of a company, added one at a time with the clock moving on, so their creation order is known. */
async function addInOrder(company: CompanyKey, list: SmsCustomer[]): Promise<string[]> {
  const ids: string[] = [];
  for (const c of list) {
    const [id] = await addSmsCustomers(t, company, [c]);
    ids.push(id!);
    t.clock.advance(MINUTE);
  }
  t.clock.set(DAYTIME);
  return ids;
}

const nina = (overrides: Partial<SmsCustomer> = {}): SmsCustomer => ({ firstName: 'Nina', phone: NINA, consent: 'express', ...overrides });

/** An outbound text of company A that went out (`sent`) with this provider id. */
async function sentText(providerSid: string, customerId: string | null = null, company: CompanyKey = 'a') {
  const [row] = await inCompany(t, idOf(company), (tx) =>
    tx
      .insert(messages)
      .values({
        companyId: idOf(company),
        customerId,
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
  return row!;
}

const messageRow = (company: CompanyKey, id: string) =>
  inCompany(t, idOf(company), async (tx) => (await tx.select().from(messages).where(eq(messages.id, id)))[0]!);

/** Nothing at all was written for a refused request. */
async function nothingWritten() {
  expect(await inboundRows('a')).toEqual([]);
  expect(await inboundRows('b')).toEqual([]);
  expect(await optOutRows('a')).toEqual([]);
  expect(await webhookRows()).toEqual([]);
  expect(await auditRows('a', 'customer.consent_revoked')).toEqual([]);
}

// ---------------------------------------------------------------------------------------------

describe('POST /hooks/twilio/sms: the brief', () => {
  test('a STOP from c1: opt-out row, consent revoked by text, an audit row, and the unsubscribe reply', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina()]);
    const fields = inbound({ Body: 'STOP' });

    const res = await sms(fields);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/xml/);
    expect(res.text).toContain("You're unsubscribed from");
    expect(messageOf(res.text)).toBe(UNSUBSCRIBED);

    expect(await optOutRows('a')).toMatchObject([{ phoneE164: NINA, keyword: 'stop', at: DAYTIME }]);
    expect(await dbCustomer(t, idOf('a'), c1!)).toMatchObject({
      smsConsentStatus: 'revoked',
      smsConsentSource: 'text',
      smsConsentAt: DAYTIME,
      smsConsentByUserId: null,
      doNotContact: false,
    });
    const audits = await auditRows('a', 'customer.consent_revoked');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: null,
      targetType: 'customer',
      targetId: c1,
      before: { smsConsentStatus: 'express' },
      after: { smsConsentStatus: 'revoked', smsConsentSource: 'text', smsConsentByUserId: null },
      at: DAYTIME,
    });
    expect(await timeline(t, idOf('a'), c1!)).toEqual([['customer.consent_changed', STOP_LINE]]);
    const [line] = await activityRows('a', 'customer.consent_changed');
    expect(line).toMatchObject({ actorType: 'system', actorUserId: null, at: DAYTIME });

    expect(await inboundRows('a')).toMatchObject([
      {
        customerId: c1,
        channel: 'sms',
        direction: 'in',
        purpose: null,
        status: 'received',
        body: 'STOP',
        fromE164: NINA,
        toE164: A_NUMBER,
        providerMessageSid: fields.MessageSid,
        stepId: null,
      },
    ]);
  });

  test('the same MessageSid again → 200 with an empty reply; still one inbound row and one of everything else', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina()]);
    const fields = inbound({ Body: 'STOP' });
    expect((await sms(fields)).status).toBe(200);

    const again = await sms(fields);

    expect(again.status).toBe(200);
    expect(again.headers['content-type']).toMatch(/^text\/xml/);
    expect(again.text).toBe(EMPTY);
    expect(await inboundRows('a')).toHaveLength(1);
    expect(await optOutRows('a')).toHaveLength(1);
    expect(await auditRows('a', 'customer.consent_revoked')).toHaveLength(1);
    expect(await timeline(t, idOf('a'), c1!)).toEqual([['customer.consent_changed', STOP_LINE]]);
    expect(await webhookRows()).toMatchObject([{ provider: 'twilio-sms', eventId: `${idOf('a')}:${fields.MessageSid}` }]);
  });

  test('a bad signature → 403, and nothing is written', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina()]);
    const fields = inbound({ Body: 'STOP' });

    const forged = await sms(fields, { signature: 'bm90IGEgcmVhbCBzaWduYXR1cmU=' });
    expect(forged.status).toBe(403);
    expect(forged.text).toBe('');
    // Signed with another company's token, for another URL, or with no signature at all.
    expect((await sms(fields, { token: TOKEN.b })).status).toBe(403);
    expect((await sms(fields, { token: MASTER_TOKEN })).status).toBe(403);
    expect((await sms(fields, { url: `${BASE}/hooks/twilio/status` })).status).toBe(403);
    expect((await sms(fields, { url: `https://evil.example${SMS}` })).status).toBe(403);
    expect((await sms(fields, { signature: null })).status).toBe(403);
    // A field changed after signing: the signature covers the body too.
    const signedForHello = twilio.getExpectedTwilioSignature(TOKEN.a, BASE + SMS, { ...fields, Body: 'Hello' });
    expect((await sms(fields, { signature: signedForHello })).status).toBe(403);

    await nothingWritten();
    expect((await dbCustomer(t, idOf('a'), c1!)).smsConsentStatus).toBe('express');
  });

  test('an unknown To → 404 with an empty body, and nothing is written', async () => {
    await addSmsCustomers(t, 'a', [nina()]);
    for (const to of ['+14025550999', t.seed.a.phoneE164, 'not-a-number', '4025550100', '']) {
      const res = await sms(inbound({ To: to }));
      expect(res.status, to).toBe(404);
      expect(res.text).toBe('');
    }
    expect((await sms(without(inbound(), 'To'))).status).toBe(404);
    await nothingWritten();
  });

  test('a number that is no longer active → 404', async () => {
    await t.deps.pools.system.update(companyPhoneNumbers).set({ status: 'released' }).where(eq(companyPhoneNumbers.e164, A_NUMBER));
    expect((await sms(inbound())).status).toBe(404);
    await nothingWritten();
  });

  test('"Can you stop by Thursday?" is stored as received, and consent is unchanged (Review Focus #1)', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina()]);

    const res = await sms(inbound({ Body: 'Can you stop by Thursday?' }));

    expect(res.status).toBe(200);
    expect(res.text).toBe(EMPTY);
    expect(await inboundRows('a')).toMatchObject([{ customerId: c1, status: 'received', body: 'Can you stop by Thursday?' }]);
    expect(await dbCustomer(t, idOf('a'), c1!)).toMatchObject({ smsConsentStatus: 'express', smsConsentSource: null });
    expect(await optOutRows('a')).toEqual([]);
    expect(await auditRows('a', 'customer.consent_revoked')).toEqual([]);
    expect(await activityRows('a', 'customer.consent_changed')).toEqual([]);
  });

  test('START after STOP: the opt-out is removed and consent is express, by text', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina()]);
    await sms(inbound({ Body: 'STOP' }));
    t.clock.advance(MINUTE);

    const res = await sms(inbound({ Body: 'Start' }));

    expect(res.status).toBe(200);
    expect(messageOf(res.text)).toBe(RESUBSCRIBED);
    expect(await optOutRows('a')).toEqual([]);
    expect(await dbCustomer(t, idOf('a'), c1!)).toMatchObject({
      smsConsentStatus: 'express',
      smsConsentSource: 'text',
      smsConsentAt: new Date(DAYTIME.getTime() + MINUTE),
      smsConsentByUserId: null,
    });
    expect(await auditRows('a', 'customer.consent_restored')).toMatchObject([
      { actorUserId: null, targetId: c1, before: { smsConsentStatus: 'revoked' }, after: { smsConsentStatus: 'express' } },
    ]);
    expect(await timeline(t, idOf('a'), c1!)).toEqual([
      ['customer.consent_changed', START_LINE],
      ['customer.consent_changed', STOP_LINE],
    ]);
    expect(await inboundRows('a')).toHaveLength(2);
  });

  test('isolation: the message lands in company A only; B sees no inbound rows and its customer is untouched', async () => {
    const [a1] = await addSmsCustomers(t, 'a', [nina()]);
    const [b1] = await addSmsCustomers(t, 'b', [nina()]);

    expect((await sms(inbound({ Body: 'STOP' }))).status).toBe(200);

    expect(await inboundRows('a')).toHaveLength(1);
    expect(await inboundRows('b')).toEqual([]);
    expect(await optOutRows('b')).toEqual([]);
    expect(await auditRows('b', 'customer.consent_revoked')).toEqual([]);
    expect((await dbCustomer(t, idOf('a'), a1!)).smsConsentStatus).toBe('revoked');
    expect((await dbCustomer(t, idOf('b'), b1!)).smsConsentStatus).toBe('express');
  });
});

describe('a STOP that arrives after a text was scheduled (spec 3.7: the whole path, hook then dispatcher)', () => {
  test("Rosa's text is held for 08:00 New York; she texts STOP overnight; the dispatcher asks the gate again and blocks it", async () => {
    t.clock.set(BATCH_AT);
    const [c1, c2, c3, c4, c5] = await addSmsCustomers(t, 'a', BRIEF_FIVE);
    const { stepId } = await approvedBatch(t, new Actors(t), [c1!, c2!, c3!, c4!, c5!]);
    await t.queue.drain(t.deps);
    expect(rowFor(await stepMessages(t, 'a', stepId), c5!)).toMatchObject({ status: 'scheduled', scheduledFor: NEXT_MORNING_NY });
    expect(t.sms.sent).toHaveLength(1); // only Nina's went out that evening

    // Overnight she replies STOP to the company's texting number, through the real webhook.
    t.clock.set(new Date(BATCH_AT.getTime() + 2 * HOUR));
    const res = await sms(inbound({ From: '+13055550105', Body: 'STOP' }));
    expect(res.status).toBe(200);
    expect((await optOutRows('a')).map((o) => o.phoneE164)).toContain('+13055550105');
    expect(await dbCustomer(t, idOf('a'), c5!)).toMatchObject({ smsConsentStatus: 'revoked' });

    // At 08:01 New York the text is due; the dispatcher decides again and the new opt-out wins.
    t.clock.set(new Date(NEXT_MORNING_NY.getTime() + MINUTE));
    await dispatchDueMessages(t.deps, t.clock.now());
    expect(rowFor(await stepMessages(t, 'a', stepId), c5!)).toMatchObject({
      status: 'blocked',
      blockRule: 'contact',
      blockReason: OPTED_OUT,
      sentAt: null,
    });
    expect(t.sms.sent).toHaveLength(1);
  });
});

describe('POST /hooks/twilio/sms: STOP', () => {
  test('several customers share the number: every one of them is revoked, archived ones too; the message is the first active one\'s', async () => {
    const [first, second, archived] = await addInOrder('a', [nina(), nina({ firstName: 'Nora', consent: 'written' }), nina({ firstName: 'Old', consent: 'attested' })]);
    const [other] = await addSmsCustomers(t, 'a', [{ firstName: 'Omar', phone: '+14025550102', consent: 'express' }]);
    await inCompany(t, idOf('a'), (tx) => tx.update(customers).set({ archivedAt: DAYTIME }).where(eq(customers.id, archived!)));

    const res = await sms(inbound({ Body: 'stop' }));

    expect(messageOf(res.text)).toBe(UNSUBSCRIBED);
    for (const id of [first!, second!, archived!]) {
      expect(await dbCustomer(t, idOf('a'), id)).toMatchObject({ smsConsentStatus: 'revoked', smsConsentSource: 'text', smsConsentAt: DAYTIME });
      expect(await timeline(t, idOf('a'), id)).toEqual([['customer.consent_changed', STOP_LINE]]);
    }
    expect((await auditRows('a', 'customer.consent_revoked')).map((r) => r.targetId).sort()).toEqual([first!, second!, archived!].sort());
    expect((await dbCustomer(t, idOf('a'), other!)).smsConsentStatus).toBe('express');
    expect(await inboundRows('a')).toMatchObject([{ customerId: first }]);
    expect(await optOutRows('a')).toHaveLength(1);
  });

  test('a STOP from a number with no customer still puts the number on the opt-out list', async () => {
    const res = await sms(inbound({ From: STRANGER, Body: 'Unsubscribe' }));

    expect(messageOf(res.text)).toBe(UNSUBSCRIBED);
    expect(await optOutRows('a')).toMatchObject([{ phoneE164: STRANGER, keyword: 'unsubscribe', at: DAYTIME }]);
    expect(await inboundRows('a')).toMatchObject([{ customerId: null, fromE164: STRANGER, toE164: A_NUMBER, body: 'Unsubscribe' }]);
    expect(await auditRows('a', 'customer.consent_revoked')).toEqual([]);
  });

  test('the keyword kept is the normalized phrase; a later STOP rewrites an office opt-out with the customer\'s own words', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina({ optedOut: true })]);
    await inCompany(t, idOf('a'), (tx) => tx.update(optOuts).set({ keyword: 'manual' }));
    t.clock.advance(MINUTE);

    await sms(inbound({ Body: "  Don't text me AGAIN!! " }));

    expect(await optOutRows('a')).toMatchObject([{ phoneE164: NINA, keyword: 'dont text me again', at: new Date(DAYTIME.getTime() + MINUTE) }]);
    expect((await dbCustomer(t, idOf('a'), c1!)).smsConsentStatus).toBe('revoked');
  });

  test('a second STOP from someone already revoked is recorded again (a new audit row and line), and they stay revoked', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina()]);
    await sms(inbound({ Body: 'STOP' }));
    t.clock.advance(MINUTE);
    const res = await sms(inbound({ Body: 'STOP STOP STOP' }));

    expect(messageOf(res.text)).toBe(UNSUBSCRIBED);
    expect((await dbCustomer(t, idOf('a'), c1!)).smsConsentStatus).toBe('revoked');
    expect(await auditRows('a', 'customer.consent_revoked')).toHaveLength(2);
    expect(await optOutRows('a')).toHaveLength(1);
  });

  test('a fullwidth ＳＴＯＰ is a STOP', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina()]);
    expect(messageOf((await sms(inbound({ Body: 'ＳＴＯＰ' }))).text)).toBe(UNSUBSCRIBED);
    expect((await dbCustomer(t, idOf('a'), c1!)).smsConsentStatus).toBe('revoked');
    expect(await optOutRows('a')).toMatchObject([{ keyword: 'stop' }]);
  });

  test('a STOP that arrives while a send to that customer holds its texting lock waits for the send, then revokes', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina()]);
    const ctx = { companyId: idOf('a'), userId: null, role: 'system' as const, canApproveSpend: false };
    const locked = gate();
    const release = gate();

    // The send path: decides under lockRecipient (the customer still has consent), then records its text as on its way.
    const send = withTenant(t.deps.pools, ctx, async (tx) => {
      await lockRecipient(tx, ctx, c1!);
      const [row] = await tx.select({ consent: customers.smsConsentStatus }).from(customers).where(eq(customers.id, c1!));
      locked.open();
      await release.opened;
      await tx.insert(messages).values({
        companyId: idOf('a'),
        customerId: c1!,
        channel: 'sms',
        direction: 'out',
        purpose: 'informational',
        body: 'Your crew arrives at 9am.',
        status: 'queued',
        toE164: NINA,
      });
      return row!.consent;
    });
    send.catch(() => locked.open());
    await locked.opened;

    const stopping = sms(inbound({ Body: 'STOP' })).then((r) => r);
    const waited = await untilAdvisoryLockWait();
    // While it waits, nothing of the STOP has happened yet.
    const meanwhile = (await dbCustomer(t, idOf('a'), c1!)).smsConsentStatus;
    const optOutsMeanwhile = await optOutRows('a');
    release.open();

    expect(await send).toBe('express');
    const res = await stopping;
    expect(waited).toBe(true);
    expect(meanwhile).toBe('express');
    expect(optOutsMeanwhile).toEqual([]);
    expect(res.status).toBe(200);
    expect(messageOf(res.text)).toBe(UNSUBSCRIBED);
    expect((await dbCustomer(t, idOf('a'), c1!)).smsConsentStatus).toBe('revoked');
    expect(await optOutRows('a')).toHaveLength(1);
  });
});

describe('POST /hooks/twilio/sms: lock order (M3)', () => {
  test('a STOP and an office edit of a customer sharing the number cannot deadlock: the STOP locks customers before the opt-out list', async () => {
    const [, second] = await addInOrder('a', [nina(), nina({ firstName: 'Nora' })]);
    const ctx = { companyId: idOf('a'), userId: t.seed.a.office.userId, role: 'office' as const, canApproveSpend: false };
    const locked = gate();
    const release = gate();

    // The office edits Nora the way updateCustomer does: her row FOR UPDATE first, then her numbers onto the opt-out list.
    const edit = withTenant(t.deps.pools, ctx, async (tx) => {
      await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, second!)).for('update');
      locked.open();
      await release.opened;
      await ensureOptOuts(tx, ctx, [NINA], DAYTIME);
    });
    edit.catch(() => locked.open());
    await locked.opened;

    const stopping = sms(inbound({ Body: 'STOP' })).then((r) => r);
    const waited = await untilLockWait();
    release.open();

    const [edited, res] = await Promise.allSettled([edit, stopping]);
    expect(waited).toBe(true);
    expect(edited.status).toBe('fulfilled');
    expect(res.status === 'fulfilled' && res.value.status).toBe(200);
    expect((await dbCustomer(t, idOf('a'), second!)).smsConsentStatus).toBe('revoked');
    // The edit's 'manual' row came first; the STOP then wrote the customer's own word over it.
    expect(await optOutRows('a')).toMatchObject([{ phoneE164: NINA, keyword: 'stop' }]);
  });
});

describe('POST /hooks/twilio/sms: HELP, START and everything else', () => {
  test('HELP → the company name and phone, and how to opt out; nothing about consent changes', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina()]);
    const res = await sms(inbound({ Body: 'help' }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/xml/);
    expect(messageOf(res.text)).toBe(HELP_REPLY);
    expect((await dbCustomer(t, idOf('a'), c1!)).smsConsentStatus).toBe('express');
    expect(await inboundRows('a')).toMatchObject([{ body: 'help', status: 'received', customerId: c1 }]);
  });

  test('HELP for a company with no phone on file → just the name and how to opt out', async () => {
    await t.deps.pools.system.update(companies).set({ phoneE164: null }).where(eq(companies.id, idOf('a')));
    expect(messageOf((await sms(inbound({ Body: 'INFO' }))).text)).toBe('Acme Roofing. Reply STOP to opt out.');
  });

  test('START never clears do-not-contact; only revoked customers change; archived ones stay revoked', async () => {
    const [dnc, written, archived] = await addInOrder('a', [
      nina({ consent: 'revoked', doNotContact: true, optedOut: true }),
      nina({ firstName: 'Nora', consent: 'written' }),
      nina({ firstName: 'Old', consent: 'revoked' }),
    ]);
    await inCompany(t, idOf('a'), (tx) => tx.update(customers).set({ archivedAt: DAYTIME }).where(eq(customers.id, archived!)));

    const res = await sms(inbound({ Body: 'START' }));

    expect(messageOf(res.text)).toBe(RESUBSCRIBED);
    expect(await optOutRows('a')).toEqual([]);
    expect(await dbCustomer(t, idOf('a'), dnc!)).toMatchObject({ smsConsentStatus: 'express', smsConsentSource: 'text', doNotContact: true });
    expect(await dbCustomer(t, idOf('a'), written!)).toMatchObject({ smsConsentStatus: 'written', smsConsentSource: null });
    expect((await dbCustomer(t, idOf('a'), archived!)).smsConsentStatus).toBe('revoked');
    expect((await auditRows('a', 'customer.consent_restored')).map((r) => r.targetId)).toEqual([dnc]);
    expect(await timeline(t, idOf('a'), dnc!)).toEqual([['customer.consent_changed', START_LINE]]);
    expect(await timeline(t, idOf('a'), written!)).toEqual([]);
  });

  test('START from a number with no customer takes it off the opt-out list', async () => {
    await sms(inbound({ From: STRANGER, Body: 'STOP' }));
    expect(await optOutRows('a')).toHaveLength(1);
    const res = await sms(inbound({ From: STRANGER, Body: 'unstop' }));
    expect(messageOf(res.text)).toBe(RESUBSCRIBED);
    expect(await optOutRows('a')).toEqual([]);
  });

  test('"Start 9" is not a START: an empty reply, and the customer stays opted out', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina()]);
    await sms(inbound({ Body: 'STOP' }));
    const res = await sms(inbound({ Body: 'Start 9' }));
    expect(res.text).toBe(EMPTY);
    expect((await dbCustomer(t, idOf('a'), c1!)).smsConsentStatus).toBe('revoked');
    expect(await optOutRows('a')).toHaveLength(1);
  });

  test('a message that reads like an opt-out is flagged for a person on each matched customer, and nobody is opted out', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina()]);

    const res = await sms(inbound({ Body: 'Please stop texting me about gutters' }));

    expect(res.text).toBe(EMPTY);
    const [message] = await inboundRows('a');
    expect(await activityRows('a', 'message.possible_opt_out')).toMatchObject([
      { subjectType: 'customer', subjectId: c1, summary: POSSIBLE, actorType: 'system', data: { messageId: message!.id }, at: DAYTIME },
    ]);
    expect((await dbCustomer(t, idOf('a'), c1!)).smsConsentStatus).toBe('express');
    expect(await optOutRows('a')).toEqual([]);
  });

  test('an ordinary message is not flagged', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina()]);
    expect((await sms(inbound({ Body: 'See you Thursday!' }))).text).toBe(EMPTY);
    expect(await activityRows('a', 'message.possible_opt_out')).toEqual([]);
    expect(await timeline(t, idOf('a'), c1!)).toEqual([]);
  });

  test('a possible opt-out from a number with no customer is flagged on the message itself (I2)', async () => {
    const res = await sms(inbound({ From: STRANGER, Body: 'never text me again' }));

    expect(res.text).toBe(EMPTY);
    const [message] = await inboundRows('a');
    expect(message).toMatchObject({ customerId: null, fromE164: STRANGER });
    expect(await activityRows('a', 'message.possible_opt_out')).toMatchObject([
      { subjectType: 'message', subjectId: message!.id, summary: POSSIBLE, actorType: 'system', data: { messageId: message!.id } },
    ]);
    expect(await optOutRows('a')).toEqual([]);

    // The owner and the office can read it on the message's timeline; a rep cannot see a message with no customer.
    const actors = new Actors(t);
    const url = `/api/activities?subjectType=message&subjectId=${message!.id}`;
    const owner = await (await actors.as('owner')).get(url);
    expect(owner.status).toBe(200);
    expect(owner.body.activities).toMatchObject([{ subjectType: 'message', kind: 'message.possible_opt_out', summary: POSSIBLE }]);
    expect((await (await actors.as('office')).get(url)).status).toBe(200);
    expect((await (await actors.as('rep')).get(url)).status).toBe(404);
    expect((await (await actors.as('owner', 'b')).get(url)).status).toBe(404);
  });

  test("polite and alternate opt-outs end to end: STOP, or flagged on the customer's timeline (I2)", async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina()]);
    expect(messageOf((await sms(inbound({ Body: 'Please take me off your list' }))).text)).toBe(UNSUBSCRIBED);
    expect(await optOutRows('a')).toMatchObject([{ keyword: 'please take me off your list' }]);
    expect((await dbCustomer(t, idOf('a'), c1!)).smsConsentStatus).toBe('revoked');

    const [c2] = await addSmsCustomers(t, 'a', [{ firstName: 'Omar', phone: '+14025550102', consent: 'express' }]);
    expect((await sms(inbound({ From: '+14025550102', Body: 'I want to cancel these texts' }))).text).toBe(EMPTY);
    expect((await dbCustomer(t, idOf('a'), c2!)).smsConsentStatus).toBe('express');
    expect(await timeline(t, idOf('a'), c2!)).toEqual([['message.possible_opt_out', POSSIBLE]]);
  });

  test('every dynamic part of the reply is XML-escaped: a company called "Bob & <Sons>"', async () => {
    await t.deps.pools.system.update(companies).set({ name: 'Bob & <Sons>' }).where(eq(companies.id, idOf('a')));

    const stop = await sms(inbound({ Body: 'STOP' }));
    expect(stop.text).toContain('Bob &amp; &lt;Sons&gt;');
    expect(stop.text).not.toContain('<Sons>');
    expect(messageOf(stop.text)).toBe(UNSUBSCRIBED.replace('Acme Roofing', 'Bob & <Sons>'));

    const help = await sms(inbound({ Body: 'HELP' }));
    expect(messageOf(help.text)).toBe(HELP_REPLY.replace('Acme Roofing', 'Bob & <Sons>'));
    const start = await sms(inbound({ Body: 'START' }));
    expect(messageOf(start.text)).toBe(RESUBSCRIBED.replace('Acme Roofing', 'Bob & <Sons>'));
  });

  test('characters XML 1.0 forbids are dropped from the reply: a company name with U+0007 (M9)', async () => {
    await t.deps.pools.system.update(companies).set({ name: 'Acme\u0007 Roofing\uFFFE' }).where(eq(companies.id, idOf('a')));
    const res = await sms(inbound({ Body: 'STOP' }));
    expect([...res.text].filter((ch) => ch === '\u0007' || ch === '\uFFFE')).toEqual([]);
    expect(messageOf(res.text)).toBe(UNSUBSCRIBED);
  });

  test('escapeXml: the five special characters become entities; everything XML 1.0 forbids is dropped', () => {
    expect(escapeXml(`Bob & <Sons> "R" 'Us'`)).toBe('Bob &amp; &lt;Sons&gt; &quot;R&quot; &apos;Us&apos;');
    const forbidden = ['\u0000', '\u0001', '\u0007', '\u0008', '\u000B', '\u000C', '\u000E', '\u001F', '\uFFFE', '\uFFFF', '\uD800', '\uDFFF'];
    for (const ch of forbidden) expect(escapeXml(`a${ch}b`), JSON.stringify(ch)).toBe('ab');
    // Tab, newline and carriage return are allowed, and so is everything else, astral characters included.
    expect(escapeXml('a\tb\nc\rd é 屋根 🙏 \u007F \uFFFD')).toBe('a\tb\nc\rd é 屋根 🙏 \u007F \uFFFD');
  });

  test("B's number is B's: its message lands in B, signed with B's token, and A's token is refused there", async () => {
    const [b1] = await addSmsCustomers(t, 'b', [nina()]);
    expect((await sms(inbound({ To: B_NUMBER }), { token: TOKEN.a })).status).toBe(403);

    const res = await sms(inbound({ To: B_NUMBER }), { token: TOKEN.b });

    expect(messageOf(res.text)).toBe(UNSUBSCRIBED.replace('Acme Roofing', 'Bolt Roofing'));
    expect(await inboundRows('b')).toMatchObject([{ customerId: b1, toE164: B_NUMBER }]);
    expect(await inboundRows('a')).toEqual([]);
    expect(await optOutRows('a')).toEqual([]);
  });
});

describe('POST /hooks/twilio/sms: signing tokens, bad requests and failures', () => {
  test('no signing token for the company (none stored, no TWILIO_AUTH_TOKEN) → 403, nothing written', async () => {
    await setToken('a', null);
    expect((await sms(inbound(), { token: TOKEN.a })).status).toBe(403);
    expect((await sms(inbound(), { token: MASTER_TOKEN })).status).toBe(403);
    await nothingWritten();
  });

  test('no stored token: the platform TWILIO_AUTH_TOKEN signs instead', async () => {
    await setup({ TWILIO_AUTH_TOKEN: MASTER_TOKEN });
    await setToken('a', null);
    await addSmsCustomers(t, 'a', [nina()]);
    expect((await sms(inbound(), { token: TOKEN.a })).status).toBe(403);
    const res = await sms(inbound(), { token: MASTER_TOKEN });
    expect(messageOf(res.text)).toBe(UNSUBSCRIBED);
    // A company with its own token is still checked against that one, not the platform's.
    expect((await sms(inbound({ To: B_NUMBER }), { token: MASTER_TOKEN })).status).toBe(403);
  });

  test('a re-split replay of a signed START cannot pose as a new message: 400, and the later STOP stands (I1)', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina()]);
    await sms(inbound({ Body: 'STOP' }));
    const start = inbound({ Body: 'START' });
    const startSignature = twilio.getExpectedTwilioSignature(TOKEN.a, BASE + SMS, start);
    await sms(start, { signature: startSignature });
    t.clock.advance(MINUTE);
    await sms(inbound({ Body: 'STOP' }));
    expect((await dbCustomer(t, idOf('a'), c1!)).smsConsentStatus).toBe('revoked');

    // Twilio's signature joins sorted keys and values with no separator, so the next field folded
    // into MessageSid still verifies, and the MessageSid looks new to the dedupe.
    const replay = { ...without(start, 'NumMedia'), MessageSid: `${start.MessageSid}NumMedia${start.NumMedia}` };
    expect(twilio.validateRequest(TOKEN.a, startSignature, BASE + SMS, replay)).toBe(true);
    const res = await sms(replay, { signature: startSignature });

    expect(res.status).toBe(400);
    expect(res.text).toBe('');
    expect((await dbCustomer(t, idOf('a'), c1!)).smsConsentStatus).toBe('revoked');
    expect(await optOutRows('a')).toHaveLength(1);
    expect(await inboundRows('a')).toHaveLength(3);
    expect(await webhookRows()).toHaveLength(3);
  });

  test('ids and numbers must be in Twilio\'s formats: MessageSid / SmsSid SM or MM + 32 hex, From and To E.164 (I1)', async () => {
    const malformed: Record<string, string>[] = [
      { MessageSid: `SM${'A'.repeat(32)}` }, // upper-case hex
      { MessageSid: `SM${'a'.repeat(31)}` },
      { MessageSid: `SM${'a'.repeat(33)}` },
      { MessageSid: `MG${'a'.repeat(32)}` },
      { MessageSid: `SM${'a'.repeat(32)}\n` },
      { SmsSid: 'SMnot-a-sid' },
      { From: '4025550101' },
      { From: '+1 402 555 0101' },
      { From: 'whatsapp:+14025550101' },
    ];
    for (const bad of malformed) {
      const res = await sms(inbound(bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.text).toBe('');
    }
    await nothingWritten();

    expect((await sms(inbound({ MessageSid: `MM${'0f'.repeat(16)}`, Body: 'photo' }))).status).toBe(200);
    expect((await sms(inbound({ SmsSid: `SM${'1e'.repeat(16)}`, Body: 'hello' }))).status).toBe(200);
    expect(await inboundRows('a')).toHaveLength(2);
  });

  test('a signed request with no MessageSid or no From → 400, nothing written', async () => {
    expect((await sms(without(inbound(), 'MessageSid'))).status).toBe(400);
    expect((await sms(without(inbound(), 'From'))).status).toBe(400);
    await nothingWritten();
  });

  test('form bodies over 64 KB are refused with 413; JSON is not read at all (no To → 404)', async () => {
    expect((await sms(inbound({ Body: 'x'.repeat(70 * 1024) }))).status).toBe(413);
    const json = await request(t.app).post(SMS).send(inbound());
    expect(json.status).toBe(404);
    await nothingWritten();
  });

  test('when handling fails, the delivery is not marked as handled: Twilio\'s next try is processed', async () => {
    const [c1] = await addSmsCustomers(t, 'a', [nina()]);
    const owner = new pg.Client({ connectionString: inject('dbUrls').owner });
    await owner.connect();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fields = inbound({ Body: 'STOP' });
    try {
      await owner.query(`create function test_refuse_inbound() returns trigger language plpgsql as $$
        begin raise exception 'inbound refused'; end $$`);
      await owner.query(`create trigger test_refuse_inbound before insert on messages
        for each row when (new.direction = 'in') execute function test_refuse_inbound()`);
      const failed = await sms(fields);
      expect(failed.status).toBe(500);
      expect(await webhookRows()).toEqual([]);
      expect((await dbCustomer(t, idOf('a'), c1!)).smsConsentStatus).toBe('express');
    } finally {
      await owner.query('drop trigger if exists test_refuse_inbound on messages');
      await owner.query('drop function if exists test_refuse_inbound()');
      await owner.end();
      quiet.mockRestore();
    }

    const retried = await sms(fields);
    expect(messageOf(retried.text)).toBe(UNSUBSCRIBED);
    expect((await dbCustomer(t, idOf('a'), c1!)).smsConsentStatus).toBe('revoked');
    expect(await inboundRows('a')).toHaveLength(1);
  });

  test('needs no session and is not under /api', async () => {
    const res = await request(t.app).get('/hooks/twilio/sms');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------

describe('POST /hooks/twilio/status', () => {
  test('delivered → the message is delivered', async () => {
    const text = await sentText(OUT(1));
    const res = await status(statusOf(OUT(1), 'delivered'));
    expect(res.status).toBe(200);
    expect(await messageRow('a', text.id)).toMatchObject({ status: 'delivered', blockReason: null });
    expect(await webhookRows()).toMatchObject([{ provider: 'twilio-status', eventId: `${idOf('a')}:${OUT(1)}:delivered` }]);
  });

  test.each(['failed', 'undelivered'])('%s → failed, with the carrier reason, not retryable', async (outcome) => {
    const text = await sentText(OUT(2));
    expect((await status(statusOf(OUT(2), outcome, { ErrorCode: '30003' }))).status).toBe(200);
    expect(await messageRow('a', text.id)).toMatchObject({ status: 'failed', blockReason: CARRIER, blockRule: null, retryable: false });
  });

  test.each(['queued', 'sending', 'sent', 'accepted', 'read', 'something-new'])('%s → nothing changes, 200', async (other) => {
    const text = await sentText(OUT(3));
    expect((await status(statusOf(OUT(3), other))).status).toBe(200);
    expect(await messageRow('a', text.id)).toMatchObject({ status: 'sent' });
  });

  test('delivered is never downgraded: a late "sent", "failed" or "undelivered" leaves it delivered', async () => {
    const text = await sentText(OUT(4));
    await status(statusOf(OUT(4), 'delivered'));
    for (const late of ['sent', 'failed', 'undelivered', 'queued']) {
      expect((await status(statusOf(OUT(4), late))).status).toBe(200);
    }
    expect(await messageRow('a', text.id)).toMatchObject({ status: 'delivered', blockReason: null });
  });

  test('only a sent text moves: a queued or already failed one is left alone', async () => {
    const text = await sentText(OUT(5));
    await inCompany(t, idOf('a'), (tx) => tx.update(messages).set({ status: 'queued' }).where(eq(messages.id, text.id)));
    await status(statusOf(OUT(5), 'delivered'));
    expect((await messageRow('a', text.id)).status).toBe('queued');
  });

  test('a duplicate callback is ignored: the same (MessageSid, MessageStatus) is handled once', async () => {
    const text = await sentText(OUT(6));
    expect((await status(statusOf(OUT(6), 'failed'))).status).toBe(200);
    // Put it back by hand: if the repeat were handled again it would fail the text a second time.
    await inCompany(t, idOf('a'), (tx) => tx.update(messages).set({ status: 'sent', blockReason: null }).where(eq(messages.id, text.id)));

    const again = await status(statusOf(OUT(6), 'failed'));

    expect(again.status).toBe(200);
    expect(await messageRow('a', text.id)).toMatchObject({ status: 'sent', blockReason: null });
    expect(await webhookRows()).toHaveLength(1);
    // A different status for the same text is a different event.
    await status(statusOf(OUT(6), 'delivered'));
    expect((await messageRow('a', text.id)).status).toBe('delivered');
  });

  test('an unknown MessageSid → 200 and nothing changes', async () => {
    const text = await sentText(OUT(7));
    expect((await status(statusOf(OUT(99), 'delivered'))).status).toBe(200);
    expect((await messageRow('a', text.id)).status).toBe('sent');
  });

  test("isolation: A's callback cannot touch B's text with the same id, nor use up B's delivery (per-company keys)", async () => {
    const bText = await sentText(OUT(50), null, 'b');
    expect((await status(statusOf(OUT(50), 'delivered'))).status).toBe(200);
    expect((await messageRow('b', bText.id)).status).toBe('sent');
    expect((await status(statusOf(OUT(50), 'delivered', { From: B_NUMBER }), { token: TOKEN.b })).status).toBe(200);
    expect((await messageRow('b', bText.id)).status).toBe('delivered');
    expect((await webhookRows()).map((r) => r.eventId).sort()).toEqual(
      [`${idOf('a')}:${OUT(50)}:delivered`, `${idOf('b')}:${OUT(50)}:delivered`].sort(),
    );
  });

  test('an inbound text with the same id is never changed', async () => {
    await sms(inbound({ MessageSid: IN_SID, Body: 'hello' }));
    await status(statusOf(IN_SID, 'delivered'));
    expect(await inboundRows('a')).toMatchObject([{ status: 'received' }]);
  });

  test('a MessageSid (or SmsSid) not in Twilio\'s format → 400, nothing changes (I1)', async () => {
    const text = await sentText(OUT(10));
    expect((await status(statusOf(`${OUT(10)}x`, 'delivered'))).status).toBe(400);
    expect((await status(statusOf(OUT(10).toUpperCase(), 'delivered'))).status).toBe(400);
    expect((await status(statusOf(OUT(10), 'delivered', { SmsSid: 'nope' }))).status).toBe(400);
    expect((await messageRow('a', text.id)).status).toBe('sent');
    expect(await webhookRows()).toEqual([]);
  });

  test('an unknown From → 404; a bad signature → 403; nothing changes either way', async () => {
    const text = await sentText(OUT(8));
    const unknown = await status(statusOf(OUT(8), 'delivered', { From: '+14025550999' }));
    expect(unknown.status).toBe(404);
    expect(unknown.text).toBe('');
    expect((await status(statusOf(OUT(8), 'delivered'), { token: TOKEN.b })).status).toBe(403);
    expect((await status(statusOf(OUT(8), 'delivered'), { signature: null })).status).toBe(403);
    expect((await messageRow('a', text.id)).status).toBe('sent');
    expect(await webhookRows()).toEqual([]);
  });

  test('no signing token → 403', async () => {
    await setToken('a', null);
    const text = await sentText(OUT(9));
    expect((await status(statusOf(OUT(9), 'delivered'))).status).toBe(403);
    expect((await messageRow('a', text.id)).status).toBe('sent');
  });
});

// ---------------------------------------------------------------------------------------------

let observer: pg.Client | undefined;
afterEach(async () => {
  await observer?.end();
  observer = undefined;
});
afterAll(async () => {
  await observer?.end();
});

/** Waits until some connection is waiting for any lock (a row lock, here), for up to 5 seconds. */
async function untilLockWait(timeoutMs = 5000): Promise<boolean> {
  if (!observer) {
    observer = new pg.Client({ connectionString: inject('dbUrls').owner });
    await observer.connect();
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    if (rows[0]!.n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** Waits until some connection is waiting for an advisory lock (lockRecipient), for up to 5 seconds. */
async function untilAdvisoryLockWait(timeoutMs = 5000): Promise<boolean> {
  if (!observer) {
    observer = new pg.Client({ connectionString: inject('dbUrls').owner });
    await observer.connect();
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ n: number }>(
      "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted",
    );
    if (rows[0]!.n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
