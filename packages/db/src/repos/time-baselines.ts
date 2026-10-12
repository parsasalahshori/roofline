import { eq } from 'drizzle-orm';
import { type BaselineKey, isEditableBaselineKey } from '@roofline/shared';
import { timeBaselines } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/**
 * The company's own minutes-per-unit for the baseline keys an owner can edit. A key with no row
 * is missing from the map (the default applies). Unknown and hidden keys are ignored.
 */
export async function loadBaselineOverrides(tx: Tx, ctx: TenantContext): Promise<Partial<Record<BaselineKey, number>>> {
  const rows = await tx
    .select({ key: timeBaselines.key, minutesPerUnit: timeBaselines.minutesPerUnit })
    .from(timeBaselines)
    .where(eq(timeBaselines.companyId, ctx.companyId));
  const out: Partial<Record<BaselineKey, number>> = {};
  for (const row of rows) {
    if (isEditableBaselineKey(row.key)) out[row.key] = row.minutesPerUnit;
  }
  return out;
}
