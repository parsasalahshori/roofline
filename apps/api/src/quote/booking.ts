import {
  AppointmentLinkError,
  createAppointment,
  g1AgentOn,
  JobLinkError,
  lockedQuoteVisit,
  lockInspector,
  quoteVisitTimes,
  setQuoteRequestAppointment,
  type TenantContext,
  withTenant,
  zoneDayAfter,
  zoneDayStart,
} from '@roofline/db';
import { isTimeZone, localDate, MAX_AVAILABILITY_DAYS, type QuoteProduct } from '@roofline/shared';
import { writeAgentNote } from '../agents/notes.ts';
import type { AppDeps } from '../app.ts';
import { INSPECTION_MINUTES, openInspectionSlots, queueCalendarPush, zoneOf } from '../front-desk/tools/times.ts';

/*
 * What the instant quote page (public/quote.ts) and the homeowner phone app (public/homeowner.ts) share once a
 * homeowner's request is filed: the open visit times they may pick from, booking the one they picked, the office's
 * alert for the new request and the speed-to-lead nudge. Moved here from public/quote.ts so both use one rule for
 * "from tomorrow", "two a day" and "the inspector's lock".
 */

export const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Where a request came from: the instant quote page, or the homeowner's phone app. */
export type RequestChannel = 'web' | 'app';

/** The next open visit times, starts only (no inspector names). */
export async function openSlots(deps: AppDeps, ctx: TenantContext, propertyId: string | null, from: Date, to: Date) {
  const now = deps.clock.now();
  return withTenant(deps.pools, ctx, (tx) => openInspectionSlots(tx, ctx, { from, to, propertyId, now }));
}

const MAX_SLOTS = 8;
const OFFER_DAYS = 10;

/** The earliest visit a homeowner may pick or be booked: midnight starting tomorrow in the company's zone (never same day). */
export async function earliestVisit(deps: AppDeps, ctx: TenantContext, now: Date): Promise<Date> {
  const zone = await withTenant(deps.pools, ctx, (tx) => zoneOf(tx, ctx));
  const tz = isTimeZone(zone) ? zone : 'UTC';
  return zoneDayStart(zoneDayAfter(localDate(now, tz)), tz);
}

/** The visit times offered to a homeowner: `{ timeZone, slots }` with each slot's id (its start), start and end. */
export type OfferedSlots = { timeZone: string; slots: { id: string; start: string; end: string }[] };

/**
 * The next open in-home visit times from tomorrow, spread over the days: at most two a day (the earliest, then one at
 * least three hours later), up to MAX_SLOTS in all. `propertyId` makes the search aware of travel to that address.
 */
export async function offeredSlots(deps: AppDeps, ctx: TenantContext, propertyId: string | null): Promise<OfferedSlots> {
  const now = deps.clock.now();
  // From tomorrow: a same-day visit a couple of hours out is more than an inspector's day can take on unseen.
  const from = await earliestVisit(deps, ctx, now);
  const world = await openSlots(deps, ctx, propertyId, from, new Date(from.getTime() + OFFER_DAYS * 24 * HOUR_MS));
  const zone = isTimeZone(world.zone) ? world.zone : 'UTC';
  const perDay = new Map<string, Date[]>();
  const picked: typeof world.slots = [];
  for (const s of world.slots) {
    if (picked.length >= MAX_SLOTS) break;
    const day = s.start.toLocaleDateString('en-CA', { timeZone: zone });
    const taken = perDay.get(day) ?? [];
    if (taken.length >= 2 || taken.some((t) => s.start.getTime() - t.getTime() < 3 * HOUR_MS)) continue;
    taken.push(s.start);
    perDay.set(day, taken);
    picked.push(s);
  }
  return { timeZone: zone, slots: picked.map((s) => ({ id: s.start.toISOString(), start: s.start.toISOString(), end: s.end.toISOString() })) };
}

/** The start and end of a visit already booked for a request, or null when it is gone. */
export async function bookedTimes(deps: AppDeps, ctx: TenantContext, appointmentId: string): Promise<{ start: string; end: string } | null> {
  const row = await withTenant(deps.pools, ctx, (tx) => quoteVisitTimes(tx, ctx, appointmentId));
  return row === null ? null : { start: row.startsAt.toISOString(), end: row.endsAt.toISOString() };
}

const ALERTS: Record<RequestChannel, { kind: string; title: string; label: string; where: string }> = {
  web: { kind: 'instant_quote_lead', title: 'New instant quote request', label: 'New request from the instant quote page', where: 'instant quote page' },
  app: { kind: 'homeowner_app_lead', title: 'New homeowner app request', label: 'New request from the homeowner app', where: 'homeowner app' },
};

/**
 * The office's alert for a new request: a note on the AI feed of Home ("New instant quote request"), linked to the
 * job. With the job's next step (due today, on every owner's and office member's My Day until someone takes it) the
 * office sees each new lead the day it comes in. Ids and products only, no name, phone or address. Never fails
 * the request.
 */
export async function officeAlert(
  deps: AppDeps,
  ctx: TenantContext,
  jobId: string,
  what: { products: QuoteProduct[]; booked: boolean; priced: boolean; channel?: RequestChannel },
): Promise<void> {
  try {
    const alert = ALERTS[what.channel ?? 'web'];
    const how = what.booked ? 'They booked a visit.' : what.priced ? 'They saw a price range; call them.' : 'No price was shown; call them.';
    await withTenant(deps.pools, ctx, (tx) =>
      writeAgentNote(
        tx,
        ctx,
        {
          agent: 'system',
          kind: alert.kind,
          title: alert.title,
          summary: `Asked about ${what.products.join(', ')}. ${how}`,
          subjectType: 'job',
          subjectId: jobId,
          label: alert.label,
        },
        deps.clock.now(),
      ),
    );
  } catch (err) {
    deps.logError?.(err, 'quote.office-alert');
  }
}

/** A visit's start and end; `already` when the request had a visit when this booking got its turn (nothing new was booked). */
export type BookedVisit = { start: string; end: string; already?: true };

/**
 * Books the visit the homeowner picked, when it is still open and not before tomorrow: re-checked on fresh busy data
 * under the inspector's lock, then made through createAppointment (so the job moves to Inspection and the calendar
 * push runs, as for any booking); the job's rep becomes the inspector and the "Call the homeowner" next step goes.
 * Any free inspector of the company may get it (no routing by area: the settings page says so). A time taken
 * meanwhile, or any booking problem, leaves the request standing with no visit (null; the page says we will call).
 * A request that already has a visit keeps it: two bookings at once (a double tap) make one visit, and the second
 * answers with the first's (`already`).
 */
export async function bookVisit(
  deps: AppDeps,
  ctx: TenantContext,
  filed: { requestId: string; customerId: string; jobId: string; propertyId: string },
  start: Date,
  channel: RequestChannel = 'web',
): Promise<BookedVisit | null> {
  const now = deps.clock.now();
  const earliest = await earliestVisit(deps, ctx, now);
  if (start.getTime() < earliest.getTime() || start.getTime() > now.getTime() + MAX_AVAILABILITY_DAYS * 24 * HOUR_MS) return null;
  const end = new Date(start.getTime() + INSPECTION_MINUTES * MINUTE_MS);
  // The slot search wants room round the visit (travel buffers), so it looks a few hours either side and matches the start.
  const from = new Date(start.getTime() - 3 * HOUR_MS);
  const to = new Date(end.getTime() + 3 * HOUR_MS);
  try {
    const made = await withTenant(deps.pools, ctx, async (tx) => {
      const before = await openInspectionSlots(tx, ctx, { from, to, propertyId: filed.propertyId, now });
      const open = before.slots.find((s) => s.start.getTime() === start.getTime());
      const inspector = open?.userIds[0];
      if (inspector === undefined) return null;
      await lockInspector(tx, ctx, inspector);
      // The request is locked too, so a second booking of it waits here and then finds the first one's visit.
      const held = await lockedQuoteVisit(tx, ctx, filed.requestId);
      if (held !== null) return { already: held };
      const fresh = await openInspectionSlots(tx, ctx, { from, to, propertyId: filed.propertyId, now });
      if (!fresh.slots.some((s) => s.start.getTime() === start.getTime() && s.userIds.includes(inspector))) return null;
      const appt = await createAppointment(
        tx,
        ctx,
        {
          kind: 'inspection',
          jobId: filed.jobId,
          customerId: filed.customerId,
          propertyId: filed.propertyId,
          assignedUserId: inspector,
          startsAt: start,
          endsAt: end,
          notes: `Booked by the homeowner on the ${ALERTS[channel].where}.`,
        },
        now,
      );
      await setQuoteRequestAppointment(tx, ctx, { requestId: filed.requestId, appointmentId: appt.row.id, jobId: filed.jobId, inspectorId: inspector }, now);
      return { booked: appt };
    });
    if (made === null) return null;
    if (made.already !== undefined) return { start: made.already.startsAt.toISOString(), end: made.already.endsAt.toISOString(), already: true };
    if (made.booked.pushDue) await queueCalendarPush(deps, ctx.companyId, made.booked.row.id);
    return { start: start.toISOString(), end: end.toISOString() };
  } catch (err) {
    if (err instanceof AppointmentLinkError || err instanceof JobLinkError) {
      deps.logError?.(err, 'quote.book');
      return null;
    }
    throw err;
  }
}

/**
 * Speed to lead: when the company's Follow-up agent is on, its run is asked for now (the same job "Run now" sends).
 * The agent decides what to do with the new lead under its own rules (consent, spacing, owner approval) and plans at
 * most once a day. Never fails the request.
 */
export async function startFollowUp(deps: AppDeps, ctx: TenantContext): Promise<void> {
  try {
    const on = await withTenant(deps.pools, ctx, (tx) => g1AgentOn(tx, ctx, 'follow_up'));
    if (on) await deps.jobs.send('followup-daily', { companyId: ctx.companyId }, { singletonKey: `quote-lead:follow_up:${ctx.companyId}` });
  } catch (err) {
    deps.logError?.(err, 'quote.follow-up');
  }
}
