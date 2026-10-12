import type { TenantContext } from '@roofline/db';

/** The tenant context every Front Desk tool runs under: the company, no user, the system role. */
export function systemCtx(companyId: string): TenantContext {
  return { companyId, userId: null, role: 'system', canApproveSpend: false };
}

/** An open job: not archived and not yet installed or lost. */
export function isOpenJob(j: { archivedAt: Date | null; stage: string }): boolean {
  return j.archivedAt === null && j.stage !== 'installed' && j.stage !== 'lost';
}
