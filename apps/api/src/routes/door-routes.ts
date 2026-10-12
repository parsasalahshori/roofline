import { Router } from 'express';
import { z } from 'zod';
import { DuplicatePhoneError, getDoorRoute, listDoorStops, listRoutesForUser, withTenant } from '@roofline/db';
import { DOOR_OUTCOMES, toE164 } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import {
  DoorLeadRequiredError,
  DoorRouteForbiddenError,
  DoorStopNotFoundError,
  recordDoorOutcome,
  type DoorOutcomeBody,
} from '../storm/doors.ts';
import { assertKnownFields, emailField, parse, UUID } from '../validate.ts';

/*
 * `/api/routes`: door-knock routes. A rep sees and works only their own routes; the owner and office
 * see every route of the company. Stops carry an address only, never an owner or customer name.
 */

export const NOT_YOUR_ROUTE = 'This route belongs to someone else.';
export const LEAD_REQUIRED = 'Please add the homeowner details.';
export const OUTCOME_MESSAGE = 'Please choose what happened at the door.';
export const PHONE_TAKEN = 'Another customer already has this number.';
const PHONE_MESSAGE = 'Please enter a valid phone number.';

const OutcomeBody = z.object({
  outcome: z.enum(DOOR_OUTCOMES, { error: OUTCOME_MESSAGE }),
  lead: z
    .object({
      name: z.string({ error: MESSAGES.checkField }).trim().min(1, MESSAGES.checkField).max(120, MESSAGES.checkField),
      phoneE164: z
        .string({ error: PHONE_MESSAGE })
        .max(32, PHONE_MESSAGE)
        .refine((v) => toE164(v) !== null, PHONE_MESSAGE)
        .optional(),
      email: emailField.optional(),
      okToText: z.boolean({ error: MESSAGES.checkField }),
      note: z.string({ error: MESSAGES.checkField }).max(1000, MESSAGES.checkField).optional(),
    })
    .strict()
    .optional(),
});
const OUTCOME_FIELDS = Object.keys(OutcomeBody.shape);

/** The id in a path, lowercased; a malformed one is a 404 like an id that does not exist. */
function idParam(raw: unknown): string {
  const id = (typeof raw === 'string' ? raw : '').toLowerCase();
  if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
  return id;
}

/** `/api/routes`: the caller's door routes, one route with its stops, and the outcome of a stop. */
export function doorRoutes(deps: AppDeps): Router {
  const { pools } = deps;
  const router = Router();

  router.get('/mine', async (req, res) => {
    const { ctx } = req;
    const routes = await withTenant(pools, ctx, (tx) => listRoutesForUser(tx, ctx.userId!));
    res.json({ routes });
  });

  router.get('/:id', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const result = await withTenant(pools, ctx, async (tx) => {
      const route = await getDoorRoute(tx, id);
      if (!route) return null;
      // A rep never learns that another rep's route exists.
      if (ctx.role === 'rep' && ctx.userId !== route.userId) return null;
      return { route, stops: await listDoorStops(tx, id) };
    });
    if (result === null) throw new AppError(404, MESSAGES.notFound);
    res.json(result);
  });

  router.post('/:id/stops/:stopId/outcome', async (req, res) => {
    const { ctx } = req;
    const routeId = idParam(req.params.id);
    const stopId = idParam(req.params.stopId);
    const body = parse(OutcomeBody, assertKnownFields(req.body, OUTCOME_FIELDS)) as DoorOutcomeBody;
    if (body.outcome === 'wants_check' && body.lead === undefined) {
      throw new AppError(400, LEAD_REQUIRED, 'lead');
    }
    try {
      res.json(await recordDoorOutcome(deps, ctx, { routeId, stopId, body }));
    } catch (err) {
      if (err instanceof DoorRouteForbiddenError) throw new AppError(403, NOT_YOUR_ROUTE);
      if (err instanceof DoorStopNotFoundError) throw new AppError(404, MESSAGES.notFound);
      if (err instanceof DoorLeadRequiredError) throw new AppError(400, LEAD_REQUIRED, 'lead');
      if (err instanceof DuplicatePhoneError) throw new AppError(409, PHONE_TAKEN, 'lead.phoneE164');
      throw err;
    }
  });

  return router;
}
