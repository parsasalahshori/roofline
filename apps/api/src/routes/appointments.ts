import { Router } from 'express';
import { z } from 'zod';
import {
  AppointmentLinkError,
  type AppointmentInput,
  type AppointmentPatch,
  createAppointment,
  getAppointmentView,
  listAppointments,
  listBusyBlocks,
  setAppointmentStatus,
  type TenantContext,
  updateAppointment,
  withTenant,
} from '@roofline/db';
import { APPOINTMENT_KINDS, type AppointmentKind, DEFAULT_DURATION_MINUTES } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, logErrorToConsole, MESSAGES } from '../errors.ts';
import { assertKnownFields, noNul, parse, TOO_LONG, UUID } from '../validate.ts';

const KIND_MESSAGE = 'Please pick a kind of appointment.';
const START_MESSAGE = 'Please pick a start time.';
const END_MESSAGE = 'Please pick an end time.';
const ORDER_MESSAGE = 'The end must be after the start.';
const HOME_MESSAGE = "That home isn't this customer's.";
const NOT_ON_TEAM = 'Pick someone on your team.';
const WINDOW_MESSAGE = 'Please pick a window of 62 days or less.';

/** The longest window a calendar may ask for in one request. */
const MAX_WINDOW_DAYS = 62;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** The fields of an appointment that can be sent, on create and on PATCH. Anything else is refused by name. */
const FIELDS = [
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
] as const;

const lowercase = (v: string): string => v.toLowerCase();

/** A UUID in either case, returned lowercase. */
const idField = z
  .string({ error: MESSAGES.checkField })
  .refine((v) => UUID.test(v), MESSAGES.checkField)
  .transform(lowercase);

/** An ISO 8601 instant with its zone (`Z` or an offset), as a Date. */
const instant = (message: string) =>
  z.iso.datetime({ offset: true, error: message }).transform((v) => new Date(v));

/** Trimmed text up to `max` characters; empty means "none". */
const text = (max: number) =>
  z
    .string({ error: MESSAGES.checkField })
    .trim()
    .max(max, TOO_LONG)
    .refine(noNul, MESSAGES.checkField)
    .transform((v) => (v === '' ? null : v));

const flag = z.enum(['true', 'false'], { error: MESSAGES.checkField }).transform((v) => v === 'true');

/** `userIds=a,b`: a comma list of UUIDs, returned lowercase and without repeats. */
const userIdList = z
  .string({ error: MESSAGES.checkField })
  .refine((v) => v.split(',').every((part) => UUID.test(part)), MESSAGES.checkField)
  .transform((v) => [...new Set(v.split(',').map(lowercase))]);

const ListQuery = z.object({
  from: instant(START_MESSAGE),
  to: instant(END_MESSAGE),
  userIds: userIdList.optional(),
  includeCanceled: flag.optional(),
  withBusy: flag.optional(),
});

/** Fields shared by create and PATCH. A `null` clears an optional link or note. */
const shared = {
  title: text(200).nullish(),
  jobId: idField.nullish(),
  customerId: idField.nullish(),
  propertyId: idField.nullish(),
  assignedUserId: z
    .string({ error: NOT_ON_TEAM })
    .refine((v) => UUID.test(v), NOT_ON_TEAM)
    .transform(lowercase)
    .nullish(),
  allDay: z.boolean({ error: MESSAGES.checkField }).optional(),
  notes: text(5000).nullish(),
};

const kindField = z.enum(APPOINTMENT_KINDS, { error: KIND_MESSAGE });

const CreateBody = z.object({
  kind: kindField,
  ...shared,
  startsAt: instant(START_MESSAGE),
  endsAt: instant(END_MESSAGE).optional(),
});

const PatchBody = z.object({
  kind: kindField.optional(),
  ...shared,
  startsAt: instant(START_MESSAGE).optional(),
  endsAt: instant(END_MESSAGE).optional(),
});

const StatusBody = z.object({
  note: text(500).nullish(),
});

/**
 * With no end given: an all-day appointment (an install unless allDay is false) ends 1 ms after its
 * start, and the repository snaps that span to exactly one company-zone day, DST included. A timed
 * install lasts 24 hours. Other kinds take the default length for their kind (spec 5.1).
 */
function defaultEnd(kind: AppointmentKind, startsAt: Date, allDay: boolean): Date {
  if (allDay) return new Date(startsAt.getTime() + 1);
  if (kind === 'install') return new Date(startsAt.getTime() + DAY_MS);
  return new Date(startsAt.getTime() + DEFAULT_DURATION_MINUTES[kind] * MINUTE_MS);
}

/**
 * A rep may give an appointment to themselves or to nobody, never to someone else: 403, before the
 * body is checked or anything is looked up. The repository enforces the same rule; owner and office
 * may assign any active member.
 */
function requireAssignRole(ctx: TenantContext, body: unknown): void {
  if (ctx.role !== 'rep') return;
  if (typeof body !== 'object' || body === null || !Object.hasOwn(body, 'assignedUserId')) return;
  const wanted = (body as Record<string, unknown>).assignedUserId;
  if (wanted === null || wanted === undefined) return;
  if (typeof wanted === 'string' && wanted.toLowerCase() === ctx.userId) return;
  throw new AppError(403, MESSAGES.roleCannot);
}

/**
 * Whose busy time a request may read. A rep sees only their own; owner and office see anyone's.
 * `undefined` means every connected user; an empty array means none.
 */
function busyUsers(ctx: TenantContext, requested: string[] | undefined): string[] | undefined {
  if (ctx.role !== 'rep') return requested;
  const self = ctx.userId;
  if (self === null) return [];
  if (requested === undefined) return [self];
  return requested.filter((id) => id === self);
}

/** What the repository's refusals mean to the caller: a 400 on the field that cannot be used. */
function linkRefused(err: unknown): never {
  if (err instanceof AppointmentLinkError) {
    switch (err.problem) {
      case 'endsAt':
        throw new AppError(400, ORDER_MESSAGE, 'endsAt');
      case 'job':
        throw new AppError(400, HOME_MESSAGE, 'jobId');
      case 'property':
        throw new AppError(400, HOME_MESSAGE, 'propertyId');
      case 'customer':
        throw new AppError(400, MESSAGES.checkField, 'customerId');
      case 'assignee':
        throw new AppError(400, NOT_ON_TEAM, 'assignedUserId');
    }
  }
  throw err;
}

/**
 * A calendar push is queued only after the change has committed, and only once per change. A queue
 * that is down must not fail a change that is already saved, so its error is logged and dropped.
 */
async function queuePush(deps: AppDeps, companyId: string, appointmentId: string, pushDue: boolean): Promise<void> {
  if (!pushDue) return;
  try {
    await deps.jobs.send('calendar-push', { companyId, appointmentId }, { singletonKey: appointmentId });
  } catch (err) {
    logErrorToConsole(err, 'calendar-push');
  }
}

/**
 * `/api/appointments`: list a window of appointments (with busy time when asked), create, open,
 * edit, and cancel, complete or mark a no-show.
 * - Every read and write goes through the appointment repository inside `withTenant`; the repository
 *   applies the rep visibility rule, and a record outside it is a 404 like a missing one.
 * - A rep may assign an appointment to themselves or nobody (403 otherwise). A rep reads only their
 *   own busy time.
 * - Conflicts come back as `warnings` (plain sentences), never as refusals.
 */
export function appointmentRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  /** `:id` as a lowercase UUID; anything else cannot be an appointment, so it is a 404 like a missing one. */
  const appointmentId = (raw: unknown): string => {
    const id = (typeof raw === 'string' ? raw : '').toLowerCase();
    if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
    return id;
  };

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const query = parse(ListQuery, req.query);
    const span = query.to.getTime() - query.from.getTime();
    if (span <= 0) throw new AppError(400, ORDER_MESSAGE, 'to');
    if (span > MAX_WINDOW_DAYS * DAY_MS) throw new AppError(400, WINDOW_MESSAGE, 'to');

    const users = busyUsers(ctx, query.userIds);
    const body = await withTenant(pools, ctx, async (tx) => {
      const appointments = await listAppointments(tx, ctx, {
        from: query.from,
        to: query.to,
        ...(query.userIds !== undefined && { userIds: query.userIds }),
        ...(query.includeCanceled !== undefined && { includeCanceled: query.includeCanceled }),
      });
      if (query.withBusy !== true) return { appointments };
      if (users !== undefined && users.length === 0) return { appointments, busy: [] };
      const busy = await listBusyBlocks(tx, ctx, {
        from: query.from,
        to: query.to,
        ...(users !== undefined && { userIds: users }),
      });
      return { appointments, busy };
    });
    res.json(body);
  });

  router.post('/', async (req, res) => {
    const { ctx } = req;
    requireAssignRole(ctx, req.body);
    const body = parse(CreateBody, assertKnownFields(req.body, FIELDS, { allowEmpty: true }));
    const input: AppointmentInput = {
      kind: body.kind,
      startsAt: body.startsAt,
      endsAt: body.endsAt ?? defaultEnd(body.kind, body.startsAt, body.allDay ?? body.kind === 'install'),
      ...(body.title !== undefined && { title: body.title }),
      ...(body.jobId !== undefined && { jobId: body.jobId }),
      ...(body.customerId !== undefined && { customerId: body.customerId }),
      ...(body.propertyId !== undefined && { propertyId: body.propertyId }),
      ...(body.assignedUserId !== undefined && { assignedUserId: body.assignedUserId }),
      ...(body.allDay !== undefined && { allDay: body.allDay }),
      ...(body.notes !== undefined && { notes: body.notes }),
    };

    const result = await withTenant(pools, ctx, async (tx) => {
      const created = await createAppointment(tx, ctx, input, clock.now());
      const appointment = await getAppointmentView(tx, ctx, created.row.id);
      if (!appointment) throw new AppError(404, MESSAGES.notFound);
      return { ...created, appointment };
    }).catch(linkRefused);

    await queuePush(deps, ctx.companyId, result.row.id, result.pushDue);
    res.status(201).json({ appointment: result.appointment, warnings: result.warnings, jobMoved: result.jobMoved });
  });

  router.get('/:id', async (req, res) => {
    const { ctx } = req;
    const id = appointmentId(req.params.id);
    const appointment = await withTenant(pools, ctx, (tx) => getAppointmentView(tx, ctx, id));
    if (!appointment) throw new AppError(404, MESSAGES.notFound);
    res.json(appointment);
  });

  router.patch('/:id', async (req, res) => {
    const { ctx } = req;
    const id = appointmentId(req.params.id);
    requireAssignRole(ctx, req.body);
    const body = parse(PatchBody, assertKnownFields(req.body, FIELDS));
    const patch: AppointmentPatch = {
      ...(body.kind !== undefined && { kind: body.kind }),
      ...(body.title !== undefined && { title: body.title }),
      ...(body.jobId !== undefined && { jobId: body.jobId }),
      ...(body.customerId !== undefined && { customerId: body.customerId }),
      ...(body.propertyId !== undefined && { propertyId: body.propertyId }),
      ...(body.assignedUserId !== undefined && { assignedUserId: body.assignedUserId }),
      ...(body.startsAt !== undefined && { startsAt: body.startsAt }),
      ...(body.endsAt !== undefined && { endsAt: body.endsAt }),
      ...(body.allDay !== undefined && { allDay: body.allDay }),
      ...(body.notes !== undefined && { notes: body.notes }),
    };

    const result = await withTenant(pools, ctx, async (tx) => {
      const updated = await updateAppointment(tx, ctx, id, patch, clock.now());
      if (!updated) throw new AppError(404, MESSAGES.notFound);
      const appointment = await getAppointmentView(tx, ctx, id);
      if (!appointment) throw new AppError(404, MESSAGES.notFound);
      return { ...updated, appointment };
    }).catch(linkRefused);

    await queuePush(deps, ctx.companyId, result.row.id, result.pushDue);
    res.json({ appointment: result.appointment, warnings: result.warnings });
  });

  for (const [action, status] of [
    ['cancel', 'canceled'],
    ['complete', 'completed'],
    ['no-show', 'no_show'],
  ] as const) {
    router.post(`/:id/${action}`, async (req, res) => {
      const { ctx } = req;
      const id = appointmentId(req.params.id);
      const body = parse(StatusBody, assertKnownFields(req.body ?? {}, ['note'], { allowEmpty: true }));
      const now = clock.now();

      const result = await withTenant(pools, ctx, async (tx) => {
        const changed = await setAppointmentStatus(tx, ctx, id, status, now, { note: body.note ?? undefined });
        if (!changed) throw new AppError(404, MESSAGES.notFound);
        const appointment = await getAppointmentView(tx, ctx, id);
        if (!appointment) throw new AppError(404, MESSAGES.notFound);
        return { ...changed, appointment };
      });

      await queuePush(deps, ctx.companyId, result.row.id, result.pushDue);
      res.json(result.appointment);
    });
  }

  return router;
}
