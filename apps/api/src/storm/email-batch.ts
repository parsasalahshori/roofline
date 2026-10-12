import {
  emailCompanyFacts,
  emailHistory,
  emailRecipientFacts,
  getStepText,
  insertStepEmail,
  isEmailOptedOut,
  lockRecipient,
  markEmailSent,
  markTextFailed,
  markUnconfirmedTexts,
  type OutboundEmail,
  rewriteRetryableEmail,
  stepTextCounts,
  stormConvectiveDay,
  type TenantContext,
  type TextState,
  type Tx,
  withTenant,
} from '@roofline/db';
import { decideEmail, type EmailGateDecision, type EmailGateRequest } from '@roofline/send-gate';
import { renderStormTemplate, stepTypes, stormDayLabel } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import type { Config } from '../config.ts';
import { batchResult, QUEUED_TOO_LONG_MS } from '../messaging/outbound.ts';
import { signUnsubscribeToken } from '../public/unsubscribe-token.ts';
import { unsubscribeKey } from '../public/unsubscribe-key.ts';
import { leaseKeeper } from '../tasks/lease.ts';
import type { StepHandler } from '../tasks/runner.ts';
/* The storm email path: the gate request, the row state, the send, and the send_email_batch step. */

export const NO_EMAIL_LOCAL_TIME = "We couldn't work out this customer's local time.";
/** Row reason when the mail service refused or failed. */
export const EMAIL_NOT_TAKEN = "The email service didn't take this message.";
export const EMAIL_UNCONFIRMED = "We couldn't confirm this email was sent, so we didn't resend it.";

export type EmailGateInput = {
  customerId: string;
  /** Subject and body templates, or the finished text when `rendered` is true. */
  subject: string;
  body: string;
  rendered: boolean;
  /** Per-recipient fields from the payload: hail_size, street. */
  fields: Record<string, string> | undefined;
  /** companyStormId of the payload (for the day label); null when none. */
  companyStormId: string | null;
  dedupeKey: string | null;
};
export type BuiltEmail = {
  req: EmailGateRequest;
  toEmail: string | null;
  /** Rendered subject / PLAIN-TEXT body exactly as handed to decideEmail. */
  subject: string;
  body: string;
  unsubscribeUrl: string;
  replyTo: string | null;
  companyName: string;
  archived: boolean;
};

const SENDING_STATUSES: ReadonlySet<string> = new Set(['trial', 'active']);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const UNREADABLE = "We couldn't read who to email or what to send. Please make this plan again.";
const ARCHIVED_REASON = 'This customer is archived.';

const filled = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';

/** Reads the facts (company, storm day, customer, opt-out, history) and builds the decideEmail request. Null when the customer is not the company's. */
export async function buildEmailGate(
  tx: Tx,
  ctx: TenantContext,
  config: Pick<Config, 'APP_ORIGIN' | 'ENCRYPTION_KEY'>,
  input: EmailGateInput,
  now: Date,
): Promise<BuiltEmail | null> {
  const facts = await emailCompanyFacts(tx, ctx);
  if (!facts) throw new Error('company not found');
  const recipient = await emailRecipientFacts(tx, ctx, input.customerId);
  if (!recipient) return null;
  const companyAddress = facts.address;

  let day = 'recently';
  if (input.companyStormId) {
    const convective = await stormConvectiveDay(tx, ctx, input.companyStormId);
    if (convective !== null) day = stormDayLabel(convective, now, facts.timezone);
  }

  const email = recipient.email;
  const unsubscribeUrl =
    email !== null
      ? `${config.APP_ORIGIN}/u/${signUnsubscribeToken(unsubscribeKey(config), { companyId: ctx.companyId, email })}`
      : `${config.APP_ORIGIN}/u/`;

  let subject = input.subject;
  let body = input.body;
  if (!input.rendered) {
    const f = input.fields;
    const values = {
      first_name: recipient.firstName ?? '',
      company: facts.name,
      hail_size: filled(f?.hail_size) ? f.hail_size : '{hail_size}',
      street: filled(f?.street) ? f.street : 'your street',
      day,
      company_address: companyAddress ?? '{company_address}',
      unsubscribe: unsubscribeUrl,
    };
    subject = renderStormTemplate(input.subject, values);
    body = renderStormTemplate(input.body, values);
  }

  let dedupeHit = false;
  let sentLast7Days = 0;
  if (email !== null) {
    const history = await emailHistory(tx, ctx, {
      email,
      dedupeKey: input.dedupeKey,
      since: new Date(now.getTime() - WEEK_MS),
    });
    dedupeHit = history.dedupeAlreadySent;
    sentLast7Days = history.sentLast7Days;
  }
  const optedOut = email !== null && (await isEmailOptedOut(tx, ctx, email));

  const req: EmailGateRequest = {
    purpose: 'marketing',
    billingOk: SENDING_STATUSES.has(facts.status),
    email,
    doNotContact: recipient.doNotContact,
    optedOut,
    subject,
    body,
    companyName: facts.name,
    companyAddress,
    dedupeHit,
    sentLast7Days,
    now,
    timeZone: recipient.timezone ?? facts.timezone,
  };
  return {
    req,
    toEmail: email,
    subject,
    body,
    unsubscribeUrl,
    replyTo: facts.replyTo,
    companyName: facts.name,
    archived: recipient.archived,
  };
}

/** decideEmail -> row state: ok & sendAt<=now queued; ok & later scheduled (blockRule 'quiet_hours', scheduledFor sendAt); !ok blocked with rule/reason; archived -> blocked 'contact' 'This customer is archived.'; RangeError -> failed not retryable NO_EMAIL_LOCAL_TIME. */
export function emailStateFor(built: Pick<BuiltEmail, 'req' | 'archived'>, now: Date): TextState {
  const archived: TextState = { status: 'blocked', blockRule: 'contact', blockReason: ARCHIVED_REASON };
  let decision: EmailGateDecision;
  try {
    decision = decideEmail(built.req);
  } catch {
    return built.archived ? archived : { status: 'failed', blockReason: NO_EMAIL_LOCAL_TIME, retryable: false };
  }
  if (built.archived && !(!decision.ok && decision.rule === 'billing')) return archived;
  if (!decision.ok) return { status: 'blocked', blockRule: decision.rule, blockReason: decision.reason };
  if (decision.sendAt.getTime() <= now.getTime()) return { status: 'queued' };
  return {
    status: 'scheduled',
    scheduledFor: decision.sendAt,
    blockRule: 'quiet_hours',
    blockReason: 'Waiting for 8 AM local time.',
  };
}

/** The HTML twin of a plain-text body: HTML-escaped, line breaks as <br>, every http(s) URL an <a href>. */
export function emailHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const linked = escaped.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`);
  return `<div>${linked.replace(/\r\n|\r|\n/g, '<br>')}</div>`;
}

/** `storm:${companyStormId}`, or 'storm' without one. */
export function emailTag(companyStormId: string | null): string {
  return companyStormId ? `storm:${companyStormId}` : 'storm';
}

export type QueuedEmail = {
  messageId: string;
  to: string;
  subject: string;
  body: string;
  replyTo: string | null;
  companyName: string;
  unsubscribeUrl: string;
  tag: string;
};

/** Provider call with no transaction open, then saves the answer: sent (markEmailSent) or failed not retryable (markTextFailed). Never throws for a provider error. */
export async function sendQueuedEmail(deps: AppDeps, ctx: TenantContext, mail: QueuedEmail): Promise<'sent' | 'failed'> {
  let messageId: string;
  try {
    const result = await deps.broadcast.send({
      to: mail.to,
      from: `"${mail.companyName} via Roofline" <${deps.config.STORM_MAIL_FROM}>`,
      replyTo: mail.replyTo,
      subject: mail.subject,
      text: mail.body,
      html: emailHtml(mail.body),
      unsubscribeUrl: mail.unsubscribeUrl,
      tag: mail.tag,
    });
    messageId = result.messageId;
  } catch {
    // The error text can name the address or echo the body, so it is neither kept nor logged.
    const now = deps.clock.now();
    await withTenant(deps.pools, ctx, (tx) =>
      markTextFailed(tx, ctx, mail.messageId, { reason: EMAIL_NOT_TAKEN, retryable: false }, now),
    );
    return 'failed';
  }
  const sentAt = deps.clock.now();
  await withTenant(deps.pools, ctx, (tx) =>
    markEmailSent(tx, ctx, mail.messageId, { providerMessageId: messageId, sentAt }, sentAt),
  );
  return 'sent';
}

/** One customer, one transaction: returns the email this run queued, else null. */
function decideOne(
  deps: AppDeps,
  ctx: TenantContext,
  stepId: string,
  input: EmailGateInput,
  tag: string,
): Promise<QueuedEmail | null> {
  const now = deps.clock.now();
  return withTenant(deps.pools, ctx, async (tx) => {
    await lockRecipient(tx, ctx, input.customerId);
    const existing = await getStepText(tx, ctx, stepId, input.customerId);
    if (existing) {
      if (existing.status === 'queued') {
        const before = new Date(now.getTime() - QUEUED_TOO_LONG_MS);
        await markUnconfirmedTexts(tx, ctx, { messageId: existing.id }, before, EMAIL_UNCONFIRMED, now);
        return null;
      }
      if (!(existing.status === 'failed' && existing.retryable)) return null;
    }
    const built = await buildEmailGate(tx, ctx, deps.config, input, now);
    // A customer who is not the company's, or who has no email address, gets no row (the table
    // needs an address); they are left out of the step's counts.
    if (!built || built.toEmail === null) return null;
    const state = emailStateFor(built, now);
    const row: OutboundEmail = {
      customerId: input.customerId,
      toEmail: built.toEmail,
      subject: built.subject,
      body: built.body,
      dedupeKey: input.dedupeKey,
    };
    const messageId = existing
      ? (await rewriteRetryableEmail(tx, ctx, existing.id, row, state, now))
        ? existing.id
        : null
      : await insertStepEmail(tx, ctx, stepId, row, state, now);
    if (messageId === null || state.status !== 'queued') return null;
    return {
      messageId,
      to: built.toEmail,
      subject: built.subject,
      body: built.body,
      replyTo: built.replyTo,
      companyName: built.companyName,
      unsubscribeUrl: built.unsubscribeUrl,
      tag,
    };
  });
}

/** The `send_email_batch` step: each customer through the email gate, then sent, scheduled or blocked. A provider error never throws and never stops the loop. */
export const sendEmailBatchHandler: StepHandler = async (deps, ctx, step) => {
  const parsed = stepTypes.send_email_batch.payload.safeParse(step.payload);
  if (!parsed.success) return { status: 'needs_attention', result: {}, errorPlain: UNREADABLE };
  const payload = parsed.data as {
    subject: string;
    body: string;
    customerIds: string[];
    fields?: Record<string, Record<string, string>>;
    dedupePrefix?: string;
    companyStormId?: string;
  };
  const stormId = payload.companyStormId ?? null;
  const tag = emailTag(stormId);

  const lease = leaseKeeper(deps, ctx, step);
  for (const customerId of payload.customerIds) {
    if (!(await lease.keep())) return { status: 'running', result: {} };
    const dedupeKey =
      payload.dedupePrefix !== undefined
        ? `email:${payload.dedupePrefix}:${customerId}`
        : stormId
          ? `email:storm:${stormId}:${customerId}`
          : null;
    const queued = await decideOne(
      deps,
      ctx,
      step.id,
      {
        customerId,
        subject: payload.subject,
        body: payload.body,
        rendered: false,
        fields: payload.fields?.[customerId],
        companyStormId: stormId,
        dedupeKey,
      },
      tag,
    );
    if (queued) await sendQueuedEmail(deps, ctx, queued);
  }

  const counts = await withTenant(deps.pools, ctx, (tx) => stepTextCounts(tx, ctx, step.id));
  return { status: counts.scheduled > 0 || counts.queued > 0 ? 'running' : 'done', result: batchResult(counts) };
};
