import {
  addActivity,
  hasUrgentNoticeFor,
  listJobs,
  loadCompanyFacts,
  updateConversation,
  updateJob,
  withTenant,
} from '@roofline/db';
import { onCallEmails } from '@roofline/db/system';
import { localDate, NEXT_STEP_MAX } from '@roofline/shared';
import type { ToolHandler } from '../engine-types.ts';
import { isOpenJob, systemCtx } from './system-ctx.ts';

/*
 * D1 Task 9: take_message. Scope comes from the server-side conversation. The follow-up is the job's
 * C1 next step (Today); urgent messages also email the on-call members once per conversation.
 * The urgent email dedupes durably: hasUrgentNoticeFor row-locks the conversation and finds an earlier urgent
 * front_desk_message activity, or an earlier turn whose take_message call was urgent (this covers a caller with
 * no customer across separate texts and relay sessions, each of which builds a fresh state). The in-memory
 * conversation.urgentNoticeSent flag covers a second urgent call within the same turn.
 * Never logs the message, names or phone numbers.
 */

export const takeMessage: ToolHandler<'take_message'> = async (ctx, input) => {
  const { conversation } = ctx;
  const tctx = systemCtx(ctx.companyId);

  const seenInDb = await withTenant(ctx.deps.pools, tctx, async (tx) => {
    const seen = input.urgent ? await hasUrgentNoticeFor(tx, tctx, conversation.conversationId) : false;
    const data = { conversationId: conversation.conversationId, urgent: input.urgent, reason: input.reason };

    let jobId: string | null = null;
    if (conversation.customerId !== null) {
      const { jobs } = await listJobs(tx, tctx, { customerId: conversation.customerId, limit: 200 });
      const open = jobs
        .filter(isOpenJob)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      jobId = open[0]?.id ?? null;
    }

    // Ruling EA: only a verified caller changes a job; a phone-matched caller leaves a note on the customer.
    if (jobId !== null && conversation.identity === 'verified') {
      const { timezone } = await loadCompanyFacts(tx, tctx);
      await updateJob(
        tx,
        tctx,
        jobId,
        { nextStep: `Call back: ${input.reason}`.slice(0, NEXT_STEP_MAX), nextStepOn: localDate(ctx.now, timezone) },
        { now: ctx.now },
      );
      await addActivity(tx, tctx, {
        subjectType: 'job',
        subjectId: jobId,
        kind: 'front_desk_message',
        summary: 'Message taken by Front Desk',
        data,
        actorAgent: 'front_desk',
        at: ctx.now,
      });
    } else if (conversation.customerId !== null) {
      await addActivity(tx, tctx, {
        subjectType: 'customer',
        subjectId: conversation.customerId,
        kind: 'front_desk_message',
        summary: 'Message taken by Front Desk',
        data,
        actorAgent: 'front_desk',
        at: ctx.now,
      });
    }

    await updateConversation(tx, tctx, conversation.conversationId, {
      outcome: 'message',
    });
    return seen;
  });

  const alreadyNotified = seenInDb || conversation.urgentNoticeSent === true;
  // Set before awaiting the mailer so a concurrent call in this conversation does not send again,
  // and so the engine's handoff sees the notice even when every send fails.
  if (input.urgent) conversation.urgentNoticeSent = true;

  if (input.urgent && !alreadyNotified) {
    try {
      const members = await onCallEmails(ctx.deps.pools.system, ctx.companyId);
      const text = input.callbackWhen === null ? input.reason : `${input.reason}\n\nCall back: ${input.callbackWhen}`;
      for (const m of members) {
        try {
          await ctx.deps.mailer.send({ to: m.email, subject: 'Urgent message from Front Desk', text });
        } catch (err) {
          ctx.deps.logError?.(err, 'front-desk.message');
        }
      }
    } catch (err) {
      ctx.deps.logError?.(err, 'front-desk.message');
    }
  }

  return { ok: true, forModel: 'Message saved. Tell the caller someone will get back to them.' };
};
