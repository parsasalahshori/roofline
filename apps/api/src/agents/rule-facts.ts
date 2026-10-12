import { eq } from 'drizzle-orm';
import { companySettings } from '@roofline/db';
import type { TenantContext, Tx } from '@roofline/db';
import type { AgentRuleFacts } from '@roofline/shared';

/*
 * A1 Task 5 and Task 14: the facts behind each agent card's rule sentences (`rulesFor` in @roofline/shared).
 *
 * Storm Scout facts are filled from `company_settings` (hail threshold, ad budget cents, ad days). When the
 * company has no settings row yet, the column defaults (1 inch, 27000 cents, 7 days) are returned so Storm
 * Scout always has its sentences.
 *
 * Front Desk facts (`frontDesk: { phoneNumber, transferNames, canBook, canConfirm, canMove }`) still wait
 * for D1: when D1 is merged into a1-agents, this function is where they get filled. Read them through the
 * given `tx` (already company-scoped by withTenant) and filter by `ctx.companyId`.
 */
export async function gatherRuleFacts(tx: Tx, ctx: TenantContext): Promise<AgentRuleFacts> {
  const [row] = await tx
    .select({
      hailThresholdIn: companySettings.hailThresholdIn,
      stormAdBudgetCents: companySettings.stormAdBudgetCents,
      stormAdDays: companySettings.stormAdDays,
    })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  return {
    stormScout: {
      thresholdInches: row ? Number(row.hailThresholdIn) : 1,
      budgetCents: row ? row.stormAdBudgetCents : 27000,
      days: row ? row.stormAdDays : 7,
    },
  };
}
