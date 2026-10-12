import type { AdCampaignStatus, AdPlatform } from '@roofline/shared';
import { and, eq, sql } from 'drizzle-orm';
import { adCampaigns, companies } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * Spend-sync queries for ad_campaigns (tenant table; app_tenant has SELECT/INSERT/UPDATE). Every query names the company.
 * The hourly sync reads the live campaigns, asks the platform for numbers outside any transaction, then writes them
 * back only while the row is still 'active', so a change made meanwhile wins.
 */
export type LiveCampaign = {
  id: string;
  platform: AdPlatform;
  externalCampaignId: string;
  status: AdCampaignStatus;
  maxSpendCents: number;
  spendCents: number;
  companyStormId: string;
  /** creative.endDate, 'YYYY-MM-DD' in the company's time zone (inclusive), or null when absent. */
  endDate: string | null;
};

export type CampaignSyncPatch = {
  spendCents: number;
  impressions: number;
  clicks: number;
  landingRequests: number;
  status?: 'active' | 'paused' | 'ended';
  now: Date;
};

/** The company's campaigns that are active and already exist on the platform, oldest first. */
export async function listActiveCampaigns(tx: Tx, ctx: TenantContext): Promise<LiveCampaign[]> {
  const rows = await tx
    .select({
      id: adCampaigns.id,
      platform: adCampaigns.platform,
      externalCampaignId: adCampaigns.externalCampaignId,
      status: adCampaigns.status,
      maxSpendCents: adCampaigns.maxSpendCents,
      spendCents: adCampaigns.spendCents,
      companyStormId: adCampaigns.companyStormId,
      endDate: sql<string | null>`${adCampaigns.creative}->>'endDate'`,
    })
    .from(adCampaigns)
    .where(
      and(
        eq(adCampaigns.companyId, ctx.companyId),
        eq(adCampaigns.status, 'active'),
        sql`${adCampaigns.externalCampaignId} is not null`,
      ),
    )
    .orderBy(adCampaigns.createdAt, adCampaigns.id);
  return rows.map((r) => ({ ...r, externalCampaignId: r.externalCampaignId as string, endDate: r.endDate ?? null }));
}

/** How many inspection requests came in through the storm's pages. */
export async function countLandingRequests(tx: Tx, ctx: TenantContext, companyStormId: string): Promise<number> {
  const result = await tx.execute<{ n: string }>(sql`
    select count(*)::text as n
      from storm_requests r
      join storm_pages p on p.company_id = r.company_id and p.id = r.storm_page_id
     where r.company_id = ${ctx.companyId} and p.company_storm_id = ${companyStormId}`);
  return Number(result.rows[0]?.n ?? 0);
}

/** Stores the platform numbers on a campaign that is still 'active'. A row changed meanwhile is left alone. */
export async function recordCampaignSync(tx: Tx, ctx: TenantContext, id: string, patch: CampaignSyncPatch): Promise<boolean> {
  const rows = await tx
    .update(adCampaigns)
    .set({
      spendCents: patch.spendCents,
      impressions: patch.impressions,
      clicks: patch.clicks,
      landingRequests: patch.landingRequests,
      ...(patch.status ? { status: patch.status } : {}),
      lastSyncedAt: patch.now,
      updatedAt: patch.now,
    })
    .where(and(eq(adCampaigns.companyId, ctx.companyId), eq(adCampaigns.id, id), eq(adCampaigns.status, 'active')))
    .returning({ id: adCampaigns.id });
  return rows.length > 0;
}

/** The company's IANA time zone (default 'America/Chicago'). */
export async function companyTimeZone(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  return row?.timezone ?? 'America/Chicago';
}
