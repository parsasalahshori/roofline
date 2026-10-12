import { Router } from 'express';
import type { AppDeps } from '../app.ts';

/** Signing a proposal, signed out, under `/api/public/proposals`. No routes yet; a later E1 task fills this in. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub parameters, used once the body exists
export function proposalSignRoutes(_deps: AppDeps): Router {
  return Router();
}
