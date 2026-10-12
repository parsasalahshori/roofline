import { eq } from 'drizzle-orm';
import { addActivity, proposals, createProposal, getMeasurementBasics, getProposal, replaceDraftOptions, withTenant, type TenantContext } from '@roofline/db';
import type { ProposalView } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { DEFAULT_PROPOSAL_MESSAGE, priceOptions, validUntilFor } from './build.ts';

/**
 * Prices a proposal again from a measurement. A draft changes in place. Any other proposal is left exactly
 * as it is (a sent proposal never re-prices) and a new draft for the same job is made instead.
 */
export async function repriceFromMeasurement(deps: AppDeps, ctx: TenantContext, proposalId: string, measurementId: string): Promise<{ proposal: ProposalView; revised: boolean }> {
  const now = deps.clock.now();
  return withTenant(deps.pools, ctx, async (tx) => {
    const existing = await getProposal(tx, ctx, proposalId);
    if (!existing) throw new AppError(404, MESSAGES.notFound);
    const m = await getMeasurementBasics(tx, ctx, measurementId);
    if (!m) throw new AppError(404, MESSAGES.notFound);
    const options = await priceOptions(tx, ctx, m);

    if (existing.status === 'draft') {
      const view = await replaceDraftOptions(tx, ctx, proposalId, { basis: m.kind, measurementId: m.id, options }, now);
      if (view === null || view === 'not_draft') throw new AppError(404, MESSAGES.notFound);
      return { proposal: view, revised: false };
    }

    const [row] = await tx.select({ customerId: proposals.customerId, propertyId: proposals.propertyId }).from(proposals).where(eq(proposals.id, proposalId)).limit(1);
    if (!row) throw new AppError(404, MESSAGES.notFound);
    const validUntil = await validUntilFor(tx, ctx, now);
    const draft = await createProposal(
      tx,
      ctx,
      { jobId: existing.jobId, customerId: row.customerId, propertyId: row.propertyId, measurementId: m.id, basis: m.kind, validUntil, messageBody: DEFAULT_PROPOSAL_MESSAGE, options },
      now,
    );
    await addActivity(tx, ctx, {
      subjectType: 'job',
      subjectId: existing.jobId,
      kind: 'proposal.drafted',
      summary: `Proposal ${draft.number} drafted (revised from ${existing.number})`,
      at: now,
    });
    return { proposal: draft, revised: true };
  });
}
