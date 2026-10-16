import { and, asc, count, desc, eq, gte, inArray } from 'drizzle-orm';
import { localDate, normalizeAddressKey } from '@roofline/shared';
import { companyStorms, customers, optOuts, stormPages, stormRequests } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';
import { audit } from './audit.ts';
import { CONSENT_LABELS } from './customers.ts';
import { createJob } from './jobs.ts';
import { addressCustomerFor, addressRowFor, lockWebLead, phoneCustomerFor, webLeadZone } from './web-lead.ts';

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
  await lockWebLead(tx, ctx.companyId, `address:${addressKey}`);
  const jobCustomer = await addressCustomerFor(tx, ctx, addressKey, phoneCustomer);
  const property = await addressRowFor(tx, ctx, input, addressKey, jobCustomer, now);

  const zone = await webLeadZone(tx, ctx);
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

