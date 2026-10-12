import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { isTimeZone, localDate, normalizeAddressKey } from '@roofline/shared';
import { companies, companyStorms, customers, optOuts, properties, stormPages, stormRequests } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';
import { audit } from './audit.ts';
import { CONSENT_LABELS } from './customers.ts';
import { createJob } from './jobs.ts';

export type StormRequestInput = {
  stormPageId: string;
  name: string;
  phoneE164: string;
  /** The address as typed. */
  address: string;
  /** Geocoded parts; null when the geocoder found nothing (the request is then rejected before this call). */
  property: { addressLine: string; city: string; state: string; zip: string; location: [number, number] | null; timezone: string | null };
  /** True only when the box was ticked. */
  okToText: boolean;
  /** The exact consent sentence shown next to the box; stored when okToText. */
  consentText: string;
  ipHash: string | null;
  now: Date;
};

export type StormRequestResult =
  | { status: 'created'; requestId: string; customerId: string; jobId: string }
  | { status: 'duplicate' };

/** The follow-up put on the new job, so it shows on Today the day the request came in. */
const NEXT_STEP = 'Call the homeowner about the storm inspection request';

type CustomerRow = typeof customers.$inferSelect;

/**
 * Takes a storm request from a landing page, in one transaction (the caller's `withTenant`):
 *
 * 1. The page must exist for this company (its storm row gives the storm id for the job).
 * 2. One request per phone per page. The request row is inserted first with `on conflict do
 *    nothing`; no row back means the phone already asked on this page, and nothing else is written.
 * 3. The customer: an active customer of the company that already has this number is reused, and its
 *    consent is never changed. Otherwise a new 'web' customer is added with consent 'none'. The form
 *    never writes express consent (Ruling BF): the box only records the homeowner's ask on the request
 *    (sms_consent, consent text and time, as evidence). The phone is verified only when a Twilio-signed
 *    text from it replies YES (`confirmFormConsentByYes`, called from the inbound text hook).
 * 4. The address: a company address with the same key is reused. When it has no customer yet, the
 *    customer from step 3 takes it. When it already belongs to another customer, the job and the
 *    request go to that customer (the address keeps its one owner, and the phone customer from step 3
 *    stays as its own record). Otherwise a new address is added for the customer from step 3.
 *    No name of any other customer is ever returned.
 * 5. The lead job through `createJob` (source 'web', the storm id, the follow-up for the company-local day), plus a
 *    job line saying it came from the storm page. When step 4 attached the request to another customer's
 *    home, that line also names who asked, so the owner can see it.
 * 6. The request row gets the customer, job, consent and IP hash.
 *
 * Phone and address takes an advisory lock first, the same way customers.ts does for phones, so two
 * requests with one new number or address cannot both pass the check.
 */
export async function createStormRequest(tx: Tx, ctx: TenantContext, input: StormRequestInput): Promise<StormRequestResult> {
  const { now } = input;
  const page = await stormPageOf(tx, ctx, input.stormPageId);
  if (!page) throw new Error('createStormRequest: the storm page does not exist for this company');

  const [claimed] = await tx
    .insert(stormRequests)
    .values({
      companyId: ctx.companyId,
      stormPageId: input.stormPageId,
      name: input.name,
      phoneE164: input.phoneE164,
      address: input.address,
      smsConsent: false,
      consentText: null,
      consentAt: null,
      customerId: null,
      jobId: null,
      ipHash: input.ipHash,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [stormRequests.stormPageId, stormRequests.phoneE164] })
    .returning({ id: stormRequests.id });
  if (!claimed) return { status: 'duplicate' };

  const phoneCustomer = await phoneCustomerFor(tx, ctx, input, now);

  const addressKey = normalizeAddressKey(input.property.addressLine, input.property.zip);
  await lock(tx, ctx.companyId, `address:${addressKey}`);
  const jobCustomer = await addressCustomerFor(tx, ctx, addressKey, phoneCustomer);
  const property = await addressRowFor(tx, ctx, input, addressKey, jobCustomer, now);

  const zone = await companyZone(tx, ctx);
  // The normal job path: its audit row, "Job created", next-step and customer timeline lines. The context is
  // the system's (no signed-in user), so the actor on those rows is null / 'system', as the direct insert had it.
  const createdJob = await createJob(
    tx,
    ctx,
    {
      customerId: jobCustomer.id,
      propertyId: property.id,
      stage: 'lead',
      source: 'web',
      stormId: page.stormId,
      nextStep: NEXT_STEP,
      nextStepOn: localDate(now, zone),
    },
    { now },
  );
  // Tells the owner where the lead came from. When the typed address was already another customer's home,
  // the job sits on that customer, so the line says so and names who asked (the owner's own data).
  const attached = jobCustomer.id !== phoneCustomer.id;
  await addActivity(tx, ctx, {
    subjectType: 'job',
    subjectId: createdJob.id,
    kind: 'job.created',
    summary: attached
      ? `Storm inspection request from the storm page, sent for this home by ${input.name}`
      : 'Storm inspection request from the storm page',
    data: { stormRequestId: claimed.id, ...(attached && { requestedByCustomerId: phoneCustomer.id }) },
    at: now,
  });

  const [request] = await tx
    .update(stormRequests)
    .set({
      customerId: jobCustomer.id,
      jobId: createdJob.id,
      smsConsent: input.okToText,
      consentText: input.okToText ? input.consentText : null,
      consentAt: input.okToText ? now : null,
      ipHash: input.ipHash,
      updatedAt: now,
    })
    .where(eq(stormRequests.id, claimed.id))
    .returning({ id: stormRequests.id });

  return { status: 'created', requestId: request!.id, customerId: jobCustomer.id, jobId: createdJob.id };
}

/**
 * Counts the requests made on this page at or after `since`; with `ipHash`, only those from that
 * requester (the per-IP share of one page). RLS limits the count to the company.
 */
export async function countStormRequestsSince(
  tx: Tx,
  _ctx: TenantContext,
  stormPageId: string,
  since: Date,
  ipHash?: string,
): Promise<number> {
  const [row] = await tx
    .select({ total: count() })
    .from(stormRequests)
    .where(
      and(
        eq(stormRequests.stormPageId, stormPageId),
        gte(stormRequests.createdAt, since),
        ...(ipHash === undefined ? [] : [eq(stormRequests.ipHash, ipHash)]),
      ),
    );
  return row?.total ?? 0;
}

/** A YES to a storm request takes effect only within this long of the request. */
export const STORM_FORM_YES_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A Twilio-signed text from `phoneE164` that reads YES (the caller checks `isYesReply`, and that
 * it is not a STOP, HELP or START). It verifies the phone: if the number has a storm request that
 * asked to be texted (sms_consent) made within 14 days, each of the customers given (the active
 * ones who have the number) that is at consent 'none' and not do-not-contact becomes `express`,
 * source `web_form`, with the request and the reply message as evidence, a `customer.consent_confirmed`
 * audit row and a timeline line. Revoked, written and express consent are left as they are, and a
 * number on the opt-out list changes nothing. Returns the ids of the customers it changed.
 */
export async function confirmFormConsentByYes(
  tx: Tx,
  ctx: TenantContext,
  yes: { phoneE164: string; customerIds: readonly string[]; messageId: string },
  now: Date,
): Promise<string[]> {
  if (yes.customerIds.length === 0) return [];
  const since = new Date(now.getTime() - STORM_FORM_YES_WINDOW_MS);
  const [request] = await tx
    .select({
      id: stormRequests.id,
      stormPageId: stormRequests.stormPageId,
      consentText: stormRequests.consentText,
      consentAt: stormRequests.consentAt,
      ipHash: stormRequests.ipHash,
      createdAt: stormRequests.createdAt,
    })
    .from(stormRequests)
    .where(
      and(
        eq(stormRequests.companyId, ctx.companyId),
        eq(stormRequests.phoneE164, yes.phoneE164),
        eq(stormRequests.smsConsent, true),
        gte(stormRequests.createdAt, since),
      ),
    )
    .orderBy(desc(stormRequests.createdAt), desc(stormRequests.id))
    .limit(1);
  if (!request) return [];

  const [optedOut] = await tx
    .select({ id: optOuts.id })
    .from(optOuts)
    .where(and(eq(optOuts.companyId, ctx.companyId), eq(optOuts.phoneE164, yes.phoneE164)))
    .limit(1);
  if (optedOut) return [];

  const locked = await tx
    .select({ id: customers.id, status: customers.smsConsentStatus, source: customers.smsConsentSource, at: customers.smsConsentAt, doNotContact: customers.doNotContact })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, [...yes.customerIds])))
    .orderBy(asc(customers.id))
    .for('update');
  const before = locked.filter((c) => c.status === 'none' && !c.doNotContact);
  if (before.length === 0) return [];

  const evidence = {
    source: 'web_form',
    verifiedBy: 'text_yes',
    stormRequestId: request.id,
    stormPageId: request.stormPageId,
    consentText: request.consentText,
    requestedAt: (request.consentAt ?? request.createdAt).toISOString(),
    ipHash: request.ipHash,
    replyMessageId: yes.messageId,
    at: now.toISOString(),
  };
  await tx
    .update(customers)
    .set({
      smsConsentStatus: 'express',
      smsConsentSource: 'web_form',
      smsConsentAt: now,
      smsConsentByUserId: null,
      smsConsentEvidence: evidence,
      updatedAt: now,
    })
    .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, before.map((c) => c.id))));

  for (const was of before) {
    await audit(tx, ctx, {
      action: 'customer.consent_confirmed',
      targetType: 'customer',
      targetId: was.id,
      before: { smsConsentStatus: 'none', smsConsentSource: was.source, smsConsentAt: was.at?.toISOString() ?? null },
      after: { smsConsentStatus: 'express', smsConsentSource: 'web_form', smsConsentAt: now.toISOString(), stormRequestId: request.id, replyMessageId: yes.messageId },
      ip: null,
      at: now,
    });
    await consentLine(tx, ctx, was.id, 'none', 'express', now, { stormRequestId: request.id, messageId: yes.messageId, via: 'text' });
  }
  return before.map((c) => c.id);
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** Takes a transaction-scoped advisory lock with the same key shape customers.ts uses for phones. */
async function lock(tx: Tx, companyId: string, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${companyId}::text || ':' || ${key}::text, 0))`);
}

/** The page and its storm id (company_storms.storm_id), or null when the page is not this company's. */
async function stormPageOf(tx: Tx, ctx: TenantContext, stormPageId: string): Promise<{ stormId: string } | null> {
  const [row] = await tx
    .select({ stormId: companyStorms.stormId })
    .from(stormPages)
    .innerJoin(companyStorms, eq(companyStorms.id, stormPages.companyStormId))
    .where(and(eq(stormPages.id, stormPageId), eq(stormPages.companyId, ctx.companyId)))
    .limit(1);
  return row ?? null;
}

/** The company's time zone, or UTC when it is missing or not a zone the platform knows. */
async function companyZone(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  return row && isTimeZone(row.timezone) ? row.timezone : 'UTC';
}

/**
 * The customer for this phone: an active one of the company that has the number, reused with its
 * consent untouched; or a new 'web' customer at consent 'none'.
 */
async function phoneCustomerFor(tx: Tx, ctx: TenantContext, input: StormRequestInput, now: Date): Promise<CustomerRow> {
  await lock(tx, ctx.companyId, input.phoneE164);
  const [found] = await tx
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.companyId, ctx.companyId),
        sql`${customers.archivedAt} is null`,
        sql`${customers.phones} @> ${JSON.stringify([{ e164: input.phoneE164 }])}::jsonb`,
      ),
    )
    .limit(1);
  if (found) return found;

  const [created] = await tx
    .insert(customers)
    .values({
      companyId: ctx.companyId,
      displayName: input.name,
      firstName: null,
      lastName: null,
      phones: [{ e164: input.phoneE164, primary: true }],
      emails: [],
      tags: [],
      doNotContact: false,
      smsConsentStatus: 'none',
      source: 'web',
      createdByUserId: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const row = created!;

  await audit(tx, ctx, {
    action: 'customer.create',
    targetType: 'customer',
    targetId: row.id,
    after: { displayName: row.displayName, phones: row.phones, smsConsentStatus: row.smsConsentStatus },
    ip: null,
    at: now,
  });
  await addActivity(tx, ctx, { subjectType: 'customer', subjectId: row.id, kind: 'customer.created', summary: 'Customer added', at: now });
  return row;
}

async function consentLine(
  tx: Tx,
  ctx: TenantContext,
  customerId: string,
  from: 'none',
  to: 'express',
  now: Date,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await addActivity(tx, ctx, {
    subjectType: 'customer',
    subjectId: customerId,
    kind: 'customer.consent_changed',
    summary: `Texting consent changed to ${CONSENT_LABELS[to]}`,
    data: { from, to, ...extra },
    at: now,
  });
}

/**
 * The customer the job goes to and the address row for it. See the note on `createStormRequest`
 * step 4: a reused address keeps its owner; an unowned one is taken by the phone customer.
 */
async function addressCustomerFor(tx: Tx, ctx: TenantContext, addressKey: string, phoneCustomer: CustomerRow): Promise<CustomerRow> {
  const existing = await addressRowByKey(tx, ctx, addressKey);
  if (!existing || existing.customerId === null || existing.customerId === phoneCustomer.id) return phoneCustomer;

  const [owner] = await tx.select().from(customers).where(eq(customers.id, existing.customerId)).limit(1);
  return owner ?? phoneCustomer;
}

type AddressRow = typeof properties.$inferSelect;

async function addressRowByKey(tx: Tx, ctx: TenantContext, addressKey: string): Promise<AddressRow | null> {
  const [row] = await tx
    .select()
    .from(properties)
    .where(and(eq(properties.companyId, ctx.companyId), eq(properties.addressKey, addressKey)))
    .limit(1);
  return row ?? null;
}

/** The address row for the job: the existing one (taking the customer when it had none) or a new one for the customer. */
async function addressRowFor(
  tx: Tx,
  ctx: TenantContext,
  input: StormRequestInput,
  addressKey: string,
  jobCustomer: CustomerRow,
  now: Date,
): Promise<AddressRow> {
  const existing = await addressRowByKey(tx, ctx, addressKey);
  if (existing) {
    if (existing.customerId !== null) return existing;
    const [claimed] = await tx
      .update(properties)
      .set({ customerId: jobCustomer.id, updatedAt: now })
      .where(eq(properties.id, existing.id))
      .returning();
    await audit(tx, ctx, {
      action: 'property.update',
      targetType: 'property',
      targetId: existing.id,
      before: { customerId: null },
      after: { customerId: jobCustomer.id },
      ip: null,
      at: now,
    });
    await addActivity(tx, ctx, {
      subjectType: 'property',
      subjectId: existing.id,
      kind: 'property.updated',
      summary: `Address linked to ${jobCustomer.displayName}`,
      data: { fields: ['customerId'], customerId: jobCustomer.id },
      at: now,
    });
    return claimed!;
  }

  const [row] = await tx
    .insert(properties)
    .values({
      companyId: ctx.companyId,
      customerId: jobCustomer.id,
      addressLine: input.property.addressLine,
      city: input.property.city,
      state: input.property.state,
      zip: input.property.zip,
      addressKey,
      ...(input.property.location !== null && { geom: input.property.location }),
      timezone: input.property.timezone !== null && isTimeZone(input.property.timezone) ? input.property.timezone : null,
      yearBuilt: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const created = row!;

  await audit(tx, ctx, {
    action: 'property.create',
    targetType: 'property',
    targetId: created.id,
    after: { customerId: created.customerId, addressLine: created.addressLine, city: created.city, state: created.state, zip: created.zip },
    ip: null,
    at: now,
  });
  await addActivity(tx, ctx, { subjectType: 'property', subjectId: created.id, kind: 'property.created', summary: 'Address added', at: now });
  return created;
}
