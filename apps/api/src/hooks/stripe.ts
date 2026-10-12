import express, { Router } from 'express';
import { audit, withTenant } from '@roofline/db';
import { applyBillingEvent, companyIdForStripeCustomer } from '@roofline/db/system';
import type { AppDeps } from '../app.ts';
import { billingUpdateFor } from '../billing/stripe-events.ts';
import { StripeSignatureError, verifyStripeSignature } from '../billing/stripe-signature.ts';
import { systemContext } from '../permissions.ts';

/** What the hook says when no webhook secret is configured yet (billing is not set up). */
export const NOT_SET_UP = "Billing isn't set up yet.";
/** What the hook says when the signature is missing, malformed, stale or wrong. */
export const SIGNATURE_FAILED = 'Signature check failed.';

/**
 * Stripe's webhooks (`/hooks/stripe`, spec 5.2). Stripe signs the exact bytes it sends, so the body
 * is kept raw here (`express.raw`), not parsed, and mounted before the JSON parser.
 *
 * - No `STRIPE_WEBHOOK_SECRET`: 503 and nothing is recorded, so Stripe retries once billing is set up.
 * - Bad signature (missing, malformed, stale or wrong): 400, nothing is recorded.
 * - An event that does not change a company (or is not one we use): 200, nothing is recorded.
 * - Otherwise the company is found by its Stripe customer; `applyBillingEvent` claims the delivery
 *   and applies the change in one transaction. When the status really changed, an audit row
 *   `billing.status_changed` is written for the company as a system actor.
 * An unexpected failure goes to the error handler (a 500), so Stripe retries and the claim rolls back.
 */
export function stripeHooks(deps: AppDeps): Router {
  const router = Router();
  router.use(express.raw({ type: '*/*', limit: '512kb' }));

  router.post('/', async (req, res, next) => {
    try {
      const secret = deps.config.STRIPE_WEBHOOK_SECRET;
      if (!secret) {
        res.status(503).json({ error: NOT_SET_UP });
        return;
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
      let event: ReturnType<typeof verifyStripeSignature>;
      try {
        if (rawBody === null) throw new StripeSignatureError('no raw body');
        event = verifyStripeSignature(rawBody, req.header('stripe-signature'), secret, deps.clock.now());
      } catch (err) {
        if (err instanceof StripeSignatureError) {
          res.status(400).json({ error: SIGNATURE_FAILED });
          return;
        }
        throw err;
      }

      const update = billingUpdateFor(event);
      if (update === null) {
        res.status(200).json({ received: true });
        return;
      }

      const companyId = await companyIdForStripeCustomer(deps.pools.system, update.customerId);
      const result = await applyBillingEvent(deps.pools.system, companyId, update);

      if (companyId !== null && result.applied && result.before !== result.after) {
        const ctx = systemContext(companyId);
        await withTenant(deps.pools, ctx, (tx) =>
          audit(tx, ctx, {
            action: 'billing.status_changed',
            targetType: 'company',
            targetId: companyId,
            after: { from: result.before, to: result.after, event: event.type },
            at: deps.clock.now(),
          }),
        );
      }

      res.status(200).json({ received: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
