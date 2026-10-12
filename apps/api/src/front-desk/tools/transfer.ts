import { hasUrgentNoticeFor, loadCompanyFacts, withTenant } from '@roofline/db';
import { onCallMembers } from '@roofline/db/system';
import { transferPlan, workIntervals } from '@roofline/shared';
import type { ToolHandler } from '../engine-types.ts';
import { markPersonAskCounted, markUnderstandingCounted, personAskCounted, understandingCounted } from '../state.ts';
import { systemCtx } from './system-ctx.ts';

/*
 * D1 Task 9: transfer_to_person. The engine turns the call into a handoff event; this handler tells the model
 * what to say and bumps the counters (the handler path only). Never puts a phone number in forModel.
 */

export const transferToPerson: ToolHandler<'transfer_to_person'> = async (ctx, input) => {
  const { conversation } = ctx;
  if (input.reason === 'asked' && !personAskCounted(conversation)) {
    conversation.askedForPersonCount += 1;
    markPersonAskCounted(conversation);
  }
  if (input.reason === 'not_understood' && !understandingCounted(conversation)) {
    conversation.failedUnderstanding += 1;
    markUnderstandingCounted(conversation);
  }

  const tctx = systemCtx(ctx.companyId);
  const { facts, urgentMessage } = await withTenant(ctx.deps.pools, tctx, async (tx) => ({
    facts: await loadCompanyFacts(tx, tctx),
    urgentMessage: await hasUrgentNoticeFor(tx, tctx, conversation.conversationId),
  }));
  const urgent = input.reason === 'danger' || input.reason === 'leak' || urgentMessage;
  const members = await onCallMembers(ctx.deps.pools.system, ctx.companyId);
  const inWorkHours = workIntervals(facts.workHours, ctx.now, new Date(ctx.now.getTime() + 1), facts.timezone).length > 0;
  const plan = transferPlan({
    reason: input.reason,
    urgent,
    inWorkHours,
    onCall: members.map((m) => ({ userId: m.userId, phone: m.phone })),
  });

  if (plan.mode === 'message') {
    return {
      ok: true,
      forModel:
        'Nobody is available to take the call right now. Tell the caller you will take a message and ask for the details (use take_message).',
      action: 'message',
    };
  }
  return { ok: true, forModel: 'Tell the caller you are connecting them now.', action: 'transfer_' + plan.mode };
};
