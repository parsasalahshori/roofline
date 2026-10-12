import { and, asc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { DEFAULT_WORK_HOURS, type Interval, type WorkHours } from '@roofline/shared';
import { agentTasks, appointments, companySettings, customers, properties } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { listBusyBlocks } from './appointments.ts';

/** A scheduled install that the weather watch may move. */
export type WeatherInstall = {
  appointmentId: string;
  jobId: string | null;
  customerId: string | null;
  assignedUserId: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  lat: number;
  lng: number;
  customerFirstName: string;
  /** True when the customer has a phone with an e164 and is not do-not-contact and not archived. */
  textable: boolean;
};

export type WeatherSettings = { workHours: WorkHours; rainPct: number; gustMph: number };

const firstWord = (s: string | null | undefined): string => (s ?? '').trim().split(/\s+/)[0] ?? '';

/** The company's work hours and weather thresholds (company_settings), or defaults when no row. */
export async function weatherSettings(tx: Tx, ctx: TenantContext): Promise<WeatherSettings> {
  const [row] = await tx
    .select({ workHours: companySettings.workHours, rainPct: companySettings.weatherRainPct, gustMph: companySettings.weatherGustMph })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  return row ?? { workHours: DEFAULT_WORK_HOURS, rainPct: 60, gustMph: 25 };
}

/** Scheduled, unarchived `install` appointments starting in [from, to) with a property with coordinates and an assigned user, soonest first. */
export async function weatherInstallCandidates(tx: Tx, ctx: TenantContext, q: { from: Date; to: Date }): Promise<WeatherInstall[]> {
  const rows = await tx
    .select({
      appointmentId: appointments.id,
      jobId: appointments.jobId,
      customerId: appointments.customerId,
      assignedUserId: appointments.assignedUserId,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      allDay: appointments.allDay,
      lat: sql<number>`ST_Y(${properties.geom})`,
      lng: sql<number>`ST_X(${properties.geom})`,
      firstName: customers.firstName,
      displayName: customers.displayName,
      textable: sql<boolean>`(${customers.id} is not null and ${customers.archivedAt} is null and ${customers.doNotContact} = false and exists (select 1 from jsonb_array_elements(${customers.phones}) as p where btrim(coalesce(p->>'e164', '')) <> ''))`,
    })
    .from(appointments)
    .innerJoin(properties, and(eq(properties.companyId, appointments.companyId), eq(properties.id, appointments.propertyId)))
    .leftJoin(customers, and(eq(customers.companyId, appointments.companyId), eq(customers.id, appointments.customerId)))
    .where(
      and(
        eq(appointments.companyId, ctx.companyId),
        eq(appointments.status, 'scheduled'),
        isNull(appointments.archivedAt),
        eq(appointments.kind, 'install'),
        gte(appointments.startsAt, q.from),
        lt(appointments.startsAt, q.to),
        sql`${appointments.assignedUserId} is not null`,
        sql`${properties.geom} is not null`,
      ),
    )
    .orderBy(asc(appointments.startsAt), asc(appointments.id));
  const out: WeatherInstall[] = [];
  for (const r of rows) {
    if (r.assignedUserId === null) continue;
    out.push({
      appointmentId: r.appointmentId,
      jobId: r.jobId,
      customerId: r.customerId,
      assignedUserId: r.assignedUserId,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      allDay: r.allDay,
      lat: Number(r.lat),
      lng: Number(r.lng),
      customerFirstName: firstWord(r.firstName) || firstWord(r.displayName),
      textable: r.textable === true,
    });
  }
  return out;
}

/** True when a scheduler `weather_moves` task was created at or after `since`, or is still draft/awaiting_owner. */
export async function weatherTaskOpen(tx: Tx, ctx: TenantContext, since: Date): Promise<boolean> {
  const rows = await tx
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.companyId, ctx.companyId),
        eq(agentTasks.agent, 'scheduler'),
        eq(agentTasks.kind, 'weather_moves'),
        or(gte(agentTasks.createdAt, since), inArray(agentTasks.status, ['draft', 'awaiting_owner'])),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Time the person is busy inside [from, to): their non-canceled, unarchived appointments (except
 * `excludeAppointmentId`) plus their calendar busy blocks, as overlapping intervals (not merged).
 */
export async function userBusyIntervals(
  tx: Tx,
  ctx: TenantContext,
  q: { userId: string; from: Date; to: Date; excludeAppointmentId?: string },
): Promise<Interval[]> {
  const rows = await tx
    .select({ start: appointments.startsAt, end: appointments.endsAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.companyId, ctx.companyId),
        eq(appointments.assignedUserId, q.userId),
        ne(appointments.status, 'canceled'),
        isNull(appointments.archivedAt),
        lt(appointments.startsAt, q.to),
        gt(appointments.endsAt, q.from),
        q.excludeAppointmentId !== undefined ? ne(appointments.id, q.excludeAppointmentId) : undefined,
      ),
    );
  const blocks = await listBusyBlocks(tx, ctx, { from: q.from, to: q.to, userIds: [q.userId] });
  const out: Interval[] = [
    ...rows.map((r) => ({ start: r.start, end: r.end })),
    ...blocks.map((b) => ({ start: new Date(b.start), end: new Date(b.end) })),
  ];
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Sets appointments.moved_by_task_id (and nothing else). */
export async function markMovedByTask(tx: Tx, ctx: TenantContext, appointmentId: string, taskId: string, now: Date): Promise<void> {
  await tx
    .update(appointments)
    .set({ movedByTaskId: taskId, updatedAt: now })
    .where(and(eq(appointments.id, appointmentId), eq(appointments.companyId, ctx.companyId)));
}
