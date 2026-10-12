import { eq } from 'drizzle-orm';
import {
  DEFAULT_TIER_TEMPLATES,
  TIERS,
  type EstimatorSettings,
  type EstimatorSettingsPatch,
  type TierTemplate,
} from '@roofline/shared';
import { companySettings, tierTemplates } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * Data access for the Good/Better/Best tier templates and the estimator settings (E1 spec 4.1, 5.3).
 * Every query runs on the tenant transaction and also names the company.
 */

const NOT_THREE_TIERS = 'Tier templates must hold exactly one of each tier: good, better and best.';

const copyTemplate = (t: TierTemplate): TierTemplate => ({
  ...t,
  addOns: t.addOns.map((a) => ({ ...a })),
  highlights: [...t.highlights],
});

type TemplateRow = typeof tierTemplates.$inferSelect;

const toTemplate = (row: TemplateRow): TierTemplate => ({
  tier: row.tier,
  name: row.name,
  material: row.material,
  wastePercent: row.wastePercent,
  markupPercent: row.markupPercent,
  addOns: row.addOns.map((a) => ({ ...a })) as TierTemplate['addOns'],
  highlights: [...row.highlights],
  enabled: row.enabled,
});

/** The company's three templates in good, better, best order; the defaults when it has saved none. */
export async function getTierTemplates(tx: Tx, ctx: TenantContext): Promise<{ templates: TierTemplate[]; isDefault: boolean }> {
  const rows = await tx.select().from(tierTemplates).where(eq(tierTemplates.companyId, ctx.companyId));
  if (rows.length === 0) return { templates: DEFAULT_TIER_TEMPLATES.map(copyTemplate), isDefault: true };
  const templates = TIERS.flatMap((tier) => rows.filter((r) => r.tier === tier).map(toTemplate));
  return { templates, isDefault: false };
}

/** Replaces the company's three templates (one per tier). */
export async function saveTierTemplates(tx: Tx, ctx: TenantContext, t: readonly TierTemplate[], now: Date): Promise<TierTemplate[]> {
  const ordered = TIERS.map((tier) => t.filter((x) => x.tier === tier));
  if (t.length !== TIERS.length || ordered.some((group) => group.length !== 1)) throw new Error(NOT_THREE_TIERS);
  const saved: TierTemplate[] = [];
  for (const group of ordered) {
    const tpl = group[0]!;
    const values = {
      name: tpl.name,
      material: tpl.material,
      wastePercent: tpl.wastePercent,
      markupPercent: tpl.markupPercent,
      addOns: tpl.addOns.map((a) => ({ ...a })),
      highlights: [...tpl.highlights],
      enabled: tpl.enabled,
    };
    const [row] = await tx
      .insert(tierTemplates)
      .values({ companyId: ctx.companyId, tier: tpl.tier, ...values, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [tierTemplates.companyId, tierTemplates.tier], set: { ...values, updatedAt: now } })
      .returning();
    saved.push(toTemplate(row!));
  }
  return saved;
}

type SettingsRow = typeof companySettings.$inferSelect;

const toSettings = (row: SettingsRow | undefined, aerialConfigured: boolean): EstimatorSettings => ({
  defaultPitchX12: row?.defaultPitchX12 ?? 6,
  overhangFt: row?.overhangFt ?? 1,
  proposalValidDays: row?.proposalValidDays ?? 30,
  aerialMeasure: row?.aerialMeasure ?? false,
  aerialConfigured,
  estimateChangeClause: row?.estimateChangeClause ?? true,
  financingAprBps: row?.financingAprBps ?? null,
  financingTermMonths: row?.financingTermMonths ?? null,
});

/** The estimator settings; a company with no settings row gets the column defaults. */
export async function getEstimatorSettings(tx: Tx, ctx: TenantContext, aerialConfigured: boolean): Promise<EstimatorSettings> {
  const [row] = await tx.select().from(companySettings).where(eq(companySettings.companyId, ctx.companyId)).limit(1);
  return toSettings(row, aerialConfigured);
}

/** Updates only the keys present in `patch` (creating the row when missing) and answers the full settings. */
export async function saveEstimatorSettings(
  tx: Tx,
  ctx: TenantContext,
  patch: EstimatorSettingsPatch,
  aerialConfigured: boolean,
  now: Date,
): Promise<EstimatorSettings> {
  const set: Partial<typeof companySettings.$inferInsert> = {};
  if (patch.defaultPitchX12 !== undefined) set.defaultPitchX12 = patch.defaultPitchX12;
  if (patch.overhangFt !== undefined) set.overhangFt = patch.overhangFt;
  if (patch.proposalValidDays !== undefined) set.proposalValidDays = patch.proposalValidDays;
  if (patch.aerialMeasure !== undefined) set.aerialMeasure = patch.aerialMeasure;
  if (patch.estimateChangeClause !== undefined) set.estimateChangeClause = patch.estimateChangeClause;
  if (patch.financingAprBps !== undefined) set.financingAprBps = patch.financingAprBps;
  if (patch.financingTermMonths !== undefined) set.financingTermMonths = patch.financingTermMonths;
  const [row] = await tx
    .insert(companySettings)
    .values({ companyId: ctx.companyId, ...set, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: companySettings.companyId, set: { ...set, updatedAt: now } })
    .returning();
  return toSettings(row, aerialConfigured);
}
