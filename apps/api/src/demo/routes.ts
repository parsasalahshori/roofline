import { type RequestHandler, Router } from 'express';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { requireCapability } from '../permissions.ts';
import { simulateCall, simulateSign, simulateStorm, simulateText, type SimulateResult } from './simulate.ts';

/*
 * Demo mode's routes (app.ts mounts them only when DEMO_MODE is on; otherwise every path here is an ordinary 404).
 * - GET /api/demo           { demo: true }, signed out too, so the shell can show its Demo badge.
 * - POST /api/demo/simulate/{text,call,storm,sign}
 *                           the presenter's buttons: owners and office members only (approve_internal), behind the
 *                           sign-in gate, the read-only guard and the cross-site Origin check like every mutation.
 *                           Each answers { ok: true, ...ids, message }, or a plain 409 when there is nothing to act on.
 */

/** GET /api/demo: mounted ahead of the sign-in gate. */
export function demoStatusRoute(): RequestHandler {
  return (_req, res) => {
    res.json({ demo: true });
  };
}

type Simulation = (deps: AppDeps, companyId: string) => Promise<SimulateResult>;

const SIMULATIONS: Record<string, Simulation> = {
  text: simulateText,
  call: simulateCall,
  storm: simulateStorm,
  sign: simulateSign,
};

/** The simulate routes, mounted at /api/demo after the sign-in gate. */
export function demoRoutes(deps: AppDeps): Router {
  const router = Router();
  router.post('/simulate/:kind', requireCapability('approve_internal'), async (req, res, next) => {
    try {
      const kind = String(req.params['kind']);
      const run = Object.hasOwn(SIMULATIONS, kind) ? SIMULATIONS[kind] : undefined;
      if (run === undefined) throw new AppError(404, MESSAGES.notFound);
      const result = await run(deps, req.ctx.companyId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });
  return router;
}
