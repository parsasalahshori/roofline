import { getTransferPhone, isCompanyOwnNumber, listOnCallRows, saveTransferPhone, setOnCallOrder, type OnCallRow, type TransferPhone } from '@roofline/db/system';
import type { TenantContext } from '@roofline/db';
import type { AppDeps } from '../app.ts';

/*
 * The Front Desk transfer phone and on-call order. Memberships sit behind the system pool, and only
 * files under account/ may import it (boundaries.test.ts), so the routes come through here.
 */

/** A signed-in session always has a user; a system context has none and has no transfer phone. */
function memberId(ctx: TenantContext): string {
  if (ctx.userId === null) throw new Error('A signed-in user is required.');
  return ctx.userId;
}

export function readOnCallRows(deps: AppDeps, ctx: TenantContext): Promise<OnCallRow[]> {
  return listOnCallRows(deps.pools.system, ctx.companyId);
}

export function readTransferPhone(deps: AppDeps, ctx: TenantContext): Promise<TransferPhone> {
  return getTransferPhone(deps.pools.system, ctx.companyId, memberId(ctx));
}

export function writeTransferPhone(deps: AppDeps, ctx: TenantContext, e164: string): Promise<TransferPhone> {
  return saveTransferPhone(deps.pools.system, ctx.companyId, memberId(ctx), e164, deps.clock.now());
}

/** True when the number is one of the company's own Roofline numbers or its business phone. */
export function isOwnCompanyNumber(deps: AppDeps, ctx: TenantContext, e164: string): Promise<boolean> {
  return isCompanyOwnNumber(deps.pools.system, ctx.companyId, e164);
}

export function writeOnCallOrder(deps: AppDeps, ctx: TenantContext, userIds: string[]): Promise<void> {
  return setOnCallOrder(deps.pools.system, ctx.companyId, userIds, deps.clock.now());
}
