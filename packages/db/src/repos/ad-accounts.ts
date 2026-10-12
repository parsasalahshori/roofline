import type { AdAccountStatus, AdPlatform } from '@roofline/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { adAccounts } from '../schema/tenant.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * Data access for ad_accounts (tenant table; app_tenant has SELECT/INSERT/UPDATE, no DELETE: revoke sets status 'revoked').
 * One row per (company, platform) (unique ad_accounts_company_platform_uniq). Every query names the company.
 */
export type AdAccountRow = typeof adAccounts.$inferSelect;

export type AdAccountPatch = {
  status: AdAccountStatus;
  name?: string | null;
  currency?: string | null;
  linkedAt?: Date | null;
  lastErrorPlain: string | null;
  now: Date;
};

/** All the company's ad accounts (any status), ordered by platform. */
export async function listAdAccounts(tx: Tx, ctx: TenantContext): Promise<AdAccountRow[]> {
  return tx.select().from(adAccounts).where(eq(adAccounts.companyId, ctx.companyId)).orderBy(asc(adAccounts.platform));
}
/** One account by id for the company, or null. */
export async function getAdAccount(tx: Tx, ctx: TenantContext, id: string): Promise<AdAccountRow | null> {
  const [row] = await tx
    .select()
    .from(adAccounts)
    .where(and(eq(adAccounts.companyId, ctx.companyId), eq(adAccounts.id, id)))
    .limit(1);
  return row ?? null;
}
/** The company's row for a platform (any status), or null. */
export async function getAdAccountByPlatform(tx: Tx, ctx: TenantContext, platform: AdPlatform): Promise<AdAccountRow | null> {
  const [row] = await tx
    .select()
    .from(adAccounts)
    .where(and(eq(adAccounts.companyId, ctx.companyId), eq(adAccounts.platform, platform)))
    .limit(1);
  return row ?? null;
}
/**
 * Inserts the platform's row, or when one exists (the caller has checked it is revoked) overwrites it:
 * external id, status, name, currency, linked_at, last_error_plain, updated_at. Returns the stored row.
 */
export async function upsertAdAccount(
  tx: Tx,
  ctx: TenantContext,
  input: { platform: AdPlatform; externalAccountId: string } & AdAccountPatch,
): Promise<AdAccountRow> {
  const [row] = await tx
    .insert(adAccounts)
    .values({
      companyId: ctx.companyId,
      platform: input.platform,
      externalAccountId: input.externalAccountId,
      status: input.status,
      name: input.name ?? null,
      currency: input.currency ?? null,
      linkedAt: input.linkedAt ?? null,
      lastErrorPlain: input.lastErrorPlain,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [adAccounts.companyId, adAccounts.platform],
      set: {
        externalAccountId: input.externalAccountId,
        status: input.status,
        name: input.name ?? null,
        currency: input.currency ?? null,
        linkedAt: input.linkedAt ?? null,
        lastErrorPlain: input.lastErrorPlain,
        updatedAt: input.now,
      },
    })
    .returning();
  return row!;
}
/** Applies a patch to one account of the company; returns the updated row or null when it is not found. */
export async function updateAdAccount(tx: Tx, ctx: TenantContext, id: string, patch: AdAccountPatch): Promise<AdAccountRow | null> {
  const set: Partial<typeof adAccounts.$inferInsert> = {
    status: patch.status,
    lastErrorPlain: patch.lastErrorPlain,
    updatedAt: patch.now,
  };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.currency !== undefined) set.currency = patch.currency;
  if (patch.linkedAt !== undefined) set.linkedAt = patch.linkedAt;
  const [row] = await tx
    .update(adAccounts)
    .set(set)
    .where(and(eq(adAccounts.companyId, ctx.companyId), eq(adAccounts.id, id)))
    .returning();
  return row ?? null;
}
/** The company's accounts whose status is 'pending'. */
export async function listPendingAdAccounts(tx: Tx, ctx: TenantContext): Promise<AdAccountRow[]> {
  return tx
    .select()
    .from(adAccounts)
    .where(and(eq(adAccounts.companyId, ctx.companyId), eq(adAccounts.status, 'pending')))
    .orderBy(asc(adAccounts.platform));
}
/** Counts for the setup checklist: accounts 'active' and accounts 'pending'. */
export async function adAccountCounts(tx: Tx, ctx: TenantContext): Promise<{ active: number; pending: number }> {
  const result = await tx.execute(
    sql`select count(*) filter (where status = 'active')::int as active,
               count(*) filter (where status = 'pending')::int as pending
          from ad_accounts
         where company_id = ${ctx.companyId}`,
  );
  const row = result.rows[0] as { active: number; pending: number } | undefined;
  return { active: row?.active ?? 0, pending: row?.pending ?? 0 };
}
