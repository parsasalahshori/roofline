import { afterEach, beforeEach, expect, test } from 'vitest';
import type { SetupView } from '@roofline/shared';
import {
  AD_ERROR_MESSAGES,
  ALREADY_LINKED,
  BAD_GOOGLE_ID,
  BAD_META_ID,
  GOOGLE_PENDING,
  META_DISABLED,
  META_NOT_SHARED,
} from '../src/storm/ad-accounts.ts';
import { loginAs, makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const NOT_ALLOWED = "Your role can't do that. Ask the owner.";
const NOT_FOUND = "We couldn't find that.";

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

async function connectItem(agent: SuperAgent): Promise<string> {
  const res = await agent.get('/api/setup');
  expect(res.status).toBe(200);
  const found = (res.body as SetupView).items.find((i) => i.key === 'connect_ads');
  if (!found) throw new Error('No connect_ads item');
  return found.status;
}

async function linkGoogle(agent: SuperAgent, customerId = '123-456-7890') {
  const res = await agent.post('/api/ads/accounts/google').send({ customerId });
  expect(res.status).toBe(201);
  return res.body.account as { id: string; status: string; externalAccountId: string };
}

test('Google flow: invite, wait, accept, check', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const res = await owner.post('/api/ads/accounts/google').send({ customerId: '123-456-7890' });
  expect(res.status).toBe(201);
  expect(res.body.account.status).toBe('pending');
  expect(res.body.account.externalAccountId).toBe('1234567890');
  expect(res.body.instructions.managerId).toBe(t.adsGoogle.managerId);
  expect(t.adsGoogle.calls.some((c) => c.method === 'invite' && c.args[0] === '1234567890')).toBe(true);
  expect(await connectItem(owner)).toBe('waiting');

  t.adsGoogle.accept('1234567890');
  const checked = await owner.post(`/api/ads/accounts/${res.body.account.id}/check`);
  expect(checked.status).toBe(200);
  expect(checked.body.account.status).toBe('active');
  expect(checked.body.account.name).toBe('Fake Ads 1234567890');
  expect(checked.body.account.currency).toBe('USD');
  expect(checked.body.account.linkedAt).not.toBeNull();
  expect(await connectItem(owner)).toBe('done');
});

test('Meta flow: not shared, then shared', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const res = await owner.post('/api/ads/accounts/meta').send({ adAccountId: '555666777' });
  expect(res.status).toBe(201);
  expect(res.body.account.externalAccountId).toBe('act_555666777');
  expect(res.body.account.status).toBe('pending');
  expect(res.body.account.lastErrorPlain).toBe(META_NOT_SHARED);
  expect(res.body.instructions).toBeUndefined();

  t.adsMeta.share('act_555666777');
  const checked = await owner.post(`/api/ads/accounts/${res.body.account.id}/check`);
  expect(checked.status).toBe(200);
  expect(checked.body.account.status).toBe('active');
});

test('GET /accounts lists rows with the manager and business ids, for any member', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  await linkGoogle(owner);
  const office = await loginAs(t.app, t.seed.a.office);
  const res = await office.get('/api/ads/accounts');
  expect(res.status).toBe(200);
  expect(res.body.accounts).toHaveLength(1);
  expect(res.body.managerId).toBe(t.adsGoogle.managerId);
  expect(res.body.businessId).toBe(t.adsMeta.businessId);
});

test('revoke is idempotent', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const acct = await linkGoogle(owner);
  const first = await owner.delete(`/api/ads/accounts/${acct.id}`);
  expect(first.status).toBe(200);
  expect(first.body.account.status).toBe('revoked');
  const second = await owner.delete(`/api/ads/accounts/${acct.id}`);
  expect(second.status).toBe(200);
  expect(second.body.account.status).toBe('revoked');
});

test('revoking a Google account ends the manager link', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const acct = await linkGoogle(owner);
  t.adsGoogle.accept('1234567890');
  const res = await owner.delete(`/api/ads/accounts/${acct.id}`);
  expect(res.status).toBe(200);
  expect(t.adsGoogle.calls.some((c) => c.method === 'unlink' && c.args[0] === '1234567890')).toBe(true);
  expect(await t.adsGoogle.linkStatus('1234567890')).toBe('none');
});

test('a failing unlink never blocks the owner removing the account', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const acct = await linkGoogle(owner);
  t.adsGoogle.failNext('other');
  const res = await owner.delete(`/api/ads/accounts/${acct.id}`);
  expect(res.status).toBe(200);
  expect(res.body.account.status).toBe('revoked');
});

test('office and rep cannot change ad accounts', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const acct = await linkGoogle(owner);
  for (const user of [t.seed.a.office, t.seed.a.rep]) {
    const agent = await loginAs(t.app, user);
    const calls = [
      await agent.post('/api/ads/accounts/google').send({ customerId: '9998887776' }),
      await agent.post('/api/ads/accounts/meta').send({ adAccountId: '555666777' }),
      await agent.post(`/api/ads/accounts/${acct.id}/check`),
      await agent.delete(`/api/ads/accounts/${acct.id}`),
    ];
    for (const res of calls) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: NOT_ALLOWED });
    }
  }
});

test('a second Google account needs the first revoked, and replaces its row', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const first = await linkGoogle(owner);
  const blocked = await owner.post('/api/ads/accounts/google').send({ customerId: '9998887776' });
  expect(blocked.status).toBe(409);
  expect(blocked.body).toEqual({ error: ALREADY_LINKED });

  expect((await owner.delete(`/api/ads/accounts/${first.id}`)).status).toBe(200);
  const second = await owner.post('/api/ads/accounts/google').send({ customerId: '9998887776' });
  expect(second.status).toBe(201);
  expect(second.body.account.id).toBe(first.id);

  const list = await owner.get('/api/ads/accounts');
  const google = (list.body.accounts as { platform: string; externalAccountId: string }[]).filter((a) => a.platform === 'google');
  expect(google).toHaveLength(1);
  expect(google[0]?.externalAccountId).toBe('9998887776');
});

test('invalid ids are 400 with the field', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const g = await owner.post('/api/ads/accounts/google').send({ customerId: '12345' });
  expect(g.status).toBe(400);
  expect(g.body).toEqual({ error: BAD_GOOGLE_ID, field: 'customerId' });
  const m = await owner.post('/api/ads/accounts/meta').send({ adAccountId: 'x1' });
  expect(m.status).toBe(400);
  expect(m.body).toEqual({ error: BAD_META_ID, field: 'adAccountId' });
  const missing = await owner.post('/api/ads/accounts/google').send({});
  expect(missing.status).toBe(400);
  expect(missing.body.field).toBe('customerId');
});

test('provider failures become our own plain messages', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const acct = await linkGoogle(owner);
  t.adsGoogle.failNext('payment');
  const res = await owner.post(`/api/ads/accounts/${acct.id}/check`);
  expect(res.status).toBe(200);
  expect(res.body.account.status).toBe('error');
  expect(res.body.account.lastErrorPlain).toBe(AD_ERROR_MESSAGES.payment);
  expect(JSON.stringify(res.body)).not.toContain('Ad platform error');

  const meta = await owner.post('/api/ads/accounts/meta').send({ adAccountId: 'act_1234567' });
  t.adsMeta.disable('act_1234567');
  const checked = await owner.post(`/api/ads/accounts/${meta.body.account.id}/check`);
  expect(checked.body.account.status).toBe('error');
  expect(checked.body.account.lastErrorPlain).toBe(META_DISABLED);
});

test('a failing invite is stored as an error, not a 500', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  t.adsGoogle.failNext('access');
  const res = await owner.post('/api/ads/accounts/google').send({ customerId: '1234567890' });
  expect(res.status).toBe(201);
  expect(res.body.account.status).toBe('error');
  expect(res.body.account.lastErrorPlain).toBe(AD_ERROR_MESSAGES.access);
});

test('checking after a failed invite sends the invitation again', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  t.adsGoogle.failNext('access');
  const res = await owner.post('/api/ads/accounts/google').send({ customerId: '1234567890' });
  expect(res.body.account.status).toBe('error');
  const checked = await owner.post(`/api/ads/accounts/${res.body.account.id}/check`);
  expect(checked.status).toBe(200);
  expect(checked.body.account.status).toBe('pending');
  expect(checked.body.account.lastErrorPlain).toBe(GOOGLE_PENDING);
  expect(t.adsGoogle.calls.filter((c) => c.method === 'invite')).toHaveLength(2);
});

test('another company cannot see or touch an account', async () => {
  const ownerA = await loginAs(t.app, t.seed.a.owner);
  const acct = await linkGoogle(ownerA);
  const ownerB = await loginAs(t.app, t.seed.b.owner);
  const list = await ownerB.get('/api/ads/accounts');
  expect(list.body.accounts).toEqual([]);
  const check = await ownerB.post(`/api/ads/accounts/${acct.id}/check`);
  expect(check.status).toBe(404);
  expect(check.body).toEqual({ error: NOT_FOUND });
  const del = await ownerB.delete(`/api/ads/accounts/${acct.id}`);
  expect(del.status).toBe(404);
  const bad = await ownerB.delete('/api/ads/accounts/not-a-uuid');
  expect(bad.status).toBe(404);
});
