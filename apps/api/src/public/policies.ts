import { Router } from 'express';
import type { AppDeps } from '../app.ts';

/**
 * The public policy pages (privacy and terms, served without a session). Stub: an empty router
 * until the policy task fills it in.
 */
export function policyPages(deps: AppDeps): Router {
  void deps;
  return Router();
}
