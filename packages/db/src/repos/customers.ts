import { and, asc, count, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { ConsentStatus } from '@roofline/shared';
import { customers, type CustomerPhone, optOuts } from '../schema/index.ts';
import { ForbiddenError } from '../errors.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';
import { audit } from './audit.ts';
import { clampPage } from './paging.ts';
import { customerScope } from './scope.ts';
import { customerMatch } from './search.ts';

export type CustomerRow = typeof customers.$inferSelect;

/** What a person sees in the timeline for each consent status. */
export const CONSENT_LABELS: Record<ConsentStatus, string> = {
  none: 'not asked',
  express: 'OK for updates',
  attested: 'confirmed on import',
  written: 'OK for offers',
  revoked: 'said no',
};

/** The request-scoped extras every write takes: the app clock's time, and the caller's address for the audit row. */
export type WriteOptions = { now: Date; ip?: string | null };

/**
 * A new customer. The caller (the API route) has already checked and normalized the values:
 * `phones` hold E.164 numbers with no repeats and exactly one primary when there are any.
 */
export type CustomerInput = {
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  phones?: CustomerPhone[];
  emails?: string[];
  tags?: string[];
  doNotContact?: boolean;
  /** Anything but 'none' is recorded as a manual consent by `ctx.userId`, now. */
  smsConsentStatus?: ConsentStatus;
  /** Kept in the consent evidence when the status is 'written'. */
  consentNote?: string;
};

/** Changes to a customer. A field left out (undefined) is not touched; null clears the optional ones. */
export type CustomerPatch = {
  displayName?: string;
  firstName?: string | null;
  lastName?: string | null;
  /** The whole new list (see `CustomerInput`). */
  phones?: CustomerPhone[];
  emails?: string[];
  tags?: string[];
  doNotContact?: boolean;
  smsConsentStatus?: ConsentStatus;
  /** Used only when this patch moves the status to 'written'. */
  consentNote?: string;
};

/**
 * Another active customer of the company already has this number. `index` is the position of the
 * number in the list that was being saved (the API reports it as `phones.<index>.number`).
 */
export class DuplicatePhoneError extends Error {
  readonly index: number;

  constructor(index: number) {
    super('Another customer in this company already has that phone number.');
    this.name = 'DuplicatePhoneError';
    this.index = index;
  }
}

// ---------------------------------------------------------------------------------------------
// Phone numbers

/**
 * Throws `DuplicatePhoneError` for the first of `phones` (in the order given) that another
 * non-archived customer of the company already has. `exceptId` is the customer being saved.
 *
 * The check and the write that follows it must not interleave with another request doing the same,
 * or two creates with one number would both pass. So each number takes a transaction-scoped
 * advisory lock first, in sorted order (two requests with overlapping numbers cannot wait on each
 * other in opposite orders), and the lock is held until the caller's transaction ends. The check
 * itself then runs after the lock, so it sees whatever the previous holder committed: this relies
 * on the default READ COMMITTED isolation that `withTenant` uses.
 *
 * This looks at every customer of the company, not only the ones the caller may see: a rep cannot
 * save a number that another rep's customer holds.
 */
/**
 * Takes the transaction-scoped advisory lock for one of the company's phone numbers, held until the
 * caller's transaction ends. Every check-then-write on a customer's number takes it (customer saves
 * here, the Front Desk caller customer in fd-text-back.ts), so they take turns.
 */
export async function lockCustomerPhone(tx: Tx, ctx: TenantContext, e164: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.companyId}::text || ':' || ${e164}::text, 0))`);
}

async function assertPhonesFree(
  tx: Tx,
  ctx: TenantContext,
  phones: readonly { e164: string; index: number }[],
  exceptId: string | null,
): Promise<void> {
  if (phones.length === 0) return;
  for (const e164 of [...new Set(phones.map((p) => p.e164))].sort()) await lockCustomerPhone(tx, ctx, e164);
  for (const { e164, index } of phones) {
    const [taken] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.companyId, ctx.companyId),
          isNull(customers.archivedAt),
          exceptId === null ? undefined : ne(customers.id, exceptId),
          sql`${customers.phones} @> ${JSON.stringify([{ e164 }])}::jsonb`,
        ),
      )
      .limit(1);
    if (taken) throw new DuplicatePhoneError(index);
  }
}

/**
 * Puts each number on the company's opt-out list (keyword 'manual'). A number already on the list
 * keeps the row it has: a STOP the customer sent themselves is the better record of the opt-out
 * than a manual one written later, and the texting rules only ask whether a row exists.
 * Rows are written in sorted order in one statement, so concurrent calls cannot deadlock.
 */
export async function ensureOptOuts(tx: Tx, ctx: TenantContext, phones: readonly string[], now: Date): Promise<void> {
  const numbers = [...new Set(phones)].sort();
  if (numbers.length === 0) return;
  await tx
    .insert(optOuts)
    .values(
      numbers.map((phoneE164) => ({
        companyId: ctx.companyId,
        phoneE164,
        keyword: 'manual',
        at: now,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing({ target: [optOuts.companyId, optOuts.phoneE164] });
}

/**
 * Consent and do-not-contact belong to the owner and the office (R16). The route refuses a rep who
 * sends any of these before it looks at anything else; this is the same rule at the data layer, so
 * a caller that forgets the route's check still cannot let a rep change consent. It looks at what
 * was sent (a key left out, or undefined, is not sent), not at whether the value differs.
 */
function assertMayChangeConsent(
  ctx: TenantContext,
  input: { smsConsentStatus?: unknown; doNotContact?: unknown; consentNote?: unknown },
): void {
  if (
    ctx.role === 'rep' &&
    (input.smsConsentStatus !== undefined || input.doNotContact !== undefined || input.consentNote !== undefined)
  ) {
    throw new ForbiddenError();
  }
}

// ---------------------------------------------------------------------------------------------
// History helpers

const AUDITED = [
  'displayName',
  'firstName',
  'lastName',
  'phones',
  'emails',
  'tags',
  'doNotContact',
  'smsConsentStatus',
  'smsConsentSource',
  'smsConsentAt',
  'smsConsentByUserId',
  'smsConsentEvidence',
] as const;
type AuditedField = (typeof AUDITED)[number];

const CONSENT_COLUMNS: readonly AuditedField[] = [
  'smsConsentStatus',
  'smsConsentSource',
  'smsConsentAt',
  'smsConsentByUserId',
  'smsConsentEvidence',
];

/** The named fields of a customer as plain JSON (dates as ISO strings), for the audit log. */
function snapshot(row: CustomerRow, fields: readonly AuditedField[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((field) => {
      const value = row[field];
      return [field, value instanceof Date ? value.toISOString() : value];
    }),
  );
}

/** Timeline lines for what changed in consent and do-not-contact between two states of a customer. */
async function logConsentChanges(
  tx: Tx,
  ctx: TenantContext,
  before: Pick<CustomerRow, 'smsConsentStatus' | 'doNotContact'>,
  after: CustomerRow,
  now: Date,
): Promise<void> {
  if (after.smsConsentStatus !== before.smsConsentStatus) {
    await addActivity(tx, ctx, {
      subjectType: 'customer',
      subjectId: after.id,
      kind: 'customer.consent_changed',
      summary: `Texting consent changed to ${CONSENT_LABELS[after.smsConsentStatus]}`,
      data: { from: before.smsConsentStatus, to: after.smsConsentStatus },
      at: now,
    });
  }
  if (after.doNotContact !== before.doNotContact) {
    await addActivity(tx, ctx, {
      subjectType: 'customer',
      subjectId: after.id,
      kind: 'customer.consent_changed',
      summary: after.doNotContact ? 'Marked as do not contact' : 'Do not contact removed',
      data: { doNotContact: after.doNotContact },
      at: now,
    });
  }
}

/** Whether texting this customer's numbers must stay off: they said no, or someone marked them do-not-contact. */
const optedOut = (row: Pick<CustomerRow, 'smsConsentStatus' | 'doNotContact'>) =>
  row.doNotContact || row.smsConsentStatus === 'revoked';

// ---------------------------------------------------------------------------------------------
// Reads

/** One customer the member may see, or null (it does not exist, is another company's, or is outside a rep's scope). */
export async function getCustomer(tx: Tx, ctx: TenantContext, id: string): Promise<CustomerRow | null> {
  const [row] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), customerScope(ctx)))
    .limit(1);
  return row ?? null;
}

export type ListCustomersOptions = {
  /** Matches the name (any part, any case) or, from 3 digits up, any phone number containing those digits. */
  q?: string;
  /** Default 50, at most 200. */
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
};

/** The customers the member may see, by name, with the count before paging. */
export async function listCustomers(
  tx: Tx,
  ctx: TenantContext,
  options: ListCustomersOptions = {},
): Promise<{ customers: CustomerRow[]; total: number }> {
  const { limit, offset } = clampPage(options);
  const conditions: (SQL | undefined)[] = [customerScope(ctx)];
  if (options.includeArchived !== true) conditions.push(isNull(customers.archivedAt));

  const q = options.q?.trim() ?? '';
  if (q !== '') conditions.push(customerMatch(q));

  const where = and(...conditions);
  const rows = await tx
    .select()
    .from(customers)
    .where(where)
    .orderBy(asc(sql`lower(${customers.displayName})`), asc(customers.createdAt), asc(customers.id))
    .limit(limit)
    .offset(offset);
  const [totals] = await tx.select({ total: count() }).from(customers).where(where);
  return { customers: rows, total: totals?.total ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Writes

/**
 * Adds a customer, created by `ctx.userId`. Throws `DuplicatePhoneError` when another active
 * customer has one of the numbers. Writes the audit row, the "Customer added" timeline line and,
 * when the customer starts out with consent set or do-not-contact on, the consent lines; and puts
 * the numbers of a customer who starts out revoked or do-not-contact on the opt-out list.
 */
export async function createCustomer(
  tx: Tx,
  ctx: TenantContext,
  input: CustomerInput,
  options: WriteOptions,
): Promise<CustomerRow> {
  const { now } = options;
  assertMayChangeConsent(ctx, input);
  const phones = input.phones ?? [];
  await assertPhonesFree(
    tx,
    ctx,
    phones.map((p, index) => ({ e164: p.e164, index })),
    null,
  );

  const status = input.smsConsentStatus ?? 'none';
  const [row] = await tx
    .insert(customers)
    .values({
      companyId: ctx.companyId,
      displayName: input.displayName,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      phones,
      emails: input.emails ?? [],
      tags: input.tags ?? [],
      doNotContact: input.doNotContact ?? false,
      smsConsentStatus: status,
      ...(status !== 'none' && {
        smsConsentSource: 'manual' as const,
        smsConsentByUserId: ctx.userId,
        smsConsentAt: now,
        smsConsentEvidence: status === 'written' && input.consentNote !== undefined ? { note: input.consentNote } : null,
      }),
      source: 'manual',
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const created = row!;

  if (optedOut(created)) await ensureOptOuts(tx, ctx, phones.map((p) => p.e164), now);

  await audit(tx, ctx, {
    action: 'customer.create',
    targetType: 'customer',
    targetId: created.id,
    after: snapshot(created, AUDITED),
    ip: options.ip ?? null,
    at: now,
  });
  await addActivity(tx, ctx, {
    subjectType: 'customer',
    subjectId: created.id,
    kind: 'customer.created',
    summary: 'Customer added',
    at: now,
  });
  await logConsentChanges(tx, ctx, { smsConsentStatus: 'none', doNotContact: false }, created, now);
  return created;
}

/**
 * Changes a customer the member may see; null when they may not (or it does not exist). The row is
 * locked for the length of the transaction, so two edits of one customer do not interleave.
 *
 * - Only numbers this customer did not already have are checked against the other customers
 *   (`DuplicatePhoneError`), so sending a customer's own numbers back never fails.
 * - A consent status different from the current one is recorded as a manual change by `ctx.userId`,
 *   now. The same status again changes nothing, so the first record of consent keeps its date.
 *   A rep may not send consent fields at all (`ForbiddenError`): the route checks too, but this is the lock that holds.
 * - When the customer ends up revoked or do-not-contact and the request named the status, the
 *   do-not-contact flag, the consent note or the numbers (even with the same values as before),
 *   every number they have is put on the opt-out list. Nothing ever comes off it here.
 * - Always writes the audit row (the fields the patch named, before and after) and a "Customer
 *   details updated" line, plus consent lines for a status or do-not-contact change.
 */
export async function updateCustomer(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  patch: CustomerPatch,
  options: WriteOptions,
): Promise<CustomerRow | null> {
  const { now } = options;
  assertMayChangeConsent(ctx, patch);
  const [before] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), customerScope(ctx)))
    .limit(1)
    .for('update');
  if (!before) return null;

  const set: Partial<typeof customers.$inferInsert> = { updatedAt: now };
  const touched = new Set<AuditedField>();
  const touch = (field: AuditedField): void => void touched.add(field);

  if (patch.displayName !== undefined) {
    set.displayName = patch.displayName;
    touch('displayName');
  }
  if (patch.firstName !== undefined) {
    set.firstName = patch.firstName;
    touch('firstName');
  }
  if (patch.lastName !== undefined) {
    set.lastName = patch.lastName;
    touch('lastName');
  }
  if (patch.emails !== undefined) {
    set.emails = patch.emails;
    touch('emails');
  }
  if (patch.tags !== undefined) {
    set.tags = patch.tags;
    touch('tags');
  }
  if (patch.phones !== undefined) {
    const had = new Set(before.phones.map((p) => p.e164));
    await assertPhonesFree(
      tx,
      ctx,
      patch.phones.flatMap((p, index) => (had.has(p.e164) ? [] : [{ e164: p.e164, index }])),
      id,
    );
    set.phones = patch.phones;
    touch('phones');
  }

  if (patch.doNotContact !== undefined) {
    set.doNotContact = patch.doNotContact;
    touch('doNotContact');
  }
  if (patch.smsConsentStatus !== undefined) {
    touch('smsConsentStatus');
    if (patch.smsConsentStatus !== before.smsConsentStatus) {
      set.smsConsentStatus = patch.smsConsentStatus;
      set.smsConsentSource = 'manual';
      set.smsConsentByUserId = ctx.userId;
      set.smsConsentAt = now;
      // The evidence of an earlier consent stays when the status moves on (to 'revoked', say):
      // it is only replaced by a new note.
      if (patch.smsConsentStatus === 'written' && patch.consentNote !== undefined) {
        set.smsConsentEvidence = { note: patch.consentNote };
      }
      for (const column of CONSENT_COLUMNS) touch(column);
    }
  }

  const [updated] = await tx.update(customers).set(set).where(eq(customers.id, id)).returning();
  const after = updated!;

  // Asking again for a state the customer is already in still counts: the list is for the texting
  // rules to lean on, and a customer who is opted out must have every number on it. The insert
  // keeps any row that is already there, so nothing is rewritten when nothing was missing.
  const touchedOptOutInputs =
    patch.smsConsentStatus !== undefined ||
    patch.consentNote !== undefined ||
    patch.doNotContact !== undefined ||
    patch.phones !== undefined;
  if (optedOut(after) && touchedOptOutInputs) {
    await ensureOptOuts(tx, ctx, after.phones.map((p) => p.e164), now);
  }

  const fields = AUDITED.filter((field) => touched.has(field));
  await audit(tx, ctx, {
    action: 'customer.update',
    targetType: 'customer',
    targetId: id,
    before: snapshot(before, fields),
    after: snapshot(after, fields),
    ip: options.ip ?? null,
    at: now,
  });
  await addActivity(tx, ctx, {
    subjectType: 'customer',
    subjectId: id,
    kind: 'customer.updated',
    summary: 'Customer details updated',
    data: { fields: Object.keys(patch).filter((key) => key !== 'consentNote') },
    at: now,
  });
  await logConsentChanges(tx, ctx, before, after, now);
  return after;
}

/**
 * Archives or restores a customer the member may see (null when they may not). There is no hard
 * delete. Doing it again changes nothing and writes nothing. Restoring brings the numbers back into
 * the "one active customer per number" rule, so it throws `DuplicatePhoneError` when another active
 * customer has since taken one of them. Opt-outs are never touched.
 */
export async function setArchived(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  archived: boolean,
  options: WriteOptions,
): Promise<CustomerRow | null> {
  const { now } = options;
  const [before] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), customerScope(ctx)))
    .limit(1)
    .for('update');
  if (!before) return null;
  if (archived === (before.archivedAt !== null)) return before;

  if (!archived) {
    await assertPhonesFree(
      tx,
      ctx,
      before.phones.map((p, index) => ({ e164: p.e164, index })),
      id,
    );
  }
  const [updated] = await tx
    .update(customers)
    .set({ archivedAt: archived ? now : null, updatedAt: now })
    .where(eq(customers.id, id))
    .returning();
  const after = updated!;

  await audit(tx, ctx, {
    action: archived ? 'customer.archive' : 'customer.unarchive',
    targetType: 'customer',
    targetId: id,
    before: { archivedAt: before.archivedAt?.toISOString() ?? null },
    after: { archivedAt: after.archivedAt?.toISOString() ?? null },
    ip: options.ip ?? null,
    at: now,
  });
  await addActivity(tx, ctx, {
    subjectType: 'customer',
    subjectId: id,
    kind: archived ? 'customer.archived' : 'customer.unarchived',
    summary: archived ? 'Customer archived' : 'Customer restored',
    at: now,
  });
  return after;
}
