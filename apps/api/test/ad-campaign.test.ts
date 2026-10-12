import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import type { StepRow } from '@roofline/db';
import { insertOmahaStorm, type Query } from '@roofline/db/testing';
import { AdPlatformError } from '../src/providers/ads-google.ts';
import { companyOriginFor } from '../src/public/storm-requests.ts';
import { createAdCampaignHandler, NO_LANDING_PAGES, NOT_APPROVED, NOT_USD } from '../src/storm/ad-campaign.ts';
import { Actors } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { agentCtx, dbSteps, enqueued, newTask, seenOf, setStep } from './task-helpers.ts';

/*
 * The create_ad_campaign step (S1 Task 19) against a real database, with the fake ad platforms. These tests
 * need Docker and run on CI only.
 */

const NOW = new Date('2026-10-12T15:00:00Z');
const DAY = '2026-10-11';
const POLICY = "Google didn't approve the ad. Edit the words and try again.";
const AD_OTHER = 'The ad could not be started. Try again in a minute.';
const ACCESS = "Roofline can't reach this ad account anymore. Reconnect it in Settings → Connections.";
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let owner: pg.Pool;
let t: TestApp;
let companyStormId: string;

const q: Query = async (text, values) => (await owner.query(text, values)).rows;
const companyA = () => t.seed.a.companyId;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  await q(`update companies set address_city = 'Omaha' where id = $1`, [companyA()]);
  const stormId = await insertOmahaStorm(q, DAY);
  const rows = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit)
     values ($1, $2, 1.5, 0, 0) returning id`,
    [companyA(), stormId],
  );
  companyStormId = rows[0]!.id as string;
  for (const [platform, external] of [
    ['google', '1234567890'],
    ['meta', 'act_555'],
  ] as const) {
    await q(
      `insert into ad_accounts (company_id, platform, external_account_id, status, currency) values ($1, $2, $3, 'active', 'USD')`,
      [companyA(), platform, external],
    );
  }
});

type Platform = 'google' | 'meta';

async function makeStep(
  platform: Platform,
  over: Record<string, unknown> = {},
  approval: { approver?: string | null } = {},
): Promise<StepRow> {
  const payload =
    platform === 'google'
      ? { companyStormId, platform, maxSpendCents: 27000, days: 7, headline: 'Hail damage?', description: 'Free roof check.', keywords: ['roof repair'], ...over }
      : { companyStormId, platform, maxSpendCents: 27000, days: 7, headline: 'Hail damage?', description: 'Free roof check.', primaryText: 'Hail hit your street.', ...over };
  const { taskId } = await newTask(t, 'a', { steps: [{ type: 'create_ad_campaign', payload }] });
  const step = (await dbSteps(t, 'a', taskId))[0]!;
  const approver = approval.approver === undefined ? t.seed.a.owner.userId : approval.approver;
  await setStep(t, 'a', step.id, {
    status: 'running',
    approvedByUserId: approver,
    approvedAt: approver === null ? null : NOW,
  });
  return (await dbSteps(t, 'a', taskId))[0]!;
}

/** The landing URL is the company origin plus the code ensureStormPage stored. */
async function expectLandingUrl(row: CampaignRow) {
  const pages = await q(`select code from storm_pages where company_id = $1 and company_storm_id = $2`, [companyA(), companyStormId]);
  expect(pages).toHaveLength(1);
  const [co] = await q(`select slug from companies where id = $1`, [companyA()]);
  const origin = companyOriginFor(t.deps.config, String(co!.slug))!;
  expect(row.creative.landingUrl).toBe(`${origin}/storm/${String(pages[0]!.code)}`);
}

const run = (step: StepRow) => createAdCampaignHandler(t.deps, agentCtx(companyA()), step);
type CampaignRow = {
  status: string;
  external_campaign_id: string | null;
  daily_budget_cents: number;
  days: number;
  max_spend_cents: number;
  creative: Record<string, unknown>;
  housing_fallback: boolean;
  error_kind: string | null;
  error_plain: string | null;
  paused_by: string | null;
};
const campaignRow = async (stepId: string) =>
  (await q(`select * from ad_campaigns where company_id = $1 and step_id = $2`, [companyA(), stepId]))[0] as unknown as CampaignRow;
const methods = (calls: { method: string }[]) => calls.map((c) => c.method);

describe('create_ad_campaign', () => {
  test('the landing page outlives the campaign and is never shortened', async () => {
    // A 30-day campaign from 2026-10-12 ends 2026-11-10; the page (convective day 10-11 + 30 = 11-10) would end a day early.
    const long = await makeStep('google', { days: 30, maxSpendCents: 30000 });
    expect((await run(long)).status).toBe('done');
    const until = async () =>
      new Date(String((await q(`select active_until from storm_pages where company_id = $1`, [companyA()]))[0]!.active_until)).toISOString();
    expect(await until()).toBe('2026-11-11T00:00:00.000Z');

    // A later, shorter campaign for the same storm leaves it alone.
    const short = await makeStep('meta', { days: 3, maxSpendCents: 3000 });
    expect((await run(short)).status).toBe('done');
    expect(await until()).toBe('2026-11-11T00:00:00.000Z');
  });

  test('without a landing pages domain the step needs attention before any platform call', async () => {
    const step = await makeStep('google');
    const deps = { ...t.deps, config: { ...t.deps.config, POLICY_PAGES_DOMAIN: undefined } };
    const outcome = await createAdCampaignHandler(deps, agentCtx(companyA()), step);
    expect(outcome.status).toBe('needs_attention');
    expect(outcome.errorPlain).toBe(NO_LANDING_PAGES);
    expect(t.adsGoogle.calls).toEqual([]);
    expect(t.adsMeta.calls).toEqual([]);
    expect(await q(`select 1 from ad_campaigns where company_id = $1`, [companyA()])).toHaveLength(0);
  });

  test('google happy path: one paused campaign, enabled, within the approved maximum', async () => {
    const step = await makeStep('google');
    const outcome = await run(step);
    expect(outcome.status).toBe('done');
    const r = outcome.result as Record<string, number>;
    expect(r).toEqual({ campaigns: 1, circles: r.circles, dailyBudgetCents: Math.floor(27000 / 7), days: 7, housingFallback: 0 });
    expect(r.circles).toBeGreaterThanOrEqual(1);
    expect(r.circles).toBeLessThanOrEqual(50);

    expect(t.adsGoogle.campaigns.size).toBe(1);
    const [[id, c]] = [...t.adsGoogle.campaigns];
    expect(c.status).toBe('active');
    expect(c.input.nameTag).toBe(`Roofline storm ${companyStormId} google`);
    expect(c.input.circles.every((x) => x.radiusM >= 1000)).toBe(true);
    const order = methods(t.adsGoogle.calls);
    expect(order.indexOf('createCampaign')).toBeLessThan(order.indexOf('setStatus'));

    const row = await campaignRow(step.id);
    expect(row.status).toBe('active');
    expect(row.external_campaign_id).toBe(id);
    expect(row.daily_budget_cents * row.days).toBeLessThanOrEqual(row.max_spend_cents);
    expect(row.creative).toMatchObject({ startDate: '2026-10-12', endDate: '2026-10-18', headline: 'Hail damage?' });
    await expectLandingUrl(row);
  });

  test.each([
    [27001, 7, 3857],
    [500, 30, 16],
  ])('budget x days stays within the maximum (%i cents, %i days)', async (max, days, daily) => {
    const step = await makeStep('google', { maxSpendCents: max, days });
    const outcome = await run(step);
    expect(outcome.status).toBe('done');
    expect((outcome.result as Record<string, number>).dailyBudgetCents).toBe(daily);
    expect(daily * days).toBeLessThanOrEqual(max);
    const [[, c]] = [...t.adsGoogle.campaigns];
    expect(c.input.dailyBudgetCents * days).toBeLessThanOrEqual(max);
  });

  test('meta: circles are at least a mile, the image is a PNG and is stored', async () => {
    const step = await makeStep('meta');
    const outcome = await run(step);
    expect(outcome.status).toBe('done');
    const [[, c]] = [...t.adsMeta.campaigns];
    expect(c.input.circles.every((x) => x.radiusM >= 1609)).toBe(true);
    expect([...c.input.imagePng.slice(0, 8)]).toEqual(PNG);
    expect(c.input.housing).toBe(false);
    expect(c.status).toBe('active');
    const files = await q(`select id from stored_files where company_id = $1 and kind = 'ad_image'`, [companyA()]);
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  test('a retry after a lost create response adopts the campaign instead of creating a second', async () => {
    const step = await makeStep('google');
    await t.adsGoogle.createCampaign({
      accountId: '1234567890',
      nameTag: `Roofline storm ${companyStormId} google`,
      dailyBudgetCents: 3857,
      startDate: '2026-10-12',
      endDate: '2026-10-18',
      circles: [{ lat: 41.2, lng: -95.9, radiusM: 1000 }],
      landingUrl: 'https://example.test/storm/x',
      headline: 'h',
      description: 'd',
      companyName: 'c',
      city: 'Omaha',
      keywords: ['k'],
    });
    t.adsGoogle.calls.length = 0;
    const outcome = await run(step);
    expect(outcome.status).toBe('done');
    expect(t.adsGoogle.campaigns.size).toBe(1);
    expect(methods(t.adsGoogle.calls)).not.toContain('createCampaign');
    const row = await campaignRow(step.id);
    expect(row.status).toBe('active');
    expect(row.external_campaign_id).toBe([...t.adsGoogle.campaigns.keys()][0]);
  });

  test('running a finished step again returns done with no new platform create', async () => {
    const step = await makeStep('google');
    const first = await run(step);
    t.adsGoogle.calls.length = 0;
    const second = await run(step);
    expect(second).toEqual(first);
    expect(methods(t.adsGoogle.calls)).not.toContain('createCampaign');
    expect(t.adsGoogle.campaigns.size).toBe(1);
  });

  test('housing fallback: one 15 mile circle, flagged on the row', async () => {
    t.adsMeta.requireHousingNext();
    const step = await makeStep('meta');
    const outcome = await run(step);
    expect(outcome.status).toBe('done');
    expect((outcome.result as Record<string, number>).housingFallback).toBe(1);
    const row = await campaignRow(step.id);
    expect(row.housing_fallback).toBe(true);
    expect(t.adsMeta.campaigns.size).toBe(1);
    const [[, c]] = [...t.adsMeta.campaigns];
    expect(c.input.housing).toBe(true);
    expect(c.input.circles).toHaveLength(1);
    expect(c.input.circles[0]!.radiusM).toBe(24140);
  });

  test.each([null, 'EUR'])('an ad account that does not bill in USD (%s) is refused before the claim and any platform call', async (currency) => {
    await q(`update ad_accounts set currency = $2 where company_id = $1`, [companyA(), currency]);
    for (const platform of ['google', 'meta'] as const) {
      const step = await makeStep(platform);
      const outcome = await run(step);
      expect(outcome.status).toBe('needs_attention');
      expect(outcome.errorPlain).toBe(NOT_USD);
      expect(await campaignRow(step.id)).toBeUndefined();
    }
    expect(t.adsGoogle.calls).toEqual([]);
    expect(t.adsMeta.calls).toEqual([]);
  });

  test.each(['google', 'meta'] as const)(
    '%s: an enable the platform applied but whose answer was lost is paused again, and the row is failed',
    async (platform) => {
      const fake = platform === 'google' ? t.adsGoogle : t.adsMeta;
      fake.loseResponseOnNextSetStatus('other');
      const step = await makeStep(platform);
      const outcome = await run(step);
      expect(outcome.status).toBe('needs_attention');
      expect(outcome.errorPlain).toBe(AD_OTHER);
      const row = await campaignRow(step.id);
      expect(row.status).toBe('failed');
      expect(row.error_kind).toBe('other');
      expect(row.external_campaign_id).not.toBeNull();
      expect(row.paused_by).toBeNull();
      expect(fake.campaigns.size).toBe(1);
      expect(fake.campaigns.get(row.external_campaign_id!)!.status).toBe('paused');
      const statuses = fake.calls.filter((c) => c.method === 'setStatus').map((c) => c.args[2]);
      expect(statuses).toEqual(['active', 'paused']);
    },
  );

  test('a non-platform error after the id is stored also pauses the campaign before it is rethrown, and a failing pause is only logged', async () => {
    const step = await makeStep('google');
    const fake = t.adsGoogle;
    const original = fake.setStatus.bind(fake);
    let n = 0;
    fake.setStatus = async (...args: Parameters<typeof original>) => {
      n += 1;
      if (n === 1) {
        await original(...args); // the platform applies the enable
        throw new Error('socket hang up');
      }
      throw new AdPlatformError('other'); // and the pause itself fails too
    };
    await expect(run(step)).rejects.toThrow('socket hang up');
    expect(n).toBe(2);
    expect(t.logged.some((l) => l.where.includes('pause after failure'))).toBe(true);
    const row = await campaignRow(step.id);
    expect(row.external_campaign_id).not.toBeNull();
    expect(fake.campaigns.get(row.external_campaign_id!)!.status).toBe('active'); // the sync's sweep pauses it
    expect(row.status).toBe('creating');
  });

  test('an error before the id is stored makes no pause call', async () => {
    const step = await makeStep('google');
    t.adsGoogle.failNext('policy'); // findCampaign throws
    const outcome = await run(step);
    expect(outcome.status).toBe('needs_attention');
    expect(t.adsGoogle.calls.some((c) => c.method === 'setStatus')).toBe(false);
  });

  test('a revoked ad account is refused before any platform create', async () => {
    await q(`update ad_accounts set status = 'revoked' where company_id = $1`, [companyA()]);
    for (const platform of ['google', 'meta'] as const) {
      const step = await makeStep(platform);
      const outcome = await run(step);
      expect(outcome.status).toBe('needs_attention');
      expect(outcome.errorPlain).toBe(ACCESS);
      expect(await campaignRow(step.id)).toBeUndefined();
    }
    expect(methods(t.adsGoogle.calls)).not.toContain('createCampaign');
    expect(methods(t.adsMeta.calls)).not.toContain('createCampaign');
  });

  test('a re-run never re-enables a campaign the sync paused or ended', async () => {
    for (const stopped of ['paused', 'ended'] as const) {
      const step = await makeStep('google');
      expect((await run(step)).status).toBe('done');
      await q(`update ad_campaigns set status = $3 where company_id = $1 and step_id = $2`, [companyA(), step.id, stopped]);
      const before = methods(t.adsGoogle.calls);
      const outcome = await run(step);
      expect(outcome.status).toBe('done');
      const after = methods(t.adsGoogle.calls).slice(before.length);
      expect(after).not.toContain('setStatus');
      expect(after).not.toContain('createCampaign');
      expect((await campaignRow(step.id)).status).toBe(stopped);
      // The next pass is a fresh step for the same storm: drop this row so it can adopt the platform campaign.
      await q(`delete from ad_campaigns where company_id = $1`, [companyA()]);
    }
  });

  test('a revoked account leaves a live campaign row alone', async () => {
    const step = await makeStep('google');
    expect((await run(step)).status).toBe('done');
    await q(`update ad_accounts set status = 'revoked' where company_id = $1`, [companyA()]);
    const outcome = await run(step);
    expect(outcome.status).toBe('needs_attention');
    expect(outcome.errorPlain).toBe(ACCESS);
    const row = await campaignRow(step.id);
    expect(row.status).toBe('active');
    expect(row.error_kind).toBeNull();
  });

  test('a retry after a refusal stores the full creative and end date', async () => {
    await q(`update ad_accounts set status = 'revoked' where company_id = $1`, [companyA()]);
    const step = await makeStep('google');
    expect((await run(step)).status).toBe('needs_attention');
    await q(`update ad_accounts set status = 'active' where company_id = $1`, [companyA()]);
    const outcome = await run(step);
    expect(outcome.status).toBe('done');
    expect((outcome.result as Record<string, number>).circles).toBeGreaterThanOrEqual(1);
    const row = await campaignRow(step.id);
    expect(row.status).toBe('active');
    expect(row.creative).toMatchObject({ startDate: '2026-10-12', endDate: '2026-10-18' });
    await expectLandingUrl(row);
    expect(t.adsGoogle.campaigns.size).toBe(1);
  });

  test('a step nobody approved never reaches a platform', async () => {
    const step = await makeStep('google', {}, { approver: null });
    const outcome = await run(step);
    expect(outcome.status).toBe('needs_attention');
    expect(outcome.errorPlain).toBe(NOT_APPROVED);
    expect(t.adsGoogle.calls).toHaveLength(0);
  });

  test('an approver who lost the right to approve spend is refused', async () => {
    const step = await makeStep('google', {}, { approver: t.seed.a.office.userId });
    const outcome = await run(step);
    expect(outcome.status).toBe('needs_attention');
    expect(outcome.errorPlain).toBe(NOT_APPROVED);
    expect(t.adsGoogle.calls).toHaveLength(0);
    expect(t.adsMeta.calls).toHaveLength(0);
  });

  test('a policy error is recorded on the row and the step needs attention', async () => {
    const step = await makeStep('google');
    const fake = t.adsGoogle;
    const find = fake.findCampaign.bind(fake);
    fake.findCampaign = async (...args) => {
      const found = await find(...args);
      fake.failNext('policy'); // the next call, createCampaign, throws
      return found;
    };
    const outcome = await run(step);
    expect(outcome.status).toBe('needs_attention');
    expect(outcome.errorPlain).toBe(POLICY);
    const row = await campaignRow(step.id);
    expect(row.status).toBe('failed');
    expect(row.error_kind).toBe('policy');
    expect(row.error_plain).toBe(POLICY);
  });

  test('F1 guard: a spend step approved by the office without delegation waits for the owner', async () => {
    const payload = { companyStormId, platform: 'google', maxSpendCents: 27000, days: 7, headline: 'Hail damage?', description: 'Free roof check.', keywords: ['roof repair'] };
    const { taskId } = await newTask(t, 'a', { steps: [{ type: 'create_ad_campaign', payload }] });
    const steps = await dbSteps(t, 'a', taskId);
    const office = await new Actors(t).as('office');
    const res = await office.post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
    expect(res.status).toBe(200);
    expect((await dbSteps(t, 'a', taskId))[0]!.status).toBe('awaiting_owner');
    expect(enqueued(t)).toEqual([]);
    expect(t.adsGoogle.calls).toHaveLength(0);
    expect(t.adsMeta.calls).toHaveLength(0);
  });
});

