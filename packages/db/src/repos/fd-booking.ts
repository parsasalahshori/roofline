import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { ConfirmedVia } from '@roofline/shared';
import { activities, appointments, customers, jobs, properties } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';
import { audit } from './audit.ts';
import { createCustomer, DuplicatePhoneError, getCustomer } from './customers.ts';
import { recordCallConsent } from './fd-text-back.ts';
import { customersWithPhone } from './inbound.ts';

/*
 * D1 Task 8: the rows behind Front Desk booking, confirming, moving and cancelling inspections.
 * Every query names ctx.companyId (RLS also enforces it). Used by apps/api/src/front-desk/tools/*.ts.
 */

/** The activity kind that records a booking's idempotency key (one per booking, on its job). */
export const BOOKING_KEY_KIND = 'appointment.front_desk_booked';

/** Job stages that still take a new inspection (a Won, Installed or Lost job does not). */
const OPEN_STAGES = ['lead', 'inspection', 'proposal'] as const;

/**
 * Takes the booking locks, held until the transaction ends: first the idempotency key (two tries of
 * one booking take turns), then the inspector (two bookings of one person take turns). The order is
 * always key, then inspector, so two callers cannot wait on each other.
 */
export async function lockBooking(tx: Tx, ctx: TenantContext, key: string, inspectorId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.companyId}::text || ':fd-book-key:' || ${key}::text, 0))`);
  await lockInspector(tx, ctx, inspectorId);
}

/** Takes only the inspector's lock (a move). */
export async function lockInspector(tx: Tx, ctx: TenantContext, inspectorId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.companyId}::text || ':fd-book-user:' || ${inspectorId}::text, 0))`);
}

export type BookingRecord = { appointmentId: string; customerId: string; jobId: string };

/** The booking made earlier under this idempotency key, when its appointment is still on (not canceled). */
export async function findBookingByKey(tx: Tx, ctx: TenantContext, key: string): Promise<BookingRecord | null> {
  const rows = await tx
    .select({ data: activities.data })
    .from(activities)
    .where(
      and(
        eq(activities.companyId, ctx.companyId),
        eq(activities.kind, BOOKING_KEY_KIND),
        sql`${activities.data} ->> 'idempotencyKey' = ${key}`,
      ),
    )
    .orderBy(sql`${activities.at} desc`);
  for (const { data } of rows) {
    const appointmentId = typeof data.appointmentId === 'string' ? data.appointmentId : null;
    if (appointmentId === null) continue;
    const [appt] = await tx
      .select({ id: appointments.id, status: appointments.status, customerId: appointments.customerId, jobId: appointments.jobId })
      .from(appointments)
      .where(and(eq(appointments.companyId, ctx.companyId), eq(appointments.id, appointmentId), isNull(appointments.archivedAt)));
    if (appt && appt.status !== 'canceled' && appt.customerId !== null && appt.jobId !== null) {
      return { appointmentId: appt.id, customerId: appt.customerId, jobId: appt.jobId };
    }
  }
  return null;
}

/** Remembers the idempotency key on the job's timeline, with the plain line "Booked by Front Desk". */
export async function recordBooking(
  tx: Tx,
  ctx: TenantContext,
  i: { key: string; appointmentId: string; jobId: string; conversationId: string },
  now: Date,
): Promise<void> {
  await addActivity(tx, ctx, {
    subjectType: 'job',
    subjectId: i.jobId,
    kind: BOOKING_KEY_KIND,
    summary: 'Booked by Front Desk',
    data: { idempotencyKey: i.key, appointmentId: i.appointmentId, conversationId: i.conversationId },
    at: now,
    actorAgent: 'front_desk',
  });
}

/**
 * Whether a point is inside the company's service area. A company with no service area drawn has
 * no limit, so the answer is true.
 */
export async function inServiceArea(tx: Tx, ctx: TenantContext, lng: number, lat: number): Promise<boolean> {
  const result = await tx.execute(
    sql`select (service_area is null or ST_Covers(service_area, ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326))) as inside from companies where id = ${ctx.companyId}`,
  );
  const row = result.rows[0] as { inside: boolean | null } | undefined;
  return row?.inside ?? true;
}

export type BookingCustomer =
  | { kind: 'ok'; customerId: string; created: boolean }
  /** Several customers (or only an archived one) hold this number: nobody is guessed. */
  | { kind: 'ambiguous' }
  | { kind: 'needs_name' };

/**
 * The customer a booking is for: the one the conversation already knows; else the one active
 * customer who has the caller's number; else a new customer from the given name and number (source
 * call). The call is express texting consent for appointment texts (consent source 'call'), but only
 * for a customer who has none yet.
 */
export async function resolveBookingCustomer(
  tx: Tx,
  ctx: TenantContext,
  i: { customerId: string | null; phone: string; firstName: string; lastName: string },
  now: Date,
): Promise<BookingCustomer> {
  if (i.customerId !== null) {
    const known = await getCustomer(tx, ctx, i.customerId);
    if (known && known.archivedAt === null) {
      await recordCallConsent(tx, ctx, known.id, now);
      return { kind: 'ok', customerId: known.id, created: false };
    }
    return { kind: 'ambiguous' };
  }
  const found = await customersWithPhone(tx, ctx, i.phone);
  const active = found.filter((c) => !c.archived);
  if (active.length === 1) {
    await recordCallConsent(tx, ctx, active[0]!.id, now);
    return { kind: 'ok', customerId: active[0]!.id, created: false };
  }
  if (found.length > 0) return { kind: 'ambiguous' };

  const firstName = i.firstName.trim();
  const lastName = i.lastName.trim();
  if (firstName === '') return { kind: 'needs_name' };
  try {
    const created = await createCustomer(
      tx,
      ctx,
      {
        displayName: [firstName, lastName].filter((part) => part !== '').join(' '),
        firstName,
        lastName: lastName === '' ? null : lastName,
        phones: [{ e164: i.phone, primary: true }],
      },
      { now },
    );
    await tx.update(customers).set({ source: 'call' }).where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, created.id)));
    await recordCallConsent(tx, ctx, created.id, now);
    return { kind: 'ok', customerId: created.id, created: true };
  } catch (err) {
    if (err instanceof DuplicatePhoneError) return { kind: 'ambiguous' };
    throw err;
  }
}

/** An address already on file for this address key (street and ZIP, any customer), or null. */
export async function findPropertyByAddress(
  tx: Tx,
  ctx: TenantContext,
  addressKey: string,
): Promise<{ id: string; customerId: string | null } | null> {
  const [row] = await tx
    .select({ id: properties.id, customerId: properties.customerId })
    .from(properties)
    .where(and(eq(properties.companyId, ctx.companyId), eq(properties.addressKey, addressKey)))
    .limit(1);
  return row ?? null;
}

/** The customer's job at this home that is still open (Lead, Inspection or Proposal), newest first; null when none. */
export async function findOpenJobAt(tx: Tx, ctx: TenantContext, customerId: string, propertyId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.companyId, ctx.companyId),
        eq(jobs.customerId, customerId),
        eq(jobs.propertyId, propertyId),
        isNull(jobs.archivedAt),
        inArray(jobs.stage, [...OPEN_STAGES]),
      ),
    )
    .orderBy(sql`${jobs.createdAt} desc`)
    .limit(1);
  return row?.id ?? null;
}

export type FdAppointment = typeof appointments.$inferSelect;

/** One appointment of the company that is not archived, or null. No visibility rule: Front Desk acts as the system. */
export async function getFdAppointment(tx: Tx, ctx: TenantContext, id: string): Promise<FdAppointment | null> {
  const [row] = await tx
    .select()
    .from(appointments)
    .where(and(eq(appointments.companyId, ctx.companyId), eq(appointments.id, id), isNull(appointments.archivedAt)))
    .limit(1);
  return row ?? null;
}

/** The customer's upcoming scheduled appointments (not canceled, not over), soonest first. */
export async function upcomingForCustomer(tx: Tx, ctx: TenantContext, customerId: string, now: Date, limit = 5): Promise<FdAppointment[]> {
  return tx
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.companyId, ctx.companyId),
        eq(appointments.customerId, customerId),
        eq(appointments.status, 'scheduled'),
        isNull(appointments.archivedAt),
        gt(appointments.endsAt, now),
      ),
    )
    .orderBy(asc(appointments.startsAt), asc(appointments.id))
    .limit(limit);
}

export type ConfirmOutcome = 'confirmed' | 'already' | 'not_found';

/**
 * Marks the customer's own upcoming appointment (any kind) confirmed, by a call or a text. Locks the
 * row. An appointment of another customer, canceled, archived or already over reads as 'not_found'.
 * Confirming twice changes nothing ('already').
 */
export async function confirmAppointment(
  tx: Tx,
  ctx: TenantContext,
  i: { appointmentId: string; customerId: string; via: ConfirmedVia },
  now: Date,
): Promise<{ outcome: ConfirmOutcome; row: FdAppointment | null }> {
  const [row] = await tx
    .select()
    .from(appointments)
    .where(and(eq(appointments.companyId, ctx.companyId), eq(appointments.id, i.appointmentId), isNull(appointments.archivedAt)))
    .limit(1)
    .for('update');
  if (!row || row.customerId !== i.customerId || row.status !== 'scheduled' || row.endsAt.getTime() <= now.getTime()) {
    return { outcome: 'not_found', row: null };
  }
  if (row.confirmedAt !== null) return { outcome: 'already', row };
  const [updated] = await tx
    .update(appointments)
    .set({ confirmedAt: now, confirmedVia: i.via, updatedAt: now })
    .where(and(eq(appointments.companyId, ctx.companyId), eq(appointments.id, row.id)))
    .returning();
  const after = updated!;
  const entry = {
    kind: 'appointment.confirmed',
    summary: `Confirmed by the customer (${i.via === 'call' ? 'on a call' : 'by text'})`,
    data: { appointmentId: after.id, via: i.via },
    at: now,
    actorAgent: 'front_desk',
  };
  if (after.jobId !== null) await addActivity(tx, ctx, { subjectType: 'job', subjectId: after.jobId, ...entry });
  else await addActivity(tx, ctx, { subjectType: 'customer', subjectId: i.customerId, ...entry });
  await audit(tx, ctx, {
    action: 'appointment.confirmed',
    targetType: 'appointment',
    targetId: after.id,
    before: { confirmedAt: null, confirmedVia: null },
    after: { confirmedAt: now.toISOString(), confirmedVia: i.via },
    at: now,
  });
  return { outcome: 'confirmed', row: after };
}

/** A moved visit needs a new yes: clears the confirmation. */
export async function clearConfirmation(tx: Tx, ctx: TenantContext, appointmentId: string, now: Date): Promise<void> {
  await tx
    .update(appointments)
    .set({ confirmedAt: null, confirmedVia: null, updatedAt: now })
    .where(and(eq(appointments.companyId, ctx.companyId), eq(appointments.id, appointmentId), sql`${appointments.confirmedAt} is not null`));
}
