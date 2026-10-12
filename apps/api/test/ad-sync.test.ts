import { companiesNeedingAdSync } from '@roofline/db/system';
import { insertOmahaStorm, type Query } from '@roofline/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { AdPlatformError, type AdCreate } from '../src/providers/ads-google.ts';
import { syncCompanyAds } from '../src/storm/ad-sync.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { dbSteps, newTask } from './task-helpers.ts';

/*
 * The campaign spend sync and the 95% pause (S1 Task 19) against a real database and the fake Google Ads.
 * These tests need Docker and run on CI only.
 */

const NOW = new Date('2026-10-12T15:00:00Z');
const ACCOUNT = '1234567890';
const MAX = 27000;

let owner: pg.Pool;
let t: TestApp;
const q: Query = async (text, values) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});
beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  await owner.query(`delete from ad_accounts where company_id in ($1, $2)`, [t.seed.a.companyId, t.seed.b.companyId]);
});

type Seeded = { companyId: string; companyStormId: string; rowId: string; campaignId: string };

const adCreate = (nameTag: string): AdCreate => ({
  accountId: ACCOUNT,
  nameTag,
  dailyBudgetCents: 3857,
  startDate: '2026-10-12',
  endDate: '2026-10-18',
  circles: [{ lat: 41.2, lng: -95.9, radiusM: 5000 }],
  landingUrl: 'https://example.test/storm/abcd2345',
  headline: 'Free roof check',
  description: 'Hail came through your area.',
  companyName: 'Test Roofing',
  city: 'Omaha',
  keywords: ['roof repair'],
});

/** An active Google account, a fake campaign and an active ad_campaigns row for one company. */
async function seed(company: 'a' | 'b', opts: { accountStatus?: string; day?: string } = {}): Promise<Seeded> {
  const companyId = t.seed[company].companyId;
  const stormId = await insertOmahaStorm(q, opts.day ?? (company === 'a' ? '2026-10-11' : '2026-10-10'));
  const storm = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit) values ($1, $2, 1.5, 0, 0) returning id`,
    [companyId, stormId],
  );
  const companyStormId = storm[0]!.id as string;
  const { taskId } = await newTask(t, company);
  const stepId = (await dbSteps(t, company, taskId))[0]!.id;
  await owner.query(
    `insert into ad_accounts (company_id, platform, external_account_id, status) values ($1, 'google', $2, $3)`,
    [companyId, ACCOUNT, opts.accountStatus ?? 'active'],
  );
  const { campaignId } = await t.adsGoogle.createCampaign(adCreate(`Roofline storm ${companyStormId} google`));
  const rows = await q(
    `insert into ad_campaigns (company_id, company_storm_id, step_id, platform, external_campaign_id, status,
                               daily_budget_cents, days, max_spend_cents, creative)
     values ($1, $2, $3, 'google', $4, 'active', 3857, 7, $5, '{"endDate":"2026-10-18","startDate":"2026-10-12"}')
     returning id`,
    [companyId, companyStormId, stepId, campaignId, MAX],
  );
  t.adsGoogle.campaigns.get(campaignId)!.status = 'active'; // the handler enabled it
  t.adsGoogle.calls.length = 0;
  return { companyId, companyStormId, rowId: rows[0]!.id as string, campaignId };
}

const rowOf = async (id: string) =>
  (await q(`select status, spend_cents, impressions, clicks, landing_requests, last_synced_at from ad_campaigns where id = $1`, [id]))[0]!;
const calls = (method: string) => t.adsGoogle.calls.filter((c) => c.method === method);
const fakeStatus = (campaignId: string) => t.adsGoogle.campaigns.get(campaignId)!.status;

/** Makes the next setStatus throw once; stats and others pass through. */
function failSetStatusOnce(): void {
  const original = t.adsGoogle.setStatus.bind(t.adsGoogle);
  let failed = false;
  t.adsGoogle.setStatus = async (...args: Parameters<typeof original>) => {
    if (!failed) {
      failed = true;
      throw new AdPlatformError('other');
    }
    return original(...args);
  };
}

describe('campaign spend sync', () => {
  test('below 95% the numbers are stored and the campaign stays active with no setStatus call', async () => {
    const s = await seed('a');
    t.adsGoogle.setSpend(s.campaignId, 5000);
    await syncCompanyAds(t.deps, s.companyId);
    const r = await rowOf(s.rowId);
    expect(r.status).toBe('active');
    expect(r.spend_cents).toBe(5000);
    expect(r.impressions).toBe(50000);
    expect(r.clicks).toBe(100);
    expect(new Date(r.last_synced_at as string).getTime()).toBe(NOW.getTime());
    expect(calls('setStatus')).toEqual([]);
    expect(fakeStatus(s.campaignId)).toBe('active');
  });

  test('exactly 95% of the maximum pauses the campaign; one cent less does not', async () => {
    const s = await seed('a');
    t.adsGoogle.setSpend(s.campaignId, 25649);
    await syncCompanyAds(t.deps, s.companyId);
    expect((await rowOf(s.rowId)).status).toBe('active');
    expect(calls('setStatus')).toEqual([]);
    t.adsGoogle.setSpend(s.campaignId, 25650);
    await syncCompanyAds(t.deps, s.companyId);
    expect(fakeStatus(s.campaignId)).toBe('paused');
    const r = await rowOf(s.rowId);
    expect(r.status).toBe('paused');
    expect(r.spend_cents).toBe(25650);
  });

  test('a failed pause leaves the row active and the next run retries; a paused row is not synced again', async () => {
    const s = await seed('a');
    t.adsGoogle.setSpend(s.campaignId, 25650);
    failSetStatusOnce();
    await syncCompanyAds(t.deps, s.companyId);
    let r = await rowOf(s.rowId);
    expect(r.status).toBe('active');
    expect(r.spend_cents).toBe(25650);
    expect(fakeStatus(s.campaignId)).toBe('active');
    expect(t.logged.length).toBeGreaterThan(0);
    await syncCompanyAds(t.deps, s.companyId);
    expect(fakeStatus(s.campaignId)).toBe('paused');
    r = await rowOf(s.rowId);
    expect(r.status).toBe('paused');
    const before = calls('setStatus').length;
    await syncCompanyAds(t.deps, s.companyId);
    expect(calls('setStatus').length).toBe(before);
  });

  test('after the end date the campaign is paused and ended; on the end date it stays active', async () => {
    const s = await seed('a');
    t.clock.set(new Date('2026-10-18T15:00:00Z'));
    await syncCompanyAds(t.deps, s.companyId);
    expect((await rowOf(s.rowId)).status).toBe('active');
    expect(fakeStatus(s.campaignId)).toBe('active');
    t.clock.set(new Date('2026-10-19T15:00:00Z'));
    await syncCompanyAds(t.deps, s.companyId);
    expect(fakeStatus(s.campaignId)).toBe('paused');
    expect((await rowOf(s.rowId)).status).toBe('ended');
  });

  test('landing requests are counted from the storm pages', async () => {
    const s = await seed('a');
    const page = await q(
      `insert into storm_pages (company_id, company_storm_id, code, active_until) values ($1, $2, 'abcd2345', $3) returning id`,
      [s.companyId, s.companyStormId, new Date('2026-10-30T00:00:00Z')],
    );
    for (const n of [1, 2, 3]) {
      await q(
        `insert into storm_requests (company_id, storm_page_id, name, phone_e164, address, sms_consent)
         values ($1, $2, $3, $4, $5, false)`,
        [s.companyId, page[0]!.id, `Home ${n}`, `+140255501${n}0`, `${n} Elm Street`],
      );
    }
    await syncCompanyAds(t.deps, s.companyId);
    expect((await rowOf(s.rowId)).landing_requests).toBe(3);
  });

  test('a revoked ad account makes no provider call and leaves the campaign unchanged', async () => {
    const s = await seed('a', { accountStatus: 'revoked' });
    t.adsGoogle.setSpend(s.campaignId, 5000);
    await syncCompanyAds(t.deps, s.companyId);
    expect(t.adsGoogle.calls).toEqual([]);
    const r = await rowOf(s.rowId);
    expect(r.status).toBe('active');
    expect(r.spend_cents).toBe(0);
    expect(r.last_synced_at).toBeNull();
  });

  test('a provider error on stats leaves the row unchanged, does not throw, and another company is still synced', async () => {
    const a = await seed('a');
    const b = await seed('b');
    t.adsGoogle.setSpend(a.campaignId, 5000);
    t.adsGoogle.setSpend(b.campaignId, 7000);
    t.adsGoogle.failNext('other');
    await expect(syncCompanyAds(t.deps, a.companyId)).resolves.toBeUndefined();
    expect((await rowOf(a.rowId)).spend_cents).toBe(0);
    expect(t.logged.length).toBeGreaterThan(0);
    await syncCompanyAds(t.deps, b.companyId);
    expect((await rowOf(b.rowId)).spend_cents).toBe(7000);
    expect((await rowOf(a.rowId)).spend_cents).toBe(0);
  });
});

describe('companiesNeedingAdSync', () => {
  test('lists a pending-account company and a live-campaign company once each', async () => {
    const b = await seed('b');
    // a: only a pending account (no campaign); b: only an active account with a live campaign
    await owner.query(
      `insert into ad_accounts (company_id, platform, external_account_id, status) values ($1, 'meta', 'act_777888999', 'pending')`,
      [t.seed.a.companyId],
    );
    const got = await companiesNeedingAdSync(t.deps.pools.system);
    expect(got).toEqual([t.seed.a.companyId, b.companyId].sort().map((companyId) => ({ companyId })));
  });
});
