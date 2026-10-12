import type { AdCampaignStatus, AdErrorKind, AdPausedBy, AdPlatform } from '@roofline/shared';
import { and, eq } from 'drizzle-orm';
import { adCampaigns } from '../schema/tenant.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * Data access for the ad_campaigns rows the create_ad_campaign step writes (tenant table). One row per
 * (company, step) (unique ad_campaigns_company_step_uniq). Every query names the company.
 */
export type AdCampaignRow = typeof adCampaigns.$inferSelect;

export async function getAdCampaignByStep(tx: Tx, ctx: TenantContext, stepId: string): Promise<AdCampaignRow | null> {
  const [row] = await tx
    .select()
    .from(adCampaigns)
    .where(and(eq(adCampaigns.companyId, ctx.companyId), eq(adCampaigns.stepId, stepId)))
    .limit(1);
  return row ?? null;
}

export type ClaimAdCampaignInput = {
  companyStormId: string;
  stepId: string;
  platform: AdPlatform;
  dailyBudgetCents: number;
  days: number;
  maxSpendCents: number;
  targets: unknown[];
  creative: Record<string, unknown>;
  now: Date;
};

/** Inserts the 'creating' row for a step, or returns the one a first run already made. */
export async function claimAdCampaign(tx: Tx, ctx: TenantContext, input: ClaimAdCampaignInput): Promise<AdCampaignRow> {
  await tx
    .insert(adCampaigns)
    .values({
      companyId: ctx.companyId,
      companyStormId: input.companyStormId,
      stepId: input.stepId,
      platform: input.platform,
      status: 'creating',
      dailyBudgetCents: input.dailyBudgetCents,
      days: input.days,
      maxSpendCents: input.maxSpendCents,
      targets: input.targets,
      creative: input.creative,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing({ target: [adCampaigns.companyId, adCampaigns.stepId] });
  const row = await getAdCampaignByStep(tx, ctx, input.stepId);
  if (!row) throw new Error('ad campaign row missing after claim');
  return row;
}

export type AdCampaignPatch = Partial<{
  externalCampaignId: string | null;
  status: AdCampaignStatus;
  pausedBy: AdPausedBy | null;
  housingFallback: boolean;
  targets: unknown[];
  creative: Record<string, unknown>;
  errorKind: AdErrorKind | null;
  errorPlain: string | null;
  now: Date;
}>;

export async function updateAdCampaign(tx: Tx, ctx: TenantContext, id: string, patch: AdCampaignPatch): Promise<void> {
  const set: Partial<typeof adCampaigns.$inferInsert> = { updatedAt: patch.now ?? new Date() };
  if (patch.externalCampaignId !== undefined) set.externalCampaignId = patch.externalCampaignId;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.pausedBy !== undefined) set.pausedBy = patch.pausedBy;
  if (patch.housingFallback !== undefined) set.housingFallback = patch.housingFallback;
  if (patch.targets !== undefined) set.targets = patch.targets;
  if (patch.creative !== undefined) set.creative = patch.creative;
  if (patch.errorKind !== undefined) set.errorKind = patch.errorKind;
  if (patch.errorPlain !== undefined) set.errorPlain = patch.errorPlain;
  await tx
    .update(adCampaigns)
    .set(set)
    .where(and(eq(adCampaigns.companyId, ctx.companyId), eq(adCampaigns.id, id)));
}
