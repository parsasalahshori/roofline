import { and, asc, count, desc, eq, inArray, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { CampaignStatus, CompanyStatus, ConsentStatus, GateRule, MessagePurpose, MessageStatus } from '@roofline/shared';
import {
  companies,
  companySettings,
  customers,
  type CustomerPhone,
  messages,
  optOuts,
  properties,
  textingRegistrations,
  usageEvents,
} from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { applyEarlyDeliveryReports } from './delivery.ts';

/*
 * Data access for outbound texts (spec 4.5): what the send gate needs to know about a company, a
 * customer and their texting history, and the message rows a batch step and the dispatcher write
 * as each text moves through `scheduled` / `queued` / `sent` / `failed` / `blocked`. Everything here
 * runs inside `withTenant`, and each query also names the company. Which sentence a row carries,
 * and when a text may go, is the API's (apps/api/src/messaging) and the gate's business.
 */

export type MessageRow = typeof messages.$inferSelect;

/** The weekly-cap default when a company has no settings row yet (the column default). */
const DEFAULT_MARKETING_CAP = 2;

/**
 * Texts that went out, or are going out right now (`queued`: handed to the provider by a run that
 * has not recorded the answer yet). History counts the second kind too, so two runs texting one
 * customer at the same moment cannot both slip under the cap or past the dedupe key.
 */
const OUT_OR_GOING: readonly MessageStatus[] = ['sent', 'delivered', 'queued'];

// ---------------------------------------------------------------------------------------------
// What the gate needs to know

/** The company as the send gate sees it. */
export type TextingCompanyFacts = {
  name: string;
  timezone: string;
  status: CompanyStatus;
  /** `none` when the company has no registration row. */
  campaignStatus: CampaignStatus;
  marketingCapPer7d: number;
};

/**
 * The context's company: its name, zone and billing status, its texting registration (the
 * `campaign_status` column only: app_tenant may read just some of that table's columns) and its
 * weekly cap. Null when the company cannot be seen.
 */
export async function textingCompanyFacts(tx: Tx, ctx: TenantContext): Promise<TextingCompanyFacts | null> {
  const [row] = await tx
    .select({
      name: companies.name,
      timezone: companies.timezone,
      status: companies.status,
      campaignStatus: textingRegistrations.campaignStatus,
      marketingCapPer7d: companySettings.marketingCapPer7d,
    })
    .from(companies)
    .leftJoin(textingRegistrations, eq(textingRegistrations.companyId, companies.id))
    .leftJoin(companySettings, eq(companySettings.companyId, companies.id))
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  if (!row) return null;
  return {
    name: row.name,
    timezone: row.timezone,
    status: row.status,
    campaignStatus: row.campaignStatus ?? 'none',
    marketingCapPer7d: row.marketingCapPer7d ?? DEFAULT_MARKETING_CAP,
  };
}

/** A customer as the send gate sees them, with the home their local time comes from. */
export type TextingRecipientFacts = {
  firstName: string | null;
  phones: CustomerPhone[];
  consent: ConsentStatus;
  doNotContact: boolean;
  /** The customer was archived: they are no longer someone the company texts. */
  archived: boolean;
  /**
   * From the customer's most recently updated property that is still in use (not archived); null
   * when they have none (or it has none). An archived home is somewhere they no longer live, and
   * archiving it touches its `updated_at`, so it is never the one used.
   */
  timezone: string | null;
  state: string | null;
};

/** One customer of the company, with their latest home's zone and state. Null when not in this company. */
export async function textingRecipientFacts(tx: Tx, ctx: TenantContext, customerId: string): Promise<TextingRecipientFacts | null> {
  const [customer] = await tx
    .select({
      firstName: customers.firstName,
      phones: customers.phones,
      consent: customers.smsConsentStatus,
      doNotContact: customers.doNotContact,
      archivedAt: customers.archivedAt,
    })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId)))
    .limit(1);
  if (!customer) return null;
  const [home] = await tx
    .select({ timezone: properties.timezone, state: properties.state })
    .from(properties)
    .where(and(eq(properties.companyId, ctx.companyId), eq(properties.customerId, customerId), isNull(properties.archivedAt)))
    .orderBy(desc(properties.updatedAt), desc(properties.createdAt), desc(properties.id))
    .limit(1);
  return {
    firstName: customer.firstName,
    phones: Array.isArray(customer.phones) ? customer.phones : [],
    consent: customer.consent,
    doNotContact: customer.doNotContact,
    archived: customer.archivedAt !== null,
    timezone: home?.timezone ?? null,
    state: home?.state ?? null,
  };
}

/** Whether the number is on the company's opt-out list (a STOP, or put there by the office). */
export async function isOptedOut(tx: Tx, ctx: TenantContext, phoneE164: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: optOuts.id })
    .from(optOuts)
    .where(and(eq(optOuts.companyId, ctx.companyId), eq(optOuts.phoneE164, phoneE164)))
    .limit(1);
  return row !== undefined;
}

export type TextHistory = {
  /** An outbound text with this dedupe key went out (or is going out), from any step. False when there is no key. */
  dedupeAlreadySent: boolean;
  /** When this customer's outbound marketing texts went out since `since` (a queued one: when it was queued). */
  marketingSentAt: Date[];
};

/** What the gate's dedupe and frequency rules look at, for one customer. */
export async function textHistory(
  tx: Tx,
  ctx: TenantContext,
  q: { customerId: string; dedupeKey: string | null; since: Date },
): Promise<TextHistory> {
  let dedupeAlreadySent = false;
  if (q.dedupeKey !== null) {
    const [hit] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.companyId, ctx.companyId),
          eq(messages.direction, 'out'),
          eq(messages.dedupeKey, q.dedupeKey),
          inArray(messages.status, [...OUT_OR_GOING]),
        ),
      )
      .limit(1);
    dedupeAlreadySent = hit !== undefined;
  }
  const rows = await tx
    .select({ sentAt: messages.sentAt, updatedAt: messages.updatedAt })
    .from(messages)
    .where(
      and(
        eq(messages.companyId, ctx.companyId),
        eq(messages.customerId, q.customerId),
        eq(messages.direction, 'out'),
        eq(messages.purpose, 'marketing'),
        inArray(messages.status, [...OUT_OR_GOING]),
        sql`coalesce(${messages.sentAt}, ${messages.updatedAt}) >= ${q.since}`,
      ),
    );
  return { dedupeAlreadySent, marketingSentAt: rows.map((r) => r.sentAt ?? r.updatedAt) };
}

/**
 * Takes a transaction-scoped lock on texting this customer, held until the caller's transaction
 * ends. Deciding a text and recording it as on its way happen under it, so two runs (two batches,
 * or a batch and the dispatcher) deciding for one customer at once take turns, and the second sees
 * the first's text in the history.
 */
export async function lockRecipient(tx: Tx, ctx: TenantContext, customerId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${ctx.companyId}::text || ':texting:' || ${customerId}::text, 0))`,
  );
}

// ---------------------------------------------------------------------------------------------
// The rows a batch step writes

/** A step's message row for one customer, as the batch needs it to decide what to do. */
export type StepTextState = { id: string; status: MessageStatus; retryable: boolean; updatedAt: Date };

/** The step's message row for this customer, or null when the step has not written one yet. */
export async function getStepText(tx: Tx, ctx: TenantContext, stepId: string, customerId: string): Promise<StepTextState | null> {
  const [row] = await tx
    .select({ id: messages.id, status: messages.status, retryable: messages.retryable, updatedAt: messages.updatedAt })
    .from(messages)
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.stepId, stepId), eq(messages.customerId, customerId)))
    .limit(1);
  return row ?? null;
}

/** One outbound text: who it is for, what it says (already rendered) and where it goes. */
export type OutboundText = {
  customerId: string;
  purpose: MessagePurpose;
  body: string;
  toE164: string | null;
  dedupeKey: string | null;
};

/** What the gate (or the attempt to ask it) made of a text. */
export type TextState =
  | { status: 'queued' }
  | { status: 'scheduled'; scheduledFor: Date; blockRule: GateRule; blockReason: string }
  | { status: 'blocked'; blockRule: GateRule; blockReason: string }
  | { status: 'failed'; blockReason: string; retryable: boolean };

/** The columns a state sets. A queued text keeps its `scheduled_for` (when it was due), the others say why. */
function stateColumns(state: TextState) {
  switch (state.status) {
    case 'queued':
      return { status: state.status, blockRule: null, blockReason: null, retryable: false };
    case 'scheduled':
      return { status: state.status, scheduledFor: state.scheduledFor, blockRule: state.blockRule, blockReason: state.blockReason, retryable: false };
    case 'blocked':
      return { status: state.status, blockRule: state.blockRule, blockReason: state.blockReason, retryable: false };
    case 'failed':
      return { status: state.status, blockRule: null, blockReason: state.blockReason, retryable: state.retryable };
  }
}

/**
 * Records a step's text for one customer: `INSERT ... ON CONFLICT (step_id, customer_id) DO NOTHING`.
 * Returns the new row's id, or null when the step already has a row for that customer (another run
 * of the step got there first, and owns it).
 */
export async function insertStepText(
  tx: Tx,
  ctx: TenantContext,
  stepId: string,
  text: OutboundText,
  state: TextState,
  now: Date,
): Promise<string | null> {
  const [row] = await tx
    .insert(messages)
    .values({
      companyId: ctx.companyId,
      customerId: text.customerId,
      stepId,
      channel: 'sms',
      direction: 'out',
      purpose: text.purpose,
      body: text.body,
      toE164: text.toE164,
      dedupeKey: text.dedupeKey,
      ...stateColumns(state),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [messages.stepId, messages.customerId], where: sql`${messages.stepId} is not null` })
    .returning({ id: messages.id });
  return row?.id ?? null;
}

/**
 * Writes a new attempt over a text that failed in a way that is safe to retry (`failed` and
 * `retryable`), with the body and number as they are now. False when the row is no longer in that
 * state (another run of the step claimed it first).
 */
export async function rewriteRetryableText(
  tx: Tx,
  ctx: TenantContext,
  messageId: string,
  text: OutboundText,
  state: TextState,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(messages)
    .set({ body: text.body, toE164: text.toE164, dedupeKey: text.dedupeKey, ...stateColumns(state), updatedAt: now })
    .where(
      and(
        eq(messages.companyId, ctx.companyId),
        eq(messages.id, messageId),
        eq(messages.status, 'failed'),
        eq(messages.retryable, true),
      ),
    )
    .returning({ id: messages.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Scheduled texts (the dispatcher)

/**
 * The next outbound text that is due (`scheduled`, `scheduled_for <= now`), oldest first, locked
 * `FOR UPDATE SKIP LOCKED` until the caller's transaction ends: a row another dispatcher holds is
 * skipped, never waited for, so two dispatchers never take the same text. `skip` leaves out rows
 * this pass already tried. Null when nothing (else) is due.
 */
export async function lockNextDueText(tx: Tx, ctx: TenantContext, now: Date, skip: readonly string[] = []): Promise<MessageRow | null> {
  const [row] = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.companyId, ctx.companyId),
        eq(messages.status, 'scheduled'),
        eq(messages.direction, 'out'),
        lte(messages.scheduledFor, now),
        skip.length > 0 ? notInArray(messages.id, [...skip]) : undefined,
      ),
    )
    .orderBy(asc(messages.scheduledFor), asc(messages.id))
    .limit(1)
    .for('update', { skipLocked: true });
  return row ?? null;
}

/** Moves a scheduled text the caller has locked to what the gate now says, with the body and number as they are now. */
export async function updateScheduledText(
  tx: Tx,
  ctx: TenantContext,
  messageId: string,
  text: Pick<OutboundText, 'body' | 'toE164'>,
  state: TextState,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(messages)
    .set({ body: text.body, toE164: text.toE164, ...stateColumns(state), updatedAt: now })
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.id, messageId), eq(messages.status, 'scheduled')))
    .returning({ id: messages.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------------
// After the provider answered

/**
 * The provider took the text: `sent`, with its id, segments and time, no reason and not retryable.
 * From `queued` (the usual case) or from `failed` (a slow send that was marked unconfirmed in the
 * meantime: it did go out, so the row says so). False when the row is in neither. When it moves,
 * the early delivery reports for its id that arrived before the save are applied in the same
 * transaction (`applyEarlyDeliveryReports`).
 */
export async function markTextSent(
  tx: Tx,
  ctx: TenantContext,
  messageId: string,
  sent: { providerSid: string; segments: number; sentAt: Date },
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(messages)
    .set({
      status: 'sent',
      providerMessageSid: sent.providerSid,
      segments: sent.segments,
      sentAt: sent.sentAt,
      blockRule: null,
      blockReason: null,
      retryable: false,
      updatedAt: now,
    })
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.id, messageId), inArray(messages.status, ['queued', 'failed'])))
    .returning({ id: messages.id });
  if (rows.length === 0) return false;
  await applyEarlyDeliveryReports(tx, ctx, messageId, sent.providerSid, now);
  return true;
}

/**
 * The send did not end in a `sent`: `failed`, with the reason, and `retryable` only when the
 * provider refused it (it never went out). When the outcome is unknown (a timeout), the text may
 * have gone out, so it is not retryable and is never sent again. Only from `queued`.
 */
export async function markTextFailed(
  tx: Tx,
  ctx: TenantContext,
  messageId: string,
  failure: { reason: string; retryable: boolean },
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(messages)
    .set({ status: 'failed', retryable: failure.retryable, blockRule: null, blockReason: failure.reason, updatedAt: now })
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.id, messageId), eq(messages.status, 'queued')))
    .returning({ id: messages.id });
  return rows.length > 0;
}

/**
 * Texts that have been `queued` since `before` or earlier (`updated_at`, which a text's move to
 * `queued` sets) were handed to the provider by a run that never recorded the answer. Whether they
 * went out is unknown, so they become `failed`, not retryable, with the reason: never sent again.
 * Narrowed to one row (`messageId`) or to one step's rows (`stepId`). Returns the ids it marked.
 */
export async function markUnconfirmedTexts(
  tx: Tx,
  ctx: TenantContext,
  which: { messageId: string } | { stepId: string },
  before: Date,
  reason: string,
  now: Date,
): Promise<string[]> {
  const rows = await tx
    .update(messages)
    .set({ status: 'failed', retryable: false, blockRule: null, blockReason: reason, updatedAt: now })
    .where(
      and(
        eq(messages.companyId, ctx.companyId),
        'messageId' in which ? eq(messages.id, which.messageId) : eq(messages.stepId, which.stepId),
        eq(messages.status, 'queued'),
        lte(messages.updatedAt, before),
      ),
    )
    .returning({ id: messages.id });
  return rows.map((r) => r.id);
}

/** Records the segments a sent text billed (`usage_events`, kind `sms_segment`), tied to the message. */
export async function recordSmsUsage(tx: Tx, ctx: TenantContext, messageId: string, segments: number, at: Date): Promise<void> {
  await tx.insert(usageEvents).values({
    companyId: ctx.companyId,
    kind: 'sms_segment',
    quantity: segments,
    refType: 'message',
    refId: messageId,
    at,
    createdAt: at,
    updatedAt: at,
  });
}

// ---------------------------------------------------------------------------------------------
// A step's tally

export type StepTextCounts = {
  /** `sent` or `delivered`. */
  sent: number;
  scheduled: number;
  /** On their way under some run right now. */
  queued: number;
  failed: number;
  /** Of `failed`: the ones the provider refused, which a retry would send. */
  retryableFailed: number;
  blocked: Record<string, number>;
};

/** How the step's texts stand, counted from its message rows. */
export async function stepTextCounts(tx: Tx, ctx: TenantContext, stepId: string): Promise<StepTextCounts> {
  const rows = await tx
    .select({ status: messages.status, blockRule: messages.blockRule, retryable: messages.retryable, n: count() })
    .from(messages)
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.stepId, stepId)))
    .groupBy(messages.status, messages.blockRule, messages.retryable);
  const counts: StepTextCounts = { sent: 0, scheduled: 0, queued: 0, failed: 0, retryableFailed: 0, blocked: {} };
  for (const { status, blockRule, retryable, n } of rows) {
    if (status === 'sent' || status === 'delivered') counts.sent += n;
    else if (status === 'scheduled') counts.scheduled += n;
    else if (status === 'queued') counts.queued += n;
    else if (status === 'failed') {
      counts.failed += n;
      if (retryable) counts.retryableFailed += n;
    } else if (status === 'blocked') {
      const rule = blockRule ?? 'unknown';
      counts.blocked[rule] = (counts.blocked[rule] ?? 0) + n;
    }
  }
  return counts;
}
