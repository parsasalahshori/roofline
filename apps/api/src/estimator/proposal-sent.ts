import {
  addActivity,
  addProposalEvent,
  getJob,
  markProposalSent,
  markReplacedProposal,
  StageRuleError,
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
