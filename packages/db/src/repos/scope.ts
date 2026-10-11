import { eq, type SQL } from 'drizzle-orm';
import { customers } from '../schema/index.ts';
import type { TenantContext } from '../tenant.ts';

/** Matches no user. A rep context always has a user id; this only keeps a malformed one from matching customers that have no creator. */
const NO_USER = '00000000-0000-0000-0000-000000000000';

/**
 * Which customers a member may see, as a WHERE condition (undefined means "all of the company's").
 *
 * Row-level security already keeps every query inside the member's company; this narrows it further
 * for reps. Until job-linked access arrives in Task 11, a rep sees only the customers they created
 * themselves; the owner, the office and the system (the runner and scheduler) see all of them.
 * A customer outside the scope is reported exactly like one that does not exist.
 */
export function customerScope(ctx: TenantContext): SQL | undefined {
  return ctx.role === 'rep' ? eq(customers.createdByUserId, ctx.userId ?? NO_USER) : undefined;
}
