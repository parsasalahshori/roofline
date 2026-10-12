import { Router } from 'express';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';

/** Stub from S1 Task 7: every request answers 404 until a later S1 task builds it. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub parameters, used once the body exists
export function adsRoutes(_deps: AppDeps): Router {
  const router = Router();
  router.use((_req, _res, next) => {
    next(new AppError(404, MESSAGES.notFound));
  });
  return router;
}
