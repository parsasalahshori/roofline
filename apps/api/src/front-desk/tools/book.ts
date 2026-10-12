import {
  AppointmentLinkError,
  companyContact,
  createAppointment,
  createJob,
  createProperty,
  findBookingByKey,
  findOpenJobAt,
  findPropertyByAddress,
  getFdAppointment,
  getProperty,
  insertAssistantText,
  JobLinkError,
  lockBooking,
  lockRecipient,
  memberNames,
  recordBooking,
  resolveBookingCustomer,
  type TenantContext,
  type Tx,
  UnknownCustomerError,
  updateConversation,
  withTenant,
} from '@roofline/db';
import { isTimeZone, normalizeAddressKey } from '@roofline/shared';
import { buildGateRequest } from '../../messaging/gate-request.ts';
import { sendQueuedText, textStateFor } from '../../messaging/outbound.ts';
import type { AppDeps } from '../../app.ts';
import type { ToolHandler } from '../engine-types.ts';
import {
  alternativeOptions,
  INSPECTION_MINUTES,
  isAvailable as timesAvailable,
  locatedMessage,
  locateForBooking,
  NOT_THEIR_HOME,
  openInspectionSlots,
  queueCalendarPush,
  whenShort,
  whenWords,
  zoneOf,
} from './times.ts';
import { systemCtx } from './system-ctx.ts';

/*
 * D1 Task 8: book_inspection. One transaction makes the customer (consent 'express', source 'call'),
 * the home, a Lead job when none is open at that home, and the appointment (source 'front_desk',
 * through C1's createAppointment, so the inspection auto-move and the calendar push work as in C1).
 * The slot is re-checked with findSlots on fresh busy data under an advisory lock per inspector.
 * The confirmation text goes through the F1 send gate after the commit; a blocked text is recorded
 * and the booking still stands.
 */

const MINUTE_MS = 60 * 1000;

export const NEEDS_NAME = "Ask for the caller's first and last name, then try again.";
export const NEEDS_ADDRESS = 'Ask for the home address (street, city, state and ZIP), then try again.';
export const NEEDS_FULL_ADDRESS = 'The address needs a street, city, state and ZIP. Ask for the missing part, then try again.';
export const NOT_INSPECTOR = 'That time is not one I offered. Look up the times again.';
export const NUMBER_SHARED = 'More than one person uses this number, so I cannot book it here. Offer to take a message so someone calls them back.';
export const BOOK_FAILED = 'I could not book that. Offer to take a message so someone calls them back.';
/** A typed address that is another customer's home: the same neutral sentence, so the tool never says whose a home is (pre-review #30). */
export const HOME_TAKEN = BOOK_FAILED;

/** Always in the tool list. */
export const isAvailable = timesAvailable;

type Summary = {
  appointmentId: string;
  customerId: string;
  propertyId: string;
  startsAt: Date;
  inspectorId: string | null;
  inspectorName: string | null;
  addressLine: string;
  companyName: string;
  zone: string;
};

type Outcome =
  | { kind: 'booked'; replay: boolean; summary: Summary }
  | { kind: 'taken'; alternatives: string[] }
  | { kind: 'refused'; message: string };

export type ConfirmationResult = 'sent' | 'scheduled' | 'blocked' | 'failed';

/** The idempotency key of a booking: the conversation and the slot. */
export function bookingKey(conversationId: string, slotStart: Date): string {
  return `${conversationId}:${slotStart.toISOString()}`;
}

/** The words of the confirmation text. */
export function confirmationBody(s: Pick<Summary, 'startsAt' | 'zone' | 'inspectorName' | 'companyName' | 'addressLine'>): string {
  const first = (s.inspectorName ?? '').trim().split(/\s+/)[0] ?? '';
  const who = first === '' ? '' : ` with ${first}`;
  return `You're booked: ${whenShort(s.startsAt, s.zone)}${who} from ${s.companyName} at ${s.addressLine}. Reply C to confirm or call us to change.`;
}

/** Reads what the confirmation and the answer need, inside the transaction. */
async function summarize(
  tx: Tx,
  tctx: TenantContext,
  appointmentId: string,
  zone: string,
): Promise<Summary | null> {
  const appt = await getFdAppointment(tx, tctx, appointmentId);
  if (!appt || appt.customerId === null || appt.propertyId === null) return null;
  const home = await getProperty(tx, tctx, appt.propertyId);
  const contact = await companyContact(tx, tctx);
  const names = await memberNames(tx);
  return {
    appointmentId: appt.id,
    customerId: appt.customerId,
    propertyId: appt.propertyId,
    startsAt: appt.startsAt,
    inspectorId: appt.assignedUserId,
    inspectorName: appt.assignedUserId !== null ? (names.get(appt.assignedUserId) ?? null) : null,
    addressLine: home?.addressLine ?? '',
    companyName: contact?.name ?? '',
    zone,
  };
}

/**
 * Sends the confirmation text through the gate. Never throws: the booking already stands, so a
 * failure is logged and reported as 'failed'. A text the gate holds back is recorded (blocked or scheduled).
 */
export async function sendConfirmationText(
  deps: AppDeps,
  tctx: TenantContext,
  conversationId: string,
  s: Summary,
  now: Date,
): Promise<ConfirmationResult> {
  try {
    const body = confirmationBody(s);
    const dedupeKey = `fd-book:${s.appointmentId}`;
    type Queued = { result: ConfirmationResult; send?: { messageId: string; to: string; sender: { accountSid: string; messagingServiceSid: string } | null } };
    const queued = await withTenant(deps.pools, tctx, async (tx): Promise<Queued> => {
      await lockRecipient(tx, tctx, s.customerId);
      const built = await buildGateRequest(
        tx,
        tctx,
        { customerId: s.customerId, purpose: 'informational', body, bodyRendered: true, dedupeKey, replyToInboundAt: null },
        now,
      );
      if (!built) return { result: 'failed' as const };
      let state = textStateFor(built);
      if (state.status === 'queued' && built.toE164 === null) {
        state = { status: 'blocked', blockRule: 'contact', blockReason: 'No mobile number on file.' };
      }
      const messageId = await insertAssistantText(
        tx,
        tctx,
        { conversationId, customerId: s.customerId, body, toE164: built.toE164, dedupeKey },
        state,
        now,
      );
      // null: this booking's text was already recorded (a retry), so nothing more is sent.
      if (messageId === null) return { result: 'sent' as const };
      if (state.status === 'scheduled') return { result: 'scheduled' as const };
      if (state.status !== 'queued' || built.toE164 === null) return { result: 'blocked' as const };
      return { result: 'sent' as const, send: { messageId, to: built.toE164, sender: built.sender } };
    });
    if (queued.send) {
      await sendQueuedText(deps, tctx, { ...queued.send, body }, 'We could not send this text.');
    }
    return queued.result;
  } catch (err) {
    deps.logError?.(err, 'front-desk.confirmation-text');
    return 'failed';
  }
}

function withWho(name: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first === '' ? '' : ` with ${first}`;
}

function confirmationNote(result: ConfirmationResult): string {
  switch (result) {
    case 'sent':
      return 'A confirmation text is on its way.';
    case 'scheduled':
      return 'A confirmation text will go out later.';
    case 'blocked':
    case 'failed':
      return 'No text could be sent, so give them the details out loud and do not promise a text.';
  }
}

export const bookInspection: ToolHandler<'book_inspection'> = async (ctx, input) => {
  const { deps, companyId, conversation, now } = ctx;
  const tctx = systemCtx(companyId);
  const slotStart = new Date(input.slotStart);
  const slotEnd = new Date(slotStart.getTime() + INSPECTION_MINUTES * MINUTE_MS);
  const key = bookingKey(conversation.conversationId, slotStart);

  // The map is asked before any transaction is open. A retry of a finished booking skips it.
  const early = await withTenant(deps.pools, tctx, (tx) => findBookingByKey(tx, tctx, key));
  let place: { line: string; city: string; state: string; zip: string; lng: number; lat: number; timezone: string | null } | null = null;
  if (early === null && input.propertyId === null) {
    const address = (input.address ?? '').trim();
    if (address === '') return { ok: false, forModel: NEEDS_ADDRESS };
    const located = await locateForBooking(deps, tctx, address);
    if (located.kind !== 'inside') {
      return { ok: false, forModel: locatedMessage(located), ...(located.kind === 'outside' && { action: 'outside_area' }) };
    }
    const r = located.result;
    const line = r.street ?? address.split(',')[0]?.trim() ?? '';
    if (line === '' || !r.city || !r.state || !r.zip) return { ok: false, forModel: NEEDS_FULL_ADDRESS };
    place = { line, city: r.city, state: r.state, zip: r.zip, lng: r.lng, lat: r.lat, timezone: r.timezone !== null && isTimeZone(r.timezone) ? r.timezone : null };
  }

  let outcome: Outcome;
  try {
    outcome = await withTenant(deps.pools, tctx, async (tx): Promise<Outcome> => {
      await lockBooking(tx, tctx, key, input.slotUserId);

      const existing = await findBookingByKey(tx, tctx, key);
      if (existing) {
        const summary = await summarize(tx, tctx, existing.appointmentId, await zoneOf(tx, tctx));
        return summary ? { kind: 'booked', replay: true, summary } : { kind: 'refused', message: BOOK_FAILED };
      }

      // The home, when it is already on file (it sets the same-home buffer).
      let homeId: string | null = null;
      let homeOwner: string | null = null;
      if (input.propertyId !== null) {
        const home = await getProperty(tx, tctx, input.propertyId);
        if (!home) return { kind: 'refused', message: NOT_THEIR_HOME };
        homeId = home.id;
        homeOwner = home.customerId;
      } else if (place !== null) {
        const found = await findPropertyByAddress(tx, tctx, normalizeAddressKey(place.line, place.zip));
        homeId = found?.id ?? null;
        homeOwner = found?.customerId ?? null;
      }

      // Re-check the slot on fresh busy data, under the inspector's lock, before anything is written.
      const fresh = await openInspectionSlots(tx, tctx, { from: slotStart, to: slotEnd, propertyId: homeId, now });
      const stillOpen = fresh.slots.some((s) => s.start.getTime() === slotStart.getTime() && s.userIds.includes(input.slotUserId));
      if (!stillOpen) {
        if (!fresh.names.has(input.slotUserId)) return { kind: 'refused', message: NOT_INSPECTOR };
        return { kind: 'taken', alternatives: await alternativeOptions(tx, tctx, { slotStart, takenUserId: input.slotUserId, propertyId: homeId, now }) };
      }

      const customer = await resolveBookingCustomer(
        tx,
        tctx,
        { customerId: conversation.customerId, phone: conversation.phone, firstName: input.firstName, lastName: input.lastName },
        now,
      );
      if (customer.kind === 'needs_name') return { kind: 'refused', message: NEEDS_NAME };
      if (customer.kind === 'ambiguous') return { kind: 'refused', message: NUMBER_SHARED };
      const customerId = customer.customerId;

      if (homeOwner !== null && homeOwner !== customerId) {
        return { kind: 'refused', message: input.propertyId !== null ? NOT_THEIR_HOME : HOME_TAKEN };
      }
      if (homeId === null) {
        if (place === null) return { kind: 'refused', message: NEEDS_ADDRESS };
        const made = await createProperty(
          tx,
          tctx,
          {
            customerId,
            addressLine: place.line,
            city: place.city,
            state: place.state,
            zip: place.zip,
            location: [place.lng, place.lat],
            ...(place.timezone !== null && { timezone: place.timezone }),
          },
          { now },
        );
        homeId = made.id;
      }

      const jobId =
        (await findOpenJobAt(tx, tctx, customerId, homeId)) ??
        (await createJob(tx, tctx, { customerId, propertyId: homeId, source: 'front_desk' }, { now })).id;

      const made = await createAppointment(
        tx,
        tctx,
        {
          kind: 'inspection',
          jobId,
          customerId,
          propertyId: homeId,
          assignedUserId: input.slotUserId,
          startsAt: slotStart,
          endsAt: slotEnd,
          notes: input.notes.trim() === '' ? null : input.notes.trim(),
          source: 'front_desk',
        },
        now,
      );
      await recordBooking(tx, tctx, { key, appointmentId: made.row.id, jobId, conversationId: conversation.conversationId }, now);
      await updateConversation(tx, tctx, conversation.conversationId, {
        outcome: 'booked',
        ...(conversation.customerId === null && { customerId }),
      });

      const summary = await summarize(tx, tctx, made.row.id, fresh.zone);
      return summary ? { kind: 'booked', replay: false, summary } : { kind: 'refused', message: BOOK_FAILED };
    });
  } catch (err) {
    if (err instanceof AppointmentLinkError || err instanceof JobLinkError || err instanceof UnknownCustomerError) {
      deps.logError?.(err, 'front-desk.book');
      return { ok: false, forModel: BOOK_FAILED };
    }
    throw err;
  }

  if (outcome.kind === 'refused') return { ok: false, forModel: outcome.message };
  if (outcome.kind === 'taken') {
    const options = outcome.alternatives.length > 0 ? `\n${outcome.alternatives.map((a) => `- ${a}`).join('\n')}` : '';
    return {
      ok: false,
      forModel:
        outcome.alternatives.length > 0
          ? `That time was just taken. Say so and offer these two instead, in words, not the codes:${options}`
          : 'That time was just taken and nothing else is open. Offer to take a message so someone calls them back.',
    };
  }

  const { summary } = outcome;
  await queueCalendarPush(deps, companyId, summary.appointmentId);
  const text = await sendConfirmationText(deps, tctx, conversation.conversationId, summary, deps.clock.now());
  return {
    ok: true,
    forModel: `Booked for ${whenWords(summary.startsAt, summary.zone)}${withWho(summary.inspectorName)} at ${summary.addressLine}. ${confirmationNote(text)}`,
    shownIds: [summary.appointmentId, summary.propertyId],
    action: 'booked',
  };
};
