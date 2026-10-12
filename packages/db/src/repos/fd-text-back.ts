import { and, eq, gte, isNotNull, like } from 'drizzle-orm';
import { calls, companySettings, customers, messages } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';
import { customersWithPhone } from './inbound.ts';
import type { TextState } from './messages.ts';

/*
 * D1 Task 13: the rows behind the missed-call text-back. Every query names ctx.companyId. Used by
 * apps/api/src/front-desk/text-back.ts.
 */

/** The dedupe_key prefix of a text-back (one per call: `fd-textback:<call id>`). */
export const TEXT_BACK_PREFIX = 'fd-textback:';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether the company has missed-call text-back on; true with no settings row (the column default). */
export async function missedCallTextBackOn(tx: Tx, ctx: TenantContext): Promise<boolean> {
  const [row] = await tx
    .select({ on: companySettings.missedCallTextBack })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId));
  return row?.on ?? true;
}

/** Whether this number was texted back in the 24 hours before `now` (by a text-back message or a call that recorded one). */
export async function textedBackWithin24h(tx: Tx, ctx: TenantContext, toE164: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - DAY_MS);
  const [msg] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.companyId, ctx.companyId),
        eq(messages.direction, 'out'),
        eq(messages.toE164, toE164),
        like(messages.dedupeKey, `${TEXT_BACK_PREFIX}%`),
        gte(messages.createdAt, since),
      ),
    )
    .limit(1);
  if (msg) return true;
  const [call] = await tx
    .select({ id: calls.id })
    .from(calls)
    .where(
      and(
        eq(calls.companyId, ctx.companyId),
        eq(calls.fromE164, toE164),
        isNotNull(calls.textBackMessageId),
        gte(calls.startedAt, since),
      ),
    )
    .limit(1);
  return call !== undefined;
}

/**
 * A call is express texting consent, but only for a customer who has none yet: revoked, written,
 * attested, express and do-not-contact are never touched. Writes the timeline line too.
 */
export async function recordCallConsent(tx: Tx, ctx: TenantContext, customerId: string, now: Date): Promise<boolean> {
  const changed = await tx
    .update(customers)
    .set({ smsConsentStatus: 'express', smsConsentSource: 'call', smsConsentAt: now, updatedAt: now })
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId), eq(customers.smsConsentStatus, 'none')))
    .returning({ id: customers.id });
  if (changed.length === 0) return false;
  await addActivity(tx, ctx, {
    subjectType: 'customer',
    subjectId: customerId,
    kind: 'customer.consent_changed',
    summary: 'Texting consent changed to Express (the customer called)',
    data: { from: 'none', to: 'express', source: 'call' },
    at: now,
  });
  return true;
}

/**
 * The company's customer for this number: the one non-archived customer who has it; a new minimal
 * customer when nobody has it; null when several do (shared phones are never guessed) or only an
 * archived customer has it.
 */
export async function findOrCreateCallerCustomer(tx: Tx, ctx: TenantContext, e164: string, now: Date = new Date()): Promise<string | null> {
  const found = await customersWithPhone(tx, ctx, e164);
  const active = found.filter((c) => !c.archived);
  if (active.length === 1) return active[0]!.id;
  if (found.length > 0) return null;
  const [row] = await tx
    .insert(customers)
    .values({
      companyId: ctx.companyId,
      displayName: e164,
      phones: [{ e164, primary: true }],
      source: 'call',
      createdByUserId: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: customers.id });
  return row?.id ?? null;
}

/** Remembers on the call which text went back to the caller. */
export async function setCallTextBackMessage(tx: Tx, ctx: TenantContext, callSid: string, messageId: string): Promise<void> {
  await tx
    .update(calls)
    .set({ textBackMessageId: messageId })
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.callSid, callSid)));
}

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

/** Records the text-back (informational, no conversation) once per dedupe key; null when the key already has one. */
export async function insertTextBackMessage(
  tx: Tx,
  ctx: TenantContext,
  i: { conversationId: string | null; customerId: string; body: string; toE164: string | null; dedupeKey: string },
  state: TextState,
  now: Date,
): Promise<string | null> {
  const [existing] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.dedupeKey, i.dedupeKey), eq(messages.direction, 'out')))
    .limit(1);
  if (existing) return null;
  const [row] = await tx
    .insert(messages)
    .values({
      companyId: ctx.companyId,
      customerId: i.customerId,
      conversationId: i.conversationId,
      channel: 'sms',
      direction: 'out',
      purpose: 'informational',
      body: i.body,
      toE164: i.toE164,
      dedupeKey: i.dedupeKey,
      ...stateColumns(state),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: messages.id });
  return row?.id ?? null;
}
