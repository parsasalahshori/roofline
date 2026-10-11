import express, { Router } from 'express';
import type { AppDeps } from '../app.ts';

/**
 * Stripe's webhooks (`/hooks/stripe`). Stripe signs the exact bytes it sends, so the body is kept
 * raw here, not parsed. Stub: an empty router (apart from that raw parser) until the Stripe task
 * fills it in.
 */
export function stripeHooks(deps: AppDeps): Router {
  void deps;
  const router = Router();
  router.use(express.raw({ type: '*/*', limit: '512kb' }));
  return router;
}
