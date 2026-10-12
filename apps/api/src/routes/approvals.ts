import { Router } from 'express';
import { z } from 'zod';
import { audit, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { can, type Member } from '../permissions.ts';
import { draftStormPlan, STORM_PLAN_ERRORS } from '../storm/plan.ts';
import {
  approveTask,
  canReview,
  declineStep,
  declineTask,
  editStep,
  getApproval,
  linkRerun,
  listApprovals,
  prepareRerun,
  rerunTask,
  retryStep,
} from '../tasks/service.ts';
import { assertKnownFields, noNul, parse, UUID } from '../validate.ts';

/** The fields a step edit can send. Anything else is refused by name. */
const EDIT_FIELDS = ['version', 'enabled', 'payload'] as const;
const APPROVE_FIELDS = ['steps'] as const;
const DECLINE_FIELDS = ['reason'] as const;

const VERSION_MESSAGE = 'Please refresh the page and try again.';

const version = z
  .number({ error: VERSION_MESSAGE })
  .int(VERSION_MESSAGE)
  .min(1, VERSION_MESSAGE)
  .max(2_147_483_647, VERSION_MESSAGE);

const EditBody = z.object({
  version,
  enabled: z.boolean({ error: 'Please choose on or off.' }).optional(),
  payload: z.record(z.string(), z.unknown(), { error: 'Please check this step.' }).optional(),
});

/** Every step the screen showed, with the version it showed. Whatever is wrong with it, the screen should reload. */
const ApproveBody = z.object({
  steps: z
    .array(
      z.object(
        {
          id: z
            .string({ error: VERSION_MESSAGE })
            .refine((v) => UUID.test(v), VERSION_MESSAGE)
            .transform((v) => v.toLowerCase()),
          version,
        },
        { error: VERSION_MESSAGE },
      ),
      { error: VERSION_MESSAGE },
    )
    .max(1000, VERSION_MESSAGE)
    .refine((steps) => new Set(steps.map((s) => s.id)).size === steps.length, VERSION_MESSAGE),
});

const DeclineBody = z.object({
  // Trimmed; empty means "no reason".
  reason: z
    .string({ error: MESSAGES.checkField })
    .trim()
    .max(500, 'Please keep the reason to 500 characters or fewer.')
    .refine(noNul, MESSAGES.checkField)
    .transform((v) => (v === '' ? null : v))
    .nullish(),
});

/**
 * `/api/approvals`: the approval queue, where an agent's draft tasks wait for a person.
 * - `GET /` the tasks waiting on the signed-in member, newest first, with the `count` the pill shows
 *   (expired plans are listed but not counted). Its steps carry no payload (a batch can hold
 *   thousands of customer ids).
 * - `GET /:taskId` one task, in any status, each step with its payload so the editor can fill itself in.
 * - `PATCH /:taskId/steps/:stepId` turn a step on or off, or change its payload, before approving.
 *   It returns the step as saved, payload included.
 * - `POST /:taskId/approve {steps: [{id, version}]}` approve what the caller may; the rest waits for
 *   the owner (partial approval). `POST /:taskId/decline {reason?}` say no to the whole plan.
 *   `POST /:taskId/steps/:stepId/decline` say no to one step waiting on the owner.
 *   `POST /:taskId/steps/:stepId/retry` run a step that did not finish again.
 *   Each returns the task's detail view (payloads included).
 * - `POST /:taskId/rerun` make a fresh draft from an expired plan ("Expired — run again?"): 201
 *   with the new task's detail view; 409 "Only expired plans can be run again." for any other plan,
 *   and 409 "This plan was already run again." for a plan that already has its copy. A storm plan is
 *   re-drafted from fresh storm and customer data (its switched-off steps are rebuilt with their reasons),
 *   and 409 "Storm Scout is paused. Turn it back on in Agents to draft a plan." when Storm Scout is paused.
 *   Any other plan is copied, each step keeping its on or off state.
 * Only the owner and the office work the queue. A rep gets an empty list, and a 404 for any one task or
 * step, exactly as for one that does not exist. A task of another company is a 404 too. Tasks are made
 * by agents through `createTask` (tasks/service.ts), never over HTTP.
 *
 * Steps are handed to `deps.queue` only after the transaction that queued them has committed. If the
 * queue refuses one, the approval still stands (the step stays `queued` for the sweeper to hand over
 * again) and the failure is logged.
 */
export function approvalRoutes(deps: AppDeps, logError: (err: unknown, path: string) => void): Router {
  const { pools, clock, queue } = deps;
  const router = Router();

  /** Hands each step to the queue, after the commit. One refusal does not stop the others. */
  async function enqueue(companyId: string, stepIds: readonly string[], path: string): Promise<void> {
    for (const stepId of stepIds) {
      try {
        await queue.enqueueStep(companyId, stepId);
      } catch (err) {
        try {
          logError(err, path);
        } catch {
          // A failing logger must not undo an approval that has been saved.
        }
      }
    }
  }

  /** Approving, declining or running again a whole plan is for those who work the queue: approve messages or internal steps. */
  const requireQueueWork = (ctx: Member): void => {
    if (!can(ctx, 'approve_message') && !can(ctx, 'approve_internal')) throw new AppError(403, MESSAGES.roleCannot);
  };

  /** A path id as a lowercase UUID; anything else cannot be one of ours, so it is a 404 like a missing one. */
  const idParam = (raw: unknown): string => {
    const id = (typeof raw === 'string' ? raw : '').toLowerCase();
    if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
    return id;
  };

  router.get('/', async (req, res) => {
    const { ctx } = req;
    if (!canReview(ctx)) {
      res.json({ count: 0, tasks: [] });
      return;
    }
    res.json(await withTenant(pools, ctx, (tx) => listApprovals(tx, ctx, clock.now())));
  });

  router.get('/:taskId', async (req, res) => {
    const { ctx } = req;
    if (!canReview(ctx)) throw new AppError(404, MESSAGES.notFound);
    const taskId = idParam(req.params.taskId);
    const task = await withTenant(pools, ctx, (tx) => getApproval(tx, ctx, taskId, clock.now()));
    if (!task) throw new AppError(404, MESSAGES.notFound);
    res.json(task);
  });

  router.patch('/:taskId/steps/:stepId', async (req, res) => {
    const { ctx } = req;
    // Before anything else, so a rep learns nothing from the id or the body they sent.
    if (!canReview(ctx)) throw new AppError(404, MESSAGES.notFound);
    const taskId = idParam(req.params.taskId);
    const stepId = idParam(req.params.stepId);
    const body = parse(EditBody, assertKnownFields(req.body, EDIT_FIELDS));
    if (body.enabled === undefined && body.payload === undefined) throw new AppError(400, MESSAGES.nothingToChange);

    const step = await withTenant(pools, ctx, (tx) =>
      editStep(
        tx,
        ctx,
        taskId,
        stepId,
        {
          version: body.version,
          ...(body.enabled !== undefined && { enabled: body.enabled }),
          ...(body.payload !== undefined && { payload: body.payload }),
        },
        { now: clock.now(), ip: req.ip ?? null },
      ),
    );
    if (!step) throw new AppError(404, MESSAGES.notFound);
    res.json(step);
  });

  router.post('/:taskId/approve', async (req, res) => {
    const { ctx } = req;
    if (!canReview(ctx)) throw new AppError(404, MESSAGES.notFound);
    const taskId = idParam(req.params.taskId);
    requireQueueWork(ctx);
    const body = parse(ApproveBody, assertKnownFields(req.body, APPROVE_FIELDS, { allowEmpty: true }));

    const out = await withTenant(pools, ctx, (tx) =>
      approveTask(tx, ctx, taskId, body.steps, { now: clock.now(), ip: req.ip ?? null }),
    );
    if (!out) throw new AppError(404, MESSAGES.notFound);
    await enqueue(ctx.companyId, out.toEnqueue, req.path);
    res.json(out.task);
  });

  router.post('/:taskId/decline', async (req, res) => {
    const { ctx } = req;
    if (!canReview(ctx)) throw new AppError(404, MESSAGES.notFound);
    const taskId = idParam(req.params.taskId);
    requireQueueWork(ctx);
    // No body at all is a decline without a reason.
    const body = parse(DeclineBody, assertKnownFields(req.body ?? {}, DECLINE_FIELDS, { allowEmpty: true }));

    const task = await withTenant(pools, ctx, (tx) =>
      declineTask(tx, ctx, taskId, body.reason ?? null, { now: clock.now(), ip: req.ip ?? null }),
    );
    if (!task) throw new AppError(404, MESSAGES.notFound);
    res.json(task);
  });

  router.post('/:taskId/steps/:stepId/decline', async (req, res) => {
    const { ctx } = req;
    if (!canReview(ctx)) throw new AppError(404, MESSAGES.notFound);
    const taskId = idParam(req.params.taskId);
    const stepId = idParam(req.params.stepId);

    const task = await withTenant(pools, ctx, (tx) =>
      declineStep(tx, ctx, taskId, stepId, { now: clock.now(), ip: req.ip ?? null }),
    );
    if (!task) throw new AppError(404, MESSAGES.notFound);
    res.json(task);
  });

  router.post('/:taskId/steps/:stepId/retry', async (req, res) => {
    const { ctx } = req;
    if (!canReview(ctx)) throw new AppError(404, MESSAGES.notFound);
    const taskId = idParam(req.params.taskId);
    const stepId = idParam(req.params.stepId);

    const out = await withTenant(pools, ctx, (tx) =>
      retryStep(tx, ctx, taskId, stepId, { now: clock.now(), ip: req.ip ?? null }),
    );
    if (!out) throw new AppError(404, MESSAGES.notFound);
    await enqueue(ctx.companyId, out.toEnqueue, req.path);
    res.json(out.task);
  });

  router.post('/:taskId/rerun', async (req, res) => {
    const { ctx } = req;
    if (!canReview(ctx)) throw new AppError(404, MESSAGES.notFound);
    const taskId = idParam(req.params.taskId);
    requireQueueWork(ctx);

    const opts = { now: clock.now(), ip: req.ip ?? null };
    const target = await withTenant(pools, ctx, (tx) => prepareRerun(tx, ctx, taskId, opts));
    if (!target) throw new AppError(404, MESSAGES.notFound);

    if (target.kind === 'storm') {
      let drafted: { taskId: string } | null;
      try {
        drafted = await draftStormPlan(deps, ctx.companyId, target.companyStormId, clock.now(), { replaceFinished: true });
      } catch (err) {
        if (err instanceof Error && err.message === STORM_PLAN_ERRORS.notFound) throw new AppError(404, MESSAGES.notFound);
        if (err instanceof Error && (err.message === STORM_PLAN_ERRORS.dismissed || err.message === STORM_PLAN_ERRORS.changed)) throw new AppError(409, err.message);
        throw err;
      }
      if (drafted === null) throw new AppError(409, MESSAGES.stormScoutPaused);
      const fresh = await withTenant(pools, ctx, async (tx) => {
        // The link a copy has, so the old plan cannot be run again twice and the card shows where it came from.
        await linkRerun(tx, ctx, drafted.taskId, taskId, opts.now);
        await audit(tx, ctx, {
          action: 'task.rerun',
          targetType: 'agent_task',
          targetId: drafted.taskId,
          after: { fromTaskId: taskId },
          ip: opts.ip,
          at: opts.now,
        });
        return getApproval(tx, ctx, drafted.taskId, clock.now());
      });
      if (!fresh) throw new AppError(404, MESSAGES.notFound);
      res.status(201).json(fresh);
      return;
    }

    const task = await withTenant(pools, ctx, (tx) => rerunTask(tx, ctx, taskId, opts));
    if (!task) throw new AppError(404, MESSAGES.notFound);
    res.status(201).json(task);
  });

  return router;
}
