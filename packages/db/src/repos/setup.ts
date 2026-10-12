import { and, eq, sql } from 'drizzle-orm';
import { BRAND_FIELDS, type CampaignStatus, type SetupFacts, type SetupItemKey, type SetupItemView } from '@roofline/shared';
import type { TenantContext, Tx } from '../tenant.ts';
import { setupItems } from '../schema/tenant.ts';
import { connectedMemberCount } from './calendar.ts';

/*
 * Data access for the setup checklist (F3 spec 5.3). Every read runs on the tenant transaction, so
 * row-level security already limits it to the context's company; each query also names the company
 * where the table has one. What a fact means for a step lives in `@roofline/shared`'s `deriveSetup`;
 * this file only gathers facts and stores the derived rows.
 */

type CompanyFactsRow = {
  address_saved: boolean;
  located: boolean;
  service_area: boolean;
  payment_method: boolean;
};

/**
 * The facts the checklist rules read, gathered on `tx`. `pendingInvites` is not here: it comes from
 * the system role (`listPendingInvites`), so the caller adds it.
 */
export async function setupFacts(tx: Tx, ctx: TenantContext): Promise<Omit<SetupFacts, 'pendingInvites'>> {
  // Booleans only: no address or service-area geometry leaves the database.
  const companyResult = await tx.execute(
    sql`select address_street is not null as address_saved,
               location is not null as located,
               service_area is not null as service_area,
               (stripe_subscription_id is not null and status in ('active', 'past_due')) as payment_method
          from companies
         where id = ${ctx.companyId}
         limit 1`,
  );
  const company = companyResult.rows[0] as CompanyFactsRow | undefined;

  const importResult = await tx.execute(
    sql`select count(*) filter (where status = 'done')::int as done,
               count(*) filter (where status in ('queued', 'processing'))::int as running
          from imports
         where company_id = ${ctx.companyId}`,
  );
  const importRow = importResult.rows[0] as { done: number; running: number } | undefined;

  const textingResult = await tx.execute(
    sql`select campaign_status, rejection_reason_plain, rejected_fields
          from texting_registrations
         where company_id = ${ctx.companyId}
         limit 1`,
  );
  const textingRow = textingResult.rows[0] as
    | { campaign_status: CampaignStatus; rejection_reason_plain: string | null; rejected_fields: string[] | null }
    | undefined;

  // company_members is a view already limited to the company (see routes/team.ts).
  const membersResult = await tx.execute(sql`select count(*)::int as active from company_members where status = 'active'`);
  const membersRow = membersResult.rows[0] as { active: number } | undefined;

  // Connected calendars of active members (calendar.ts): a dead grant (status error) does not count.
  const calendarsConnected = await connectedMemberCount(tx, ctx);

  const skippedRows = await tx
    .select({ key: setupItems.key })
    .from(setupItems)
    .where(and(eq(setupItems.companyId, ctx.companyId), eq(setupItems.status, 'skipped')));
  const skipped = new Set<SetupItemKey>(skippedRows.map((row) => row.key));

  // Only brand fields the web can highlight; the column is text[] and may hold anything a carrier sent.
  const rejectedFields = (textingRow?.rejected_fields ?? []).filter((f) => (BRAND_FIELDS as readonly string[]).includes(f));

  return {
    addressSaved: company?.address_saved ?? false,
    located: company?.located ?? false,
    serviceArea: company?.service_area ?? false,
    imports: { done: importRow?.done ?? 0, running: importRow?.running ?? 0 },
    texting: {
      campaignStatus: textingRow?.campaign_status ?? 'none',
      rejectionReason: textingRow?.rejection_reason_plain ?? null,
      rejectedFields,
    },
    activeMembers: membersRow?.active ?? 0,
    paymentMethod: company?.payment_method ?? false,
    calendarsConnected,
    skipped,
  };
}

/** Stores each derived row (status and data) for the company, keyed by (company_id, key). */
export async function saveSetupItems(tx: Tx, ctx: TenantContext, items: readonly SetupItemView[], now: Date): Promise<void> {
  for (const item of items) {
    await tx
      .insert(setupItems)
      .values({
        companyId: ctx.companyId,
        key: item.key,
        status: item.status,
        data: item.data,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [setupItems.companyId, setupItems.key],
        set: { status: item.status, data: item.data, updatedAt: now },
      });
  }
}

/** Marks one item skipped (or back to todo). The next GET re-derives the real status from the facts. */
export async function setSetupSkipped(tx: Tx, ctx: TenantContext, key: SetupItemKey, skipped: boolean, now: Date): Promise<void> {
  const status = skipped ? 'skipped' : 'todo';
  await tx
    .insert(setupItems)
    .values({ companyId: ctx.companyId, key, status, data: {}, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [setupItems.companyId, setupItems.key],
      set: { status, updatedAt: now },
    });
}
