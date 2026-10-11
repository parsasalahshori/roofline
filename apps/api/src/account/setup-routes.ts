import { Router } from 'express';
import type { AppDeps } from '../app.ts';

/** The setup routes (`/api/setup`). Stub: an empty router until the setup task fills it in. */
export function setupRoutes(deps: AppDeps): Router {
  void deps;
  return Router();
}
