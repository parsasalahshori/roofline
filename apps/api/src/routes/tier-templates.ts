import { Router } from 'express';
import type { AppDeps } from '../app.ts';

/** `/api/tier-templates`. No routes yet (the 404 handler answers); a later E1 task fills this in. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub parameters, used once the body exists
export function tierTemplateRoutes(_deps: AppDeps): Router {
  return Router();
}
