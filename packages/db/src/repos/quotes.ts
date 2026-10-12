/* eslint-disable @typescript-eslint/no-unused-vars -- placeholder: its parameters are used when the real body lands */
import type { QuoteSummary } from '@roofline/shared';
import type { TenantContext, Tx } from '../tenant.ts';

// placeholder: Task 15 replaces the body (the quote list shown on a job).

/** A job's quotes, newest first. Placeholder: returns none until Task 15. */
export async function listQuoteSummaries(_tx: Tx, _ctx: TenantContext, _jobId: string): Promise<QuoteSummary[]> {
  return [];
}
