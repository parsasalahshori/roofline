import { Router } from 'express';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';

/**
 * Viewing a proposal by its link token, signed out, under `/api/public/proposals`. Stub from E1
 * Task 5: every request answers 404 until a later E1 task builds it.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub parameters, used once the body exists
export function publicProposalRoutes(_deps: AppDeps): Router {
  const router = Router();
  router.all('/:token', (_req, _res, next) => {
    next(new AppError(404, MESSAGES.notFound));
  });
  return router;
}
