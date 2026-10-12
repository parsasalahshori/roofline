import {
  addActivity,
  createJob,
  findClaimIntake,
  getJob,
  insertClaimIntake,
  listJobs,
  listProperties,
  type TenantContext,
  updateConversation,
  withTenant,
} from '@roofline/db';
import type { ToolHandler } from '../engine-types.ts';

/*
 * D1 Task 9: take_claim_details. Scope comes from the server-side conversation, never from the model.
 * Never logs claim numbers or descriptions.
 */

const NOT_FOUND = 'I could not find that job.';

export const takeClaimDetails: ToolHandler<'take_claim_details'> = async (ctx, input) => {
  const { conversation } = ctx;
  const tctx: TenantContext = { companyId: ctx.companyId, role: 'system', userId: null, canApproveSpend: false };

  return withTenant(ctx.deps.pools, tctx, async (tx) => {
    const existing = await findClaimIntake(tx, tctx, {
      conversationId: conversation.conversationId,
      insurer: input.insurer,
      description: input.description,
    });
    if (existing) {
      return {
        ok: true,
        forModel: 'Claim details saved. Tell the caller the team will follow up.',
        shownIds: existing.jobId !== null ? [existing.jobId] : [],
      };
    }

    let jobId: string | null = null;

    if (input.jobId !== null) {
      if (!conversation.shownIds.has(input.jobId)) return { ok: false, forModel: NOT_FOUND };
      const job = await getJob(tx, tctx, input.jobId);
      if (!job) return { ok: false, forModel: NOT_FOUND };
      jobId = job.id;
    } else if (conversation.identity === 'verified' && conversation.customerId !== null) {
      const customerId = conversation.customerId;
      const { jobs } = await listJobs(tx, tctx, { customerId, limit: 200 });
      const open = jobs.filter((j) => j.archivedAt === null && j.stage !== 'installed' && j.stage !== 'lost');
      if (open.length === 1) {
        jobId = open[0]!.id;
      } else {
        const { properties } = await listProperties(tx, tctx, { customerId, limit: 200 });
        const latest = [...properties].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        if (latest) {
          const created = await createJob(
            tx,
            tctx,
            { customerId, propertyId: latest.id, stage: 'lead', source: 'front_desk' },
            { now: ctx.now },
          );
          jobId = created.id;
        }
      }
    }

    const intake = await insertClaimIntake(tx, tctx, {
      jobId,
      conversationId: conversation.conversationId,
      insurer: input.insurer,
      claimNumber: input.claimNumber,
      dateOfLoss: input.dateOfLoss,
      description: input.description,
      adjusterVisitAt: input.adjusterVisitAt === null ? null : new Date(input.adjusterVisitAt),
      takenBy: 'front_desk',
    });

    if (jobId !== null && intake.created) {
      await addActivity(tx, tctx, {
        subjectType: 'job',
        subjectId: jobId,
        kind: 'claim.intake_taken',
        summary: 'Claim details taken by Front Desk',
        data: { conversationId: conversation.conversationId, insurer: input.insurer },
        actorAgent: 'front_desk',
        at: ctx.now,
      });
    }
    await updateConversation(tx, tctx, conversation.conversationId, { outcome: 'claim' });

    return {
      ok: true,
      forModel: 'Claim details saved. Tell the caller the team will follow up.',
      shownIds: jobId !== null ? [jobId] : [],
    };
  });
};
