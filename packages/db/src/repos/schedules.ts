import { and, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  DEFAULT_WORK_HOURS,
  localDate,
  type AppointmentKind,
  type BusyItem,
  type MemberRef,
  type ScheduleSettings,
  type WorkHours,
} from '@roofline/shared';
import { appointments, calendarBusyBlocks, companies, companySettings, memberSchedules } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK_ZONE = 'America/Chicago';

/** The company's work hours, travel buffer, minimum notice and stuck threshold. Defaults when unset. */
export async function scheduleSettings(tx: Tx, ctx: TenantContext): Promise<ScheduleSettings> {
  const [row] = await tx
    .select({
      workHours: companySettings.workHours,
      travelBufferMinutes: companySettings.travelBufferMinutes,
      minNoticeMinutes: companySettings.minNoticeMinutes,
      stuckAfterDays: companySettings.stuckAfterDays,
    })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  if (!row) {
    return { workHours: DEFAULT_WORK_HOURS, travelBufferMinutes: 30, minNoticeMinutes: 120, stuckAfterDays: 14 };
  }
  return row;
}

/** Writes the company's schedule settings (insert or update) and returns what was saved. */
export async function saveScheduleSettings(tx: Tx, ctx: TenantContext, s: ScheduleSettings, now: Date): Promise<ScheduleSettings> {
  const [row] = await tx
    .insert(companySettings)
    .values({
      companyId: ctx.companyId,
      workHours: s.workHours,
      travelBufferMinutes: s.travelBufferMinutes,
      minNoticeMinutes: s.minNoticeMinutes,
      stuckAfterDays: s.stuckAfterDays,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: companySettings.companyId,
      set: {
        workHours: s.workHours,
        travelBufferMinutes: s.travelBufferMinutes,
        minNoticeMinutes: s.minNoticeMinutes,
        stuckAfterDays: s.stuckAfterDays,
        updatedAt: now,
      },
    })
    .returning({
      workHours: companySettings.workHours,
      travelBufferMinutes: companySettings.travelBufferMinutes,
      minNoticeMinutes: companySettings.minNoticeMinutes,
      stuckAfterDays: companySettings.stuckAfterDays,
    });
  if (!row) throw new Error('saveScheduleSettings: no company_settings row returned');
  return row;
}

/** A member's own weekly hours, or the company hours when they have none (`custom` is false then). */
export async function memberHours(tx: Tx, ctx: TenantContext, userId: string): Promise<{ workHours: WorkHours; custom: boolean }> {
  const [row] = await tx
    .select({ weeklyHours: memberSchedules.weeklyHours })
    .from(memberSchedules)
    .where(and(eq(memberSchedules.companyId, ctx.companyId), eq(memberSchedules.userId, userId)))
    .limit(1);
  // A JSON null is the "back on company hours" marker (app_tenant cannot DELETE member_schedules rows).
  if (row && row.weeklyHours !== null) return { workHours: row.weeklyHours, custom: true };
  const settings = await scheduleSettings(tx, ctx);
  return { workHours: settings.workHours, custom: false };
}

/** Sets a member's own weekly hours, or with `null` clears them so the member uses the company hours.
 * The row is kept and its weekly_hours set to a JSON null: app_tenant has no DELETE on member_schedules. */
export async function saveMemberHours(tx: Tx, ctx: TenantContext, userId: string, hours: WorkHours | null, now: Date): Promise<void> {
  const stored = hours === null ? sql<WorkHours>`'null'::jsonb` : hours;
  await tx
    .insert(memberSchedules)
    .values({ companyId: ctx.companyId, userId, weeklyHours: stored, updatedAt: now })
    .onConflictDoUpdate({
      target: [memberSchedules.companyId, memberSchedules.userId],
      set: { weeklyHours: stored, updatedAt: now },
    });
}

/**
 * Busy time for each user in `[from, to)`: their open appointments (not canceled or archived) and
 * their outside calendar blocks. Every requested user gets an entry, possibly empty. All-day rows
 * widen to whole local days in the company zone. Each list is sorted by start.
 */
export async function busyFor(
  tx: Tx,
  ctx: TenantContext,
  userIds: readonly string[],
  from: Date,
  to: Date,
): Promise<Map<string, BusyItem[]>> {
  const result = new Map<string, BusyItem[]>();
  if (userIds.length === 0) return result;
  for (const id of userIds) result.set(id, []);

  const zone = await companyZone(tx, ctx);
  // An all-day row can widen past its stored instants by up to a day either way, so the database
  // window is padded by two days and the exact overlap is checked after widening.
  const padFrom = new Date(from.getTime() - 2 * DAY_MS);
  const padTo = new Date(to.getTime() + 2 * DAY_MS);

  const apptRows = await tx
    .select({
      userId: appointments.assignedUserId,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      allDay: appointments.allDay,
      propertyId: appointments.propertyId,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.companyId, ctx.companyId),
        inArray(appointments.assignedUserId, [...userIds]),
        ne(appointments.status, 'canceled'),
        isNull(appointments.archivedAt),
        lt(appointments.startsAt, padTo),
        gt(appointments.endsAt, padFrom),
      ),
    );

  const busyRows = await tx
    .select({
      userId: calendarBusyBlocks.userId,
      startsAt: calendarBusyBlocks.startsAt,
      endsAt: calendarBusyBlocks.endsAt,
      allDay: calendarBusyBlocks.allDay,
    })
    .from(calendarBusyBlocks)
    .where(
      and(
        eq(calendarBusyBlocks.companyId, ctx.companyId),
        inArray(calendarBusyBlocks.userId, [...userIds]),
        lt(calendarBusyBlocks.startsAt, padTo),
        gt(calendarBusyBlocks.endsAt, padFrom),
      ),
    );

  for (const row of apptRows) {
    if (!row.userId) continue;
    const list = result.get(row.userId);
    if (!list) continue;
    const span = row.allDay ? wholeDays(row.startsAt, row.endsAt, zone) : { start: row.startsAt, end: row.endsAt };
    if (overlaps(span.start, span.end, from, to)) list.push({ ...span, propertyId: row.propertyId ?? null });
  }

  for (const row of busyRows) {
    const list = result.get(row.userId);
    if (!list) continue;
    const span = row.allDay ? wholeDays(row.startsAt, row.endsAt, zone) : { start: row.startsAt, end: row.endsAt };
    if (overlaps(span.start, span.end, from, to)) list.push({ ...span, propertyId: null });
  }

  for (const list of result.values()) list.sort((a, b) => a.start.getTime() - b.start.getTime());
  return result;
}

/**
 * Active members who can take a visit of this kind. Inspections go to owners and reps; every other
 * kind goes to everyone active. Ordered by name, then user id.
 */
export async function bookableMembers(tx: Tx, _ctx: TenantContext, kind: AppointmentKind): Promise<MemberRef[]> {
  const result =
    kind === 'inspection'
      ? await tx.execute(
          sql`select user_id, name from company_members where status = 'active' and role in ('owner', 'rep') order by name, user_id`,
        )
      : await tx.execute(sql`select user_id, name from company_members where status = 'active' order by name, user_id`);
  return result.rows.map((r) => ({ userId: r.user_id as string, name: r.name as string }));
}

/** The company's time zone, read from its company row. */
async function companyZone(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx
    .select({ timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return row?.timezone ?? FALLBACK_ZONE;
}

/** True when `[aStart, aEnd)` and `[bStart, bEnd)` share any time. */
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
}

/** Widens an all-day span to whole local days in `zone`: from local midnight of its first day to local midnight after its last. */
function wholeDays(startsAt: Date, endsAt: Date, zone: string): { start: Date; end: Date } {
  const firstDay = localDate(startsAt, zone);
  const lastInstant = new Date(Math.max(startsAt.getTime(), endsAt.getTime() - 1));
  const lastDay = localDate(lastInstant, zone);
  return {
    start: localMidnight(firstDay, zone),
    end: localMidnight(addDays(lastDay, 1), zone),
  };
}

/** The instant of local midnight at the start of `day` (`YYYY-MM-DD`) in `zone`. */
function localMidnight(day: string, zone: string): Date {
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  const wallMs = Date.UTC(year, month - 1, dayOfMonth);
  // Two passes: the first offset may be the one before a daylight-saving change.
  const first = wallMs - zoneOffsetMs(new Date(wallMs), zone);
  return new Date(wallMs - zoneOffsetMs(new Date(first), zone));
}

/** The calendar day `n` days after `day` (`YYYY-MM-DD`), counted on the calendar alone. */
function addDays(day: string, n: number): string {
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, dayOfMonth + n)).toISOString().slice(0, 10);
}

/** The offset of `zone` from UTC at `instant`, in milliseconds (positive east of Greenwich). */
function zoneOffsetMs(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const wholeSecondMs = Math.floor(instant.getTime() / 1000) * 1000;
  return wallAsUtc - wholeSecondMs;
}
