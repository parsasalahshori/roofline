import { encrypt, textingRegistrations } from '@roofline/db';
import request from 'supertest';
import twilio from 'twilio';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MAX_SIDS_TRIED } from '../src/hooks/twilio-registration.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from './helpers.ts';

/*
 * Security finding 7: the registration hook looks a body's sids up before it can check the
 * signature, so it caps the lookups (MAX_SIDS_TRIED, in body order) and refuses an unsigned request
 * before any lookup. The lookups are counted through a wrapper around the real system query.
 */

const lookups = vi.hoisted(() => ({ sids: [] as string[] }));

vi.mock('@roofline/db/system', async (importOriginal) => {
  const actual = await importOriginal<{ companyIdForTextingSid: (system: unknown, sid: string) => Promise<string | null> }>();
  return {
    ...actual,
    companyIdForTextingSid: async (system: unknown, sid: string) => {
      lookups.sids.push(sid);
      return actual.companyIdForTextingSid(system, sid);
    },
  };
});

let t: TestApp;

const PUBLIC_URL = 'https://app.roofline.test';
const PATH = '/hooks/twilio-registration';
const TOKEN = 'test-subaccount-token-a';
const SUBACCOUNT_SID = `AC${'c3'.repeat(16)}`;
const BRAND_SID = `BN${'a1'.repeat(16)}`;

/** A brand sid nobody owns, distinct for each `n`. */
function strangerSid(n: number): string {
  return `BN${n.toString(16).padStart(32, '0')}`;
}

beforeEach(async () => {
  t = await makeTestApp();
  const state = { subaccountSid: SUBACCOUNT_SID, subaccountAuthTokenEncrypted: encrypt(TOKEN, TEST_ENCRYPTION_KEY), brandSid: BRAND_SID };
  await t.deps.pools.system
    .insert(textingRegistrations)
    .values({ companyId: t.seed.a.companyId, ...state })
    .onConflictDoUpdate({ target: textingRegistrations.companyId, set: state });
  lookups.sids = [];
});

afterEach(async () => {
  await t.close();
});

function signed(fields: Record<string, string>, token = TOKEN) {
  const signature = twilio.getExpectedTwilioSignature(token, PUBLIC_URL + PATH, fields);
  return request(t.app).post(PATH).type('form').set('X-Twilio-Signature', signature).send(fields);
}

describe('twilio registration hook lookups', () => {
  test('a body full of sids costs at most MAX_SIDS_TRIED lookups', async () => {
    const fields: Record<string, string> = {};
    for (let i = 1; i <= 200; i++) fields[`F${i}`] = strangerSid(i);

    const res = await signed(fields, 'forged-token');
    expect(res.status).toBe(404);
    expect(MAX_SIDS_TRIED).toBeLessThanOrEqual(3);
    expect(lookups.sids).toEqual([strangerSid(1), strangerSid(2), strangerSid(3)].slice(0, MAX_SIDS_TRIED));
  });

  test('the owned sid behind the cap is not reached', async () => {
    const fields: Record<string, string> = {};
    for (let i = 1; i <= MAX_SIDS_TRIED; i++) fields[`F${i}`] = strangerSid(i);
    fields.BrandRegistrationSid = BRAND_SID;

    const res = await signed(fields);
    expect(res.status).toBe(404);
    expect(lookups.sids).toHaveLength(MAX_SIDS_TRIED);
  });

  test('an unsigned request is refused before any lookup', async () => {
    const fields: Record<string, string> = {};
    for (let i = 1; i <= 50; i++) fields[`F${i}`] = strangerSid(i);
    fields.BrandRegistrationSid = BRAND_SID;

    const res = await request(t.app).post(PATH).type('form').send(fields);
    expect(res.status).toBe(403);
    expect(lookups.sids).toEqual([]);
    expect(t.jobs.sent.filter((j) => j.name === 'texting-registration')).toHaveLength(0);
  });

  test('a bad signature is still 403, and a genuine callback still wakes the registration', async () => {
    const before = t.jobs.sent.length;
    const fields = { AccountSid: SUBACCOUNT_SID, BrandRegistrationSid: BRAND_SID, Status: 'APPROVED' };

    const bad = await signed(fields, 'some-other-token');
    expect(bad.status).toBe(403);
    expect(t.jobs.sent.length).toBe(before);

    const ok = await signed(fields);
    expect(ok.status).toBe(200);
    expect(t.jobs.sent.length - before).toBe(1);
    expect(t.jobs.sent[t.jobs.sent.length - 1]).toEqual({
      name: 'texting-registration',
      data: { companyId: t.seed.a.companyId },
      singletonKey: t.seed.a.companyId,
    });
    // The subaccount sid comes first and names the company: one lookup per callback.
    expect(lookups.sids).toEqual([SUBACCOUNT_SID, SUBACCOUNT_SID]);
  });
});
