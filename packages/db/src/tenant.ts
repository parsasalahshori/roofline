import { type ExtractTablesWithRelations, sql } from 'drizzle-orm';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { Role } from '@roofline/shared';
import type { Pools, Schema } from './pools.ts';

/**
 * Who a piece of tenant work runs for. Repositories take this, never a raw company id.
 * `role: 'system'` is the runner and scheduler acting for a company with no signed-in user.
 */
export type TenantContext = {
  companyId: string;
  userId: string | null;
  role: Role | 'system';
  canApproveSpend: boolean;
};

/** The Drizzle transaction handed to `withTenant` callbacks. */
export type Tx = PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/**
 * Runs `fn` in one app_tenant transaction scoped to `ctx.companyId`. The setting is
 * transaction-local (`set_config(..., true)`, the same as `SET LOCAL`), so it resets at commit or
 * rollback and a pooled connection never carries a stale company into the next request.
 * Row-level security then limits every tenant table to that company.
 */
export function withTenant<T>(pools: Pools, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return pools.tenant.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.company_id', ${ctx.companyId}, true)`);
    return fn(tx);
  });
}
