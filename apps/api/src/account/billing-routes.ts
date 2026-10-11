import { Router } from 'express';
import type { AppDeps } from '../app.ts';

/** The billing routes (`/api/billing`). Stub: an empty router until the billing task fills it in. */
export function billingRoutes(deps: AppDeps): Router {
  void deps;
  return Router();
}
