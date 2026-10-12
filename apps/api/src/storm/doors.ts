/**
 * Recording a door knock outcome (S1 Task 15).
 *
 * Everything runs in one tenant transaction, so any throw rolls the outcome back too.
 * A rep may only record on their own route (owner and office on any route in the company).
 * An outcome is recorded once per stop: a repeat returns the stored stop and writes nothing.
 * 'do_not_knock' adds a door exclusion for the footprint. 'wants_check' creates a customer
 * (tag 'storm'), a home and a Lead job (source 'storm', assigned to the route's rep, follow-up
 * due today); SMS consent 'express' from source 'door' is written only when "OK to text" is
 * ticked and a phone was given. The other outcomes write nothing but the outcome.
 */
import { eq } from 'drizzle-orm';
import { toE164, type DoorOutcome } from '@roofline/shared';
import {
  addDoorExclusion,
  addNote,
  companies,
  createCustomer,
  createJob,
  createProperty,
  customers,
  DuplicateAddressError,
  getDoorRoute,
  linkPropertyToCustomer,
  lockDoorStop,
  NOTE_MAX,
  setDoorStopCreated,
  setDoorStopOutcome,
  withTenant,
  type DoorRouteRow,
  type DoorStopRow,
  type PropertyRow,
  type TenantContext,
  type Tx,
} from '@roofline/db';
import type { AppDeps } from '../app.ts';

export type DoorLead = { name: string; phoneE164?: string; email?: string; okToText: boolean; note?: string };
export type DoorOutcomeBody = { outcome: DoorOutcome; lead?: DoorLead };
export type DoorOutcomeResult = { stop: DoorStopRow; createdJobId?: string };

/** Thrown when the route is not the caller's (a rep) : the API turns it into 403. */
export class DoorRouteForbiddenError extends Error {}
/** Thrown when the route or stop does not exist for this company: the API turns it into 404. */
export class DoorStopNotFoundError extends Error {}
/** Thrown when wants_check has no usable lead: the API turns it into 400 field "lead". */
export class DoorLeadRequiredError extends Error {}

const OK_TO_TEXT_EVIDENCE = 'Homeowner said yes to texts at the door.';
const ADDRESS_PATTERN = /^(.+),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})/;

type Place = { addressLine: string; city: string; state: string; zip: string };

/** What a stop's address uses for any part the company profile cannot supply. */
const FALLBACK_CITY = 'Unknown';
const FALLBACK_STATE = 'NE';
const FALLBACK_ZIP = '00000';
const nearLabel = (stop: DoorStopRow): string => `Near ${stop.lat}, ${stop.lng}`;

function placeFor(stop: DoorStopRow, company: CompanyBits): Place {
  const match = stop.address === null ? null : ADDRESS_PATTERN.exec(stop.address);
  if (match) {
    return { addressLine: match[1]!.trim(), city: match[2]!.trim(), state: match[3]!, zip: match[4]! };
  }
  return {
    addressLine: stop.address ?? nearLabel(stop),
    city: company.city ?? FALLBACK_CITY,
    state: company.state ?? FALLBACK_STATE,
    zip: company.zip ?? FALLBACK_ZIP,
  };
}

type CompanyBits = { city: string | null; state: string | null; zip: string | null; timezone: string };

async function readCompany(tx: Tx, ctx: TenantContext): Promise<CompanyBits> {
  const [row] = await tx
    .select({
      city: companies.addressCity,
      state: companies.addressState,
      zip: companies.addressZip,
      timezone: companies.timezone,
    })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return row ?? { city: null, state: null, zip: null, timezone: 'America/Chicago' };
}

async function createHome(
  tx: Tx,
  ctx: TenantContext,
  stop: DoorStopRow,
  customer: { id: string; displayName: string },
  company: CompanyBits,
  now: Date,
): Promise<string> {
  if (stop.propertyId !== null) {
    const linked: PropertyRow = await linkPropertyToCustomer(tx, ctx, stop.propertyId, customer, { now });
    if (linked.customerId === customer.id) return stop.propertyId;
    // The home already belongs to someone else: this lead gets its own address row.
  }
  const place = placeFor(stop, company);
  const input = { customerId: customer.id, ...place, location: [stop.lng, stop.lat] as [number, number] };
  try {
    // A nested transaction is a savepoint: a duplicate-key failure must not abort the outer transaction.
    return (await tx.transaction((sp) => createProperty(sp, ctx, input, { now }))).id;
  } catch (err) {
    if (!(err instanceof DuplicateAddressError)) throw err;
    return (await createProperty(tx, ctx, { ...input, addressLine: `${place.addressLine} #${stop.position}` }, { now })).id;
  }
}

async function createLead(
  tx: Tx,
  ctx: TenantContext,
  route: DoorRouteRow,
  stop: DoorStopRow,
  lead: DoorLead,
  now: Date,
): Promise<{ customerId: string; jobId: string }> {
  const phones = lead.phoneE164 ? [{ e164: toE164(lead.phoneE164) ?? lead.phoneE164, primary: true }] : [];
  const emails = lead.email ? [lead.email] : [];
  const customer = await createCustomer(tx, ctx, { displayName: lead.name, phones, emails, tags: ['storm'] }, { now });

  if (lead.okToText && phones.length > 0) {
    await tx
      .update(customers)
      .set({
        smsConsentStatus: 'express',
        smsConsentSource: 'door',
        smsConsentAt: now,
        smsConsentByUserId: ctx.userId,
        smsConsentEvidence: { by: ctx.userId, at: now.toISOString(), text: OK_TO_TEXT_EVIDENCE },
        updatedAt: now,
      })
      .where(eq(customers.id, customer.id));
  }

  const company = await readCompany(tx, ctx);
  const propertyId = await createHome(tx, ctx, stop, customer, company, now);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: company.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  const job = await createJob(
    tx,
    ctx,
    {
      customerId: customer.id,
      propertyId,
      stage: 'lead',
      source: 'storm',
      stormId: route.stormId,
      assignedUserId: route.userId,
      nextStep: 'Call back about the roof check',
      nextStepOn: today,
    },
    { now },
  );

  const note = lead.note?.trim();
  if (note) await addNote(tx, ctx, { subjectType: 'job', subjectId: job.id, body: note.slice(0, NOTE_MAX) }, now);
  return { customerId: customer.id, jobId: job.id };
}

export async function recordDoorOutcome(
  deps: AppDeps,
  ctx: TenantContext,
  input: { routeId: string; stopId: string; body: DoorOutcomeBody },
): Promise<DoorOutcomeResult> {
  const { body } = input;
  return withTenant(deps.pools, ctx, async (tx) => {
    const route = await getDoorRoute(tx, input.routeId);
    if (route === null) throw new DoorStopNotFoundError();
    if (ctx.role === 'rep' && route.userId !== ctx.userId) throw new DoorRouteForbiddenError();

    const stop = await lockDoorStop(tx, input.routeId, input.stopId);
    if (stop === null) throw new DoorStopNotFoundError();
    if (stop.outcome !== null) {
      return { stop, ...(stop.createdJobId ? { createdJobId: stop.createdJobId } : {}) };
    }
    if (body.outcome === 'wants_check' && !body.lead) throw new DoorLeadRequiredError();

    const now = deps.clock.now();
    const recorded = await setDoorStopOutcome(tx, stop, { outcome: body.outcome, by: ctx.userId!, at: now });

    if (body.outcome === 'do_not_knock') {
      if (stop.footprintId !== null) await addDoorExclusion(tx, stop.footprintId, 'do_not_knock');
      return { stop: recorded };
    }
    if (body.outcome !== 'wants_check' || !body.lead) return { stop: recorded };

    const created = await createLead(tx, ctx, route, stop, body.lead, now);
    const updated = await setDoorStopCreated(tx, stop.id, created);
    return { stop: updated, createdJobId: created.jobId };
  });
}
