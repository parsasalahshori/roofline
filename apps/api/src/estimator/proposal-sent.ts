import {
  addActivity,
  addProposalEvent,
  getJob,
  lockJobProposalsOf,
  markProposalSent,
  markReplacedProposal,
  setProposalStatus,
  StageRuleError,
  stepTextReason,
  type TenantContext,
  type Tx,
  updateJob,
} from '@roofline/db';

/*
 * What a sent proposal text changes (E1 spec): called inside a tenant transaction when the text has gone
 * out, now from the send step or later from the dispatcher. Idempotent: a proposal that is already sent (or
 * signed, or closed) is left alone, so a second call changes nothing.
 */

/**
 * Called inside a tenant transaction when the proposal's text has gone out (now, or later from the dispatcher):
 * proposal -> 'sent' with sent_at (only from 'ready'/'draft'; a signed or already-sent one is left alone),
 * job lead/inspection -> proposal via updateJob, an activity, a 'sent' proposal event, and the old proposal
 * this one revised becomes 'replaced' only if it is not signed. Idempotent.
 */
export async function settleSentProposal(tx: Tx, ctx: TenantContext, proposalId: string, now: Date): Promise<void> {
  // C-M1: this changes two proposals of the job (this one, and the one it replaces), so the job's proposals are
  // locked first in the one order every such writer takes (signing does the same).
  await lockJobProposalsOf(tx, ctx, proposalId);
  const sent = await markProposalSent(tx, ctx, proposalId, ['draft', 'ready'], now);
  if (sent === null) return;

  // The job moves to Proposal only from Lead or Inspection; any other stage (or a stage rule) is left as it is.
  const job = await getJob(tx, ctx, sent.jobId);
  if (job !== null && (job.stage === 'lead' || job.stage === 'inspection')) {
    try {
      await updateJob(tx, ctx, sent.jobId, { stage: 'proposal' }, { now, ip: null });
    } catch (err) {
      if (!(err instanceof StageRuleError)) throw err;
    }
  }

  await addActivity(tx, ctx, {
    subjectType: 'job',
    subjectId: sent.jobId,
    kind: 'proposal.sent',
    summary: `Proposal ${sent.number} texted`,
    actorAgent: 'estimator',
    at: now,
  });
  await addProposalEvent(tx, ctx, { proposalId, kind: 'sent', at: now });
  await markReplacedProposal(tx, ctx, { proposalId, jobId: sent.jobId, customerId: sent.customerId, now });
}

/** The reason shown when a blocked text has none of its own. */
export const BLOCKED_FALLBACK = "The texting service held this text. Check the customer's texting settings, then retry.";
/** The reason shown when a failed text has none of its own. */
export const FAILED_FALLBACK = "This text didn't go out. You can retry it.";

/**
 * Called inside a tenant transaction when the proposal's text was blocked or failed for good, from the send step
 * or later from the dispatcher (C-I4): the proposal goes back from 'ready' to 'draft', so it can be edited and
 * sent for approval again. Returns the reason for the step, as a person can read it.
 */
export async function settleUnsentProposal(
  tx: Tx,
  ctx: TenantContext,
  t: { proposalId: string; stepId: string; customerId: string; blocked: boolean },
  now: Date,
): Promise<string> {
  await setProposalStatus(tx, ctx, t.proposalId, ['ready'], 'draft', now);
  const reason = await stepTextReason(tx, ctx, t.stepId, t.customerId);
  return reason ?? (t.blocked ? BLOCKED_FALLBACK : FAILED_FALLBACK);
}
