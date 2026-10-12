import { and, eq, gte } from 'drizzle-orm';
import type { CompanyStatus, Meter } from '@roofline/shared';
import { meterUnits } from '@roofline/shared';
import { companies, usageEvents } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * Billing reads for the company's own billing screens (spec 5.2). Both functions run inside the
 * company's transaction, so the tenant context limits them to one company's rows.
 */

/** The company facts the billing summary and checkout need, read in one row. */
export type BillingFacts = {
  status: CompanyStatus;
  planKey: string | null;
  trialEndsAt: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  billingPeriodStart: Date | null;
  createdAt: Date;
  name: string;
  email: string | null;
};

/** The billing facts for the context's company. Throws when the company row is missing. */
export async function billingFacts(tx: Tx, ctx: TenantContext): Promise<BillingFacts> {
  const [row] = await tx
    .select({
      status: companies.status,
      planKey: companies.planKey,
      trialEndsAt: companies.trialEndsAt,
      stripeCustomerId: companies.stripeCustomerId,
      stripeSubscriptionId: companies.stripeSubscriptionId,
      billingPeriodStart: companies.billingPeriodStart,
      createdAt: companies.createdAt,
      name: companies.name,
      email: companies.email,
    })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  if (!row) throw new Error(`billingFacts: no company row for ${ctx.companyId}`);
  return row;
}

/**
 * Metered usage totals for the context's company since `since`, per meter. Both meters are always
 * present (zero when nothing was used). Each row is converted on its own, so an MMS counts three
 * SMS segments; rows with no meter are skipped.
 */
export async function usageTotals(tx: Tx, ctx: TenantContext, since: Date): Promise<Record<Meter, number>> {
  const result: Record<Meter, number> = { ai_call_minute: 0, sms_segment: 0 };
  const rows = await tx
    .select({ kind: usageEvents.kind, quantity: usageEvents.quantity })
    .from(usageEvents)
    .where(and(eq(usageEvents.companyId, ctx.companyId), gte(usageEvents.at, since)));
  for (const row of rows) {
    const units = meterUnits(row.kind, row.quantity);
    if (units === null) continue;
    result[units.meter] += units.value;
  }
  return result;
}
