import { sql } from 'drizzle-orm';
import type { UsageKind } from '../schema/enums.ts';
import { usageEvents } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * Metered usage (spec 5.2): one `usage_events` row per billable thing that happened, such as a
 * segment of a sent text, an AI call minute or an exact report. The Stripe reporter reads these
 * rows later; writing them here never talks to Stripe.
 */

/** One billable event, before it is written to `usage_events`. */
export type NewUsage = {
  kind: UsageKind;
  quantity: number;
  unitCostCents: number | null;
  /** What the event is about, for example `message` or `report`. */
  refType: string;
  /** The id of that thing, as text. */
  refId: string;
  /** A plain description for the invoice line, such as "Exact roof report - 812 Oak St". */
  description: string | null;
  at: Date;
};

/**
 * Writes one usage event for the context's company. A repeated call for the same reference
 * (company, kind, refType, refId) is a no-op: the partial unique index `usage_events_ref_uniq`
 * drops the second insert, so a retried job never bills the same thing twice. Returns true when a
 * row was written, false when one already existed.
 */
export async function recordUsage(tx: Tx, ctx: TenantContext, input: NewUsage): Promise<boolean> {
  const rows = await tx
    .insert(usageEvents)
    .values({
      companyId: ctx.companyId,
      kind: input.kind,
      quantity: input.quantity,
      unitCostCents: input.unitCostCents,
      refType: input.refType,
      refId: input.refId,
      description: input.description,
      at: input.at,
      createdAt: input.at,
      updatedAt: input.at,
    })
    .onConflictDoNothing({
      target: [usageEvents.companyId, usageEvents.kind, usageEvents.refType, usageEvents.refId],
      where: sql`${usageEvents.refId} is not null`,
    })
    .returning({ id: usageEvents.id });
  return rows.length > 0;
}
