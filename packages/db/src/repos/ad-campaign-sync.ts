import type { AdCampaignStatus, AdPausedBy, AdPlatform } from '@roofline/shared';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import { adCampaigns, companies } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * Spend-sync queries for ad_campaigns (tenant table; app_tenant has SELECT/INSERT/UPDATE). Every query names the company.
 * The hourly sync reads the campaigns it must guard, asks the platform for numbers outside any transaction, then
 * writes them back only while the row still has the status the list read, so a change made meanwhile wins.
 */
export type LiveCampaign = {
  id: string;
  platform: AdPlatform;
  externalCampaignId: string;
  status: AdCampaignStatus;
  /** Who paused it ('roofline' rows are never listed; null means not ours). */
  pausedBy: AdPausedBy | null;
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
  /** undefined leaves the column alone; null clears it. */
  pausedBy?: AdPausedBy | null;
  /** The status the list read: the write happens only while the row still has it. */
  expectStatus: AdCampaignStatus;
  now: Date;
};

/** A row that went quiet while 'creating' (the handler may still be mid-flight before this). */
export const CREATING_SWEEP_AFTER_MS = 60 * 60 * 1000;

/**
 * The company's campaigns the hourly sync must look at, oldest first. All of them exist on the platform (they have
 * an external_campaign_id) and Roofline has not confirmed them off (paused_by is not 'roofline'; null counts as not
 * ours). They are: 'active' rows; 'paused' rows (the platform or an owner paused them, so they may come back); and
 * the sweep rows 'failed', or 'creating' for more than an hour, whose enable response may have been lost while the
 * platform applied it.
 */
export async function listActiveCampaigns(tx: Tx, ctx: TenantContext, now: Date = new Date()): Promise<LiveCampaign[]> {
  const quietBefore = new Date(now.getTime() - CREATING_SWEEP_AFTER_MS);
  const rows = await tx
    .select({
      id: adCampaigns.id,
      platform: adCampaigns.platform,
      externalCampaignId: adCampaigns.externalCampaignId,
      status: adCampaigns.status,
      pausedBy: adCampaigns.pausedBy,
      maxSpendCents: adCampaigns.maxSpendCents,
      spendCents: adCampaigns.spendCents,
      companyStormId: adCampaigns.companyStormId,
      endDate: sql<string | null>`${adCampaigns.creative}->>'endDate'`,
    })
    .from(adCampaigns)
    .where(
      and(
        eq(adCampaigns.companyId, ctx.companyId),
        sql`${adCampaigns.externalCampaignId} is not null`,
        or(
          eq(adCampaigns.status, 'active'),
          and(
            sql`${adCampaigns.pausedBy} is distinct from 'roofline'`,
            or(
              eq(adCampaigns.status, 'paused'),
              eq(adCampaigns.status, 'failed'),
              and(eq(adCampaigns.status, 'creating'), lt(adCampaigns.updatedAt, quietBefore)),
            ),
          ),
        ),
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

/** Stores the platform numbers on a campaign that still has the status the list read. A row changed meanwhile is left alone. */
export async function recordCampaignSync(tx: Tx, ctx: TenantContext, id: string, patch: CampaignSyncPatch): Promise<boolean> {
  const rows = await tx
    .update(adCampaigns)
    .set({
      spendCents: patch.spendCents,
      impressions: patch.impressions,
      clicks: patch.clicks,
      landingRequests: patch.landingRequests,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.pausedBy !== undefined ? { pausedBy: patch.pausedBy } : {}),
      lastSyncedAt: patch.now,
      updatedAt: patch.now,
    })
    .where(and(eq(adCampaigns.companyId, ctx.companyId), eq(adCampaigns.id, id), eq(adCampaigns.status, patch.expectStatus)))
    .returning({ id: adCampaigns.id });
  return rows.length > 0;
}

/** The company's IANA time zone (default 'America/Chicago'). */
export async function companyTimeZone(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  return row?.timezone ?? 'America/Chicago';
}
