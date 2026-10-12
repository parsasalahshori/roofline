import { AdPlatformError, type AdStats } from '../ads-google.ts';
import type { GoogleAdsHttp } from './http.ts';

export type GoogleAdsReport = {
  stats(customerId: string, campaignId: string): Promise<AdStats>;
};

/** Google reports micros (millionths of the account currency); one cent is 10,000 micros. */
const MICROS_PER_CENT = 10_000;

function digits(id: string): string {
  return id.replace(/-/g, '');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Google sends int64 values as JSON strings; anything unreadable counts as zero. */
function number(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function mapStatus(status: string): AdStats['status'] {
  switch (status) {
    case 'ENABLED':
      return 'active';
    case 'REMOVED':
      return 'removed';
    default:
      // PAUSED, and UNKNOWN (which we never treat as spending): not delivering, so show as paused.
      return 'paused';
  }
}

export function createReport(http: GoogleAdsHttp): GoogleAdsReport {
  return {
    async stats(customerId: string, campaignId: string): Promise<AdStats> {
      if (!/^\d+$/.test(campaignId)) throw new AdPlatformError('other');

      const rows = await http.search(
        digits(customerId),
        `SELECT campaign.id, campaign.status, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE campaign.id = ${campaignId}`,
      );
      if (rows.length === 0) return { spendCents: 0, impressions: 0, clicks: 0, status: 'removed' };

      let costMicros = 0;
      let impressions = 0;
      let clicks = 0;
      for (const row of rows) {
        const metrics = asRecord(asRecord(row)?.metrics);
        costMicros += number(metrics?.costMicros);
        impressions += number(metrics?.impressions);
        clicks += number(metrics?.clicks);
      }
      const campaign = asRecord(asRecord(rows[0])?.campaign);
      const status = mapStatus(typeof campaign?.status === 'string' ? campaign.status : '');

      return { spendCents: Math.round(costMicros / MICROS_PER_CENT), impressions, clicks, status };
    },
  };
}
