import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ConsentStatus } from '@roofline/shared';
import { companies, customers, messages, optOuts } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';
import { audit } from './audit.ts';
import { lockRecipient } from './messages.ts';

/*
 * Data access for texts that come in (spec 4.5, R24): the inbound message row, a STOP or START
 * sent by text and what it does to consent and the opt-out list, a message flagged for a person,
 * and the provider's delivery reports for texts that went out. Everything runs inside the
 * webhook's `withTenant` (role `system`, no user), and each query also names the company.
 */

/** What the timeline says when a customer opts out or back in by text. */
export const TEXTED_STOP = 'Texted STOP. Texting is turned off.';
export const TEXTED_START = 'Texted START. Updates are back on.';
export const POSSIBLE_OPT_OUT = 'Possible opt-out. Please check this message.';

/** A customer who has a number, as an inbound text needs them. */
export type PhoneCustomer = { id: string; archived: boolean; consent: ConsentStatus };

/**
 * Every customer of the company with this number among their phones, archived ones included:
 * the active ones first, then oldest first. Normally one active customer holds a number, but an
 * archived customer may share it, and so may customers written straight to the table (an import).
 */
export async function customersWithPhone(tx: Tx, ctx: TenantContext, e164: string): Promise<PhoneCustomer[]> {
  const rows = await tx
    .select({ id: customers.id, archivedAt: customers.archivedAt, consent: customers.smsConsentStatus })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), sql`${customers.phones} @> ${JSON.stringify([{ e164 }])}::jsonb`))
    .orderBy(sql`${customers.archivedAt} is not null`, asc(customers.createdAt), asc(customers.id));
  return rows.map((r) => ({ id: r.id, archived: r.archivedAt !== null, consent: r.consent }));
}

/**
 * Takes each customer's texting lock (`lockRecipient`, the one a send decides under), in id order
 * so that two callers locking overlapping customers cannot wait on each other. Held until the
 * caller's transaction ends.
 */
export async function lockRecipients(tx: Tx, ctx: TenantContext, customerIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(customerIds)].sort()) await lockRecipient(tx, ctx, id);
}

/** The company's name and its phone on file, for the replies. Null when the company cannot be seen. */
export async function companyContact(tx: Tx, ctx: TenantContext): Promise<{ name: string; phoneE164: string | null } | null> {
  const [row] = await tx
    .select({ name: companies.name, phoneE164: companies.phoneE164 })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return row ?? null;
}

export type InboundText = {
  /** The customer the text is filed under, or null when the number is no customer's. */
  customerId: string | null;
  body: string;
  /** Who sent it. */
  fromE164: string;
  /** The company's texting number it was sent to. */
  toE164: string;
  /** The provider's id for the text (Twilio's MessageSid). */
  providerSid: string;
};

/** Stores a text that came in: `direction in`, `status received`, channel sms. Returns its id. */
export async function insertInboundText(tx: Tx, ctx: TenantContext, text: InboundText, now: Date): Promise<string> {
  const [row] = await tx
    .insert(messages)
    .values({
      companyId: ctx.companyId,
      customerId: text.customerId,
      channel: 'sms',
      direction: 'in',
      body: text.body,
      status: 'received',
      fromE164: text.fromE164,
      toE164: text.toE164,
      providerMessageSid: text.providerSid,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: messages.id });
  return row!.id;
}

const CONSENT_FIELDS = {
  id: customers.id,
  smsConsentStatus: customers.smsConsentStatus,
  smsConsentSource: customers.smsConsentSource,
  smsConsentAt: customers.smsConsentAt,
  smsConsentByUserId: customers.smsConsentByUserId,
};

type ConsentState = { smsConsentStatus: ConsentStatus; smsConsentSource: string | null; smsConsentAt: Date | null; smsConsentByUserId: string | null };

/** The consent columns as plain JSON for the audit log. */
function consentSnapshot(row: ConsentState): Record<string, unknown> {
  return {
    smsConsentStatus: row.smsConsentStatus,
    smsConsentSource: row.smsConsentSource,
    smsConsentAt: row.smsConsentAt?.toISOString() ?? null,
    smsConsentByUserId: row.smsConsentByUserId,
  };
}

/** The customers' consent columns, locked for the rest of the transaction. */
function lockConsent(tx: Tx, ctx: TenantContext, customerIds: readonly string[]) {
  return tx
    .select(CONSENT_FIELDS)
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, [...customerIds])))
    .orderBy(asc(customers.id))
    .for('update');
}

/**
 * A STOP by text from `phoneE164`. The caller has taken the customers' texting locks
 * (`lockRecipients`) first, so this waits for any send deciding for them right now, and the next
 * send sees it.
 * - The number goes on the opt-out list with the customer's own words (`keyword`, normalized),
 *   replacing whatever row was there (an office opt-out is a weaker record than the customer's STOP).
 *   This happens even when the number is no customer's.
 * - Every customer given (all who have the number, archived ones too) becomes `revoked`, source
 *   `text`, now, by nobody; each gets a `customer.consent_revoked` audit row (no actor) and a
 *   "Texted STOP" line. A customer who was already revoked is recorded again: it is a new STOP.
 * Returns the ids of the customers it revoked.
 */
export async function revokeConsentByText(
  tx: Tx,
  ctx: TenantContext,
  stop: { phoneE164: string; keyword: string; customerIds: readonly string[]; messageId: string },
  now: Date,
): Promise<string[]> {
  await tx
    .insert(optOuts)
    .values({ companyId: ctx.companyId, phoneE164: stop.phoneE164, keyword: stop.keyword, at: now, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [optOuts.companyId, optOuts.phoneE164],
      set: { keyword: stop.keyword, at: now, updatedAt: now },
    });
  if (stop.customerIds.length === 0) return [];

  const before = await lockConsent(tx, ctx, stop.customerIds);
  const after = await tx
    .update(customers)
    .set({ smsConsentStatus: 'revoked', smsConsentSource: 'text', smsConsentAt: now, smsConsentByUserId: null, updatedAt: now })
    .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, before.map((c) => c.id))))
    .returning(CONSENT_FIELDS);
  const afterById = new Map(after.map((row) => [row.id, row]));

  for (const was of before) {
    await audit(tx, ctx, {
      action: 'customer.consent_revoked',
      targetType: 'customer',
      targetId: was.id,
      before: consentSnapshot(was),
      after: consentSnapshot(afterById.get(was.id)!),
      at: now,
    });
    await addActivity(tx, ctx, {
      subjectType: 'customer',
      subjectId: was.id,
      kind: 'customer.consent_changed',
      summary: TEXTED_STOP,
      data: { from: was.smsConsentStatus, to: 'revoked', via: 'text', keyword: stop.keyword, messageId: stop.messageId },
      at: now,
    });
  }
  return before.map((c) => c.id);
}

/**
 * A START by text from `phoneE164`, after the caller took the customers' texting locks.
 * - Every opt-out row for the number is deleted.
 * - Of the customers given (the active ones who have the number), each one that is `revoked`
 *   becomes `express`, source `text`, now, by nobody, with a `customer.consent_restored` audit row
 *   and a "Texted START" line. Any other consent is left as it is (a `written` consent is never
 *   lowered), and do-not-contact is never touched: a START does not clear it.
 * Returns the ids of the customers whose consent came back.
 */
export async function restoreConsentByText(
  tx: Tx,
  ctx: TenantContext,
  start: { phoneE164: string; customerIds: readonly string[]; messageId: string },
  now: Date,
): Promise<string[]> {
  await tx.delete(optOuts).where(and(eq(optOuts.companyId, ctx.companyId), eq(optOuts.phoneE164, start.phoneE164)));
  if (start.customerIds.length === 0) return [];

  const before = (await lockConsent(tx, ctx, start.customerIds)).filter((c) => c.smsConsentStatus === 'revoked');
  if (before.length === 0) return [];
  const after = await tx
    .update(customers)
    .set({ smsConsentStatus: 'express', smsConsentSource: 'text', smsConsentAt: now, smsConsentByUserId: null, updatedAt: now })
    .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, before.map((c) => c.id))))
    .returning(CONSENT_FIELDS);
  const afterById = new Map(after.map((row) => [row.id, row]));

  for (const was of before) {
    await audit(tx, ctx, {
      action: 'customer.consent_restored',
      targetType: 'customer',
      targetId: was.id,
      before: consentSnapshot(was),
      after: consentSnapshot(afterById.get(was.id)!),
      at: now,
    });
    await addActivity(tx, ctx, {
      subjectType: 'customer',
      subjectId: was.id,
      kind: 'customer.consent_changed',
      summary: TEXTED_START,
      data: { from: 'revoked', to: 'express', via: 'text', messageId: start.messageId },
      at: now,
    });
  }
  return before.map((c) => c.id);
}

/**
 * Puts "Possible opt-out. Please check this message." on each customer's timeline, pointing at the
 * message. Only a flag for a person: nobody's consent or opt-out changes.
 */
export async function flagPossibleOptOut(
  tx: Tx,
  ctx: TenantContext,
  customerIds: readonly string[],
  messageId: string,
  now: Date,
): Promise<void> {
  for (const id of customerIds) {
    await addActivity(tx, ctx, {
      subjectType: 'customer',
      subjectId: id,
      kind: 'message.possible_opt_out',
      summary: POSSIBLE_OPT_OUT,
      data: { messageId },
      at: now,
    });
  }
}

/** What the provider reported about a text that went out. */
export type DeliveryOutcome = { status: 'delivered' } | { status: 'failed'; reason: string };

/**
 * Applies a delivery report to the company's outbound text with this provider id. Only a `sent`
 * text moves, so a report never takes a text backwards (a late "failed" after "delivered" changes
 * nothing) and never touches one that is not out yet. A failure is final: not retryable, with the
 * reason. False when no sent text of the company has that id.
 */
export async function recordDeliveryOutcome(
  tx: Tx,
  ctx: TenantContext,
  providerSid: string,
  outcome: DeliveryOutcome,
  now: Date,
): Promise<boolean> {
  const set =
    outcome.status === 'delivered'
      ? { status: 'delivered' as const, updatedAt: now }
      : { status: 'failed' as const, blockRule: null, blockReason: outcome.reason, retryable: false, updatedAt: now };
  const rows = await tx
    .update(messages)
    .set(set)
    .where(
      and(
        eq(messages.companyId, ctx.companyId),
        eq(messages.providerMessageSid, providerSid),
        eq(messages.direction, 'out'),
        eq(messages.status, 'sent'),
      ),
    )
    .returning({ id: messages.id });
  return rows.length > 0;
}
