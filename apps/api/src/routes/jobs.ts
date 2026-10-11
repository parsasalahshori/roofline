import { Router } from 'express';
import { z } from 'zod';
import {
  canSeeJobValue,
  createJob,
  getJob,
  JobLinkError,
  type JobRow,
  listJobs,
  setJobArchived,
  type TenantContext,
  updateJob,
  withTenant,
} from '@roofline/db';
import { JOB_SOURCES, JOB_STAGE_LABELS, JOB_STAGES } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { assertKnownFields, limitParam, noNul, offsetParam, parse, UUID } from '../validate.ts';

const PICK_CUSTOMER = 'Please pick a customer.';
const PICK_ADDRESS = 'Please pick an address.';
const NO_CUSTOMER = "We couldn't find that customer.";
const NO_ADDRESS = "We couldn't find that address.";
const WRONG_CUSTOMER = 'That address belongs to a different customer.';
const NOT_ON_TEAM = 'Pick someone on your team.';
const STAGE_MESSAGE = 'Please pick a valid stage.';
const SOURCE_MESSAGE = 'Please pick a valid source.';
const VALUE_MESSAGE = 'Please enter the job value in cents, as a whole number.';
const REASON_TOO_LONG = 'Please keep the reason to 500 characters or fewer.';
const ASSIGNED_MESSAGE = 'Please use me or unassigned.';

/** The largest number the database column (a 32-bit integer) holds. */
const MAX_VALUE_CENTS = 2_147_483_647;

/** The fields of a job that can be sent, on create and on PATCH. Anything else is refused by name. */
const FIELDS = ['customerId', 'propertyId', 'stage', 'source', 'valueCents', 'assignedUserId', 'lostReason'] as const;

const lowercase = (v: string): string => v.toLowerCase();

const uuidField = (missing: string, malformed: string) =>
  z
    .string({ error: missing })
    .refine((v) => UUID.test(v), malformed)
    .transform(lowercase);

const Fields = {
  customerId: uuidField(PICK_CUSTOMER, NO_CUSTOMER),
  propertyId: uuidField(PICK_ADDRESS, NO_ADDRESS),
  stage: z.enum(JOB_STAGES, { error: STAGE_MESSAGE }),
  source: z.enum(JOB_SOURCES, { error: SOURCE_MESSAGE }),
  valueCents: z.number({ error: VALUE_MESSAGE }).int(VALUE_MESSAGE).min(0, VALUE_MESSAGE).max(MAX_VALUE_CENTS, VALUE_MESSAGE),
  assignedUserId: uuidField(NOT_ON_TEAM, NOT_ON_TEAM),
  // Trimmed; empty means "no reason".
  lostReason: z
    .string({ error: MESSAGES.checkField })
    .trim()
    .max(500, REASON_TOO_LONG)
    .refine(noNul, MESSAGES.checkField)
    .transform((v) => (v === '' ? null : v)),
} as const;

const CreateBody = z.object({
  customerId: Fields.customerId,
  propertyId: Fields.propertyId,
  stage: Fields.stage.optional(),
  source: Fields.source.optional(),
  valueCents: Fields.valueCents.nullish(),
  assignedUserId: Fields.assignedUserId.nullish(),
  lostReason: Fields.lostReason.nullish(),
});

const PatchBody = z.object({
  customerId: Fields.customerId.optional(),
  propertyId: Fields.propertyId.optional(),
  stage: Fields.stage.optional(),
  source: Fields.source.optional(),
  valueCents: Fields.valueCents.nullish(),
  assignedUserId: Fields.assignedUserId.nullish(),
  lostReason: Fields.lostReason.nullish(),
});

const idQuery = z
  .string({ error: MESSAGES.checkField })
  .refine((v) => UUID.test(v), MESSAGES.checkField)
  .transform(lowercase)
  .optional();

const ListQuery = z.object({
  stage: Fields.stage.optional(),
  assigned: z.enum(['me', 'unassigned'], { error: ASSIGNED_MESSAGE }).optional(),
  customerId: idQuery,
  propertyId: idQuery,
  limit: limitParam,
  offset: offsetParam,
  includeArchived: z
    .enum(['true', 'false'], { error: MESSAGES.checkField })
    .transform((v) => v === 'true')
    .optional(),
});

/**
 * A rep may give a job to themselves or to nobody, never to someone else: 403, before the body is
 * checked or the job is looked up, so it says nothing about jobs the rep cannot see. The
 * repository enforces the same rule; owner and office may assign anyone.
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
 * The job as the API shows it. `valueCents` is left out (not null) for a rep on a job that is
 * neither assigned to them nor created by them: they can see an unassigned lead, not what it is worth.
 */
function jobBody(row: JobRow, ctx: TenantContext) {
  return {
    id: row.id,
    customerId: row.customerId,
    propertyId: row.propertyId,
    stage: row.stage,
    stageLabel: JOB_STAGE_LABELS[row.stage],
    stageChangedAt: row.stageChangedAt,
    source: row.source,
    ...(canSeeJobValue(ctx, row) && { valueCents: row.valueCents }),
    assignedUserId: row.assignedUserId,
    createdByUserId: row.createdByUserId,
    lostReason: row.lostReason,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** What the repository's refusals mean to the caller: a 400 on the field that cannot be used. */
function refused(err: unknown): never {
  if (err instanceof JobLinkError) {
    switch (err.problem) {
      case 'customer':
        throw new AppError(400, NO_CUSTOMER, 'customerId');
      case 'property':
        throw new AppError(400, NO_ADDRESS, 'propertyId');
      case 'propertyCustomer':
        throw new AppError(400, WRONG_CUSTOMER, 'propertyId');
      case 'assignee':
        throw new AppError(400, NOT_ON_TEAM, 'assignedUserId');
    }
  }
  throw err;
}

/**
 * `/api/jobs`: list, create, open, edit (stage, value, assignee, ...), archive and restore.
 * - Reps work with the jobs the visibility rule gives them (scope.ts): assigned to them, created by
 *   them, or an unassigned lead. Any other job is a 404, and the repository applies that.
 * - A rep sees `valueCents` only on a job assigned to or created by them.
 * - A rep may assign a job to themselves or nobody; owner and office may assign any active member.
 * - Every edit is audited (before and after); a move to another stage, an assignment and an
 *   archive are added to the job's timeline, and a new job to its customer's.
 */
export function jobRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  /** `:id` as a lowercase UUID; anything else cannot be a job, so it is a 404 like a missing one. */
  const jobId = (raw: unknown): string => {
    const id = (typeof raw === 'string' ? raw : '').toLowerCase();
    if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
    return id;
  };

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const query = parse(ListQuery, req.query);
    const result = await withTenant(pools, ctx, (tx) => listJobs(tx, ctx, query));
    res.json({ jobs: result.jobs.map((row) => jobBody(row, ctx)), total: result.total });
  });

  router.post('/', async (req, res) => {
    const { ctx } = req;
    requireAssignRole(ctx, req.body);
    const body = parse(CreateBody, assertKnownFields(req.body, FIELDS, { allowEmpty: true }));

    const created = await withTenant(pools, ctx, (tx) =>
      createJob(
        tx,
        ctx,
        {
          customerId: body.customerId,
          propertyId: body.propertyId,
          ...(body.stage !== undefined && { stage: body.stage }),
          ...(body.source !== undefined && { source: body.source }),
          ...(body.valueCents !== undefined && { valueCents: body.valueCents }),
          ...(body.assignedUserId !== undefined && { assignedUserId: body.assignedUserId }),
          ...(body.lostReason !== undefined && { lostReason: body.lostReason }),
        },
        { now: clock.now(), ip: req.ip ?? null },
      ),
    ).catch(refused);
    res.status(201).json(jobBody(created, ctx));
  });

  router.get('/:id', async (req, res) => {
    const { ctx } = req;
    const id = jobId(req.params.id);
    const row = await withTenant(pools, ctx, (tx) => getJob(tx, ctx, id));
    if (!row) throw new AppError(404, MESSAGES.notFound);
    res.json(jobBody(row, ctx));
  });

  router.patch('/:id', async (req, res) => {
    const { ctx } = req;
    const id = jobId(req.params.id);
    requireAssignRole(ctx, req.body);
    const body = parse(PatchBody, assertKnownFields(req.body, FIELDS));

    const updated = await withTenant(pools, ctx, (tx) =>
      updateJob(
        tx,
        ctx,
        id,
        {
          ...(body.customerId !== undefined && { customerId: body.customerId }),
          ...(body.propertyId !== undefined && { propertyId: body.propertyId }),
          ...(body.stage !== undefined && { stage: body.stage }),
          ...(body.source !== undefined && { source: body.source }),
          ...(body.valueCents !== undefined && { valueCents: body.valueCents }),
          ...(body.assignedUserId !== undefined && { assignedUserId: body.assignedUserId }),
          ...(body.lostReason !== undefined && { lostReason: body.lostReason }),
        },
        { now: clock.now(), ip: req.ip ?? null },
      ),
    ).catch(refused);
    if (!updated) throw new AppError(404, MESSAGES.notFound);
    res.json(jobBody(updated, ctx));
  });

  for (const [action, archived] of [
    ['archive', true],
    ['unarchive', false],
  ] as const) {
    router.post(`/:id/${action}`, async (req, res) => {
      const { ctx } = req;
      const id = jobId(req.params.id);
      const row = await withTenant(pools, ctx, (tx) =>
        setJobArchived(tx, ctx, id, archived, { now: clock.now(), ip: req.ip ?? null }),
      );
      if (!row) throw new AppError(404, MESSAGES.notFound);
      res.json(jobBody(row, ctx));
    });
  }

  return router;
}
