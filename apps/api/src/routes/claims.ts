import { type Request, Router } from 'express';
import { z } from 'zod';
import {
  ClaimFieldError,
  getJobClaim,
  latestClaimPacket,
  listClaims,
  listSteps,
  moveStep,
  saveClaim,
  type ClaimPatch,
  withTenant,
} from '@roofline/db';
import { CLAIM_FIELD_LIMITS, CLAIM_STATUSES, toE164 } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { ObjectStoreUnavailableError } from '../providers/object-store.ts'; // G1 Task 7
import { runStep } from '../tasks/runner.ts'; // G1 Task 7
import { runLiveStep } from '../agents/notes.ts';
import { assertKnownFields, noNul, parse, UUID } from '../validate.ts';

const NO_JOB = "We couldn't find that job.";
const NO_STORAGE = "File storage isn't set up."; // G1 Task 7
const NO_PACKET = 'No claim packet yet.'; // G1 Task 7
const PACKET_FAILED = 'We could not build the claim packet.'; // G1 Task 7
const STATUS_MESSAGE = 'Please pick a valid status.';
const DATE_MESSAGE = 'Please enter a date as YYYY-MM-DD.';
const PHONE_MESSAGE = 'Please enter a valid phone number.';
const EMAIL_MESSAGE = 'Please enter a valid email address.';
const DEDUCTIBLE_MESSAGE = 'Please enter the deductible in cents, as a whole number.';
const APPOINTMENT_MESSAGE = 'Please pick an appointment on this job.';
const TEXT_TOO_LONG = 'Please keep that to 200 characters or fewer.';
const NOTES_TOO_LONG = 'Please keep the notes to 2000 characters or fewer.';

/** The largest number the database column (a 32-bit integer) holds. */
const MAX_DEDUCTIBLE_CENTS = 2_147_483_647;

/** The fields a person may send on PUT. Anything else is refused by name. */
const FIELDS = [
  'insurer',
  'claimNumber',
  'dateOfLoss',
  'status',
  'adjusterName',
  'adjusterPhone',
  'adjusterEmail',
  'adjusterAppointmentId',
  'deductibleCents',
  'notes',
] as const;

/** A short text field: trimmed, empty means no value, no NUL, at most `max` characters. */
const textField = (max: number, tooLong: string) =>
  z
    .string({ error: MESSAGES.checkField })
    .trim()
    .max(max, tooLong)
    .refine(noNul, MESSAGES.checkField)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

/** A real calendar date in YYYY-MM-DD form (no rollover: 2026-02-30 is refused). */
const isRealDate = (value: string): boolean => {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const isUuid = (value: string): boolean => UUID.test(value);

const ClaimBody = z.object({
  insurer: textField(CLAIM_FIELD_LIMITS.text, TEXT_TOO_LONG),
  claimNumber: textField(CLAIM_FIELD_LIMITS.text, TEXT_TOO_LONG),
  dateOfLoss: z
    .string({ error: DATE_MESSAGE })
    .regex(/^\d{4}-\d{2}-\d{2}$/, DATE_MESSAGE)
    .refine(isRealDate, DATE_MESSAGE)
    .nullable()
    .optional(),
  status: z.enum(CLAIM_STATUSES, { error: STATUS_MESSAGE }).optional(),
  adjusterName: textField(CLAIM_FIELD_LIMITS.text, TEXT_TOO_LONG),
  adjusterPhone: z
    .string({ error: PHONE_MESSAGE })
    .refine((v) => toE164(v) !== null, PHONE_MESSAGE)
    .transform((v) => toE164(v) ?? v)
    .nullable()
    .optional(),
  adjusterEmail: z
    .string({ error: EMAIL_MESSAGE })
    .trim()
    .toLowerCase()
    .max(CLAIM_FIELD_LIMITS.text, TEXT_TOO_LONG)
    .pipe(z.email(EMAIL_MESSAGE))
    .nullable()
    .optional(),
  adjusterAppointmentId: z
    .string({ error: APPOINTMENT_MESSAGE })
    .refine(isUuid, APPOINTMENT_MESSAGE)
    .transform((v) => v.toLowerCase())
    .nullable()
    .optional(),
  deductibleCents: z
    .number({ error: DEDUCTIBLE_MESSAGE })
    .int(DEDUCTIBLE_MESSAGE)
    .min(0, DEDUCTIBLE_MESSAGE)
    .max(MAX_DEDUCTIBLE_CENTS, DEDUCTIBLE_MESSAGE)
    .nullable()
    .optional(),
  notes: textField(CLAIM_FIELD_LIMITS.notes, NOTES_TOO_LONG),
});

const BoardQuery = z.object({
  status: z.enum(CLAIM_STATUSES, { error: STATUS_MESSAGE }).optional(),
});

/** The mount path's params, typed: `:jobId` comes from the mount, not from this router's routes. */
const paramsOf = (req: Request): { jobId?: unknown } => req.params as { jobId?: unknown };

/** Only the fields the body sent: absent = leave alone, null = clear. */
function toPatch(body: z.output<typeof ClaimBody>): ClaimPatch {
  return {
    ...(body.insurer !== undefined && { insurer: body.insurer }),
    ...(body.claimNumber !== undefined && { claimNumber: body.claimNumber }),
    ...(body.dateOfLoss !== undefined && { dateOfLoss: body.dateOfLoss }),
    ...(body.status !== undefined && { status: body.status }),
    ...(body.adjusterName !== undefined && { adjusterName: body.adjusterName }),
    ...(body.adjusterPhone !== undefined && { adjusterPhone: body.adjusterPhone }),
    ...(body.adjusterEmail !== undefined && { adjusterEmail: body.adjusterEmail }),
    ...(body.adjusterAppointmentId !== undefined && { adjusterAppointmentId: body.adjusterAppointmentId }),
    ...(body.deductibleCents !== undefined && { deductibleCents: body.deductibleCents }),
    ...(body.notes !== undefined && { notes: body.notes }),
  };
}

/** What the repository's refusals mean to the caller: a 400 on the field that cannot be used. */
function refused(err: unknown): never {
  if (err instanceof ClaimFieldError) throw new AppError(400, err.message, err.field);
  throw err;
}

/**
 * `/api/jobs/:jobId/claim`: the insurance claim on one job.
 * - GET returns the claim, or, while there is none, the job's latest intake (so the screen can show
 *   what was reported). A job outside the caller's scope is a 404, the same as a missing one.
 * - PUT saves any of the claim's fields. The first save creates the claim, filled from the intake
 *   for every field the body leaves out. Each status change is recorded in the claim's history.
 * - Adjuster contact details are stored for the company to read. Nothing here sends a text or an
 *   email to anyone, and nothing here addresses an insurer or adjuster.
 */
export function jobClaimRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router({ mergeParams: true });

  /** `:jobId` as a lowercase UUID; anything else cannot be a job, so it is a 404 like a missing one. */
  const jobId = (raw: unknown): string => {
    const id = (typeof raw === 'string' ? raw : '').toLowerCase();
    if (!UUID.test(id)) throw new AppError(404, NO_JOB);
    return id;
  };

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const id = jobId(paramsOf(req).jobId);
    const result = await withTenant(pools, ctx, (tx) => getJobClaim(tx, ctx, id));
    if (!result) throw new AppError(404, NO_JOB);
    res.json(result);
  });

  router.put('/', async (req, res) => {
    const { ctx } = req;
    const id = jobId(paramsOf(req).jobId);
    const body = parse(ClaimBody, assertKnownFields(req.body, FIELDS, { allowEmpty: true }));

    const saved = await withTenant(pools, ctx, (tx) =>
      saveClaim(tx, ctx, id, toPatch(body), { actor: 'user', userId: ctx.userId }, clock.now()),
    ).catch(refused);
    if (!saved) throw new AppError(404, NO_JOB);
    res.json(saved);
  });

  // G1 Task 7: build the packet now. A live task with one internal step is made, the step is queued and
  // run inline, so the step stays the single writer of the file. Nothing is sent to anyone.
  router.post('/packet', async (req, res) => {
    const { ctx } = req;
    const id = jobId(paramsOf(req).jobId);
    const visible = await withTenant(pools, ctx, (tx) => getJobClaim(tx, ctx, id));
    if (!visible) throw new AppError(404, NO_JOB);
    if (visible.claim === null) throw new AppError(409, 'Save the claim details first.');

    const now = clock.now();
    const { taskId, stepId } = await withTenant(pools, ctx, async (tx) => {
      const created = await runLiveStep(
        tx,
        ctx,
        {
          agent: 'claims',
          kind: 'claim_packet',
          title: 'Build the claim packet',
          subjectType: 'job',
          subjectId: id,
          step: { type: 'build_claim_packet', payload: { jobId: id } },
        },
        now,
      );
      await moveStep(tx, ctx, created.stepId, ['pending'], { status: 'queued', approvedAt: now }, now);
      return created;
    });
    await runStep(deps, ctx.companyId, stepId);

    const after = await withTenant(pools, ctx, async (tx) => ({
      claim: await getJobClaim(tx, ctx, id),
      steps: await listSteps(tx, ctx, [taskId]),
    }));
    const packet = after.claim?.packet ?? null;
    if (packet === null || packet.storedFileId === visible.packet?.storedFileId) {
      const errorPlain = after.steps.find((s) => s.id === stepId)?.errorPlain ?? null;
      if (errorPlain === NO_STORAGE) throw new AppError(503, NO_STORAGE);
      throw new AppError(500, errorPlain ?? PACKET_FAILED);
    }
    res.status(200).json({ packet });
  });

  // G1 Task 7: the newest packet, streamed.
  router.get('/packet', async (req, res) => {
    const { ctx } = req;
    const id = jobId(paramsOf(req).jobId);
    const found = await withTenant(pools, ctx, async (tx) => {
      const view = await getJobClaim(tx, ctx, id);
      if (!view) return 'no_job' as const;
      if (view.claim === null) return null;
      return latestClaimPacket(tx, ctx, view.claim.id);
    });
    if (found === 'no_job') throw new AppError(404, NO_JOB);
    if (found === null) throw new AppError(404, NO_PACKET);
    let bytes: Uint8Array | null;
    try {
      bytes = await deps.objectStore.get(found.objectKey);
    } catch (err) {
      if (err instanceof ObjectStoreUnavailableError) throw new AppError(503, NO_STORAGE);
      throw err;
    }
    if (bytes === null) throw new AppError(404, NO_PACKET);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="claim-packet.pdf"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(bytes));
  });

  return router;
}

/**
 * `/api/claims`: the claims board. Lists the claims in the caller's scope, newest status change
 * first, optionally filtered to one status. Reps see the claims on jobs they can see; office and
 * owner see every job.
 */
export function claimBoardRoutes(deps: AppDeps): Router {
  const { pools } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const query = parse(BoardQuery, req.query);
    const claims = await withTenant(pools, ctx, (tx) =>
      listClaims(tx, ctx, { ...(query.status !== undefined && { status: query.status }) }),
    );
    res.json({ claims });
  });

  return router;
}
