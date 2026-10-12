import { and, eq } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { memberships } from '../schema/index.ts';
import type { TenantContext } from '../tenant.ts';

/*
 * Whether a member is on the company's call list (D1 Task 18). `memberships` is a global table the
 * tenant role cannot read, so this runs on the system pool. A rep sees unknown-number conversations
 * only while on call. Only apps/api/src/account/ imports it (boundaries.test.ts).
 */
export async function isOnCallMember(system: Db, ctx: TenantContext): Promise<boolean> {
  if (ctx.userId === null) return false;
  const [row] = await system
    .select({ order: memberships.onCallOrder })
    .from(memberships)
    .where(and(eq(memberships.companyId, ctx.companyId), eq(memberships.userId, ctx.userId), eq(memberships.status, 'active')))
    .limit(1);
  return row !== undefined && row.order !== null;
}
