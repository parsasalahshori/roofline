import {
  markTextFailed,
  markTextSent,
  recordCarrierOptOut,
  recordSmsUsage,
  type StepTextCounts,
  type TenantContext,
  type TextState,
  withTenant,
} from '@roofline/db';
import { decide, type GateDecision, isSmsRefusedError, type SmsSendResult } from '@roofline/send-gate';
import type { GateRule, StepResult } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import type { BuiltGateRequest } from './gate-request.ts';

/*
 * The pieces of sending a text that the batch step (send-batch.ts) and the dispatcher
 * (dispatcher.ts) share: what the gate's answer means for a message row, the send itself, and the
 * step's tally.
 *
 * Every text is sent the same way, so a text is never sent twice:
 * 1. In a short transaction it becomes `queued` (the batch inserts it, or claims a retryable failure;
 *    the dispatcher moves its locked `scheduled` row). Only the run that did that sends it.
 * 2. That commits, and only then is the provider called, outside any transaction.
 * 3. In a new transaction the answer is saved: `sent` (with the usage row); `failed` and retryable
 *    when the provider refused it (`SmsRefusedError`: it definitely did not go out); `failed`, not
 *    retryable, when the refusal is permanent (a number that can't get texts, or a carrier opt-out,
 *    which also turns texting off for that customer in the same transaction); `failed`, not
 *    retryable (`UNCONFIRMED`) on any other error, since the provider may have sent it after all.
 * A run that dies between 1 and 3 leaves the row `queued`. After `QUEUED_TOO_LONG_MS` nobody can say
 * whether it went out, so it becomes `failed`, not retryable (`UNCONFIRMED`), and is never resent.
 */

/** A text still `queued` after this long is taken to be lost by the run that queued it. */
export const QUEUED_TOO_LONG_MS = 5 * 60 * 1000;

export const UNCONFIRMED = "We couldn't confirm this text was sent, so we didn't resend it.";
export const NO_LOCAL_TIME = "We couldn't work out this customer's local time.";

export const ARCHIVED = 'This customer is archived.';

/** The gate rules that come before `contact`, so they win over "archived" (which is a contact block). */
const BEFORE_CONTACT: ReadonlySet<GateRule> = new Set(['billing', 'registration']);

/**
 * The row state for what the gate says about a built request. `decide` throwing (no usable time
 * zone) is a failure nobody can retry. An archived customer is blocked at the contact rule, "This
 * customer is archived.": only a billing or registration block, which the gate checks first, is
 * reported instead.
 */
export function textStateFor(built: Pick<BuiltGateRequest, 'req' | 'archived'>): TextState {
  const archived: TextState = { status: 'blocked', blockRule: 'contact', blockReason: ARCHIVED };
  let decision: GateDecision;
  try {
    decision = decide(built.req);
  } catch {
    return built.archived ? archived : { status: 'failed', blockReason: NO_LOCAL_TIME, retryable: false };
  }
  if (built.archived && !(decision.action === 'block' && BEFORE_CONTACT.has(decision.rule))) return archived;
  switch (decision.action) {
    case 'send':
      return { status: 'queued' };
    case 'schedule':
      return { status: 'scheduled', scheduledFor: decision.at, blockRule: decision.rule, blockReason: decision.reason };
    case 'block':
      return { status: 'blocked', blockRule: decision.rule, blockReason: decision.reason };
  }
}

/**
 * A text this run has made `queued` (and committed), ready to hand to the provider. `sender` is the
 * company's Twilio subaccount and messaging service (null when it has none yet).
 */
export type QueuedText = {
  messageId: string;
  to: string;
  body: string;
  sender: { accountSid: string; messagingServiceSid: string } | null;
};

/**
 * Steps 2 and 3 above for one queued text: calls the provider with no transaction open, then saves
 * the answer. A provider error is not thrown and not kept (it can name the number or echo the
 * body); the row says what happened instead:
 * - `failed` (a permanent refusal: the provider will never take this number): `failed`, not
 *   retryable, with the refusal's plain reason. When the refusal is a carrier opt-out, the customer's
 *   texting is turned off in the same transaction (`recordCarrierOptOut`). Returns `failed`, so a
 *   batch does not throw for it;
 * - `refused` (any other `SmsRefusedError`): `failed`, retryable, with `refusedReason`;
 * - `unknown` (any other error): `failed`, not retryable, `UNCONFIRMED`. Never sent again.
 * A failure to save the answer is thrown (the row stays `queued`, so it is never sent again either).
 */
export async function sendQueuedText(
  deps: AppDeps,
  ctx: TenantContext,
  text: QueuedText,
  refusedReason: string,
): Promise<'sent' | 'refused' | 'failed' | 'unknown'> {
  let answer: SmsSendResult;
  try {
    answer = await deps.sms.send({ companyId: ctx.companyId, to: text.to, body: text.body, sender: text.sender });
  } catch (err) {
    const now = deps.clock.now();
    const refusal = isSmsRefusedError(err) ? err : null;
    if (refusal !== null && refusal.permanent) {
      const reason = refusal.reasonPlain ?? refusedReason;
      const optedOut = refusal.optedOut;
      await withTenant(deps.pools, ctx, async (tx) => {
        await markTextFailed(tx, ctx, text.messageId, { reason, retryable: false }, now);
        if (optedOut) await recordCarrierOptOut(tx, ctx, text.to, now);
      });
      return 'failed';
    }
    const failure = refusal !== null ? { reason: refusedReason, retryable: true } : { reason: UNCONFIRMED, retryable: false };
    await withTenant(deps.pools, ctx, (tx) => markTextFailed(tx, ctx, text.messageId, failure, now));
    return refusal !== null ? 'refused' : 'unknown';
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
