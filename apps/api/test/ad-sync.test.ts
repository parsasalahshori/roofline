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
async function seed(
  company: 'a' | 'b',
  opts: {
    accountStatus?: string;
    day?: string;
    /** The row's status (default 'active'). */
    rowStatus?: string;
    pausedBy?: string | null;
    /** When the row was last touched (default NOW). */
    updatedAt?: Date;
    /** What the fake platform reports (default 'active'). */
    platformStatus?: 'active' | 'paused';
    externalId?: boolean;
  } = {},
): Promise<Seeded> {
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
    `insert into ad_accounts (company_id, platform, external_account_id, status, currency) values ($1, 'google', $2, $3, 'USD')`,
    [companyId, ACCOUNT, opts.accountStatus ?? 'active'],
  );
  const { campaignId } = await t.adsGoogle.createCampaign(adCreate(`Roofline storm ${companyStormId} google`));
  const rows = await q(
    `insert into ad_campaigns (company_id, company_storm_id, step_id, platform, external_campaign_id, status,
                               daily_budget_cents, days, max_spend_cents, creative)
     values ($1, $2, $3, 'google', $4, $6, 3857, 7, $5, '{"endDate":"2026-10-18","startDate":"2026-10-12"}')
     returning id`,
    [companyId, companyStormId, stepId, opts.externalId === false ? null : campaignId, MAX, opts.rowStatus ?? 'active'],
  );
  await owner.query(`update ad_campaigns set paused_by = $2, updated_at = $3 where id = $1`, [
    rows[0]!.id,
    opts.pausedBy ?? null,
    opts.updatedAt ?? NOW,
  ]);
  t.adsGoogle.campaigns.get(campaignId)!.status = opts.platformStatus ?? 'active'; // the handler enabled it
  t.adsGoogle.calls.length = 0;
  return { companyId, companyStormId, rowId: rows[0]!.id as string, campaignId };
}

const rowOf = async (id: string) =>
  (await q(`select status, paused_by, spend_cents, impressions, clicks, landing_requests, last_synced_at from ad_campaigns where id = $1`, [id]))[0]!;
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

describe('a lost enable: the sweep of failed and long-creating rows', () => {
  const HOUR = 3_600_000;

  test('the handler loses the enable response, and the next sync of the failed row pauses a campaign the platform still reports active', async () => {
    const s = await seed('a', { rowStatus: 'failed', platformStatus: 'active' });
    t.adsGoogle.setSpend(s.campaignId, 5000);
    await syncCompanyAds(t.deps, s.companyId);
    expect(fakeStatus(s.campaignId)).toBe('paused');
    const r = await rowOf(s.rowId);
    expect(r.status).toBe('failed'); // never changed
    expect(r.paused_by).toBe('roofline'); // confirmed off
    expect(r.spend_cents).toBe(5000);
    expect(calls('setStatus').map((c) => c.args[2])).toEqual(['paused']);
    // Confirmed off: the row is not read again, and nothing re-enables it.
    t.adsGoogle.calls.length = 0;
    await syncCompanyAds(t.deps, s.companyId);
    expect(t.adsGoogle.calls).toEqual([]);
  });

  test('a failed row the platform reports paused (or ended) is only marked confirmed off: no pause call, status unchanged', async () => {
    const s = await seed('a', { rowStatus: 'failed', platformStatus: 'paused' });
    await syncCompanyAds(t.deps, s.companyId);
    expect(calls('setStatus')).toEqual([]);
    const r = await rowOf(s.rowId);
    expect(r.status).toBe('failed');
    expect(r.paused_by).toBe('roofline');
  });

  test('a failed pause is retried by the next run; the row stays in the sweep until the platform confirms it paused', async () => {
    const s = await seed('a', { rowStatus: 'failed' });
    failSetStatusOnce();
    await syncCompanyAds(t.deps, s.companyId);
    expect(fakeStatus(s.campaignId)).toBe('active');
    expect((await rowOf(s.rowId)).paused_by).toBeNull();
    expect(t.logged.length).toBeGreaterThan(0);
    await syncCompanyAds(t.deps, s.companyId);
    expect(fakeStatus(s.campaignId)).toBe('paused');
    expect((await rowOf(s.rowId)).paused_by).toBe('roofline');
  });

  test('a creating row is swept only after an hour (the handler may be mid-flight), and a row without a platform id never', async () => {
    const fresh = await seed('a', { rowStatus: 'creating', updatedAt: new Date(NOW.getTime() - 10 * 60_000) });
    await syncCompanyAds(t.deps, fresh.companyId);
    expect(t.adsGoogle.calls).toEqual([]);
    expect(fakeStatus(fresh.campaignId)).toBe('active');
    await owner.query(`update ad_campaigns set updated_at = $2 where id = $1`, [fresh.rowId, new Date(NOW.getTime() - 2 * HOUR)]);
    await syncCompanyAds(t.deps, fresh.companyId);
    expect(fakeStatus(fresh.campaignId)).toBe('paused');
    const r = await rowOf(fresh.rowId);
    expect(r.status).toBe('creating');
    expect(r.paused_by).toBe('roofline');

    const noId = await seed('b', { rowStatus: 'failed', externalId: false });
    t.adsGoogle.calls.length = 0;
    await syncCompanyAds(t.deps, noId.companyId);
    expect(t.adsGoogle.calls).toEqual([]);
  });

  test('the sweep works with an account whose Check failed, and never re-enables', async () => {
    const s = await seed('a', { rowStatus: 'failed', accountStatus: 'error' });
    await syncCompanyAds(t.deps, s.companyId);
    expect(fakeStatus(s.campaignId)).toBe('paused');
    expect(calls('setStatus').every((c) => c.args[2] === 'paused')).toBe(true);
  });
});

describe('a failed Check does not turn off the 95% guard', () => {
  test.each(['error', 'pending'])('a campaign on a %s account is still paused at 95%%', async (accountStatus) => {
    const s = await seed('a', { accountStatus });
    t.adsGoogle.setSpend(s.campaignId, 25650);
    await syncCompanyAds(t.deps, s.companyId);
    expect(fakeStatus(s.campaignId)).toBe('paused');
    expect(await rowOf(s.rowId)).toMatchObject({ status: 'paused', paused_by: 'roofline' });
  });
});

describe('who paused it', () => {
  test('a platform-reported pause below the line is paused(platform) and is read again; back to active when the platform resumes', async () => {
    const s = await seed('a');
    t.adsGoogle.campaigns.get(s.campaignId)!.status = 'paused'; // In-process, with issues, or the owner paused it there
    t.adsGoogle.setSpend(s.campaignId, 5000);
    await syncCompanyAds(t.deps, s.companyId);
    expect(await rowOf(s.rowId)).toMatchObject({ status: 'paused', paused_by: 'platform', spend_cents: 5000 });
    expect(calls('setStatus')).toEqual([]);

    await syncCompanyAds(t.deps, s.companyId); // still read
    expect(calls('stats').length).toBe(2);

    t.adsGoogle.campaigns.get(s.campaignId)!.status = 'active';
    await syncCompanyAds(t.deps, s.companyId);
    expect(await rowOf(s.rowId)).toMatchObject({ status: 'active', paused_by: null });
    expect(calls('setStatus')).toEqual([]);
  });

  test('a paused row with no paused_by counts as not ours: it is read and can go back to active', async () => {
    const s = await seed('a', { rowStatus: 'paused', pausedBy: null, platformStatus: 'active' });
    await syncCompanyAds(t.deps, s.companyId);
    expect(await rowOf(s.rowId)).toMatchObject({ status: 'active', paused_by: null });
  });

  test('a paused(platform) row the platform reports active again still pauses at 95%, as ours', async () => {
    const s = await seed('a', { rowStatus: 'paused', pausedBy: 'platform', platformStatus: 'active' });
    t.adsGoogle.setSpend(s.campaignId, 25650);
    await syncCompanyAds(t.deps, s.companyId);
    expect(fakeStatus(s.campaignId)).toBe('paused');
    expect(await rowOf(s.rowId)).toMatchObject({ status: 'paused', paused_by: 'roofline' });
  });

  test('a paused(platform) row still ends after its end date', async () => {
    const s = await seed('a', { rowStatus: 'paused', pausedBy: 'platform', platformStatus: 'paused' });
    t.clock.set(new Date('2026-10-19T15:00:00Z'));
    await syncCompanyAds(t.deps, s.companyId);
    expect((await rowOf(s.rowId)).status).toBe('ended');
  });

  test('our own 95% pause and ended stop the sync: the rows are not read again', async () => {
    const own = await seed('a', { rowStatus: 'paused', pausedBy: 'roofline', platformStatus: 'paused' });
    await syncCompanyAds(t.deps, own.companyId);
    expect(t.adsGoogle.calls).toEqual([]);
    expect(await rowOf(own.rowId)).toMatchObject({ status: 'paused', paused_by: 'roofline', last_synced_at: null });
    const ended = await seed('b', { rowStatus: 'ended' });
    t.adsGoogle.calls.length = 0;
    await syncCompanyAds(t.deps, ended.companyId);
    expect(t.adsGoogle.calls).toEqual([]);
  });

  test('the write is guarded by the status the list read: a row changed meanwhile is left alone', async () => {
    const s = await seed('a');
    const original = t.adsGoogle.stats.bind(t.adsGoogle);
    t.adsGoogle.stats = async (...args: Parameters<typeof original>) => {
      await owner.query(`update ad_campaigns set status = 'ended' where id = $1`, [s.rowId]);
      return original(...args);
    };
    t.adsGoogle.setSpend(s.campaignId, 5000);
    await syncCompanyAds(t.deps, s.companyId);
    expect(await rowOf(s.rowId)).toMatchObject({ status: 'ended', spend_cents: 0 });
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

  test('lists a company with a failed, paused (not by Roofline) or long-creating campaign that has a platform id, and drops confirmed-off rows', async () => {
    const a = await seed('a', { rowStatus: 'failed' });
    const list = () => companiesNeedingAdSync(t.deps.pools.system, NOW);
    const only = (id: string) => [{ companyId: id }];
    expect(await list()).toEqual(only(a.companyId));
    await owner.query(`update ad_campaigns set paused_by = 'roofline' where id = $1`, [a.rowId]);
    expect(await list()).toEqual([]);
    await owner.query(`update ad_campaigns set status = 'paused', paused_by = 'platform' where id = $1`, [a.rowId]);
    expect(await list()).toEqual(only(a.companyId));
    await owner.query(`update ad_campaigns set paused_by = null where id = $1`, [a.rowId]);
    expect(await list()).toEqual(only(a.companyId));
    await owner.query(`update ad_campaigns set paused_by = 'roofline' where id = $1`, [a.rowId]);
    expect(await list()).toEqual([]);
    await owner.query(`update ad_campaigns set status = 'creating', paused_by = null, updated_at = $2 where id = $1`, [a.rowId, NOW]);
    expect(await list()).toEqual([]); // the handler may be mid-flight
    await owner.query(`update ad_campaigns set updated_at = $2 where id = $1`, [a.rowId, new Date(NOW.getTime() - 2 * 3_600_000)]);
    expect(await list()).toEqual(only(a.companyId));
    await owner.query(`update ad_campaigns set external_campaign_id = null where id = $1`, [a.rowId]);
    expect(await list()).toEqual([]);
    await owner.query(`update ad_campaigns set external_campaign_id = 'g-x', status = 'ended' where id = $1`, [a.rowId]);
    expect(await list()).toEqual([]);
  });
});
