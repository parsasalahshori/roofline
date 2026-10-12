import { and, asc, eq, gt, inArray, isNull, lt, ne, or, type SQL, sql } from 'drizzle-orm';
import {
  type AppointmentKind,
  type AppointmentSource,
  type AppointmentView,
  localDate,
} from '@roofline/shared';
import { ForbiddenError } from '../errors.ts';
import {
  activities,
  appointments,
  calendarBusyBlocks,
  calendarConnections,
  calendarEventLinks,
  companies,
  customers,
  jobs,
  properties,
} from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';
import { audit } from './audit.ts';
import { getCustomer } from './customers.ts';
import { updateJob } from './jobs.ts';
import { getProperty } from './properties.ts';
import { jobScope } from './scope.ts';

export type AppointmentRow = typeof appointments.$inferSelect;

export type AppointmentInput = {
  kind: AppointmentKind;
  title?: string | null;
  jobId?: string | null;
  customerId?: string | null;
  propertyId?: string | null;
  assignedUserId?: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay?: boolean;
  notes?: string | null;
  source?: AppointmentSource;
};
export type AppointmentPatch = Partial<Omit<AppointmentInput, 'source'>>;

/**
 * Why a link, assignee or time is refused; the route turns it into a 400 with `field`:
 * - `job` (jobId), `property` (propertyId), `customer` (customerId), `assignee` (assignedUserId):
 *   not something the member can use, or not agreeing with the rest of the appointment.
 * - `endsAt`: the end is not after the start.
 */
export type AppointmentProblem = 'job' | 'property' | 'customer' | 'assignee' | 'endsAt';
export class AppointmentLinkError extends Error {
  constructor(readonly problem: AppointmentProblem) {
    super(`appointment ${problem}`);
    this.name = 'AppointmentLinkError';
  }
}

export type ChangeOrigin = { origin?: 'user' | 'pull'; activitySummary?: string };

/** A busy block from someone's outside calendar, in ISO strings. Times only. */
export type BusyBlockView = { userId: string; start: string; end: string; allDay: boolean };

// ---------------------------------------------------------------------------------------------
// Company zone helpers (DST-safe, computed with Intl; never Date local methods)

const DEFAULT_ZONE = 'America/Chicago';
const NO_USER = '00000000-0000-0000-0000-000000000000';

const KIND_LABEL: Record<AppointmentKind, string> = {
  inspection: 'Inspection',
  install: 'Install',
  adjuster: 'Adjuster visit',
  other: 'Appointment',
};

/** The kind inside a warning sentence: "Sam already has an inspection 2:00–3:00". */
const KIND_PHRASE: Record<AppointmentKind, string> = {
  inspection: 'an inspection',
  install: 'an install',
  adjuster: 'an adjuster visit',
  other: 'an appointment',
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, zone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const cacheKey = `${key}|${zone}`;
  let found = formatters.get(cacheKey);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', { timeZone: zone, ...options });
    formatters.set(cacheKey, found);
  }
  return found;
}

function partsOf(fmt: Intl.DateTimeFormat, instant: Date): Record<string, string> {
  return Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
}

/** The wall-clock reading of an instant in a zone. */
function wallClock(instant: Date, zone: string): number {
  const p = partsOf(
    formatter('wall', zone, {
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }),
    instant,
  );
  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
}

/** The zone's offset from UTC at an instant, in milliseconds (negative west of Greenwich). */
function zoneOffsetMs(instant: Date, zone: string): number {
  return wallClock(instant, zone) - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant of midnight at the start of a calendar day (`YYYY-MM-DD`) in the zone. */
export function zoneDayStart(day: string, zone: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const base = Date.UTC(y!, m! - 1, d!);
  const first = base - zoneOffsetMs(new Date(base), zone);
  return new Date(base - zoneOffsetMs(new Date(first), zone));
}

/** The calendar day after `day` (`YYYY-MM-DD`). Calendar arithmetic only; no zone is involved. */
export function zoneDayAfter(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}

function dayLabel(instant: Date, zone: string): string {
  const p = partsOf(formatter('day', zone, { weekday: 'short', month: 'short', day: 'numeric' }), instant);
  return `${p.weekday}, ${p.month} ${p.day}`;
}

/** "2:00 PM" in the zone. */
function clockLabel(instant: Date, zone: string): string {
  const p = partsOf(formatter('clock', zone, { hour: 'numeric', minute: '2-digit', hour12: true }), instant);
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** "2:00" in the zone: 12-hour, no AM or PM (the warning text). */
function clockShort(instant: Date, zone: string): string {
  const p = partsOf(formatter('clock', zone, { hour: 'numeric', minute: '2-digit', hour12: true }), instant);
  return `${p.hour}:${p.minute}`;
}

/** "Tue, Oct 13 · 2:00 PM", or "Tue, Oct 13 · all day". */
function whenLabel(instant: Date, zone: string, allDay: boolean): string {
  return allDay ? `${dayLabel(instant, zone)} · all day` : `${dayLabel(instant, zone)} · ${clockLabel(instant, zone)}`;
}

/** "2:00–3:00" in the zone (the en dash). */
function rangeLabel(start: Date, end: Date, zone: string): string {
  return `${clockShort(start, zone)}–${clockShort(end, zone)}`;
}

/** An all-day span: the company-zone midnight of the start day, and the midnight at or after the end (never before the next midnight). */
function snapAllDay(startsAt: Date, endsAt: Date, zone: string): { startsAt: Date; endsAt: Date } {
  const startDay = localDate(startsAt, zone);
  const snappedStart = zoneDayStart(startDay, zone);
  const endDay = localDate(endsAt, zone);
  let snappedEnd = zoneDayStart(endDay, zone);
  if (snappedEnd.getTime() < endsAt.getTime()) snappedEnd = zoneDayStart(zoneDayAfter(endDay), zone);
  const minEnd = zoneDayStart(zoneDayAfter(startDay), zone);
  if (snappedEnd.getTime() < minEnd.getTime()) snappedEnd = minEnd;
  return { startsAt: snappedStart, endsAt: snappedEnd };
}

async function companyZone(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx
    .select({ timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return row?.timezone ?? DEFAULT_ZONE;
}

// ---------------------------------------------------------------------------------------------
// Names and visibility

/** Every member's id and name, from the `company_members` view (the only way the tenant role sees names). */
export async function memberNames(tx: Tx): Promise<Map<string, string>> {
  const result = await tx.execute(sql`select user_id, name from company_members`);
  return new Map(result.rows.map((r) => [r.user_id as string, r.name as string]));
}

/** The name of an active member of the company, or null when they are not one. */
async function activeMemberName(tx: Tx, userId: string): Promise<string | null> {
  const result = await tx.execute(
    sql`select name from company_members where user_id = ${userId} and status = 'active' limit 1`,
  );
  const row = result.rows[0];
  return row ? (row.name as string) : null;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** A rep may give an appointment to themselves or to nobody, never to someone else. Owner, office and system may assign anyone. */
function assertMayAssign(ctx: TenantContext, assignedUserId: string | null | undefined): void {
  if (ctx.role === 'rep' && assignedUserId !== undefined && assignedUserId !== null && assignedUserId !== ctx.userId) {
    throw new ForbiddenError();
  }
}

/** Whether the member may change this appointment: owner, office and system always; a rep when it is assigned to them or they made it. */
function canEditAppointment(row: { assignedUserId: string | null; createdByUserId: string | null }, ctx: TenantContext): boolean {
  if (ctx.role !== 'rep') return true;
  return ctx.userId !== null && (row.assignedUserId === ctx.userId || row.createdByUserId === ctx.userId);
}

function assertMayEdit(row: AppointmentRow, ctx: TenantContext): void {
  if (!canEditAppointment(row, ctx)) throw new ForbiddenError();
}

/**
 * Appointments a member may see: the owner, office and system all of them; a rep those assigned to
 * them, those they made, and those on a job they may see (never another rep's on a hidden job).
 */
export function appointmentScope(ctx: TenantContext): SQL | undefined {
  if (ctx.role !== 'rep') return undefined;
  const me = ctx.userId ?? NO_USER;
  return or(
    eq(appointments.assignedUserId, me),
    eq(appointments.createdByUserId, me),
    sql`${appointments.jobId} in (select ${jobs.id} from ${jobs} where ${jobScope(ctx)})`,
  );
}

// ---------------------------------------------------------------------------------------------
// Links

type LinkCandidate = {
  jobId: string | null;
  /** undefined or null: take it from the job, or none. */
  customerId?: string | null;
  propertyId?: string | null;
};

type ResolvedLinks = {
  jobId: string | null;
  customerId: string | null;
  propertyId: string | null;
  job: { id: string; stage: string } | null;
};

/**
 * Checks the links the appointment points at, and fills the customer and address from the job when
 * they are left out. A job the member cannot see is "not found" (`job`). The job's customer and
 * address must agree with any given; an address that belongs to one customer must match the
 * appointment's customer.
 */
async function resolveLinks(tx: Tx, ctx: TenantContext, c: LinkCandidate): Promise<ResolvedLinks> {
  let job: { id: string; stage: string; customerId: string; propertyId: string } | null = null;
  if (c.jobId !== null) {
    const [row] = await tx
      .select({ id: jobs.id, stage: jobs.stage, customerId: jobs.customerId, propertyId: jobs.propertyId })
      .from(jobs)
      .where(and(eq(jobs.id, c.jobId), jobScope(ctx)))
      .limit(1);
    if (!row) throw new AppointmentLinkError('job');
    job = row;
  }

  let customerId: string | null;
  if (job) {
    if (c.customerId != null && c.customerId !== job.customerId) throw new AppointmentLinkError('job');
    customerId = job.customerId;
  } else {
    customerId = c.customerId ?? null;
    if (customerId !== null && !(await getCustomer(tx, ctx, customerId))) throw new AppointmentLinkError('customer');
  }

  let propertyId: string | null;
  if (job) {
    if (c.propertyId != null && c.propertyId !== job.propertyId) throw new AppointmentLinkError('property');
    propertyId = job.propertyId;
  } else {
    propertyId = c.propertyId ?? null;
  }

  if (propertyId !== null) {
    const property = await getProperty(tx, ctx, propertyId);
    if (!property) throw new AppointmentLinkError('property');
    if (property.customerId !== null) {
      if (customerId === null) customerId = property.customerId;
      else if (property.customerId !== customerId) throw new AppointmentLinkError('property');
    }
  }

  return { jobId: job?.id ?? null, customerId, propertyId, job };
}

// ---------------------------------------------------------------------------------------------
// Conflict warnings (plain sentences; never refusals)

async function conflictWarnings(
  tx: Tx,
  zone: string,
  p: { assigneeId: string; name: string; kind: AppointmentKind; startsAt: Date; endsAt: Date; excludeId?: string },
): Promise<string[]> {
  const warnings: string[] = [];
  const others = await tx
    .select({ kind: appointments.kind, startsAt: appointments.startsAt, endsAt: appointments.endsAt, allDay: appointments.allDay })
    .from(appointments)
    .where(
      and(
        eq(appointments.assignedUserId, p.assigneeId),
        ne(appointments.status, 'canceled'),
        isNull(appointments.archivedAt),
        lt(appointments.startsAt, p.endsAt),
        gt(appointments.endsAt, p.startsAt),
        p.excludeId === undefined ? undefined : ne(appointments.id, p.excludeId),
      ),
    )
    .orderBy(asc(appointments.startsAt), asc(appointments.id));
  for (const o of others) {
    const span = o.allDay ? 'all day' : rangeLabel(o.startsAt, o.endsAt, zone);
    warnings.push(`${p.name} already has ${KIND_PHRASE[o.kind]} ${span}`);
  }

  const busy = await tx
    .select({ startsAt: calendarBusyBlocks.startsAt, endsAt: calendarBusyBlocks.endsAt, allDay: calendarBusyBlocks.allDay })
    .from(calendarBusyBlocks)
    .innerJoin(calendarConnections, eq(calendarConnections.id, calendarBusyBlocks.connectionId))
    .where(
      and(
        eq(calendarConnections.userId, p.assigneeId),
        lt(calendarBusyBlocks.startsAt, p.endsAt),
        gt(calendarBusyBlocks.endsAt, p.startsAt),
      ),
    )
    .orderBy(asc(calendarBusyBlocks.startsAt));
  for (const b of busy) {
    const span = b.allDay ? 'all day' : rangeLabel(b.startsAt, b.endsAt, zone);
    warnings.push(`${p.name}'s calendar shows busy ${span}`);
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------
// History

const AUDITED = [
  'kind',
  'title',
  'jobId',
  'customerId',
  'propertyId',
  'assignedUserId',
  'startsAt',
  'endsAt',
  'allDay',
  'notes',
  'status',
  'canceledAt',
] as const;
type AuditedField = (typeof AUDITED)[number];

function plain(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** The fields that differ between two rows, as they were and as they are now (for the audit log). */
function changedFields(before: AppointmentRow, after: AppointmentRow): {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  names: AuditedField[];
} {
  const names = AUDITED.filter((f) => JSON.stringify(plain(before[f])) !== JSON.stringify(plain(after[f])));
  return {
    before: Object.fromEntries(names.map((f) => [f, plain(before[f])])),
    after: Object.fromEntries(names.map((f) => [f, plain(after[f])])),
    names,
  };
}

function snapshot(row: AppointmentRow): Record<string, unknown> {
  return Object.fromEntries(AUDITED.map((f) => [f, plain(row[f])]));
}

/** Timeline line on the job the appointment is for, else on its customer (no line when it has neither). */
async function appointmentActivity(
  tx: Tx,
  ctx: TenantContext,
  row: { id: string; jobId: string | null; customerId: string | null },
  kind: string,
  summary: string,
  now: Date,
): Promise<void> {
  const data = { appointmentId: row.id };
  if (row.jobId !== null) {
    await addActivity(tx, ctx, { subjectType: 'job', subjectId: row.jobId, kind, summary, data, at: now });
  } else if (row.customerId !== null) {
    await addActivity(tx, ctx, { subjectType: 'customer', subjectId: row.customerId, kind, summary, data, at: now });
  }
}

/** The inspection auto-move's line: exactly one, even if it is written again. */
async function addJobLineOnce(tx: Tx, ctx: TenantContext, jobId: string, summary: string, now: Date): Promise<void> {
  const [existing] = await tx
    .select({ id: activities.id })
    .from(activities)
    .where(and(eq(activities.subjectType, 'job'), eq(activities.subjectId, jobId), eq(activities.summary, summary)))
    .limit(1);
  if (existing) return;
  await addActivity(tx, ctx, { subjectType: 'job', subjectId: jobId, kind: 'job.stage_changed', summary, at: now });
}

// ---------------------------------------------------------------------------------------------
// Writes

/**
 * Books an appointment at `now`, made by `ctx.userId`. Throws `AppointmentLinkError` for a link the
 * member cannot use or that disagrees, or an end that is not after the start; `ForbiddenError` when
 * a rep assigns someone else. Returns the row, the conflict warnings, whether an inspection moved its
 * job from Lead to Inspection, and whether a `calendar-push` is due (an assignee exists).
 * Install defaults to all day; all-day spans snap to the company zone's midnights.
 */
export async function createAppointment(
  tx: Tx,
  ctx: TenantContext,
  i: AppointmentInput,
  now: Date,
): Promise<{ row: AppointmentRow; warnings: string[]; jobMoved: boolean; pushDue: boolean }> {
  assertMayAssign(ctx, i.assignedUserId);
  if (!(i.endsAt > i.startsAt)) throw new AppointmentLinkError('endsAt');
  const zone = await companyZone(tx, ctx);
  const links = await resolveLinks(tx, ctx, {
    jobId: i.jobId ?? null,
    customerId: i.customerId,
    propertyId: i.propertyId,
  });

  const assigneeId = i.assignedUserId ?? null;
  const assigneeName = assigneeId !== null ? await activeMemberName(tx, assigneeId) : null;
  if (assigneeId !== null && assigneeName === null) throw new AppointmentLinkError('assignee');

  const allDay = i.allDay ?? i.kind === 'install';
  const times = allDay ? snapAllDay(i.startsAt, i.endsAt, zone) : { startsAt: i.startsAt, endsAt: i.endsAt };

  const [row] = await tx
    .insert(appointments)
    .values({
      companyId: ctx.companyId,
      kind: i.kind,
      title: i.title ?? null,
      jobId: links.jobId,
      customerId: links.customerId,
      propertyId: links.propertyId,
      assignedUserId: assigneeId,
      startsAt: times.startsAt,
      endsAt: times.endsAt,
      allDay,
      status: 'scheduled',
      notes: i.notes ?? null,
      source: i.source ?? 'manual',
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const created = row!;

  const warnings =
    assigneeId !== null && assigneeName !== null
      ? await conflictWarnings(tx, zone, {
          assigneeId,
          name: assigneeName,
          kind: created.kind,
          startsAt: created.startsAt,
          endsAt: created.endsAt,
          excludeId: created.id,
        })
      : [];

  let jobMoved = false;
  if (i.kind === 'inspection' && links.job !== null && links.job.stage === 'lead') {
    await updateJob(tx, ctx, links.job.id, { stage: 'inspection' }, { now });
    await addJobLineOnce(tx, ctx, links.job.id, 'Moved to Inspection — inspection booked', now);
    jobMoved = true;
  }

  const withName = assigneeName !== null ? ` with ${firstName(assigneeName)}` : '';
  await appointmentActivity(
    tx,
    ctx,
    created,
    'appointment.booked',
    `${KIND_LABEL[created.kind]} booked for ${whenLabel(created.startsAt, zone, allDay)}${withName}`,
    now,
  );

  await audit(tx, ctx, {
    action: 'appointment.created',
    targetType: 'appointment',
    targetId: created.id,
    after: snapshot(created),
    at: now,
  });

  return { row: created, warnings, jobMoved, pushDue: assigneeId !== null };
}

/**
 * Changes an appointment the member may see and edit (null when they may not see it). A rep who
 * may see but not edit it is refused (`ForbiddenError`). Moving the times adds "<Kind> moved to
 * <when>" to its timeline (or `origin.activitySummary`); the audit row lists the fields that changed.
 * `pushDue` is true when the change did not come from the person's calendar and an assignee exists now or existed before.
 */
export async function updateAppointment(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  p: AppointmentPatch,
  now: Date,
  o: ChangeOrigin = {},
): Promise<{ row: AppointmentRow; warnings: string[]; pushDue: boolean } | null> {
  const [before] = await tx
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, id), isNull(appointments.archivedAt), appointmentScope(ctx)))
    .limit(1)
    .for('update');
  if (!before) return null;
  assertMayEdit(before, ctx);
  assertMayAssign(ctx, p.assignedUserId);

  const zone = await companyZone(tx, ctx);
  const jobChanged = p.jobId !== undefined && p.jobId !== before.jobId;
  const detachingJob = p.jobId === null;
  // Links are re-checked only when the patch changes one; a member who may edit the appointment may keep a job they can no longer see (e.g. after the inspection auto-move).
  const linksChanged =
    (p.jobId !== undefined && p.jobId !== before.jobId) ||
    (p.customerId !== undefined && p.customerId !== before.customerId) ||
    (p.propertyId !== undefined && p.propertyId !== before.propertyId);
  const links: ResolvedLinks = linksChanged
    ? await resolveLinks(tx, ctx, {
        jobId: p.jobId !== undefined ? p.jobId : before.jobId,
        customerId: p.customerId !== undefined ? p.customerId : jobChanged && !detachingJob ? null : before.customerId,
        propertyId: p.propertyId !== undefined ? p.propertyId : jobChanged && !detachingJob ? null : before.propertyId,
      })
    : { jobId: before.jobId, customerId: before.customerId, propertyId: before.propertyId, job: null };

  const kind = p.kind ?? before.kind;
  const rawStart = p.startsAt ?? before.startsAt;
  const rawEnd = p.endsAt ?? before.endsAt;
  if (!(rawEnd > rawStart)) throw new AppointmentLinkError('endsAt');
  const allDay = p.allDay ?? before.allDay;
  const times = allDay ? snapAllDay(rawStart, rawEnd, zone) : { startsAt: rawStart, endsAt: rawEnd };

  const assigneeId = p.assignedUserId !== undefined ? p.assignedUserId : before.assignedUserId;
  const assigneeChanged = assigneeId !== before.assignedUserId;
  const assigneeName = assigneeId !== null ? await activeMemberName(tx, assigneeId) : null;
  if (assigneeId !== null && assigneeName === null && assigneeChanged) throw new AppointmentLinkError('assignee');

  const [updated] = await tx
    .update(appointments)
    .set({
      kind,
      title: p.title !== undefined ? p.title : before.title,
      jobId: links.jobId,
      customerId: links.customerId,
      propertyId: links.propertyId,
      assignedUserId: assigneeId,
      startsAt: times.startsAt,
      endsAt: times.endsAt,
      allDay,
      notes: p.notes !== undefined ? p.notes : before.notes,
      updatedAt: now,
    })
    .where(eq(appointments.id, id))
    .returning();
  const after = updated!;

  const warnings =
    assigneeId !== null && assigneeName !== null
      ? await conflictWarnings(tx, zone, {
          assigneeId,
          name: assigneeName,
          kind: after.kind,
          startsAt: after.startsAt,
          endsAt: after.endsAt,
          excludeId: id,
        })
      : [];

  const timesMoved = before.startsAt.getTime() !== after.startsAt.getTime() || before.endsAt.getTime() !== after.endsAt.getTime();
  const changes = changedFields(before, after);
  if (timesMoved) {
    await appointmentActivity(
      tx,
      ctx,
      after,
      'appointment.moved',
      o.activitySummary ?? `${KIND_LABEL[after.kind]} moved to ${whenLabel(after.startsAt, zone, after.allDay)}`,
      now,
    );
  } else if (changes.names.length > 0 && o.activitySummary !== undefined) {
    await appointmentActivity(tx, ctx, after, 'appointment.updated', o.activitySummary, now);
  }

  await audit(tx, ctx, {
    action: 'appointment.updated',
    targetType: 'appointment',
    targetId: id,
    before: changes.before,
    after: changes.after,
    at: now,
  });

  return {
    row: after,
    warnings,
    pushDue: o.origin !== 'pull' && (assigneeId !== null || before.assignedUserId !== null),
  };
}

const STATUS_WORDS: Record<'completed' | 'canceled' | 'no_show', { phrase: string; action: string }> = {
  canceled: { phrase: 'canceled', action: 'appointment.canceled' },
  completed: { phrase: 'marked done', action: 'appointment.completed' },
  no_show: { phrase: 'no-show', action: 'appointment.no_show' },
};

/**
 * Cancels, completes or marks a no-show on an appointment the member may edit; null when they may
 * not see it. Setting the status it already has changes nothing. A note is added to the timeline line.
 */
export async function setAppointmentStatus(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  status: 'completed' | 'canceled' | 'no_show',
  now: Date,
  o: ChangeOrigin & { note?: string } = {},
): Promise<{ row: AppointmentRow; pushDue: boolean } | null> {
  const [before] = await tx
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, id), isNull(appointments.archivedAt), appointmentScope(ctx)))
    .limit(1)
    .for('update');
  if (!before) return null;
  assertMayEdit(before, ctx);
  if (before.status === status) return { row: before, pushDue: false };

  const [updated] = await tx
    .update(appointments)
    .set({
      status,
      canceledAt: status === 'canceled' ? now : null,
      updatedAt: now,
    })
    .where(eq(appointments.id, id))
    .returning();
  const after = updated!;

  const word = STATUS_WORDS[status];
  const note = o.note?.trim();
  const summary = o.activitySummary ?? `${KIND_LABEL[after.kind]} ${word.phrase}${note ? ` — ${note}` : ''}`;
  await appointmentActivity(tx, ctx, after, word.action, summary, now);

  const changes = changedFields(before, after);
  await audit(tx, ctx, {
    action: word.action,
    targetType: 'appointment',
    targetId: id,
    before: changes.before,
    after: changes.after,
    at: now,
  });

  return {
    row: after,
    pushDue: o.origin !== 'pull' && (after.assignedUserId !== null || before.assignedUserId !== null),
  };
}

// ---------------------------------------------------------------------------------------------
// Reads

export type AppointmentJoinRow = {
  appointment: AppointmentRow;
  customerName: string | null;
  addressLine: string | null;
};

/** Appointments matching a condition (already scoped), oldest first, with the customer name and address. */
export async function loadAppointmentRows(tx: Tx, where: SQL | undefined, limit: number): Promise<AppointmentJoinRow[]> {
  return tx
    .select({
      appointment: appointments,
      customerName: customers.displayName,
      addressLine: properties.addressLine,
    })
    .from(appointments)
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .leftJoin(properties, eq(properties.id, appointments.propertyId))
    .where(where)
    .orderBy(asc(appointments.startsAt), asc(appointments.id))
    .limit(limit);
}

/** Builds the views for joined rows: the assignee's name, the calendar sync state and whether the member may edit. */
export async function appointmentViews(
  tx: Tx,
  ctx: TenantContext,
  rows: AppointmentJoinRow[],
): Promise<AppointmentView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.appointment.id);
  const assigneeIds = [...new Set(rows.flatMap((r) => (r.appointment.assignedUserId !== null ? [r.appointment.assignedUserId] : [])))];

  const names = await memberNames(tx);
  const links = await tx
    .select({ appointmentId: calendarEventLinks.appointmentId, pushErrorPlain: calendarEventLinks.pushErrorPlain })
    .from(calendarEventLinks)
    .where(inArray(calendarEventLinks.appointmentId, ids));
  const linkBy = new Map(links.map((l) => [l.appointmentId, l]));
  const connected =
    assigneeIds.length === 0
      ? []
      : await tx
          .select({ userId: calendarConnections.userId })
          .from(calendarConnections)
          .where(and(inArray(calendarConnections.userId, assigneeIds), eq(calendarConnections.status, 'connected')));
  const connectedSet = new Set(connected.map((c) => c.userId));

  return rows.map(({ appointment: a, customerName, addressLine }) => {
    const link = linkBy.get(a.id);
    const sync: AppointmentView['sync'] = link
      ? link.pushErrorPlain !== null
        ? 'failed'
        : 'synced'
      : a.assignedUserId !== null && connectedSet.has(a.assignedUserId)
        ? 'pending'
        : 'none';
    const assignedName = a.assignedUserId !== null ? names.get(a.assignedUserId) : undefined;
    return {
      id: a.id,
      kind: a.kind,
      title: a.title ?? KIND_LABEL[a.kind],
      status: a.status,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      allDay: a.allDay,
      assigned: a.assignedUserId !== null && assignedName !== undefined ? { userId: a.assignedUserId, name: assignedName } : null,
      jobId: a.jobId,
      customerId: a.customerId,
      customerName: customerName ?? null,
      propertyId: a.propertyId,
      addressLine: addressLine ?? null,
      notes: a.notes,
      source: a.source,
      sync,
      canEdit: canEditAppointment(a, ctx),
    };
  });
}

/** Appointments the member may see that overlap [from, to), oldest first. Canceled ones only when asked. */
export async function listAppointments(
  tx: Tx,
  ctx: TenantContext,
  q: { from: Date; to: Date; userIds?: string[]; includeCanceled?: boolean },
): Promise<AppointmentView[]> {
  if (q.userIds !== undefined && q.userIds.length === 0) return [];
  const rows = await loadAppointmentRows(
    tx,
    and(
      lt(appointments.startsAt, q.to),
      gt(appointments.endsAt, q.from),
      isNull(appointments.archivedAt),
      q.userIds !== undefined ? inArray(appointments.assignedUserId, q.userIds) : undefined,
      q.includeCanceled === true ? undefined : ne(appointments.status, 'canceled'),
      appointmentScope(ctx),
    ),
    2000,
  );
  return appointmentViews(tx, ctx, rows);
}

/** Busy blocks overlapping [from, to) for the given users (every connected user when omitted). A rep sees only their own. */
export async function listBusyBlocks(
  tx: Tx,
  ctx: TenantContext,
  q: { from: Date; to: Date; userIds?: string[] },
): Promise<BusyBlockView[]> {
  if (q.userIds !== undefined && q.userIds.length === 0) return [];
  const me = ctx.userId;
  if (ctx.role === 'rep' && me === null) return [];
  const rows = await tx
    .select({
      userId: calendarConnections.userId,
      startsAt: calendarBusyBlocks.startsAt,
      endsAt: calendarBusyBlocks.endsAt,
      allDay: calendarBusyBlocks.allDay,
    })
    .from(calendarBusyBlocks)
    .innerJoin(calendarConnections, eq(calendarConnections.id, calendarBusyBlocks.connectionId))
    .where(
      and(
        lt(calendarBusyBlocks.startsAt, q.to),
        gt(calendarBusyBlocks.endsAt, q.from),
        ctx.role === 'rep' && me !== null ? eq(calendarConnections.userId, me) : undefined,
        q.userIds !== undefined ? inArray(calendarConnections.userId, q.userIds) : undefined,
      ),
    )
    .orderBy(asc(calendarBusyBlocks.startsAt), asc(calendarBusyBlocks.id));
  return rows.map((r) => ({
    userId: r.userId,
    start: r.startsAt.toISOString(),
    end: r.endsAt.toISOString(),
    allDay: r.allDay,
  }));
}

/** A job's appointments the member may see, oldest first (canceled ones included, as history). */
export async function listAppointmentsForJob(tx: Tx, ctx: TenantContext, jobId: string): Promise<AppointmentView[]> {
  const rows = await loadAppointmentRows(
    tx,
    and(eq(appointments.jobId, jobId), isNull(appointments.archivedAt), appointmentScope(ctx)),
    500,
  );
  return appointmentViews(tx, ctx, rows);
}

/** A customer's upcoming appointments the member may see: not canceled, not yet over, soonest first. */
export async function listAppointmentsForCustomer(
  tx: Tx,
  ctx: TenantContext,
  customerId: string,
  limit: number,
  now: Date,
): Promise<AppointmentView[]> {
  const rows = await loadAppointmentRows(
    tx,
    and(
      eq(appointments.customerId, customerId),
      ne(appointments.status, 'canceled'),
      isNull(appointments.archivedAt),
      gt(appointments.endsAt, now),
      appointmentScope(ctx),
    ),
    limit,
  );
  return appointmentViews(tx, ctx, rows);
}

/** One appointment the member may see, or null. */
export async function getAppointmentView(tx: Tx, ctx: TenantContext, id: string): Promise<AppointmentView | null> {
  const rows = await loadAppointmentRows(
    tx,
    and(eq(appointments.id, id), isNull(appointments.archivedAt), appointmentScope(ctx)),
    1,
  );
  const [view] = await appointmentViews(tx, ctx, rows);
  return view ?? null;
}
