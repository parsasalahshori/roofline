import { and, asc, eq, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { BrandInfo } from '@roofline/shared';
import type { Db } from '../pools.ts';
import { companies, companyPhoneNumbers, textingRegistrations } from '../schema/index.ts';

/*
 * Texting registration data access, on the app_system pool: the texting_registrations rows are
 * global, and the scheduler and the registration job read them before a tenant context exists.
 * Only apps/api/src/{account,jobs/scheduler}/** imports this module. The subaccount auth token is
 * only ever stored and read here as an encrypted box; callers decrypt it where they use it.
 */

export type RegistrationRecord = typeof textingRegistrations.$inferSelect;

/** Postgres's lock_not_available: a `FOR UPDATE NOWAIT` found the row already locked. */
const LOCK_NOT_AVAILABLE = '55P03';

function isLockNotAvailable(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === LOCK_NOT_AVAILABLE || e?.cause?.code === LOCK_NOT_AVAILABLE;
}

/**
 * Companies (oldest first) that are not canceled and have no texting subaccount yet: no
 * registration row, or one whose `subaccount_sid` is null. At most `limit` ids.
 */
export async function companiesNeedingSubaccount(system: Db, limit: number): Promise<string[]> {
  const rows = await system
    .select({ id: companies.id })
    .from(companies)
    .leftJoin(textingRegistrations, eq(textingRegistrations.companyId, companies.id))
    .where(
      and(
        ne(companies.status, 'canceled'),
        or(isNull(textingRegistrations.id), isNull(textingRegistrations.subaccountSid)),
      ),
    )
    .orderBy(asc(companies.createdAt), asc(companies.id))
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Stores a company's subaccount. Inserts the row when there is none; when there is one, fills
 * the sid and token only while its `subaccount_sid` is still null. An existing sid is never
 * overwritten.
 */
export async function saveSubaccount(system: Db, companyId: string, sid: string, tokenEncrypted: Buffer): Promise<void> {
  await system
    .insert(textingRegistrations)
    .values({ companyId, subaccountSid: sid, subaccountAuthTokenEncrypted: tokenEncrypted })
    .onConflictDoUpdate({
      target: textingRegistrations.companyId,
      set: {
        subaccountSid: sid,
        subaccountAuthTokenEncrypted: tokenEncrypted,
        updatedAt: sql`now()`,
      },
      setWhere: isNull(textingRegistrations.subaccountSid),
    });
}

/** The company's registration row, or null when it has none yet. */
export async function loadRegistration(system: Db, companyId: string): Promise<RegistrationRecord | null> {
  const [row] = await system
    .select()
    .from(textingRegistrations)
    .where(eq(textingRegistrations.companyId, companyId))
    .limit(1);
  return row ?? null;
}

/**
 * Records a registration submission. Under one transaction, with the row locked (created when
 * missing): allowed only when `campaign_status` is `none` or `rejected`. Then it stores the brand
 * and sets `pending`, clearing the rejection. The sids are never touched: they are the previous
 * ids of a resubmission. Otherwise the registration is already waiting.
 */
export async function saveSubmission(
  system: Db,
  companyId: string,
  brand: BrandInfo,
  now: Date,
): Promise<'saved' | 'already_waiting'> {
  return system.transaction(async (tx) => {
    await tx
      .insert(textingRegistrations)
      .values({ companyId })
      .onConflictDoNothing({ target: textingRegistrations.companyId });
    const [row] = await tx
      .select({ campaignStatus: textingRegistrations.campaignStatus })
      .from(textingRegistrations)
      .where(eq(textingRegistrations.companyId, companyId))
      .limit(1)
      .for('update');
    if (row?.campaignStatus !== 'none' && row?.campaignStatus !== 'rejected') return 'already_waiting';
    await tx
      .update(textingRegistrations)
      .set({
        brandInfo: brand,
        submittedAt: now,
        campaignStatus: 'pending',
        rejectedFields: [],
        rejectionReasonPlain: null,
      })
      .where(eq(textingRegistrations.companyId, companyId));
    return 'saved';
  });
}

/** Sets the given columns of the company's registration row. */
export async function updateRegistration(
  system: Db,
  companyId: string,
  patch: Partial<RegistrationRecord>,
): Promise<void> {
  await system.update(textingRegistrations).set(patch).where(eq(textingRegistrations.companyId, companyId));
}

/**
 * Runs `fn` in a transaction that holds the company's registration row locked (`FOR UPDATE
 * NOWAIT`). When another transaction holds it, returns 'busy' without waiting. A company with no
 * row has nothing to lock, so `fn` runs without one. Any other error is rethrown.
 */
export async function withRegistrationLock<T>(
  system: Db,
  companyId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T | 'busy'> {
  try {
    return await system.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: textingRegistrations.id })
        .from(textingRegistrations)
        .where(eq(textingRegistrations.companyId, companyId))
        .limit(1)
        .for('update', { noWait: true });
      void row;
      return fn(tx as unknown as Db);
    });
  } catch (err) {
    if (isLockNotAvailable(err)) return 'busy';
    throw err;
  }
}

/* Texting registration progress and the poll's windows (the hooks, the poll and the monthly fees). */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The company a texting sid (subaccount, customer profile, trust product, brand, campaign or messaging service) belongs to. */
export async function companyIdForTextingSid(system: Db, sid: string): Promise<string | null> {
  const [row] = await system
    .select({ companyId: textingRegistrations.companyId })
    .from(textingRegistrations)
    .where(
      or(
        eq(textingRegistrations.subaccountSid, sid),
        eq(textingRegistrations.customerProfileSid, sid),
        eq(textingRegistrations.trustProductSid, sid),
        eq(textingRegistrations.brandSid, sid),
        eq(textingRegistrations.campaignSid, sid),
        eq(textingRegistrations.messagingServiceSid, sid),
      ),
    )
    .limit(1);
  return row?.companyId ?? null;
}

/**
 * Companies whose registration the poll should check now (their ids, in order). A pending campaign
 * is checked hourly while its brand is with the carriers, daily once the campaign is, and a submitted
 * registration with no brand sid after an hour is checked too (a stuck stage 1).
 */
export async function registrationsToCheck(system: Db, now: Date): Promise<string[]> {
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const rows = await system
    .select({ companyId: textingRegistrations.companyId })
    .from(textingRegistrations)
    .where(
      and(
        eq(textingRegistrations.campaignStatus, 'pending'),
        or(
          and(
            isNull(textingRegistrations.campaignSid),
            isNotNull(textingRegistrations.brandSid),
            or(isNull(textingRegistrations.lastCheckedAt), lt(textingRegistrations.lastCheckedAt, hourAgo)),
          ),
          and(
            isNotNull(textingRegistrations.campaignSid),
            or(isNull(textingRegistrations.lastCheckedAt), lt(textingRegistrations.lastCheckedAt, dayAgo)),
          ),
          and(
            isNull(textingRegistrations.brandSid),
            isNotNull(textingRegistrations.submittedAt),
            lt(textingRegistrations.submittedAt, hourAgo),
          ),
        ),
      ),
    )
    .orderBy(asc(textingRegistrations.companyId));
  return rows.map((r) => r.companyId);
}

/** Records the company's main number (purpose 'main', status 'active'); idempotent on e164. */
export async function addMainNumber(
  system: Db,
  companyId: string,
  n: { e164: string; providerSid: string; capabilities: string[] },
): Promise<void> {
  await system
    .insert(companyPhoneNumbers)
    .values({
      companyId,
      e164: n.e164,
      capabilities: n.capabilities,
      providerSid: n.providerSid,
      purpose: 'main',
      status: 'active',
    })
    .onConflictDoNothing({ target: companyPhoneNumbers.e164 });
}

/** Companies with an active main number or an approved campaign (ids, in order). */
export async function companiesWithTextingFees(system: Db): Promise<string[]> {
  const [numbers, campaigns] = await Promise.all([
    system
      .select({ companyId: companyPhoneNumbers.companyId })
      .from(companyPhoneNumbers)
      .where(and(eq(companyPhoneNumbers.purpose, 'main'), eq(companyPhoneNumbers.status, 'active'))),
    system
      .select({ companyId: textingRegistrations.companyId })
      .from(textingRegistrations)
      .where(and(eq(textingRegistrations.campaignStatus, 'approved'), isNotNull(textingRegistrations.campaignSid))),
  ]);
  return [...new Set([...numbers, ...campaigns].map((r) => r.companyId))].sort();
}
