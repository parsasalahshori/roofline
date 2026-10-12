import { isOnCallMember } from '@roofline/db/system';
import type { InboxScope, TenantContext } from '@roofline/db';
import type { AppDeps } from '../app.ts';

/*
 * A rep's unknown-number access in the Front Desk inbox depends on the on-call list, which only the
 * system pool can read. Only files under account/ may import it (boundaries.test.ts), so the
 * conversations route comes through here.
 */
export async function inboxScopeOf(deps: AppDeps, ctx: TenantContext): Promise<InboxScope> {
  return { onCall: ctx.role === 'rep' ? await isOnCallMember(deps.pools.system, ctx) : false };
}
