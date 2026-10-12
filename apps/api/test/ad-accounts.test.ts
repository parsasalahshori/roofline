import { afterEach, beforeEach, expect, test } from 'vitest';
import { AdPlatformError } from '../src/providers/ads-google.ts';
import {
  AD_ERROR_MESSAGES,
  evaluateAdAccount,
  GOOGLE_PENDING,
  GOOGLE_REFUSED,
  META_DISABLED,
  META_NOT_ASSIGNED,
  META_NOT_SHARED,
  normalizeGoogleCustomerId,
  normalizeMetaAdAccountId,
} from '../src/storm/ad-accounts.ts';
import { loginAs, makeTestApp, type TestApp } from './helpers.ts';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

test('normalizeGoogleCustomerId accepts 10 digits with or without hyphens', () => {
  expect(normalizeGoogleCustomerId('123-456-7890')).toBe('1234567890');
  expect(normalizeGoogleCustomerId('1234567890')).toBe('1234567890');
  expect(normalizeGoogleCustomerId(' 123-456-7890 ')).toBe('1234567890');
  expect(normalizeGoogleCustomerId('12345')).toBeNull();
  expect(normalizeGoogleCustomerId('abc')).toBeNull();
  expect(normalizeGoogleCustomerId(1234567890)).toBeNull();
});

test('normalizeMetaAdAccountId adds the act_ prefix and rejects junk', () => {
  expect(normalizeMetaAdAccountId('act_555666777')).toBe('act_555666777');
  expect(normalizeMetaAdAccountId('555666777')).toBe('act_555666777');
  expect(normalizeMetaAdAccountId('ACT_555666777')).toBe('act_555666777');
  expect(normalizeMetaAdAccountId('act_')).toBeNull();
  expect(normalizeMetaAdAccountId('x1')).toBeNull();
  expect(normalizeMetaAdAccountId(42)).toBeNull();
});

test('evaluateAdAccount maps Google link states', async () => {
  const acct = { platform: 'google' as const, externalAccountId: '1234567890' };
  expect(await evaluateAdAccount(t.deps, acct)).toEqual({ status: 'pending', name: null, currency: null, lastErrorPlain: GOOGLE_PENDING });
  t.adsGoogle.refuse('1234567890');
  expect(await evaluateAdAccount(t.deps, acct)).toEqual({ status: 'error', name: null, currency: null, lastErrorPlain: GOOGLE_REFUSED });
  t.adsGoogle.accept('1234567890');
  expect(await evaluateAdAccount(t.deps, acct)).toEqual({
    status: 'active',
    name: 'Fake Ads 1234567890',
    currency: 'USD',
    lastErrorPlain: null,
  });
});

test('evaluateAdAccount maps Meta access reasons', async () => {
  const acct = { platform: 'meta' as const, externalAccountId: 'act_1' };
  expect((await evaluateAdAccount(t.deps, acct)).lastErrorPlain).toBe(META_NOT_SHARED);
  t.adsMeta.unassign('act_1');
  const unassigned = await evaluateAdAccount(t.deps, acct);
  expect(unassigned.status).toBe('pending');
  expect(unassigned.lastErrorPlain).toBe(META_NOT_ASSIGNED);
  t.adsMeta.disable('act_1');
  expect(await evaluateAdAccount(t.deps, acct)).toMatchObject({ status: 'error', lastErrorPlain: META_DISABLED });
  t.adsMeta.share('act_1');
  expect(await evaluateAdAccount(t.deps, acct)).toMatchObject({ status: 'active', name: 'Fake Meta act_1', currency: 'USD' });
});

test('evaluateAdAccount never throws and never uses provider text', async () => {
  t.adsGoogle.failNext('payment');
  const res = await evaluateAdAccount(t.deps, { platform: 'google', externalAccountId: '1234567890' });
  expect(res).toEqual({ status: 'error', name: null, currency: null, lastErrorPlain: AD_ERROR_MESSAGES.payment, fromThrow: true });
  expect(new AdPlatformError('payment').message).toContain('Ad platform error');
  expect(res.lastErrorPlain).not.toContain('Ad platform error');

  t.adsMeta.verifyAccess = async () => {
    throw new Error('raw provider text');
  };
  const other = await evaluateAdAccount(t.deps, { platform: 'meta', externalAccountId: 'act_1' });
  expect(other.lastErrorPlain).toBe(AD_ERROR_MESSAGES.other);
});

async function linkGoogleRoute(customerId: string) {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const res = await owner.post('/api/ads/accounts/google').send({ customerId });
  expect(res.status).toBe(201);
  return { owner, id: res.body.account.id as string };
}

test('checkAdAccount re-invites a refused Google link', async () => {
  const { owner, id } = await linkGoogleRoute('123-456-7890');
  t.adsGoogle.refuse('1234567890');
  const before = t.adsGoogle.calls.length;
  const checked = await owner.post(`/api/ads/accounts/${id}/check`);
  expect(checked.status).toBe(200);
  const invites = t.adsGoogle.calls.slice(before).filter((c) => c.method === 'invite');
  expect(invites.some((c) => c.args[0] === '1234567890')).toBe(true);
  expect(checked.body.account.status).toBe('pending');
  expect(checked.body.account.lastErrorPlain).toBe(GOOGLE_PENDING);
});

test('checkAdAccount does not re-invite an active Google link', async () => {
  const { owner, id } = await linkGoogleRoute('123-456-7890');
  t.adsGoogle.accept('1234567890');
  const before = t.adsGoogle.calls.length;
  const checked = await owner.post(`/api/ads/accounts/${id}/check`);
  expect(checked.status).toBe(200);
  expect(checked.body.account.status).toBe('active');
  expect(t.adsGoogle.calls.slice(before).some((c) => c.method === 'invite')).toBe(false);
});
