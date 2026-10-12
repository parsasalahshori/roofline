/* eslint-disable @typescript-eslint/no-unused-vars -- placeholder: its parameters are used when the real body lands */
import { Router } from 'express';
import type { AppDeps } from '../app.ts';

/** Quotes API (C1 Task 15, PDF in Task 16). Placeholder: an empty router for now. */
export function quoteRoutes(_deps: AppDeps): Router {
  return Router({ mergeParams: true });
}

/** A job's quotes, mounted at /api/jobs/:jobId/quotes (C1 Task 15). Placeholder: an empty router. */
export function jobQuoteRoutes(_deps: AppDeps): Router {
  return Router({ mergeParams: true });
}
