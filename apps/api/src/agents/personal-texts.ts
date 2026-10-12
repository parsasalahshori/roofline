import {
  followUpLogFor,
  getStepText,
  insertStepText,
  lastInboundAt,
  lastStormTextAt,
  lockRecipient,
  markUnconfirmedTexts,
  type OutboundText,
  recordFollowUp,
  rewriteRetryableText,
  stepTextCounts,
  type TenantContext,
  type TextState,
  withTenant,
} from '@roofline/db';
import { claimsGuard, type FollowUpKind, followUpAllowed, type MessagePurpose, stepTypes } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { buildGateRequest } from '../messaging/gate-request.ts';
import { batchResult, QUEUED_TOO_LONG_MS, type QueuedText, sendQueuedText, textStateFor, UNCONFIRMED } from '../messaging/outbound.ts';
import { NOT_TAKEN } from '../messaging/send-batch.ts';
import { leaseKeeper } from '../tasks/lease.ts';
import type { StepHandler } from '../tasks/runner.ts';

/*
 * The `send_personal_texts` step (G1 Task 5): like `send_sms_batch` (messaging/send-batch.ts), but
 * every customer gets a text of their own, already written for them by the agent, so nothing is
 * rendered from a template. The run is built the same way: a lease check before each customer, one
 * transaction per customer under their texting lock, a message row written before anything is sent,
 * and the outcome counted from the step's rows.
 *
 * The differences from send-batch:
 * - The body is used as written (the gate request is built with the body already rendered).
 * - The dedupe key is always `<dedupePrefix>:<customerId>`.
 * - Before the gate asks, two checks of our own can block the text: the claims guard (no prices,
 *   coverage or insurer talk: blockRule `content`) and, for every kind but reminders and no-show
 *   notices, the follow-up limits (replied, storm text, spacing, claims limits: blockRule `frequency`).
 *   Those write a `blocked` row and the gate's verdict is not used.
 * - A text that is written as `queued` or `scheduled` is also logged in the follow-up log, in the
 *   same transaction. Blocked and failed rows are not logged.
 */

const UNREADABLE = "We couldn't read who to text or what to send. Please make this plan again.";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back the follow-up log is read. followUpAllowed checks each row's age itself for spacing (3 and 4 days), but its per-claim cap (CLAIMS_MAX_PER_CLAIM, counted per job) counts every row it is given. Claims texts are at least 4 days apart, so a 7-day window would hold at most 2 of them and the cap could never fire. The window must cover the whole life of a claim. */
const LOG_WINDOW_DAYS = 365;

const CONTENT_HELD = 'This text was held: it talks about prices, coverage or the insurer.';

const FREQUENCY_REASONS = {
  replied: 'They replied recently.',
  storm_text: 'They got a storm text recently.',
  spacing: 'They were texted recently.',
  claims_spacing: 'They were texted recently.',
  claims_max: 'This claim has had enough reminders.',
} as const;

type PersonalText = {
  customerId: string;
  jobId: string | null;
  body: string;
  purpose: MessagePurpose;
  kind: FollowUpKind;
  dedupeKey: string;
};

/** The handler: see the comment above and send-batch.ts `sendSmsBatch` for the shape of the run. */
export const sendPersonalTexts: StepHandler = async (deps, ctx, step) => {
  const parsed = stepTypes.send_personal_texts.payload.safeParse(step.payload);
  if (!parsed.success) return { status: 'needs_attention', result: {}, errorPlain: UNREADABLE };
  const { purpose, kind, messages, dedupePrefix } = parsed.data as {
    purpose: MessagePurpose;
    kind: FollowUpKind;
    messages: { customerId: string; jobId: string | null; body: string }[];
    dedupePrefix: string;
  };

  const lease = leaseKeeper(deps, ctx, step);
  let refused = 0;
  for (const message of messages) {
    if (!(await lease.keep())) return { status: 'running', result: {} };
    const dedupeKey = `${dedupePrefix}:${message.customerId}`;
    const queued = await decideOne(deps, ctx, step.id, {
      customerId: message.customerId,
      jobId: message.jobId,
      body: message.body,
      purpose,
      kind,
      dedupeKey,
    });
    if (queued && (await sendQueuedText(deps, ctx, queued, NOT_TAKEN)) === 'refused') refused += 1;
  }

  const counts = await withTenant(deps.pools, ctx, (tx) => stepTextCounts(tx, ctx, step.id));
  if (refused > 0 || counts.retryableFailed > 0) {
    const n = Math.max(refused, counts.retryableFailed);
    throw new Error(`The texting service did not take ${n} text(s) of this step; the step will be tried again.`);
  }
  const result = batchResult(counts);
  return { status: counts.scheduled > 0 || counts.queued > 0 ? 'running' : 'done', result };
};

/** One customer, in one transaction. Returns the text to send when this run queued it, else null. */
function decideOne(deps: AppDeps, ctx: TenantContext, stepId: string, text: PersonalText): Promise<QueuedText | null> {
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

    // Built first for the number and the sender (and to skip a customer who is not the company's);
    // its verdict is used only when our own checks below let the text through.
    const built = await buildGateRequest(
      tx,
      ctx,
      { customerId: text.customerId, purpose: text.purpose, body: text.body, bodyRendered: true, dedupeKey: text.dedupeKey, replyToInboundAt: null },
      now,
    );
    if (!built) return null;

    let state: TextState;
    if (!claimsGuard(text.body).ok) {
      state = { status: 'blocked', blockRule: 'content', blockReason: CONTENT_HELD };
    } else {
      let held: TextState | null = null;
      if (text.kind !== 'reminder' && text.kind !== 'no_show') {
        // A retry of this step's own refused text must not be spaced out by the log row its first attempt wrote.
        const log = (await followUpLogFor(tx, ctx, [text.customerId], new Date(now.getTime() - LOG_WINDOW_DAYS * DAY_MS))).filter(
          (r) => r.messageId !== existing?.id,
        );
        const inboundAt = await lastInboundAt(tx, ctx, text.customerId);
        const stormAt = await lastStormTextAt(tx, ctx, text.customerId);
        const decision = followUpAllowed({
          log,
          kind: text.kind,
          customerId: text.customerId,
          jobId: text.jobId,
          now,
          lastInboundAt: inboundAt,
          lastStormTextAt: stormAt,
        });
        if (!decision.allowed) {
          held = { status: 'blocked', blockRule: 'frequency', blockReason: FREQUENCY_REASONS[decision.reason] };
        }
      }
      state = held ?? textStateFor(built);
      // The gate never lets a text through without a number; this keeps the type honest.
      if (state.status === 'queued' && built.toE164 === null) {
        state = { status: 'blocked', blockRule: 'contact', blockReason: 'No mobile number on file.' };
      }
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

    if (messageId === null) return null;
    if (state.status === 'queued' || state.status === 'scheduled') {
      await recordFollowUp(tx, ctx, { customerId: text.customerId, jobId: text.jobId, kind: text.kind, messageId, at: now });
    }
    if (state.status !== 'queued') return null;
    return { messageId, to: built.toE164!, body: row.body, sender: built.sender };
  });
}
