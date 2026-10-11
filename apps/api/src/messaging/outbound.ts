import {
  markTextNotTaken,
  markTextSent,
  recordSmsUsage,
  type StepTextCounts,
  type TenantContext,
  type TextState,
  withTenant,
} from '@roofline/db';
import { decide, type GateDecision, type GateRequest, type SmsSendResult } from '@roofline/send-gate';
import type { StepResult } from '@roofline/shared';
import type { AppDeps } from '../app.ts';

/*
 * The pieces of sending a text that the batch step (send-batch.ts) and the dispatcher
 * (dispatcher.ts) share: what the gate's answer means for a message row, the send itself, and the
 * step's tally.
 *
 * Every text is sent the same way, so a text is never sent twice:
 * 1. In a short transaction it becomes `queued` (the batch inserts it, or claims a retryable failure;
 *    the dispatcher moves its locked `scheduled` row). Only the run that did that sends it.
 * 2. That commits, and only then is the provider called, outside any transaction.
 * 3. In a new transaction the answer is saved: `sent` (with the usage row), or `failed` and
 *    retryable when the provider refused it.
 * A run that dies between 1 and 3 leaves the row `queued`. After `QUEUED_TOO_LONG_MS` nobody can say
 * whether it went out, so it becomes `failed`, not retryable (`UNCONFIRMED`), and is never resent.
 */

/** A text still `queued` after this long is taken to be lost by the run that queued it. */
export const QUEUED_TOO_LONG_MS = 5 * 60 * 1000;

export const UNCONFIRMED = "We couldn't confirm this text was sent, so we didn't resend it.";
export const NO_LOCAL_TIME = "We couldn't work out this customer's local time.";

/** The row state for what the gate said. `decide` throwing (no usable time zone) is a failure nobody can retry. */
export function textStateFor(req: GateRequest): TextState {
  let decision: GateDecision;
  try {
    decision = decide(req);
  } catch {
    return { status: 'failed', blockReason: NO_LOCAL_TIME, retryable: false };
  }
  switch (decision.action) {
    case 'send':
      return { status: 'queued' };
    case 'schedule':
      return { status: 'scheduled', scheduledFor: decision.at, blockRule: decision.rule, blockReason: decision.reason };
    case 'block':
      return { status: 'blocked', blockRule: decision.rule, blockReason: decision.reason };
  }
}

/** A text this run has made `queued` (and committed), ready to hand to the provider. */
export type QueuedText = { messageId: string; to: string; body: string };

/**
 * Steps 2 and 3 above for one queued text: calls the provider with no transaction open, then saves
 * the answer. A refusal is not thrown: the row becomes `failed`, retryable, with `notTakenReason`,
 * and the caller is told. A failure to save the answer is thrown (the row stays `queued`, so it is
 * never sent again).
 */
export async function sendQueuedText(
  deps: AppDeps,
  ctx: TenantContext,
  text: QueuedText,
  notTakenReason: string,
): Promise<'sent' | 'not_taken'> {
  let answer: SmsSendResult;
  try {
    answer = await deps.sms.send({ companyId: ctx.companyId, to: text.to, body: text.body });
  } catch {
    // The provider's error is not kept: it can name the number or echo the body.
    const now = deps.clock.now();
    await withTenant(deps.pools, ctx, (tx) => markTextNotTaken(tx, ctx, text.messageId, notTakenReason, now));
    return 'not_taken';
  }
  const now = deps.clock.now();
  await withTenant(deps.pools, ctx, async (tx) => {
    const saved = await markTextSent(tx, ctx, text.messageId, { providerSid: answer.providerSid, segments: answer.segments, sentAt: now }, now);
    if (saved) await recordSmsUsage(tx, ctx, text.messageId, answer.segments, now);
  });
  return 'sent';
}

/** A batch step's result, `{sent, scheduled, failed, blocked: {<rule>: n}}`, rules in a fixed order. */
export function batchResult(counts: StepTextCounts): StepResult {
  const blocked: Record<string, number> = {};
  for (const rule of Object.keys(counts.blocked).sort()) blocked[rule] = counts.blocked[rule]!;
  return { sent: counts.sent, scheduled: counts.scheduled, failed: counts.failed, blocked };
}
