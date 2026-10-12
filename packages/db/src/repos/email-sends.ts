import { and, asc, desc, eq, inArray, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { CompanyStatus } from '@roofline/shared';
import { agentTaskSteps, companies, companyStorms, customers, messages, properties, storms } from '../schema/index.ts';
import { type MessageRow, stateColumns, type TextState } from './messages.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/* Data access for storm emails: the facts the email gate reads and the message rows (channel 'email') a batch and the dispatcher write. */

const OUT_OR_GOING = ['sent', 'delivered', 'queued'] as const;

export type EmailCompanyFacts = {
  name: string;
  timezone: string;
  status: CompanyStatus;
  /** companies.email: the reply-to address; null when blank. */
  replyTo: string | null;
  /** One line "street, city, ST zip" from the company address columns; null when the street is blank. */
  address: string | null;
};
export type EmailRecipientFacts = {
  firstName: string | null;
  /** First non-blank entry of customers.emails, trimmed; null when none. */
  email: string | null;
  doNotContact: boolean;
  archived: boolean;
  /** Zone of the customer's newest non-archived property; null when none. */
  timezone: string | null;
};
export type EmailHistory = { dedupeAlreadySent: boolean; sentLast7Days: number };
export type OutboundEmail = { customerId: string; toEmail: string; subject: string; body: string; dedupeKey: string | null };

export async function emailCompanyFacts(tx: Tx, ctx: TenantContext): Promise<EmailCompanyFacts | null> {
  const [row] = await tx
    .select({
      name: companies.name,
      timezone: companies.timezone,
      status: companies.status,
      email: companies.email,
      street: companies.addressStreet,
      city: companies.addressCity,
      state: companies.addressState,
      zip: companies.addressZip,
    })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  if (!row) return null;
  const street = row.street?.trim() ?? '';
  const stateZip = [row.state, row.zip].map((p) => p?.trim() ?? '').filter((p) => p !== '').join(' ');
  const address = street === '' ? null : [street, row.city?.trim() ?? '', stateZip].filter((p) => p !== '').join(', ');
  const replyTo = row.email?.trim() ?? '';
  return { name: row.name, timezone: row.timezone, status: row.status, replyTo: replyTo === '' ? null : replyTo, address };
}
/** The storm's convective day ('YYYY-MM-DD') for a company_storms id, or null. */
export async function stormConvectiveDay(tx: Tx, ctx: TenantContext, companyStormId: string): Promise<string | null> {
  const [row] = await tx
    .select({ day: storms.convectiveDay })
    .from(companyStorms)
    .innerJoin(storms, eq(storms.id, companyStorms.stormId))
    .where(and(eq(companyStorms.companyId, ctx.companyId), eq(companyStorms.id, companyStormId)))
    .limit(1);
  return row?.day ?? null;
}
/** payload.companyStormId of a step, or null. */
export async function emailStepStormId(tx: Tx, ctx: TenantContext, stepId: string): Promise<string | null> {
  const [row] = await tx
    .select({ payload: agentTaskSteps.payload })
    .from(agentTaskSteps)
    .where(and(eq(agentTaskSteps.companyId, ctx.companyId), eq(agentTaskSteps.id, stepId)))
    .limit(1);
  const id = row?.payload?.companyStormId;
  return typeof id === 'string' ? id : null;
}
export async function emailRecipientFacts(tx: Tx, ctx: TenantContext, customerId: string): Promise<EmailRecipientFacts | null> {
  const [customer] = await tx
    .select({
      firstName: customers.firstName,
      emails: customers.emails,
      doNotContact: customers.doNotContact,
      archivedAt: customers.archivedAt,
    })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId)))
    .limit(1);
  if (!customer) return null;
  const [home] = await tx
    .select({ timezone: properties.timezone })
    .from(properties)
    .where(and(eq(properties.companyId, ctx.companyId), eq(properties.customerId, customerId), isNull(properties.archivedAt)))
    .orderBy(desc(properties.updatedAt), desc(properties.createdAt), desc(properties.id))
    .limit(1);
  const list: unknown[] = Array.isArray(customer.emails) ? customer.emails : [];
  const first = list.find((e): e is string => typeof e === 'string' && e.trim() !== '');
  return {
    firstName: customer.firstName,
    email: first === undefined ? null : first.trim(),
    doNotContact: customer.doNotContact,
    archived: customer.archivedAt !== null,
    timezone: home?.timezone ?? null,
  };
}
export async function emailHistory(
  tx: Tx,
  ctx: TenantContext,
  q: { email: string; dedupeKey: string | null; since: Date },
): Promise<EmailHistory> {
  const base = [
    eq(messages.companyId, ctx.companyId),
    eq(messages.channel, 'email'),
    eq(messages.direction, 'out'),
    inArray(messages.status, [...OUT_OR_GOING]),
  ];
  let dedupeAlreadySent = false;
  if (q.dedupeKey !== null) {
    const [hit] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(...base, eq(messages.dedupeKey, q.dedupeKey)))
      .limit(1);
    dedupeAlreadySent = hit !== undefined;
  }
  const rows = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        ...base,
        eq(messages.purpose, 'marketing'),
        eq(messages.toEmail, q.email),
        sql`coalesce(${messages.sentAt}, ${messages.updatedAt}) >= ${q.since}`,
      ),
    );
  return { dedupeAlreadySent, sentLast7Days: rows.length };
}
export async function insertStepEmail(
  tx: Tx,
  ctx: TenantContext,
  stepId: string,
  mail: OutboundEmail,
  state: TextState,
  now: Date,
): Promise<string | null> {
  const [row] = await tx
    .insert(messages)
    .values({
      companyId: ctx.companyId,
      customerId: mail.customerId,
      stepId,
      channel: 'email',
      direction: 'out',
      purpose: 'marketing',
      body: mail.body,
      subject: mail.subject,
      toEmail: mail.toEmail,
      toE164: null,
      dedupeKey: mail.dedupeKey,
      ...stateColumns(state),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [messages.stepId, messages.customerId], where: sql`${messages.stepId} is not null` })
    .returning({ id: messages.id });
  return row?.id ?? null;
}
export async function rewriteRetryableEmail(
  tx: Tx,
  ctx: TenantContext,
  messageId: string,
  mail: OutboundEmail,
  state: TextState,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(messages)
    .set({
      body: mail.body,
      subject: mail.subject,
      toEmail: mail.toEmail,
      dedupeKey: mail.dedupeKey,
      ...stateColumns(state),
      updatedAt: now,
    })
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
export async function lockNextDueEmail(tx: Tx, ctx: TenantContext, now: Date, skip: readonly string[] = []): Promise<MessageRow | null> {
  const [row] = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.companyId, ctx.companyId),
        eq(messages.status, 'scheduled'),
        eq(messages.direction, 'out'),
        eq(messages.channel, 'email'),
        lte(messages.scheduledFor, now),
        skip.length > 0 ? notInArray(messages.id, [...skip]) : undefined,
      ),
    )
    .orderBy(asc(messages.scheduledFor), asc(messages.id))
    .limit(1)
    .for('update', { skipLocked: true });
  return row ?? null;
}
export async function updateScheduledEmail(
  tx: Tx,
  ctx: TenantContext,
  messageId: string,
  mail: Pick<OutboundEmail, 'toEmail' | 'subject' | 'body'>,
  state: TextState,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(messages)
    .set({ body: mail.body, subject: mail.subject, toEmail: mail.toEmail, ...stateColumns(state), updatedAt: now })
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.id, messageId), eq(messages.status, 'scheduled')))
    .returning({ id: messages.id });
  return rows.length > 0;
}
export async function markEmailSent(
  tx: Tx,
  ctx: TenantContext,
  messageId: string,
  sent: { providerMessageId: string; sentAt: Date },
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(messages)
    .set({
      status: 'sent',
      providerMessageSid: sent.providerMessageId,
      sentAt: sent.sentAt,
      blockRule: null,
      blockReason: null,
      retryable: false,
      updatedAt: now,
    })
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.id, messageId), inArray(messages.status, ['queued', 'failed'])))
    .returning({ id: messages.id });
  return rows.length > 0;
}
