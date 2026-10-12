import { encrypt, textingRegistrations } from '@roofline/db';
import { registrationsToCheck } from '@roofline/db/system';
import request from 'supertest';
import twilio from 'twilio';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from './helpers.ts';

/*
 * Task 28: Twilio's registration callbacks (POST /hooks/twilio-registration) and the poll's
 * windows (registrationsToCheck). Requests are signed the way Twilio signs them, with the company's
 * own subaccount token (stored encrypted). No provider is called.
 */

let t: TestApp;

const PUBLIC_URL = 'https://app.roofline.test';
const PATH = '/hooks/twilio-registration';
const TOKEN = 'test-subaccount-token-a';
const BRAND_SID = `BN${'a1'.repeat(16)}`;
const CAMPAIGN_SID = `QE${'b2'.repeat(16)}`;
const SUBACCOUNT_SID = `AC${'c3'.repeat(16)}`;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** A registration row's columns, as the poll sees them. Anything not given is reset to a fresh state. */
const FRESH = {
  brandSid: null,
  brandStatus: null,
  campaignSid: null,
  campaignStatus: 'pending',
  submittedAt: null,
  lastCheckedAt: null,
} as const;

type RowFields = Partial<typeof textingRegistrations.$inferInsert>;

beforeEach(async () => {
  t = await makeTestApp();
});

afterEach(async () => {
  await t.close();
});

/** Acme's registration row, set to `fields` (the rest fresh). Acme is the only company the poll tests change. */
async function setRow(fields: RowFields): Promise<void> {
  const state = { ...FRESH, ...fields };
  await t.deps.pools.system
    .insert(textingRegistrations)
    .values({ companyId: t.seed.a.companyId, ...state })
    .onConflictDoUpdate({ target: textingRegistrations.companyId, set: state });
}

/** Whether Acme is among the registrations the poll checks now. */
async function acmeIsChecked(): Promise<boolean> {
  const ids = await registrationsToCheck(t.deps.pools.system, t.clock.now());
  return ids.includes(t.seed.a.companyId);
}

/** Posts the form to the callback, signed with `token` for the public URL, as Twilio would. */
function post(fields: Record<string, string>, token = TOKEN) {
  const signature = twilio.getExpectedTwilioSignature(token, PUBLIC_URL + PATH, fields);
  return request(t.app).post(PATH).type('form').set('X-Twilio-Signature', signature).send(fields);
}

describe('texting registration callbacks and poll', () => {
  test('a signed callback wakes the registration', async () => {
    await setRow({ subaccountSid: SUBACCOUNT_SID, subaccountAuthTokenEncrypted: encrypt(TOKEN, TEST_ENCRYPTION_KEY), brandSid: BRAND_SID });
    const before = t.jobs.sent.length;

    const ok = await post({ BrandRegistrationSid: BRAND_SID });
    expect(ok.status).toBe(200);
    expect(t.jobs.sent.length - before).toBe(1);
    expect(t.jobs.sent[t.jobs.sent.length - 1]).toEqual({
      name: 'texting-registration',
      data: { companyId: t.seed.a.companyId },
      singletonKey: t.seed.a.companyId,
    });

    const bad = await post({ BrandRegistrationSid: BRAND_SID }, 'some-other-token');
    expect(bad.status).toBe(403);
    expect(t.jobs.sent.length - before).toBe(1);

    const unknown = await post({ BrandRegistrationSid: `BN${'d4'.repeat(16)}` });
    expect(unknown.status).toBe(404);
    expect(t.jobs.sent.length - before).toBe(1);
  });

  test('the poll checks brands hourly and campaigns daily', async () => {
    const now = new Date('2026-10-12T15:00:00.000Z');
    t.clock.set(now);
    const ago = (ms: number) => new Date(now.getTime() - ms);

    // Brand stage: a brand with the carriers and no campaign yet, checked hourly.
    await setRow({ brandSid: BRAND_SID, brandStatus: 'pending', lastCheckedAt: ago(59 * MINUTE_MS) });
    expect(await acmeIsChecked()).toBe(false);
    await setRow({ brandSid: BRAND_SID, brandStatus: 'pending', lastCheckedAt: ago(61 * MINUTE_MS) });
    expect(await acmeIsChecked()).toBe(true);

    // Campaign stage: a campaign with the carriers, checked daily.
    await setRow({ brandSid: BRAND_SID, brandStatus: 'approved', campaignSid: CAMPAIGN_SID, lastCheckedAt: ago(23 * HOUR_MS) });
    expect(await acmeIsChecked()).toBe(false);
    await setRow({ brandSid: BRAND_SID, brandStatus: 'approved', campaignSid: CAMPAIGN_SID, lastCheckedAt: ago(25 * HOUR_MS) });
    expect(await acmeIsChecked()).toBe(true);

    // Stuck stage 1: submitted with no brand sid for over an hour.
    await setRow({ submittedAt: ago(59 * MINUTE_MS) });
    expect(await acmeIsChecked()).toBe(false);
    await setRow({ submittedAt: ago(61 * MINUTE_MS) });
    expect(await acmeIsChecked()).toBe(true);
  });
});
