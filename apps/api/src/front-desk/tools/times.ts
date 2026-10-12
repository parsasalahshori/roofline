import { eq } from 'drizzle-orm';
import {
  bookableMembers,
  busyFor,
  companies,
  getProperty,
  inServiceArea,
  memberHours,
  scheduleSettings,
  type TenantContext,
  type Tx,
  withTenant,
  zoneDayStart,
} from '@roofline/db';
import { DEFAULT_DURATION_MINUTES, findSlots, type BusyItem, type Interval } from '@roofline/shared';
import { locateAddress } from '../../company/location.ts';
import type { GeocodeResult } from '../../providers/geocoder.ts';
import type { AppDeps } from '../../app.ts';
import type { CompanyBlockInput, ToolHandler } from '../engine-types.ts';

/*
 * D1 Task 8: find_inspection_times, and the pieces the booking tools share. The slot logic is C1's
 * findSlots (packages/shared) run for every inspector; nothing here re-implements it.
 */

/** Inspections are 60 minutes (C1's default for the kind). */
export const INSPECTION_MINUTES = DEFAULT_DURATION_MINUTES.inspection;
/** How far ahead times are offered, in days. */
export const OFFER_DAYS = 10;
/** The most times offered in one answer. */
export const MAX_OFFERED = 6;
/** The next-best times offered when a slot was taken meanwhile. */
export const ALTERNATIVES = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

export const OUTSIDE_AREA =
  'That address may be outside the area we serve. Tell the caller we may not cover that area and someone will call them, then use take_message.';
export const ADDRESS_NOT_FOUND = 'I could not find that address. Ask the caller for the street, city and state again.';
export const LOOKUP_DOWN = 'The address lookup is not working right now. Offer to take a message so someone calls them back.';
export const NOT_THEIR_HOME = 'That address does not belong to this caller. Ask for the address again.';
export const NO_TIMES = 'There are no open inspection times in the next 10 days. Offer to take a message so someone calls them back.';

/** Settings the tool list depends on (Task 19 passes the company's block input or its settings row). */
export type ToolSettings = Pick<CompanyBlockInput, 'canMove' | 'canCancel'>;

/** Not switchable: find_inspection_times is always in the tool list. */
export function isAvailable(settings: ToolSettings): boolean {
  return settings !== null;
}

export function systemCtx(companyId: string): TenantContext {
  return { companyId, userId: null, role: 'system', canApproveSpend: false };
}

/** A slot some inspectors can take. `userIds` are in the order of the inspectors' names. */
export type OpenSlot = { start: Date; end: Date; userIds: string[] };

export type SlotWorld = {
  zone: string;
  names: Map<string, string>;
  slots: OpenSlot[];
};

/** A busy item to leave out (the visit being moved, so it does not block its own new time). */
export type IgnoreBusy = { userId: string; start: Date; end: Date; propertyId: string | null };

export async function zoneOf(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  return row?.timezone ?? 'America/Chicago';
}

/**
 * The open inspection starts in [from, to), merged across every inspector (owners and reps), from
 * fresh busy data. Inside the caller's transaction, so a booking can re-check under its lock.
 */
export async function openInspectionSlots(
  tx: Tx,
  ctx: TenantContext,
  q: { from: Date; to: Date; propertyId: string | null; now: Date; ignore?: IgnoreBusy },
): Promise<SlotWorld> {
  const settings = await scheduleSettings(tx, ctx);
  const zone = await zoneOf(tx, ctx);
  const members = await bookableMembers(tx, ctx, 'inspection');
  const busy = await busyFor(
    tx,
    ctx,
    members.map((m) => m.userId),
    q.from,
    q.to,
  );
  const byStart = new Map<number, OpenSlot>();
  for (const member of members) {
    const { workHours } = await memberHours(tx, ctx, member.userId);
    let items: BusyItem[] = busy.get(member.userId) ?? [];
    const skip = q.ignore;
    if (skip && skip.userId === member.userId) {
      const at = items.findIndex(
        (b) => b.start.getTime() === skip.start.getTime() && b.end.getTime() === skip.end.getTime() && b.propertyId === skip.propertyId,
      );
      if (at >= 0) items = items.filter((_, i) => i !== at);
    }
    const free: Interval[] = findSlots({
      workHours,
      busy: items,
      propertyId: q.propertyId,
      durationMinutes: INSPECTION_MINUTES,
      bufferMinutes: settings.travelBufferMinutes,
      from: q.from,
      to: q.to,
      timeZone: zone,
      minNoticeMinutes: settings.minNoticeMinutes,
      now: q.now,
    });
    for (const slot of free) {
      const entry = byStart.get(slot.start.getTime()) ?? { start: slot.start, end: slot.end, userIds: [] };
      entry.userIds.push(member.userId);
      byStart.set(slot.start.getTime(), entry);
    }
  }
  return {
    zone,
    names: new Map(members.map((m) => [m.userId, m.name])),
    slots: [...byStart.values()].sort((a, b) => a.start.getTime() - b.start.getTime()),
  };
}

function parts(instant: Date, zone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, ...options }).formatToParts(instant).map((p) => [p.type, p.value]));
}

/** "Thursday, October 15 at 10:00 AM" in the zone. */
export function whenWords(instant: Date, zone: string): string {
  const d = parts(instant, zone, { weekday: 'long', month: 'long', day: 'numeric' });
  const c = parts(instant, zone, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${d.weekday}, ${d.month} ${d.day} at ${c.hour}:${c.minute} ${c.dayPeriod}`;
}

/** "Thu Oct 15, 10:00 AM" in the zone: the short form for texts. */
export function whenShort(instant: Date, zone: string): string {
  const d = parts(instant, zone, { weekday: 'short', month: 'short', day: 'numeric' });
  const c = parts(instant, zone, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${d.weekday} ${d.month} ${d.day}, ${c.hour}:${c.minute} ${c.dayPeriod}`;
}

export type PartOfDay = 'morning' | 'afternoon';

/** Before noon local time is morning; noon on is afternoon. */
export function partOfDay(instant: Date, zone: string): PartOfDay {
  return Number(parts(instant, zone, { hour: 'numeric', hourCycle: 'h23' }).hour) < 12 ? 'morning' : 'afternoon';
}

function localDay(instant: Date, zone: string): string {
  const d = parts(instant, zone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${d.year}-${d.month}-${d.day}`;
}

/**
 * At most `max` starts, spread over the days: the earliest start of each morning and afternoon first
 * (in date order), then, if there is room, the next earliest of what is left.
 */
export function pickOffers(slots: readonly OpenSlot[], zone: string, max: number): OpenSlot[] {
  const firstOfBucket: OpenSlot[] = [];
  const seen = new Set<string>();
  const rest: OpenSlot[] = [];
  for (const slot of slots) {
    const bucket = `${localDay(slot.start, zone)}|${partOfDay(slot.start, zone)}`;
    if (seen.has(bucket)) rest.push(slot);
    else {
      seen.add(bucket);
      firstOfBucket.push(slot);
    }
  }
  const chosen = firstOfBucket.slice(0, max);
  for (const slot of rest) {
    if (chosen.length >= max) break;
    chosen.push(slot);
  }
  return chosen.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** One option as the model reads it: the words to say, and the values to pass back to book_inspection or move_inspection. */
export function optionLine(slot: OpenSlot, zone: string, names: Map<string, string>): string {
  const userId = slot.userIds[0]!;
  const first = (names.get(userId) ?? '').trim().split(/\s+/)[0] ?? '';
  const who = first === '' ? '' : ` with ${first}`;
  return `${whenWords(slot.start, zone)}${who} (slotStart ${slot.start.toISOString()}, slotUserId ${userId})`;
}

/**
 * The next two open starts at or after a slot that was taken (another inspector at the same time
 * counts), padded with the closest earlier ones, as lines for the model. `ignore` leaves out a visit
 * that is being moved.
 */
export async function alternativeOptions(
  tx: Tx,
  ctx: TenantContext,
  q: { slotStart: Date; takenUserId: string; propertyId: string | null; now: Date; ignore?: IgnoreBusy },
): Promise<string[]> {
  const from = new Date(Math.max(q.slotStart.getTime(), q.now.getTime()));
  const world = await openInspectionSlots(tx, ctx, {
    from,
    to: new Date(q.slotStart.getTime() + OFFER_DAYS * DAY_MS),
    propertyId: q.propertyId,
    now: q.now,
    ...(q.ignore && { ignore: q.ignore }),
  });
  const usable: OpenSlot[] = [];
  for (const s of world.slots) {
    const userIds = s.start.getTime() === q.slotStart.getTime() ? s.userIds.filter((u) => u !== q.takenUserId) : s.userIds;
    if (userIds.length > 0) usable.push({ ...s, userIds });
  }
  let picked = usable.slice(0, ALTERNATIVES);
  if (picked.length < ALTERNATIVES && q.slotStart.getTime() > q.now.getTime()) {
    const before = await openInspectionSlots(tx, ctx, {
      from: q.now,
      to: q.slotStart,
      propertyId: q.propertyId,
      now: q.now,
      ...(q.ignore && { ignore: q.ignore }),
    });
    picked = [...before.slots.slice(-(ALTERNATIVES - picked.length)), ...picked];
  }
  return picked.map((s) => optionLine(s, world.zone, world.names));
}

/** The customer id of a verified caller, else null (an unverified caller cannot confirm, move or cancel). */
export function verifiedCustomerId(conversation: { identity: string; customerId: string | null }): string | null {
  return conversation.identity === 'verified' ? conversation.customerId : null;
}

export type Located =
  | { kind: 'inside'; result: GeocodeResult }
  | { kind: 'outside' }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

/**
 * Looks an address up on the map and checks it against the company's service area. The map call is
 * outside any transaction (provider calls never run inside one).
 */
export async function locateForBooking(deps: AppDeps, ctx: TenantContext, address: string): Promise<Located> {
  const found = await locateAddress(deps.geocoder, address);
  if (found.kind !== 'located') return { kind: found.kind };
  const inside = await withTenant(deps.pools, ctx, (tx) => inServiceArea(tx, ctx, found.result.lng, found.result.lat));
  return inside ? { kind: 'inside', result: found.result } : { kind: 'outside' };
}

export function locatedMessage(located: Exclude<Located, { kind: 'inside' }>): string {
  switch (located.kind) {
    case 'outside':
      return OUTSIDE_AREA;
    case 'not_found':
      return ADDRESS_NOT_FOUND;
    case 'unavailable':
      return LOOKUP_DOWN;
  }
}

/** Queues the calendar push for an appointment after its change committed. A queue that is down must not undo the change. */
export async function queueCalendarPush(deps: AppDeps, companyId: string, appointmentId: string): Promise<void> {
  try {
    await deps.jobs.send('calendar-push', { companyId, appointmentId }, { singletonKey: appointmentId });
  } catch (err) {
    deps.logError?.(err, 'front-desk.calendar-push');
  }
}

export const findInspectionTimes: ToolHandler<'find_inspection_times'> = async (ctx, input) => {
  const { deps, companyId, conversation, now } = ctx;
  const tctx = systemCtx(companyId);

  let propertyId: string | null = null;
  if (input.propertyId !== null) {
    const home = await withTenant(deps.pools, tctx, (tx) => getProperty(tx, tctx, input.propertyId!));
    if (!home || (home.customerId !== null && conversation.customerId !== null && home.customerId !== conversation.customerId)) {
      return { ok: false, forModel: NOT_THEIR_HOME };
    }
    propertyId = home.id;
  } else if (input.address !== null && input.address.trim() !== '') {
    const located = await locateForBooking(deps, tctx, input.address.trim());
    if (located.kind !== 'inside') return { ok: false, forModel: locatedMessage(located), ...(located.kind === 'outside' && { action: 'outside_area' }) };
  }

  const { zone, names, slots } = await withTenant(deps.pools, tctx, async (tx) => {
    const zoneName = await zoneOf(tx, tctx);
    const base = input.fromDate !== null ? zoneDayStart(input.fromDate, zoneName) : now;
    const from = new Date(Math.max(base.getTime(), now.getTime()));
    const to = new Date(base.getTime() + OFFER_DAYS * DAY_MS);
    return openInspectionSlots(tx, tctx, { from, to, propertyId, now });
  });

  const wanted = input.partOfDay === 'any' ? slots : slots.filter((s) => partOfDay(s.start, zone) === input.partOfDay);
  const offers = pickOffers(wanted, zone, MAX_OFFERED);
  if (offers.length === 0) return { ok: true, forModel: NO_TIMES };

  const lines: string[] = [];
  for (const part of ['morning', 'afternoon'] as const) {
    const inPart = offers.filter((s) => partOfDay(s.start, zone) === part);
    if (inPart.length === 0) continue;
    lines.push(`${part === 'morning' ? 'Morning' : 'Afternoon'}:`);
    for (const slot of inPart) lines.push(`- ${optionLine(slot, zone, names)}`);
  }
  return {
    ok: true,
    forModel: `Open inspection times (about an hour each). Offer two at a time, in words, not the codes.\n${lines.join('\n')}`,
  };
};
