import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { DEFAULT_WORK_HOURS } from '@roofline/shared';
import type { ConversationChannel, ConversationOutcome, HandledBy, IdentityLevel, WorkHours } from '@roofline/shared';
import { companies, companyPhoneNumbers, companySettings, conversations } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

export type NewConversation = {
  channel: ConversationChannel;
  phoneE164: string;
  companyNumberE164: string;
  customerId?: string | null;
  identity?: IdentityLevel;
  /** The app clock's now (deps.clock), so durations measured from it agree with the code's clock. */
  now?: Date;
};

/** What the assistant may say about the company: profile plus the Front Desk settings. */
export type CompanyFacts = {
  name: string;
  timezone: string;
  city: string | null;
  state: string | null;
  workHours: WorkHours;
  facts: string;
  canMove: boolean;
  canCancel: boolean;
  /** The company's active number (first provisioned), else its profile phone, else null. */
  companyNumberE164: string | null;
};

/** Opens a conversation (a call or an SMS thread) for the context's company. */
export async function insertConversation(tx: Tx, ctx: TenantContext, c: NewConversation): Promise<{ id: string }> {
  const [row] = await tx
    .insert(conversations)
    .values({
      companyId: ctx.companyId,
      channel: c.channel,
      phoneE164: c.phoneE164,
      companyNumberE164: c.companyNumberE164,
      customerId: c.customerId ?? null,
      identity: c.identity ?? 'unknown',
      ...(c.now !== undefined && { createdAt: c.now, updatedAt: c.now, lastMessageAt: c.now }),
    })
    .returning({ id: conversations.id });
  return { id: row!.id };
}

/** The company's name, time zone, hours and the facts the owner allows the assistant to state. */
export async function loadCompanyFacts(tx: Tx, ctx: TenantContext): Promise<CompanyFacts> {
  const [company] = await tx
    .select({
      name: companies.name,
      timezone: companies.timezone,
      city: companies.addressCity,
      state: companies.addressState,
      phoneE164: companies.phoneE164,
    })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  if (!company) throw new Error('Company not found');
  const [settings] = await tx
    .select({
      workHours: companySettings.workHours,
      facts: companySettings.frontDeskFacts,
      canMove: companySettings.frontDeskCanMove,
      canCancel: companySettings.frontDeskCanCancel,
    })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId));
  const [number] = await tx
    .select({ e164: companyPhoneNumbers.e164 })
    .from(companyPhoneNumbers)
    .where(and(eq(companyPhoneNumbers.companyId, ctx.companyId), eq(companyPhoneNumbers.status, 'active')))
    .orderBy(asc(companyPhoneNumbers.createdAt))
    .limit(1);
  return {
    name: company.name,
    timezone: company.timezone,
    city: company.city,
    state: company.state,
    workHours: settings ? (settings.workHours as WorkHours) : DEFAULT_WORK_HOURS,
    facts: settings?.facts ?? '',
    canMove: settings?.canMove ?? true,
    canCancel: settings?.canCancel ?? true,
    companyNumberE164: number?.e164 ?? company.phoneE164 ?? null,
  };
}

/** Sets only the fields given. */
export async function updateConversation(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  patch: {
    identity?: IdentityLevel;
    customerId?: string | null;
    handledBy?: HandledBy;
    status?: 'active' | 'ended';
    outcome?: ConversationOutcome;
    summary?: string;
    lastMessageAt?: Date;
    /** Raises the unread count to at least this number (never lowers it). */
    unreadAtLeast?: number;
  },
): Promise<void> {
  const set: Partial<typeof conversations.$inferInsert> = {};
  if (patch.identity !== undefined) set.identity = patch.identity;
  if (patch.customerId !== undefined) set.customerId = patch.customerId;
  if (patch.handledBy !== undefined) set.handledBy = patch.handledBy;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.outcome !== undefined) set.outcome = patch.outcome;
  if (patch.summary !== undefined) set.summary = patch.summary;
  if (patch.lastMessageAt !== undefined) set.lastMessageAt = patch.lastMessageAt;
  if (patch.unreadAtLeast !== undefined) set.unreadCount = sql`greatest(${conversations.unreadCount}, ${patch.unreadAtLeast})` as unknown as number;
  if (Object.keys(set).length === 0) return;
  set.updatedAt = sql`now()` as unknown as Date;
  await tx
    .update(conversations)
    .set(set)
    .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.id, id)));
}

/** One conversation of the context's company, or null. */
export async function getConversation(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<typeof conversations.$inferSelect | null> {
  const [row] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.id, id)));
  return row ?? null;
}

/** Ids of this company's active SMS conversations whose last message is older than `before`, oldest first. */
export async function listIdleSmsConversationIds(tx: Tx, ctx: TenantContext, before: Date, limit: number): Promise<string[]> {
  const rows = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.companyId, ctx.companyId),
        eq(conversations.channel, 'sms'),
        eq(conversations.status, 'active'),
        lt(conversations.lastMessageAt, before),
      ),
    )
    .orderBy(asc(conversations.lastMessageAt), asc(conversations.id))
    .limit(limit);
  return rows.map((r) => r.id);
}
