import {
  agentTaskSteps,
  claimAdCampaign,
  coverCircles,
  ensureStormPage,
  getAdAccountByPlatform,
  getAdCampaignByStep,
  getCompanyName,
  swathCenter,
  type TenantContext,
  updateAdCampaign,
  withTenant,
} from '@roofline/db';
import {
  dailyBudgetCents,
  GOOGLE_MIN_CIRCLE_RADIUS_M,
  localDate,
  META_MIN_CIRCLE_RADIUS_M,
  stepTypes,
} from '@roofline/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { AppDeps } from '../app.ts';
import { can } from '../permissions.ts';
import { companyOriginFor } from '../public/storm-requests.ts';
import { type AdErrorKind, AdPlatformError } from '../providers/ads-google.ts';
import type { StepHandler, StepOutcome } from '../tasks/runner.ts';
import { resolveAdImage } from './creative.ts';

/*
 * The create_ad_campaign step (S1 Task 19, Review Focus 1): no money moves without the owner. Every run
 * re-checks the step's spend approval and the ad account before any platform call, searches the platform
 * for the campaign's name tag before creating one (a retry after a lost response must not create a second),
 * creates the campaign PAUSED with a total budget of daily x days <= the approved maximum, stores its id,
 * and only then enables it. All platform calls happen outside transactions.
 */

const UNREADABLE = "We couldn't read this ad. Please make it again.";
export const NOT_APPROVED = 'This ad was not approved. Ask the owner to approve it.';
const NO_BUDGET = 'The most to spend is too small for that many days. Raise it or pick fewer days.';
const NO_AREA = "We couldn't find a hail area to show this ad in.";
const NO_STORM = "We couldn't find that storm. Please make this plan again.";

/** The same five sentences as apps/web/src/copy (the API cannot import web copy). */
export const AD_ERROR_COPY: Record<AdErrorKind, string> = {
  policy: "Google didn't approve the ad. Edit the words and try again.",
  payment: 'The ad account has a payment problem. Fix it in Google Ads.',
  access: "Roofline can't reach this ad account anymore. Reconnect it in Settings → Connections.",
  targeting: 'The ad platform did not accept the area. Try again, or pick a smaller area.',
  other: 'The ad could not be started. Try again in a minute.',
};

const MAX_CIRCLES = 50;
/** Meta's Housing category needs a wide, plain area: one 15 mile circle on the middle of the hail. */
const HOUSING_RADIUS_M = 24140;

const attention = (errorPlain: string): StepOutcome => ({ status: 'needs_attention', result: {}, errorPlain });

/** 'YYYY-MM-DD' plus whole days. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export const createAdCampaignHandler: StepHandler = async (deps: AppDeps, ctx: TenantContext, step) => {
  const parsed = stepTypes.create_ad_campaign.payload.safeParse(step.payload);
  if (!parsed.success) return attention(UNREADABLE);
  const p = parsed.data;
  const { companyStormId, platform } = p;

  // Review Focus 1: the approval is re-read from the database, never taken from the step the runner passed.
  const approved = await withTenant(deps.pools, ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(agentTaskSteps)
      .where(and(eq(agentTaskSteps.companyId, ctx.companyId), eq(agentTaskSteps.id, step.id)))
      .limit(1);
    if (!row) return false;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    if (
      row.status !== 'running' ||
      !row.enabled ||
      row.approvedByUserId === null ||
      row.approvedAt === null ||
      row.approvalClass !== 'spend' ||
      payload.maxSpendCents !== p.maxSpendCents ||
      payload.days !== p.days
    ) {
      return false;
    }
    const members = await tx.execute(
      sql`select role, can_approve_spend from company_members
          where user_id = ${row.approvedByUserId} and status = 'active' limit 1`,
    );
    const m = members.rows[0];
    if (!m) return false;
    const role = String(m.role);
    if (role !== 'owner' && role !== 'office' && role !== 'rep') return false;
    return can({ role, canApproveSpend: m.can_approve_spend === true }, 'approve_spend');
  });
  if (!approved) return attention(NOT_APPROVED);

  const now = deps.clock.now();
  const daily = dailyBudgetCents(p.maxSpendCents, p.days);
  if (daily < 1 || daily * p.days > p.maxSpendCents) return attention(NO_BUDGET);

  const prep = await withTenant(deps.pools, ctx, async (tx) => {
    const account = await getAdAccountByPlatform(tx, ctx, platform);
    const storm = await tx.execute(sql`select id from company_storms where id = ${companyStormId}`);
    if (!storm.rows[0]) return { kind: 'no_storm' as const };
    const co = await tx.execute(
      sql`select name, slug, timezone, address_city from companies where id = ${ctx.companyId}`,
    );
    const c = co.rows[0];
    const name = (await getCompanyName(tx, ctx)) ?? String(c?.name ?? '');
    const cityRaw = typeof c?.address_city === 'string' ? c.address_city.trim() : '';
    const circles = await coverCircles(
      tx,
      companyStormId,
      platform === 'google' ? GOOGLE_MIN_CIRCLE_RADIUS_M : META_MIN_CIRCLE_RADIUS_M,
      MAX_CIRCLES,
    );
    return {
      kind: 'ok' as const,
      account,
      name,
      city: cityRaw !== '' ? cityRaw : name,
      slug: String(c?.slug ?? ''),
      timezone: typeof c?.timezone === 'string' && c.timezone !== '' ? c.timezone : 'America/Chicago',
      circles,
    };
  });
  if (prep.kind === 'no_storm') return attention(NO_STORM);
  const { account, name: companyName, city, slug, timezone, circles } = prep;

  if (!account || account.status !== 'active') {
    // Nothing is created and no row is made. A row an earlier run made is marked failed only while it
    // never went live; an active, paused or ended campaign is left alone.
    await withTenant(deps.pools, ctx, async (tx) => {
      const existing = await getAdCampaignByStep(tx, ctx, step.id);
      if (existing && (existing.status === 'creating' || existing.status === 'failed')) {
        await updateAdCampaign(tx, ctx, existing.id, {
          status: 'failed',
          errorKind: 'access',
          errorPlain: AD_ERROR_COPY.access,
          now,
        });
      }
    });
    return attention(AD_ERROR_COPY.access);
  }
  if (circles.length === 0) return attention(NO_AREA);

  const startDate = localDate(now, timezone);
  const endDate = addDays(startDate, p.days - 1);
  // The landing page is Task 20's: ensureStormPage owns the code and the active-until rule.
  const page = await withTenant(deps.pools, ctx, (tx) => ensureStormPage(tx, ctx, { companyStormId, now }));
  const landingUrl = `${companyOriginFor(deps.config, slug) ?? deps.config.PUBLIC_BASE_URL}/storm/${page.code}`;

  const creative: Record<string, unknown> = {
    headline: p.headline,
    description: p.description,
    startDate,
    endDate,
    landingUrl,
    ...(platform === 'meta' ? { primaryText: p.primaryText } : { keywords: p.keywords ?? [] }),
  };

  // Claim before any platform call; the row is how a retry knows what already happened.
  const row = await withTenant(deps.pools, ctx, (tx) =>
    claimAdCampaign(tx, ctx, {
      companyStormId,
      stepId: step.id,
      platform,
      dailyBudgetCents: daily,
      days: p.days,
      maxSpendCents: p.maxSpendCents,
      targets: circles,
      creative,
      now,
    }),
  );
  const summary = (campaignRow: typeof row): StepOutcome => ({
    status: 'done',
    result: {
      campaigns: 1,
      circles: campaignRow.targets.length,
      dailyBudgetCents: campaignRow.dailyBudgetCents,
      days: campaignRow.days,
      housingFallback: campaignRow.housingFallback ? 1 : 0,
    },
  });
  // A campaign that went live is never re-enabled: the hourly sync may have paused it at 95% or ended it.
  if (row.status === 'active' || row.status === 'paused' || row.status === 'ended') return summary(row);

  const stored = row.creative;
  const useCreative = {
    headline: String(stored.headline ?? p.headline),
    description: String(stored.description ?? p.description),
    startDate: String(stored.startDate ?? startDate),
    endDate: String(stored.endDate ?? endDate),
    landingUrl: String(stored.landingUrl ?? landingUrl),
  };
  const useCircles = row.targets as { lat: number; lng: number; radiusM: number }[];
  const nameTag = `Roofline storm ${companyStormId} ${platform}`;
  const accountId = account.externalAccountId;
  const api = platform === 'google' ? deps.adsGoogle : deps.adsMeta;

  const fail = async (kind: AdErrorKind): Promise<StepOutcome> => {
    const errorPlain = AD_ERROR_COPY[kind];
    await withTenant(deps.pools, ctx, (tx) =>
      updateAdCampaign(tx, ctx, row.id, { status: 'failed', errorKind: kind, errorPlain, now: deps.clock.now() }),
    );
    return attention(errorPlain);
  };

  try {
    let campaignId = row.externalCampaignId ?? (await api.findCampaign(accountId, nameTag));
    let housing = row.housingFallback;
    let finalTargets = useCircles;
    if (campaignId === null) {
      if (platform === 'google') {
        const made = await deps.adsGoogle.createCampaign({
          accountId,
          nameTag,
          dailyBudgetCents: daily,
          ...useCreative,
          circles: useCircles,
          companyName,
          city,
          keywords: p.keywords ?? [],
        });
        campaignId = made.campaignId;
      } else {
        const image = await resolveAdImage(deps, ctx, { companyName, photoId: p.photoId });
        const base = {
          accountId,
          nameTag,
          dailyBudgetCents: daily,
          ...useCreative,
          companyName,
          city,
          primaryText: p.primaryText ?? '',
          imagePng: image.bytes,
        };
        try {
          campaignId = (await deps.adsMeta.createCampaign({ ...base, circles: useCircles, housing: false })).campaignId;
        } catch (err) {
          if (!(err instanceof AdPlatformError) || err.kind !== 'targeting') throw err;
          const found = await deps.adsMeta.findCampaign(accountId, nameTag);
          if (found !== null) {
            campaignId = found;
          } else {
            const centre = await withTenant(deps.pools, ctx, (tx) => swathCenter(tx, companyStormId));
            if (!centre) return await fail('targeting');
            const one = [{ lat: centre.lat, lng: centre.lng, radiusM: HOUSING_RADIUS_M }];
            campaignId = (await deps.adsMeta.createCampaign({ ...base, circles: one, housing: true })).campaignId;
            housing = true;
            finalTargets = one;
            await withTenant(deps.pools, ctx, (tx) =>
              updateAdCampaign(tx, ctx, row.id, { targets: one, housingFallback: true, now: deps.clock.now() }),
            );
          }
        }
      }
    }
    // The paused id is stored first; only then is the campaign enabled.
    await withTenant(deps.pools, ctx, (tx) =>
      updateAdCampaign(tx, ctx, row.id, { externalCampaignId: campaignId, now: deps.clock.now() }),
    );
    await api.setStatus(accountId, campaignId, 'active');
    await withTenant(deps.pools, ctx, (tx) =>
      updateAdCampaign(tx, ctx, row.id, { status: 'active', errorKind: null, errorPlain: null, now: deps.clock.now() }),
    );
    return summary({
      ...row,
      targets: finalTargets,
      housingFallback: housing,
    });
  } catch (err) {
    if (err instanceof AdPlatformError) return fail(err.kind);
    throw err;
  }
};
