import { and, eq, gt, isNull, lt, ne } from 'drizzle-orm';
import {
  AppointmentLinkError,
  appointments,
  type AppointmentRow,
  createAppointment,
  getJobClaim,
  listBusyBlocks,
  markMovedByTask,
  saveClaim,
  type TenantContext,
  type Tx,
  updateAppointment,
  userBusyIntervals,
  withTenant,
} from '@roofline/db';
import { stepTypes } from '@roofline/shared';
import type { StepHandler, StepOutcome } from '../tasks/runner.ts';

/*
 * The `create_appointment` step (G1 Task 8): books an adjuster visit or an inspection that an agent
 * drafted and a person approved. At run time it checks again that the assignee is free, books the
 * visit through the same function the calendar screen uses, links an adjuster visit to the job's
 * claim, and queues the calendar push. It texts and emails nobody (no adjuster, no insurer), and it
 * never logs the note.
 *
 * A step result can only hold numbers, so a rerun finds the appointment this step made by looking
 * for one with the same job, kind, assignee and start time, and reuses it.
 */

const UNREADABLE = "We couldn't read this booking. Please make this plan again.";
const NOT_FREE = "That time isn't free any more.";
const CANT_BOOK = "We couldn't book this visit. Please check the job and the person, then make this plan again.";

/** The appointment this step already made: same job, kind, assignee and start, not canceled. */
async function existingVisit(
  tx: Tx,
  ctx: TenantContext,
  p: { jobId: string; kind: 'adjuster' | 'inspection'; userId: string; startsAt: Date },
): Promise<AppointmentRow | null> {
  const [row] = await tx
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.companyId, ctx.companyId),
        eq(appointments.jobId, p.jobId),
        eq(appointments.kind, p.kind),
        eq(appointments.assignedUserId, p.userId),
        eq(appointments.startsAt, p.startsAt),
        ne(appointments.status, 'canceled'),
        isNull(appointments.archivedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Whether the person has a visit or a calendar busy block that overlaps [startsAt, endsAt). */
async function isBusy(tx: Tx, ctx: TenantContext, userId: string, startsAt: Date, endsAt: Date): Promise<boolean> {
  const [clash] = await tx
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.companyId, ctx.companyId),
        eq(appointments.assignedUserId, userId),
        ne(appointments.status, 'canceled'),
        isNull(appointments.archivedAt),
        lt(appointments.startsAt, endsAt),
        gt(appointments.endsAt, startsAt),
      ),
    )
    .limit(1);
  if (clash) return true;
  return (await listBusyBlocks(tx, ctx, { from: startsAt, to: endsAt, userIds: [userId] })).length > 0;
}

/** Points the job's claim at an adjuster visit, and moves it to `adjuster_scheduled` when it is earlier in the flow. */
async function linkClaim(tx: Tx, ctx: TenantContext, jobId: string, appointmentId: string, now: Date): Promise<void> {
  const claim = (await getJobClaim(tx, ctx, jobId))?.claim;
  if (!claim) return; // no claim on this job: nothing to link (saveClaim would make one)
  // A person approved this visit, so it is not bound by the reply flow: any claim earlier than the visit moves on.
  const moves = claim.status === 'not_filed' || claim.status === 'filed';
  await saveClaim(
    tx,
    ctx,
    jobId,
    { adjusterAppointmentId: appointmentId, ...(moves ? { status: 'adjuster_scheduled' as const } : {}) },
    { actor: 'agent', userId: null },
    now,
  );
}

type Booked = { kind: 'busy' } | { kind: 'booked'; appointmentId: string; created: boolean; pushDue: boolean };

export const createAppointmentStep: StepHandler = async (deps, ctx, step): Promise<StepOutcome> => {
  const parsed = stepTypes.create_appointment.payload.safeParse(step.payload);
  if (!parsed.success) return { status: 'needs_attention', result: {}, errorPlain: UNREADABLE };
  const { jobId, kind, start, end, userId, note } = parsed.data as {
    jobId: string;
    kind: 'adjuster' | 'inspection';
    start: string;
    end: string;
    userId: string;
    note: string;
  };
  const startsAt = new Date(start);
  const endsAt = new Date(end);
  const now = deps.clock.now();

  let booked: Booked;
  try {
    booked = await withTenant(deps.pools, ctx, async (tx): Promise<Booked> => {
      // A rerun (or a second delivery) finds the visit the first run made, and books nothing new.
      const existing = await existingVisit(tx, ctx, { jobId, kind, userId, startsAt });
      if (existing) {
        if (kind === 'adjuster') await linkClaim(tx, ctx, jobId, existing.id, now);
        return { kind: 'booked', appointmentId: existing.id, created: false, pushDue: true };
      }

      if (await isBusy(tx, ctx, userId, startsAt, endsAt)) return { kind: 'busy' };

      const made = await createAppointment(
        tx,
        ctx,
        { jobId, kind, startsAt, endsAt, assignedUserId: userId, notes: note, source: 'scheduler' },
        now,
      );
      if (kind === 'adjuster') await linkClaim(tx, ctx, jobId, made.row.id, now);
      return { kind: 'booked', appointmentId: made.row.id, created: true, pushDue: made.pushDue };
    });
  } catch (err) {
    if (err instanceof AppointmentLinkError) return { status: 'failed', result: {}, errorPlain: CANT_BOOK };
    throw err;
  }

  if (booked.kind === 'busy') return { status: 'failed', result: {}, errorPlain: NOT_FREE };

  // After the booking is committed, like the calendar screen (the singleton key drops a repeat, so a rerun that finds the visit pushes it again safely).
  if (booked.pushDue) {
    await deps.jobs.send('calendar-push', { companyId: ctx.companyId, appointmentId: booked.appointmentId }, { singletonKey: booked.appointmentId });
  }
  return { status: 'done', result: { created: booked.created ? 1 : 0 } };
};

/*
 * The `move_appointment` step (G1 Task 11): moves one scheduled install to a new time that a person
 * approved after a weather warning. It checks again that the install is unchanged and the new time is
 * free, never cancels, never texts or emails anyone, and never logs the reason.
 */

const UNREADABLE_MOVE = "We couldn't read this move. Please make this plan again.";
const CHANGED = 'That install was changed since this plan was made.';
const DAY_NOT_FREE = "That day isn't free any more.";

type Moved = { kind: 'failed'; errorPlain: string } | { kind: 'moved'; pushDue: boolean } | { kind: 'already' };

export const moveAppointmentStep: StepHandler = async (deps, ctx, step): Promise<StepOutcome> => {
  const parsed = stepTypes.move_appointment.payload.safeParse(step.payload);
  if (!parsed.success) return { status: 'needs_attention', result: {}, errorPlain: UNREADABLE_MOVE };
  const { appointmentId, start, end, userId } = parsed.data as {
    appointmentId: string;
    start: string;
    end: string;
    userId: string;
    reason: string;
  };
  const newStart = new Date(start);
  const newEnd = new Date(end);
  const now = deps.clock.now();

  let moved: Moved;
  try {
    moved = await withTenant(deps.pools, ctx, async (tx): Promise<Moved> => {
      const [row] = await tx
        .select()
        .from(appointments)
        .where(and(eq(appointments.id, appointmentId), eq(appointments.companyId, ctx.companyId)))
        .limit(1)
        .for('update');
      if (!row || row.archivedAt !== null) return { kind: 'failed', errorPlain: CHANGED };

      // A rerun finds the install already moved by this task (an all-day install is snapped to the company day, so only the task is compared then).
      const sameTime = row.startsAt.getTime() === newStart.getTime() && row.endsAt.getTime() === newEnd.getTime();
      if (row.movedByTaskId === step.taskId && (sameTime || row.allDay)) return { kind: 'already' };

      if (row.status !== 'scheduled' || row.assignedUserId !== userId) return { kind: 'failed', errorPlain: CHANGED };

      const busy = await userBusyIntervals(tx, ctx, { userId, from: newStart, to: newEnd, excludeAppointmentId: appointmentId });
      if (busy.length > 0) return { kind: 'failed', errorPlain: DAY_NOT_FREE };

      const updated = await updateAppointment(tx, ctx, appointmentId, { startsAt: newStart, endsAt: newEnd }, now);
      if (!updated) return { kind: 'failed', errorPlain: CHANGED };
      await markMovedByTask(tx, ctx, appointmentId, step.taskId, now);
      return { kind: 'moved', pushDue: updated.pushDue };
    });
  } catch (err) {
    if (err instanceof AppointmentLinkError) return { status: 'failed', result: {}, errorPlain: CHANGED };
    throw err;
  }

  if (moved.kind === 'failed') return { status: 'failed', result: {}, errorPlain: moved.errorPlain };
  if (moved.kind === 'moved' && moved.pushDue) {
    await deps.jobs.send('calendar-push', { companyId: ctx.companyId, appointmentId }, { singletonKey: appointmentId });
  }
  return { status: 'done', result: { moved: 1 } };
};
