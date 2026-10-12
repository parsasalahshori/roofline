import { addActivity, createProposal, getMeasurementBasics, lockProposalForReprice, replaceDraftOptions, replaceReadyProposal, withTenant, type TenantContext } from '@roofline/db';
import type { ProposalView } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { DEFAULT_PROPOSAL_MESSAGE, priceOptions, validUntilFor } from './build.ts';

/** The 409 for a revision of a signed proposal (Ruling EJ): a signed price is never reworked. */
export const SIGNED_PROPOSAL_MESSAGE = 'This proposal is signed. Make a new proposal for more work.';
/** The 409 for a revision of a proposal a newer one already replaced. */
export const REPLACED_PROPOSAL_MESSAGE = 'A newer proposal replaced this one. Change the newer one instead.';

/**
 * Prices a proposal again from a measurement, in one transaction with the proposal's row locked, so a signature
 * landing at the same moment is seen (B9). A draft changes in place and keeps the rep's per-option edits (B10).
 * A signed proposal is refused (Ruling EJ), and so is one already replaced. Any other proposal is left exactly as
 * it is (a sent proposal never re-prices) and a new draft for the same job is made instead; a 'ready' one (its send
 * waiting for approval) becomes 'replaced' by that draft, so its waiting send texts nothing (Ruling EO, B1).
 */
export async function repriceFromMeasurement(deps: AppDeps, ctx: TenantContext, proposalId: string, measurementId: string): Promise<{ proposal: ProposalView; revised: boolean }> {
  const now = deps.clock.now();
  return withTenant(deps.pools, ctx, async (tx) => {
    const existing = await lockProposalForReprice(tx, ctx, proposalId);
    if (!existing) throw new AppError(404, MESSAGES.notFound);
    if (existing.status === 'signed') throw new AppError(409, SIGNED_PROPOSAL_MESSAGE);
    if (existing.status === 'replaced') throw new AppError(409, REPLACED_PROPOSAL_MESSAGE);
    const m = await getMeasurementBasics(tx, ctx, measurementId);
    if (!m) throw new AppError(404, MESSAGES.notFound);
    // Only a measurement of the proposal's own home may price it.
    if (m.propertyId !== existing.propertyId) throw new AppError(400, MESSAGES.checkField, 'measurementId');
    const options = await priceOptions(tx, ctx, m);

    if (existing.status === 'draft') {
      const view = await replaceDraftOptions(tx, ctx, proposalId, { basis: m.kind, measurementId: m.id, options }, now);
      if (view === null || view === 'not_draft') throw new AppError(404, MESSAGES.notFound);
      return { proposal: view, revised: false };
    }

    const validUntil = await validUntilFor(tx, ctx, now);
    const draft = await createProposal(
      tx,
      ctx,
      { jobId: existing.jobId, customerId: existing.customerId, propertyId: existing.propertyId, measurementId: m.id, basis: m.kind, validUntil, messageBody: DEFAULT_PROPOSAL_MESSAGE, options },
      now,
    );
    if (existing.status === 'ready') await replaceReadyProposal(tx, ctx, proposalId, draft.id, now);
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
