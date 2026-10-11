import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { canReview, editStep, getApproval, listApprovals } from '../tasks/service.ts';
import { assertKnownFields, parse, UUID } from '../validate.ts';

/** The fields a step edit can send. Anything else is refused by name. */
const EDIT_FIELDS = ['version', 'enabled', 'payload'] as const;

const VERSION_MESSAGE = 'Please refresh the page and try again.';

const EditBody = z.object({
  version: z
    .number({ error: VERSION_MESSAGE })
    .int(VERSION_MESSAGE)
    .min(1, VERSION_MESSAGE)
    .max(2_147_483_647, VERSION_MESSAGE),
  enabled: z.boolean({ error: 'Please choose on or off.' }).optional(),
  payload: z.record(z.string(), z.unknown(), { error: 'Please check this step.' }).optional(),
});

/**
 * `/api/approvals`: the approval queue, where an agent's draft tasks wait for a person.
 * - `GET /` the tasks waiting on the signed-in member, newest first, with the `count` the pill shows.
 *   Its steps carry no payload (a batch can hold thousands of customer ids).
 * - `GET /:taskId` one task, in any status, each step with its payload so the editor can fill itself in.
 * - `PATCH /:taskId/steps/:stepId` turn a step on or off, or change its payload, before approving.
 *   It returns the step as saved, payload included.
 * Only the owner and the office work the queue. A rep gets an empty list, and a 404 for any one task or
 * step, exactly as for one that does not exist. A task of another company is a 404 too. Tasks are made
 * by agents through `createTask` (tasks/service.ts), never over HTTP.
 */
export function approvalRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

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

  return router;
}
