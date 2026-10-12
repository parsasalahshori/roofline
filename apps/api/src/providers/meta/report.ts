import type { AdStats } from '../ads-google.ts';
import type { MetaHttp } from './http.ts';

type Status = AdStats['status'];

/** Maps Meta effective_status to the four-state campaign status. Anything not listed counts as paused. */
function mapStatus(effective: unknown): Status {
  switch (effective) {
    case 'ACTIVE':
      return 'active';
    case 'DELETED':
      return 'removed';
    case 'ARCHIVED':
      return 'ended';
    default:
      return 'paused';
  }
}

/** Lifetime spend, impressions and clicks for one campaign, plus its status. Spend is a decimal string in account currency. */
export async function metaStats(http: MetaHttp, _adAccountId: string, campaignId: string): Promise<AdStats> {
  const insights = (await http.get(`${campaignId}/insights`, { fields: 'spend,impressions,clicks', date_preset: 'maximum' })) as {
    data?: { spend?: unknown; impressions?: unknown; clicks?: unknown }[];
  };
  const row = insights.data?.[0];
  const spendCents = row?.spend ? Math.round(parseFloat(String(row.spend)) * 100) : 0;
  const impressions = row?.impressions ? parseInt(String(row.impressions), 10) : 0;
  const clicks = row?.clicks ? parseInt(String(row.clicks), 10) : 0;

  const campaign = (await http.get(campaignId, { fields: 'status,effective_status' })) as { effective_status?: unknown };
  return { spendCents, impressions, clicks, status: mapStatus(campaign.effective_status) };
}
