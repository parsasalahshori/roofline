import { emailStepStormId, lockNextDueEmail, lockRecipient, type TenantContext, type TextState, updateScheduledEmail, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { reportJobError } from '../jobs/scheduler/report.ts';
import { buildEmailGate, emailStateFor, emailTag, type QueuedEmail, sendQueuedEmail } from '../storm/email-batch.ts';

/** Counts for one pass over the due scheduled emails of one company. */
export type EmailDispatchSummary = { sent: number; scheduled: number; blocked: number; failed: number };

const NO_ADDRESS: TextState = { status: 'blocked', blockRule: 'contact', blockReason: 'No email address on file.' };

/** Sends the company's due `scheduled` email rows (channel 'email'), re-gating each one. */
export async function dispatchEmail(deps: AppDeps, ctx: TenantContext, now: Date): Promise<EmailDispatchSummary> {
  const summary: EmailDispatchSummary = { sent: 0, scheduled: 0, blocked: 0, failed: 0 };
  const tried: string[] = [];
  for (;;) {
    const before = tried.length;
    let outcome: Awaited<ReturnType<typeof dispatchNextEmail>>;
    try {
      outcome = await dispatchNextEmail(deps, ctx, now, tried);
    } catch (err) {
      if (tried.length === before) throw err;
      reportJobError(deps, err, `dispatch-messages: email ${tried[tried.length - 1]}`);
      continue;
    }
    if (outcome === 'none') break;
    if (outcome !== 'skipped') summary[outcome] += 1;
  }
  return summary;
}

async function dispatchNextEmail(
  deps: AppDeps,
  ctx: TenantContext,
  now: Date,
  tried: string[],
): Promise<'none' | 'skipped' | 'sent' | 'scheduled' | 'blocked' | 'failed'> {
  const decided = await withTenant(deps.pools, ctx, async (tx) => {
    const row = await lockNextDueEmail(tx, ctx, now, tried);
    if (!row) return null;
    tried.push(row.id);
    const at = deps.clock.now();
    const subject = row.subject ?? '';
    const toEmail = row.toEmail ?? '';
    if (row.customerId === null) {
      if (!(await updateScheduledEmail(tx, ctx, row.id, { toEmail, subject, body: row.body }, NO_ADDRESS, at))) return { skipped: true as const };
      return { state: NO_ADDRESS, mail: null };
    }
    await lockRecipient(tx, ctx, row.customerId);
    // The row is `scheduled`, which the history does not count, so it never blocks itself on its own dedupe key.
    const built = await buildEmailGate(
      tx,
      ctx,
      deps.config,
      { customerId: row.customerId, subject, body: row.body, rendered: true, fields: undefined, companyStormId: null, dedupeKey: row.dedupeKey },
      at,
    );
    const state: TextState = built ? emailStateFor(built, at) : NO_ADDRESS;
    const to = built?.toEmail ?? toEmail;
    if (!(await updateScheduledEmail(tx, ctx, row.id, { toEmail: to, subject, body: row.body }, state, at))) return { skipped: true as const };
    if (state.status !== 'queued' || !built) return { state, mail: null };
    const stormId = row.stepId === null ? null : await emailStepStormId(tx, ctx, row.stepId);
    const mail: QueuedEmail = {
      messageId: row.id,
      to,
      subject: built.subject,
      body: built.body,
      replyTo: built.replyTo,
      companyName: built.companyName,
      unsubscribeUrl: built.unsubscribeUrl,
      tag: emailTag(stormId),
    };
    return { state, mail };
  });
  if (!decided) return 'none';
  if ('skipped' in decided) return 'skipped';
  if (decided.state.status !== 'queued' || !decided.mail) return decided.state.status === 'queued' ? 'failed' : decided.state.status;
  return (await sendQueuedEmail(deps, ctx, decided.mail)) === 'sent' ? 'sent' : 'failed';
}

