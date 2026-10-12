import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import {
  audit,
  bookableMembers,
  busyFor,
  companies,
  memberHours,
  saveMemberHours,
  saveScheduleSettings,
  scheduleSettings,
  type TenantContext,
  type Tx,
  withTenant,
} from '@roofline/db';
import {
  APPOINTMENT_KINDS,
  type AppointmentKind,
  DEFAULT_DURATION_MINUTES,
  findSlots,
  type Interval,
  MAX_AVAILABILITY_DAYS,
  type MemberRef,
  type ScheduleSettings,
  WEEKDAYS,
  type WorkHours,
  WorkHoursSchema,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { requireCapability } from '../permissions.ts';
import { assertKnownFields, parse, UUID } from '../validate.ts';

/** Zone used when a company row has no time zone yet (the same default as the schema). */
const DEFAULT_ZONE = 'America/Chicago';

const TRAVEL_MESSAGE = 'Travel time must be between 0 and 120 minutes.';
const NOTICE_MESSAGE = 'Minimum notice must be between 0 and 4320 minutes.';
const STUCK_MESSAGE = 'Stuck after must be between 3 and 90 days.';
const KIND_MESSAGE = 'Please pick a kind of visit.';
const INSTALL_MESSAGE = 'Installs are booked by the day.';
const FROM_MESSAGE = 'Please pick a start time.';
const TO_MESSAGE = 'Please pick an end time.';
const ORDER_MESSAGE = 'The end must be after the start.';
const WINDOW_MESSAGE = `Please check up to ${MAX_AVAILABILITY_DAYS} days at a time.`;
const PROPERTY_MESSAGE = 'Please pick a property.';
const OWN_TIMES_MESSAGE = 'You can only check your own times.';
const HOURS_MESSAGE = 'Please check these hours.';

const SETTINGS_FIELDS = ['workHours', 'travelBufferMinutes', 'minNoticeMinutes', 'stuckAfterDays'] as const;
const HOURS_FIELDS = ['workHours'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A whole number from `min` to `max`, with the plain-English message for that field. */
const wholeNumber = (min: number, max: number, message: string) =>
  z.number({ error: message }).int(message).min(min, message).max(max, message);

/** The integer settings of the PUT body; the work hours are checked separately (their messages name the day). */
const SettingsNumbers = z.object({
  travelBufferMinutes: wholeNumber(0, 120, TRAVEL_MESSAGE),
  minNoticeMinutes: wholeNumber(0, 4320, NOTICE_MESSAGE),
  stuckAfterDays: wholeNumber(3, 90, STUCK_MESSAGE),
});

/** A zoned ISO instant, such as `2026-11-01T08:00:00-05:00` or `...Z`. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;

/** The field name for a work-hours problem: `workHours.<day>` when the message names a weekday, else `workHours`. */
function hoursField(message: string): string {
  const colon = message.indexOf(':');
  const token = colon > 0 ? message.slice(0, colon) : '';
  return (WEEKDAYS as readonly string[]).includes(token) ? `workHours.${token}` : 'workHours';
}

/**
 * Checks a weekly-hours value. A problem is a 400 whose `field` is `workHours.<day>` (the day the
 * message names), with the schema's own plain-English message.
 */
function checkedHours(input: unknown): WorkHours {
  const result = WorkHoursSchema.safeParse(input);
  if (result.success) return result.data;
  const message = result.error.issues[0]?.message ?? HOURS_MESSAGE;
  throw new AppError(400, message, hoursField(message));
}

/** The signed-in member's id. Behind the sign-in gate a member always has one. */
function signedInUserId(ctx: TenantContext): string {
  if (ctx.userId === null) throw new AppError(401, MESSAGES.signIn);
  return ctx.userId;
}

/** A UUID from the URL or query, lowercased, or null when it is not one. */
function asId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.toLowerCase();
  return UUID.test(id) ? id : null;
}

/** The company's time zone (`companies.timezone`), or the default when none is set. */
async function companyZone(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx
    .select({ timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return row?.timezone ?? DEFAULT_ZONE;
}

/** A query value that must be a visit kind that is booked by time (install is refused: it is booked by the day). */
function bookedKind(raw: unknown): Exclude<AppointmentKind, 'install'> {
  if (typeof raw !== 'string' || !(APPOINTMENT_KINDS as readonly string[]).includes(raw)) {
    throw new AppError(400, KIND_MESSAGE, 'kind');
  }
  if (raw === 'install') throw new AppError(400, INSTALL_MESSAGE, 'kind');
  return raw as Exclude<AppointmentKind, 'install'>;
}

/** A query value that must be an ISO instant. */
function instantParam(raw: unknown, field: 'from' | 'to', message: string): Date {
  if (typeof raw !== 'string' || !ISO_INSTANT.test(raw)) throw new AppError(400, message, field);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new AppError(400, message, field);
  return date;
}

/**
 * `/api/calendar`: the company's schedule settings (`/settings`), each person's weekly hours
 * (`/my-hours` for oneself, `/hours/:userId` for an owner), and suggested times (`/availability`).
 * Reads are open to any member; changing the company's settings or someone else's hours needs
 * `company_admin`. A rep only ever sees their own times. Every change is written with its audit
 * row in the same transaction. The slot logic is `findSlots` in @roofline/shared, and nothing here
 * re-implements it.
 */
export function calendarRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  router.get('/settings', async (req, res) => {
    const { ctx } = req;
    res.json(await withTenant(pools, ctx, (tx) => scheduleSettings(tx, ctx)));
  });

  router.put('/settings', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    const body = assertKnownFields(req.body, SETTINGS_FIELDS);
    const numbers = parse(SettingsNumbers, body);
    const workHours = checkedHours(body.workHours);
    const settings: ScheduleSettings = { workHours, ...numbers };
    const now = clock.now();

    const saved = await withTenant(pools, ctx, async (tx) => {
      const before = await scheduleSettings(tx, ctx);
      const after = await saveScheduleSettings(tx, ctx, settings, now);
      await audit(tx, ctx, {
        action: 'calendar.settings',
        targetType: 'company_settings',
        targetId: ctx.companyId,
        before,
        after,
        ip: req.ip ?? null,
        at: now,
      });
      return after;
    });
    res.json(saved);
  });

  router.get('/my-hours', async (req, res) => {
    const { ctx } = req;
    const userId = signedInUserId(ctx);
    res.json(await withTenant(pools, ctx, (tx) => memberHours(tx, ctx, userId)));
  });

  router.put('/my-hours', async (req, res) => {
    const { ctx } = req;
    const userId = signedInUserId(ctx);
    const body = assertKnownFields(req.body, HOURS_FIELDS);
    const hours = body.workHours === null ? null : checkedHours(body.workHours);
    const now = clock.now();

    const saved = await withTenant(pools, ctx, async (tx) => {
      const before = await memberHours(tx, ctx, userId);
      await saveMemberHours(tx, ctx, userId, hours, now);
      const after = await memberHours(tx, ctx, userId);
      await audit(tx, ctx, {
        action: 'calendar.hours',
        targetType: 'member_schedule',
        targetId: userId,
        before: { workHours: before.workHours, custom: before.custom },
        after: { workHours: after.workHours, custom: after.custom },
        ip: req.ip ?? null,
        at: now,
      });
      return after;
    });
    res.json(saved);
  });

  router.put('/hours/:userId', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    // A malformed id and another company's member look the same: not found.
    const userId = asId(req.params.userId);
    if (userId === null) throw new AppError(404, MESSAGES.notFound);
    const body = assertKnownFields(req.body, HOURS_FIELDS);
    const hours = body.workHours === null ? null : checkedHours(body.workHours);
    const now = clock.now();

    const saved = await withTenant(pools, ctx, async (tx) => {
      const members = await bookableMembers(tx, ctx, 'other');
      if (!members.some((m) => m.userId === userId)) throw new AppError(404, MESSAGES.notFound);
      const before = await memberHours(tx, ctx, userId);
      await saveMemberHours(tx, ctx, userId, hours, now);
      const after = await memberHours(tx, ctx, userId);
      await audit(tx, ctx, {
        action: 'calendar.hours',
        targetType: 'member_schedule',
        targetId: userId,
        before: { workHours: before.workHours, custom: before.custom },
        after: { workHours: after.workHours, custom: after.custom },
        ip: req.ip ?? null,
        at: now,
      });
      return after;
    });
    res.json(saved);
  });

  /**
   * Suggested times for a visit. Each slot lists the members free at that start, in list order.
   * Slots at the same start are merged across members, and the result is sorted by start.
   */
  router.get('/availability', async (req, res) => {
    const { ctx } = req;
    const query = req.query as Record<string, unknown>;

    const kind = bookedKind(query.kind);
    const from = instantParam(query.from, 'from', FROM_MESSAGE);
    const to = instantParam(query.to, 'to', TO_MESSAGE);
    if (to.getTime() <= from.getTime()) throw new AppError(400, ORDER_MESSAGE, 'to');
    if (to.getTime() - from.getTime() > MAX_AVAILABILITY_DAYS * DAY_MS) throw new AppError(400, WINDOW_MESSAGE, 'to');

    let propertyId: string | null = null;
    if (query.propertyId !== undefined && query.propertyId !== '') {
      propertyId = asId(query.propertyId);
      if (propertyId === null) throw new AppError(400, PROPERTY_MESSAGE, 'propertyId');
    }

    const durationMinutes = DEFAULT_DURATION_MINUTES[kind];
    const callerId = ctx.userId === null ? null : ctx.userId.toLowerCase();
    const requested = query.userId === undefined || query.userId === '' ? null : query.userId;

    // A rep may ask only for themselves. This check comes before the lookup, so it reveals nothing.
    if (ctx.role === 'rep' && requested !== null && asId(requested) !== callerId) {
      throw new AppError(403, OWN_TIMES_MESSAGE);
    }
    const userId = requested === null ? null : asId(requested);
    if (requested !== null && userId === null) throw new AppError(404, MESSAGES.notFound);

    const now = clock.now();
    const slots = await withTenant(pools, ctx, async (tx) => {
      const settings = await scheduleSettings(tx, ctx);
      const timeZone = await companyZone(tx, ctx);
      const bookable = await bookableMembers(tx, ctx, kind);

      let members: MemberRef[];
      if (userId !== null) {
        const match = bookable.find((m) => m.userId === userId);
        if (!match) throw new AppError(404, MESSAGES.notFound);
        members = [match];
      } else if (ctx.role === 'rep') {
        members = bookable.filter((m) => m.userId === callerId);
      } else {
        members = bookable;
      }

      const busy = await busyFor(
        tx,
        ctx,
        members.map((m) => m.userId),
        from,
        to,
      );
      const found: { member: MemberRef; free: Interval[] }[] = [];
      for (const member of members) {
        const { workHours } = await memberHours(tx, ctx, member.userId);
        found.push({
          member,
          free: findSlots({
            workHours,
            busy: busy.get(member.userId) ?? [],
            propertyId,
            durationMinutes,
            bufferMinutes: settings.travelBufferMinutes,
            from,
            to,
            timeZone,
            minNoticeMinutes: settings.minNoticeMinutes,
            now,
          }),
        });
      }

      // Merge by start: each slot lists the members free then, in list order.
      const byStart = new Map<string, { start: Date; end: Date; userIds: string[] }>();
      for (const { member, free } of found) {
        for (const slot of free) {
          const key = slot.start.toISOString();
          const entry = byStart.get(key) ?? { start: slot.start, end: slot.end, userIds: [] };
          entry.userIds.push(member.userId);
          byStart.set(key, entry);
        }
      }
      return [...byStart.values()]
        .sort((a, b) => a.start.getTime() - b.start.getTime())
        .map((entry) => ({
          start: entry.start.toISOString(),
          end: entry.end.toISOString(),
          userIds: entry.userIds,
        }));
    });
    res.json({ slots });
  });

  return router;
}
