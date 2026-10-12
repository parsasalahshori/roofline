import pg from 'pg';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { JOB_HANDLERS } from '../src/jobs/handlers.ts';
import { AD_ERROR_MESSAGES } from '../src/storm/ad-accounts.ts';
import { recheckPendingAdAccounts } from '../src/storm/ad-recheck.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
const NOW = new Date('2026-10-12T15:00:00Z');
const GOOGLE_ID = '1234567890';
const META_ID = 'act_777888999';

let t: TestApp;
let a: string;
let b: string;

async function insertAccount(companyId: string, platform: 'google' | 'meta', externalId: string, status: string): Promise<void> {
  await owner.query(`insert into ad_accounts (company_id, platform, external_account_id, status) values ($1, $2, $3, $4)`, [
    companyId,
    platform,
    externalId,
    status,
  ]);
}

async function row(companyId: string, platform: string) {
  const { rows } = await owner.query(
    `select status, name, currency, linked_at, last_error_plain from ad_accounts where company_id = $1 and platform = $2`,
    [companyId, platform],
  );
  return rows[0];
}

afterAll(async () => {
  await owner.end();
});

beforeEach(async () => {
  t = await makeTestApp();
  a = t.seed.a.companyId;
  b = t.seed.b.companyId;
  await owner.query(`delete from ad_accounts where company_id in ($1, $2)`, [a, b]);
});

describe('recheckPendingAdAccounts', () => {
  test('an accepted google invitation becomes active with name, currency and linked_at', async () => {
    await insertAccount(a, 'google', GOOGLE_ID, 'pending');
    t.adsGoogle.accept(GOOGLE_ID);
    await recheckPendingAdAccounts(t.deps, a, NOW);
    const r = await row(a, 'google');
    expect(r.status).toBe('active');
    expect(r.name).toBe('Fake Ads 1234567890');
    expect(r.currency).toBe('USD');
    expect(new Date(r.linked_at).getTime()).toBe(NOW.getTime());
    expect(r.last_error_plain).toBeNull();
  });

  test('a google account not yet accepted stays pending and keeps a plain reason', async () => {
    await insertAccount(a, 'google', GOOGLE_ID, 'pending');
    await recheckPendingAdAccounts(t.deps, a, NOW);
    const r = await row(a, 'google');
    expect(r.status).toBe('pending');
    expect(r.last_error_plain).not.toBeNull();
  });

  test('a meta account stays pending until it is shared, then becomes active', async () => {
    await insertAccount(a, 'meta', META_ID, 'pending');
    await recheckPendingAdAccounts(t.deps, a, NOW);
    expect((await row(a, 'meta')).status).toBe('pending');
    t.adsMeta.share(META_ID);
    await recheckPendingAdAccounts(t.deps, a, NOW);
    expect((await row(a, 'meta')).status).toBe('active');
  });

  test('a refused google invitation becomes error with a plain reason', async () => {
    await insertAccount(a, 'google', GOOGLE_ID, 'pending');
    t.adsGoogle.refuse(GOOGLE_ID);
    await recheckPendingAdAccounts(t.deps, a, NOW);
    const r = await row(a, 'google');
    expect(r.status).toBe('error');
    expect(r.last_error_plain).not.toBeNull();
  });

  test('a revoked account is never touched and causes no provider calls', async () => {
    await insertAccount(a, 'google', GOOGLE_ID, 'revoked');
    t.adsGoogle.accept(GOOGLE_ID);
    await recheckPendingAdAccounts(t.deps, a, NOW);
    expect((await row(a, 'google')).status).toBe('revoked');
    expect(t.adsGoogle.calls).toEqual([]);
  });

  test('a provider failure keeps the account pending with our own plain message, and the next hour activates it', async () => {
    await insertAccount(a, 'google', GOOGLE_ID, 'pending');
    t.adsGoogle.failNext('payment');
    await recheckPendingAdAccounts(t.deps, a, NOW);
    const r = await row(a, 'google');
    expect(r.status).toBe('pending');
    expect(r.last_error_plain).not.toBeNull();
    expect(r.last_error_plain).not.toContain('Ad platform error');
    expect(r.last_error_plain).toBe(AD_ERROR_MESSAGES.payment);
    t.adsGoogle.accept(GOOGLE_ID);
    await recheckPendingAdAccounts(t.deps, a, NOW);
    const again = await row(a, 'google');
    expect(again.status).toBe('active');
    expect(again.last_error_plain).toBeNull();
  });

  test('the ad-sync-company job rechecks the company', async () => {
    await insertAccount(a, 'google', GOOGLE_ID, 'pending');
    t.adsGoogle.accept(GOOGLE_ID);
    await t.deps.jobs.send('ad-sync-company', { companyId: a });
    await t.jobs.drain(t.deps, JOB_HANDLERS);
    expect((await row(a, 'google')).status).toBe('active');
  });

  test("another company's pending account is untouched", async () => {
    await insertAccount(a, 'google', GOOGLE_ID, 'pending');
    await insertAccount(b, 'google', '9876543210', 'pending');
    t.adsGoogle.accept(GOOGLE_ID);
    t.adsGoogle.accept('9876543210');
    await recheckPendingAdAccounts(t.deps, a, NOW);
    expect((await row(a, 'google')).status).toBe('active');
    expect((await row(b, 'google')).status).toBe('pending');
  });
});
