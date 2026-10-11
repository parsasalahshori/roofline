import {
  getStepText,
  insertStepText,
  lockRecipient,
  markUnconfirmedTexts,
  type OutboundText,
  rewriteRetryableText,
  stepTextCounts,
  type TenantContext,
  type TextState,
  withTenant,
} from '@roofline/db';
import { type MessagePurpose, stepTypes } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import type { StepHandler } from '../tasks/runner.ts';
import { buildGateRequest } from './gate-request.ts';
import { batchResult, QUEUED_TOO_LONG_MS, type QueuedText, sendQueuedText, textStateFor, UNCONFIRMED } from './outbound.ts';

/*
 * The `send_sms_batch` step (spec 4.5): one approved message to a list of customers, each one
 * through the send gate. A customer the gate lets through now is texted; one it holds (quiet hours,
 * the daily limit) gets a `scheduled` row that the dispatcher sends later; one it refuses gets a
 * `blocked` row saying why. Nothing is ever texted without a message row saying so first.
 *
 * The runner holds no lock while this runs, and it may run more than once for one step (a retry
 * after a throw, a second run after a lost lease, two at once). So each customer is handled in
 * transactions of its own, and the step's message rows are what make it safe to repeat: a customer
 * the step already has a row for is left alone, unless that row is a send the provider refused
 * (`failed` and retryable), which is tried again. See outbound.ts for how a single text is sent.
 */

/** A text the provider refused while this step was running: the runner tries the step again. */
export const NOT_TAKEN = "The texting service didn't take this message. We'll try again.";

const UNREADABLE = "We couldn't read who to text or what to send. Please make this plan again.";

type BatchText = { customerId: string; purpose: MessagePurpose; template: string; dedupeKey: string | null };

/**
 * The handler. For each customer in `payload.customerIds`, in order:
 * 1. One short transaction, under the customer's texting lock (`lockRecipient`):
 *    - the step's row for them is looked up. None, or a retryable failure: go on. `queued` for
 *      longer than `QUEUED_TOO_LONG_MS`: marked unconfirmed (never resent). Anything else: done.
 *    - the gate request is built (gate-request.ts) and the gate decides. `decide` throwing (no usable
 *      time zone) fails the row, not retryable ("We couldn't work out this customer's local time.").
 *    - the row is written as `blocked`, `scheduled`, `failed` or `queued`: inserted with
 *      `ON CONFLICT (step_id, customer_id) DO NOTHING`, or written over the retryable failure only
 *      while it still is one. A run that writes nothing lost the customer to another run and skips
 *      them. It commits.
 * 2. A `queued` row is then sent (outbound.ts): provider first, then `sent`; `failed` and retryable
 *    when the provider refused it; `failed`, not retryable ("We couldn't confirm ...") on any other
 *    provider error, since it may have gone out.
 *
 * Then the step's rows are counted into the result `{sent, scheduled, failed, blocked: {<rule>: n}}`
 * and the run ends, from those rows rather than from what this run did:
 * - any text of the step the provider refused (`failed` and retryable: this run's, or one another
 *   run or the dispatcher had refused after this run passed that customer) → throws (no customer
 *   data in the error), so the runner tries again; what was sent stays sent and is skipped next time;
 * - else a row still `scheduled` (or `queued` under another run) → `running`: the step is parked and
 *   the dispatcher finishes it;
 * - else `done`.
 * A customer who is not in the company is skipped. A payload that is not a batch's needs attention.
 */
export const sendSmsBatch: StepHandler = async (deps, ctx, step) => {
  const parsed = stepTypes.send_sms_batch.payload.safeParse(step.payload);
  if (!parsed.success) return { status: 'needs_attention', result: {}, errorPlain: UNREADABLE };
  const { purpose, body, customerIds, dedupePrefix } = parsed.data as {
    purpose: MessagePurpose;
    body: string;
    customerIds: string[];
    dedupePrefix?: string;
  };

  let refused = 0;
  for (const customerId of customerIds) {
    const dedupeKey = dedupePrefix !== undefined ? `${dedupePrefix}:${customerId}` : null;
    const queued = await decideOne(deps, ctx, step.id, { customerId, purpose, template: body, dedupeKey });
    if (queued && (await sendQueuedText(deps, ctx, queued, NOT_TAKEN)) === 'refused') refused += 1;
  }

  // The outcome comes from the step's rows, not from what this run did: another run (or the
  // dispatcher) may have had a text refused after this run passed that customer.
  const counts = await withTenant(deps.pools, ctx, (tx) => stepTextCounts(tx, ctx, step.id));
  if (refused > 0 || counts.retryableFailed > 0) {
    const n = Math.max(refused, counts.retryableFailed);
    throw new Error(`The texting service did not take ${n} text(s) of this batch; the step will be tried again.`);
  }
  const result = batchResult(counts);
  return { status: counts.scheduled > 0 || counts.queued > 0 ? 'running' : 'done', result };
};

/**
 * Step 1 for one customer, in one transaction. Returns the text to send when this run queued it,
 * else null (blocked, scheduled, failed, or another run's).
 */
function decideOne(deps: AppDeps, ctx: TenantContext, stepId: string, text: BatchText): Promise<QueuedText | null> {
  const now = deps.clock.now();
  return withTenant(deps.pools, ctx, async (tx) => {
    await lockRecipient(tx, ctx, text.customerId);

    const existing = await getStepText(tx, ctx, stepId, text.customerId);
    if (existing) {
      if (existing.status === 'queued') {
        const before = new Date(now.getTime() - QUEUED_TOO_LONG_MS);
        await markUnconfirmedTexts(tx, ctx, { messageId: existing.id }, before, UNCONFIRMED, now);
        return null;
      }
      if (!(existing.status === 'failed' && existing.retryable)) return null;
    }

    const built = await buildGateRequest(
      tx,
      ctx,
      { customerId: text.customerId, purpose: text.purpose, body: text.template, dedupeKey: text.dedupeKey, replyToInboundAt: null },
      now,
    );
    if (!built) return null;

    let state: TextState = textStateFor(built);
    // The gate never lets a text through without a number; this keeps the type honest.
    if (state.status === 'queued' && built.toE164 === null) {
      state = { status: 'blocked', blockRule: 'contact', blockReason: 'No mobile number on file.' };
    }
    const row: OutboundText = {
      customerId: text.customerId,
      purpose: text.purpose,
      body: built.req.message.body,
      toE164: built.toE164,
      dedupeKey: text.dedupeKey,
    };
    const messageId = existing
      ? (await rewriteRetryableText(tx, ctx, existing.id, row, state, now))
        ? existing.id
        : null
      : await insertStepText(tx, ctx, stepId, row, state, now);

    if (messageId === null || state.status !== 'queued') return null;
    return { messageId, to: built.toE164!, body: row.body };
  });
}
