import { afterEach, beforeEach, expect, test } from 'vitest';
import { AdPlatformError } from '../src/providers/ads-google.ts';
import { FakeAdsMeta } from '../src/providers/fakes/ads-meta.ts';
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

test('a Check that throws keeps an active Google account active and only notes the problem (the 95% guard stays on)', async () => {
  const { owner, id } = await linkGoogleRoute('123-456-7890');
  t.adsGoogle.accept('1234567890');
  const ok = await owner.post(`/api/ads/accounts/${id}/check`);
  expect(ok.body.account).toMatchObject({ status: 'active', name: 'Fake Ads 1234567890', lastErrorPlain: null });
  t.adsGoogle.failNext('other'); // linkStatus throws
  const bad = await owner.post(`/api/ads/accounts/${id}/check`);
  expect(bad.status).toBe(200);
  expect(bad.body.account).toMatchObject({
    status: 'active',
    name: 'Fake Ads 1234567890',
    lastErrorPlain: AD_ERROR_MESSAGES.other,
  });
  // The next good Check clears the note.
  const again = await owner.post(`/api/ads/accounts/${id}/check`);
  expect(again.body.account).toMatchObject({ status: 'active', lastErrorPlain: null });
});

test('a Check that throws keeps a pending Meta account pending, and a definite answer still changes the status', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const res = await owner.post('/api/ads/accounts/meta').send({ adAccountId: 'act_555666777' });
  expect(res.status).toBe(201);
  const id = res.body.account.id as string;
  expect(res.body.account.status).toBe('pending');
  t.adsMeta.verifyAccess = async () => {
    throw new AdPlatformError('other');
  };
  const bad = await owner.post(`/api/ads/accounts/${id}/check`);
  expect(bad.body.account).toMatchObject({ status: 'pending', lastErrorPlain: AD_ERROR_MESSAGES.other });
  t.adsMeta.disable('act_555666777');
  t.adsMeta.verifyAccess = FakeAdsMeta.prototype.verifyAccess.bind(t.adsMeta);
  const disabled = await owner.post(`/api/ads/accounts/${id}/check`);
  expect(disabled.body.account).toMatchObject({ status: 'error', lastErrorPlain: META_DISABLED });
});
