import {
  companyTimeZone,
  countLandingRequests,
  getAdAccountByPlatform,
  listActiveCampaigns,
  recordCampaignSync,
  withTenant,
  type LiveCampaign,
} from '@roofline/db';
import { localDate } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { reportJobError } from '../jobs/scheduler/report.ts';
import { systemContext } from '../permissions.ts';
import type { AdStats } from '../providers/ads-google.ts';
import { recheckPendingAdAccounts } from './ad-recheck.ts';

/**
 * Syncs one company's ad accounts and ad spend: the recheck of accounts waiting to be accepted, then the
 * campaign spend sync. One failing does not skip the other.
 */
export async function syncCompanyAds(deps: AppDeps, companyId: string): Promise<void> {
  try {
    await recheckPendingAdAccounts(deps, companyId);
  } catch (err) {
    reportJobError(deps, err, `ad-sync: company ${companyId} recheck`);
  }
  try {
    await syncCampaignSpend(deps, companyId);
  } catch (err) {
    reportJobError(deps, err, `ad-sync: company ${companyId} spend`);
  }
}

/** The approved maximum is a hard stop: at 95% of it (integer math) the campaign is paused, every run until the platform says paused. */
export function atPauseLine(spendCents: number, maxSpendCents: number): boolean {
  return spendCents * 100 >= maxSpendCents * 95;
}

type PlatformAds = {
  stats(accountId: string, campaignId: string): Promise<AdStats>;
  setStatus(accountId: string, campaignId: string, s: 'active' | 'paused'): Promise<void>;
};

/**
 * The hourly look at one company's live campaigns. Each gets one stats read on its platform (outside any
 * transaction), then its numbers are stored (only while the row is still 'active'). At 95% of the approved
 * maximum the campaign is paused on the platform; the row becomes 'paused' only once the platform reports
 * paused, so a failed pause is retried by the next run. After the end date the campaign is paused and
 * becomes 'ended'. A campaign whose ad account is not active is skipped with no provider call. One campaign
 * failing is logged (never provider text) and leaves that campaign untouched; the others continue.
 */
export async function syncCampaignSpend(deps: AppDeps, companyId: string, now: Date = deps.clock.now()): Promise<void> {
  const ctx = systemContext(companyId);
  const campaigns = await withTenant(deps.pools, ctx, (tx) => listActiveCampaigns(tx, ctx));
  for (const campaign of campaigns) {
    try {
      await syncOne(deps, companyId, campaign, now);
    } catch (err) {
      reportJobError(deps, err, `ad-sync: company ${companyId} campaign ${campaign.id}`);
    }
  }
}

async function syncOne(deps: AppDeps, companyId: string, campaign: LiveCampaign, now: Date): Promise<void> {
  const ctx = systemContext(companyId);
  const prep = await withTenant(deps.pools, ctx, async (tx) => {
    const account = await getAdAccountByPlatform(tx, ctx, campaign.platform);
    if (!account || account.status !== 'active') return null;
    return {
      accountId: account.externalAccountId,
      zone: await companyTimeZone(tx, ctx),
      landingRequests: await countLandingRequests(tx, ctx, campaign.companyStormId),
    };
  });
  if (!prep) return;
  const ads: PlatformAds = campaign.platform === 'google' ? deps.adsGoogle : deps.adsMeta;
  const { accountId } = prep;
  const stats = await ads.stats(accountId, campaign.externalCampaignId);

  let status: 'active' | 'paused' | 'ended' | undefined;
  let pauseError: unknown;
  const pause = async (): Promise<boolean> => {
    try {
      await ads.setStatus(accountId, campaign.externalCampaignId, 'paused');
      return true;
    } catch (err) {
      pauseError = err;
      return false;
    }
  };

  const pastEnd = campaign.endDate !== null && localDate(now, prep.zone) > campaign.endDate;
  if (atPauseLine(stats.spendCents, campaign.maxSpendCents)) {
    let paused = stats.status === 'paused';
    if (!paused && (await pause())) {
      try {
        paused = (await ads.stats(accountId, campaign.externalCampaignId)).status === 'paused';
      } catch (err) {
        pauseError = err;
      }
    }
    if (paused) status = 'paused';
  } else if (pastEnd || stats.status === 'ended' || stats.status === 'removed') {
    if (stats.status === 'active' && !(await pause())) status = undefined;
    else status = 'ended';
  } else if (stats.status === 'paused') {
    status = 'paused';
  }

  await withTenant(deps.pools, ctx, (tx) =>
    recordCampaignSync(tx, ctx, campaign.id, {
      spendCents: stats.spendCents,
      impressions: stats.impressions,
      clicks: stats.clicks,
      landingRequests: prep.landingRequests,
      status,
      now,
    }),
  );
  if (pauseError !== undefined) reportJobError(deps, pauseError, `ad-sync: company ${companyId} campaign ${campaign.id} pause`);
}
