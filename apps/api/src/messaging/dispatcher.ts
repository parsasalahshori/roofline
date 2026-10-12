import { isDeepStrictEqual } from 'node:util';
import {
  finishParkedStep,
  getStep,
  getTask,
  listParkedSteps,
  lockNextDueText,
  lockRecipient,
  markUnconfirmedTexts,
  type MessageRow,
  stepTextCounts,
  type TenantContext,
  type TextState,
  type Tx,
  updateScheduledText,
  withTenant,
} from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { settleSentProposal, settleUnsentProposal } from '../estimator/proposal-sent.ts';
import { reportJobError } from '../jobs/scheduler/report.ts';
import { systemContext } from '../permissions.ts';
import { refreshTask } from '../tasks/service.ts';
import { type BuiltGateRequest, buildGateRequest } from './gate-request.ts';
import { batchResult, QUEUED_TOO_LONG_MS, sendQueuedText, textStateFor, UNCONFIRMED } from './outbound.ts';

/*
 * The scheduled-text dispatcher, for one company (the scheduler job, jobs/scheduler/dispatch-messages.ts,
 * calls it for every company with something to do). Everything here runs as app_tenant inside
 * `withTenant`, under RLS.
 *
 * A waiting text is not simply sent when its time comes: the gate is asked again, with everything
 * read fresh, so a STOP, a do-not-contact flag, a change of consent or billing, or the weekly cap
 * reached overnight are all honoured at send time.
 */

/** A text the provider refused when its time came: nothing retries it by itself, but a retry of the step does. */
export const NOT_TAKEN_LATER = "The texting service didn't take this message. You can retry it.";
/** A batch step whose waiting texts are all dealt with, but some the provider refused. */
export const STEP_FAILED = "Some texts didn't go out. You can retry them.";

/** The step types that wait on texts: a batch's texts, and a proposal's single text. */
const PARKED_TEXT_STEP_TYPES = ['send_sms_batch', 'send_proposal'] as const;

/** A text with no customer has no consent on file. */
const NO_CUSTOMER: TextState = { status: 'blocked', blockRule: 'consent', blockReason: 'No texting consent on file.' };

export type DispatchSummary = {
  /** Texts sent. */
  sent: number;
  /** Texts the gate held again (they wait for their new time). */
  scheduled: number;
  /** Texts the gate now refuses. */
  blocked: number;
  /** Texts that failed: the provider refused them, or no local time could be worked out. */
  failed: number;
  /** Batch steps finished (done or failed). */
  finished: number;
};

export const emptySummary = (): DispatchSummary => ({ sent: 0, scheduled: 0, blocked: 0, failed: 0, finished: 0 });

/**
 * One pass for one company at `now` (the job's tick):
 * 1. **Due texts.** One at a time, each in its own short transaction: the next `scheduled` text with
 *    `scheduled_for <= now` is locked `FOR UPDATE SKIP LOCKED` (so two dispatchers never take the
 *    same one), the customer's texting lock is taken, the gate request is built afresh and the
 *    gate decides:
 *    - send → the row becomes `queued`, commits, and is sent as every text is (outbound.ts): a
 *      refusal fails it retryable ("You can retry it."), an unknown outcome fails it for good;
 *    - schedule → the row waits again, with its new `scheduled_for` and reason;
 *    - block → `blocked`, with the rule and reason.
 *    A text that throws is logged (its id only) and left for the next pass; the others go on.
 * 2. **Parked text steps.** For every parked `send_sms_batch` or `send_proposal` step of the company
 *    (`running`, no lease). A proposal's step is settled the same way, and when its one text went
 *    out here, the proposal is marked sent in the same transaction (`settleSentProposal`).
 *    Each: its texts left `queued` for longer than `QUEUED_TOO_LONG_MS` become unconfirmed (never
 *    resent), and its result is counted again. While a text still waits (`scheduled`, or `queued`
 *    under a live run) the step stays parked, with the new result. Otherwise it is finished with
 *    one conditional UPDATE (only while it is still parked): `done`, or `failed` when the provider
 *    refused some of its texts (a retry sends those), and its task follows (`refreshTask`). A
 *    proposal's step whose text did not go out (blocked or failed) follows the step handler's rule
 *    instead: the proposal goes back to draft and the step needs attention with the reason. The task
 *    row is locked first, then the step: the order every writer takes. A step that throws is logged
 *    (its id only) and left for the next pass; the other steps go on.
 */
export async function dispatchCompanyMessages(deps: AppDeps, companyId: string, now: Date): Promise<DispatchSummary> {
  const ctx = systemContext(companyId);
  const summary = emptySummary();

  const tried: string[] = [];
  for (;;) {
    const before = tried.length;
    let outcome: Awaited<ReturnType<typeof dispatchNext>>;
    try {
      outcome = await dispatchNext(deps, ctx, now, tried);
    } catch (err) {
      // Nothing was picked up at all: the company itself is in trouble, so its job run fails.
      if (tried.length === before) throw err;
      reportJobError(deps, err, `dispatch-messages: message ${tried[tried.length - 1]}`);
      continue;
    }
    if (outcome === 'none') break;
    if (outcome !== 'skipped') summary[outcome] += 1;
  }

  for (const type of PARKED_TEXT_STEP_TYPES) {
    for (const step of await withTenant(deps.pools, ctx, (tx) => listParkedSteps(tx, ctx, type))) {
      // One step that cannot be settled is logged and left for the next pass; the others go on.
      try {
        if (await settleParkedStep(deps, ctx, { ...step, type })) summary.finished += 1;
      } catch (err) {
        reportJobError(deps, err, `dispatch-messages: step ${step.id}`);
      }
    }
  }
  return summary;
}

/** Step 1 for the next due text. Returns what became of it, or `none` when nothing (else) is due. */
async function dispatchNext(
  deps: AppDeps,
  ctx: TenantContext,
  now: Date,
  tried: string[],
): Promise<'none' | 'skipped' | 'sent' | 'scheduled' | 'blocked' | 'failed'> {
  const decided = await withTenant(deps.pools, ctx, async (tx) => {
    const row = await lockNextDueText(tx, ctx, now, tried);
    if (!row) return null;
    tried.push(row.id);
    const at = deps.clock.now();
    const { state, toE164, sender } = await decideAgain(tx, ctx, row, at);
    // The row is locked and `scheduled`, so this always lands; the check is what makes the send safe.
    if (!(await updateScheduledText(tx, ctx, row.id, { body: row.body, toE164 }, state, at))) return { skipped: true as const };
    return { state, text: { messageId: row.id, to: toE164 ?? '', body: row.body, sender } };
  });
  if (!decided) return 'none';
  if ('skipped' in decided) return 'skipped';
  if (decided.state.status !== 'queued') return decided.state.status;
  return (await sendQueuedText(deps, ctx, decided.text, NOT_TAKEN_LATER)) === 'sent' ? 'sent' : 'failed';
}

/** What the gate says now about a due text (the caller holds its row lock). */
async function decideAgain(
  tx: Tx,
  ctx: TenantContext,
  row: MessageRow,
  at: Date,
): Promise<{ state: TextState; toE164: string | null; sender: BuiltGateRequest['sender'] }> {
  if (row.customerId === null) return { state: NO_CUSTOMER, toE164: row.toE164, sender: null };
  await lockRecipient(tx, ctx, row.customerId);
  const built = await buildGateRequest(
    tx,
    ctx,
    {
      customerId: row.customerId,
      // A text whose purpose was never recorded is held to the marketing rules, the stricter ones.
      purpose: row.purpose ?? 'marketing',
      body: row.body,
      bodyRendered: true,
      dedupeKey: row.dedupeKey,
      replyToInboundAt: null,
    },
    at,
  );
  if (!built) return { state: NO_CUSTOMER, toE164: row.toE164, sender: null };
  const state = textStateFor(built);
  if (state.status === 'queued' && built.toE164 === null) {
    return { state: { status: 'blocked', blockRule: 'contact', blockReason: 'No mobile number on file.' }, toE164: null, sender: built.sender };
  }
  return { state, toE164: built.toE164, sender: built.sender };
}

/** Step 2 for one parked batch step. True when this call finished it. */
async function settleParkedStep(
  deps: AppDeps,
  ctx: TenantContext,
  step: { id: string; taskId: string; type: string; result: Record<string, unknown> | null },
): Promise<boolean> {
  const now = deps.clock.now();
  return withTenant(deps.pools, ctx, async (tx) => {
    const stale = new Date(now.getTime() - QUEUED_TOO_LONG_MS);
    await markUnconfirmedTexts(tx, ctx, { stepId: step.id }, stale, UNCONFIRMED, now);
    const counts = await stepTextCounts(tx, ctx, step.id);
    const result = batchResult(counts);

    if (counts.scheduled > 0 || counts.queued > 0) {
      if (isDeepStrictEqual(result, step.result)) return false;
      await getTask(tx, ctx, step.taskId, { forUpdate: true });
      await finishParkedStep(tx, ctx, step.id, { status: 'running', result }, now);
      return false;
    }

    const someRefused = counts.retryableFailed > 0;
    await getTask(tx, ctx, step.taskId, { forUpdate: true });
    let finish: Parameters<typeof finishParkedStep>[3] = { status: someRefused ? 'failed' : 'done', result, errorPlain: someRefused ? STEP_FAILED : null };
    if (step.type === 'send_proposal') {
      const row = await getStep(tx, ctx, step.taskId, step.id);
      const payload = row?.payload as { proposalId?: unknown; customerId?: unknown } | undefined;
      const proposalId = payload?.proposalId;
      if (typeof proposalId !== 'string') throw new Error(`send_proposal step ${step.id} has no proposal id.`);
      if (counts.sent === 1 && !someRefused) {
        // A proposal's single text went out (now, or just now from the loop above): the proposal follows.
        await settleSentProposal(tx, ctx, proposalId, now);
      } else if (counts.sent === 0) {
        // C-I4: the held text was blocked or failed when its time came. The step handler's rule applies: the
        // proposal is a draft again and the step needs attention with the reason.
        const customerId = typeof payload?.customerId === 'string' ? payload.customerId : '';
        const blocked = Object.values(counts.blocked).some((n) => n > 0);
        const errorPlain = await settleUnsentProposal(tx, ctx, { proposalId, stepId: step.id, customerId, blocked }, now);
        finish = { status: 'needs_attention', result, errorPlain };
      }
    }
    const saved = await finishParkedStep(tx, ctx, step.id, finish, now);
    if (!saved) return false;
    await refreshTask(tx, ctx, saved.taskId, now);
    return true;
  });
}
