import { and, asc, eq, inArray, isNull, lt, gt, lte, ne, not, or, sql } from 'drizzle-orm';
import { daysInStage, isStuck, localDate, type JobCard, type TodayView } from '@roofline/shared';
import { appointments, customers, jobs, properties } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { canSeeJobValue, jobScope } from './scope.ts';
import {
  appointmentScope,
  appointmentViews,
  loadAppointmentRows,
  memberNames,
  zoneDayAfter,
  zoneDayStart,
} from './appointments.ts';

/**
 * The member's Today, in the company zone. `appointments`: their own appointments that overlap
 * today and are not canceled, in their scope. `followUps`: visible jobs that are not archived, not
 * installed or lost, and whose next step is due today or earlier. Owner and office see follow-ups
 * on jobs assigned to them, or unassigned jobs they created; a rep gets every job their scope shows.
 */
export async function todayView(
  tx: Tx,
  ctx: TenantContext,
  now: Date,
  timeZone: string,
  stuckAfterDays: number,
): Promise<TodayView> {
  const today = localDate(now, timeZone);
  const dayStart = zoneDayStart(today, timeZone);
  const dayEnd = zoneDayStart(zoneDayAfter(today), timeZone);
  const me = ctx.userId;

  const todaysRows = await loadAppointmentRows(
    tx,
    and(
      me === null ? sql`false` : eq(appointments.assignedUserId, me),
      isNull(appointments.archivedAt),
      ne(appointments.status, 'canceled'),
      lt(appointments.startsAt, dayEnd),
      gt(appointments.endsAt, dayStart),
      appointmentScope(ctx),
    ),
    200,
  );
  const todaysAppointments = await appointmentViews(tx, ctx, todaysRows);

  let ownerScope: ReturnType<typeof or> | undefined;
  if (ctx.role !== 'rep') {
    ownerScope =
      me === null
        ? sql`false`
        : or(eq(jobs.assignedUserId, me), and(isNull(jobs.assignedUserId), eq(jobs.createdByUserId, me)));
  }

  const followRows = await tx
    .select({
      job: jobs,
      customerName: customers.displayName,
      addressLine: properties.addressLine,
    })
    .from(jobs)
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .where(
      and(
        jobScope(ctx),
        isNull(jobs.archivedAt),
        lte(jobs.nextStepOn, today),
        not(inArray(jobs.stage, ['installed', 'lost'])),
        ownerScope,
      ),
    )
    .orderBy(asc(jobs.nextStepOn), asc(jobs.id));

  const names = await memberNames(tx);
  const followUps: JobCard[] = followRows.map(({ job, customerName, addressLine }) => {
    const days = daysInStage(job.stageChangedAt, now, timeZone);
    const assignedName = job.assignedUserId !== null ? names.get(job.assignedUserId) : undefined;
    return {
      id: job.id,
      customerId: job.customerId,
      customerName,
      propertyId: job.propertyId,
      addressLine,
      stage: job.stage,
      valueCents: canSeeJobValue(ctx, job) ? job.valueCents : null,
      assigned:
        job.assignedUserId !== null && assignedName !== undefined
          ? { userId: job.assignedUserId, name: assignedName }
          : null,
      daysInStage: days,
      stuck: isStuck(job.stage, days, stuckAfterDays),
      nextStep: job.nextStep,
      nextStepOn: job.nextStepOn,
      updatedAt: job.updatedAt.toISOString(),
    };
  });

  return { appointments: todaysAppointments, followUps };
}
