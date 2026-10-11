import { Router } from 'express';
import { z } from 'zod';
import { audit, billingFacts, usageTotals, withTenant } from '@roofline/db';
import { setStripeCustomerIfMissing } from '@roofline/db/system';
import { type BillingView, planByKey, type PlanSummary, priceLookupKeys } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { requireVerifiedEmail } from '../auth/middleware.ts';
import { hasPaymentMethod } from '../billing/guards.ts';
import { billingConfig } from '../billing/plans.ts';
import { AppError } from '../errors.ts';
import { requireCapability } from '../permissions.ts';
import { BillingUnavailableError } from '../providers/billing.ts';
import { parse } from '../validate.ts';

// Messages for the billing routes (Ruling 33): plain English, shown as they are.
const UNKNOWN_PLAN = 'Pick one of the plans.';
const ALREADY_SUBSCRIBED = 'You already have a plan. Use Change plan.';
const NO_CARD_YET = 'Add a card first.';
const NO_SUBSCRIPTION = 'Pick a plan first.';
const NOT_CONFIGURED = "Billing isn't set up yet.";
const UNREACHABLE = "We couldn't reach the payment service. Try again in a minute.";

/** A trial ending sooner than this is billed at checkout instead of being kept (Ruling 7). */
const TRIAL_KEEP_MS = 48 * 60 * 60 * 1000;

const PlanBody = z.object({
  planKey: z.string({ error: UNKNOWN_PLAN }),
});

/** Reads `{ planKey }` from the body and checks that the plan exists in the plans file. */
function planFromBody(deps: AppDeps, body: unknown): string {
  const { planKey } = parse(PlanBody, body);
  if (planByKey(billingConfig(deps), planKey) === null) throw new AppError(400, UNKNOWN_PLAN, 'planKey');
  return planKey;
}

/** 503 when no real billing provider is set up. Read from `deps` at request time. */
function requireConfigured(deps: AppDeps): void {
  if (!deps.billing.configured) throw new AppError(503, NOT_CONFIGURED);
}

/** Runs a provider call; a provider that is unreachable becomes a 503 with a plain message. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BillingUnavailableError) throw new AppError(503, UNREACHABLE);
    throw err;
  }
}

/**
 * `/api/billing`: the plan and usage summary, Stripe Checkout, the customer portal and changing the
 * plan. Every route is owner-only (`billing`); Checkout also needs a verified email. Stripe is
 * reached only through `deps.billing`, and its messages never leave this file.
 */
export function billingRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', requireCapability('billing'), async (req, res) => {
    const ctx = req.ctx;
    const config = billingConfig(deps);
    const view = await withTenant(deps.pools, ctx, async (tx): Promise<BillingView> => {
      const facts = await billingFacts(tx, ctx);
      const periodStart = facts.billingPeriodStart ?? facts.createdAt;
      const totals = await usageTotals(tx, ctx, periodStart);
      const plan = facts.planKey ? planByKey(config, facts.planKey) : null;
      const plans: PlanSummary[] = config.plans.map((p) => ({
        key: p.key,
        name: p.name,
        monthlyPriceCents: p.monthly_price_cents,
        included: { aiCallMinutes: p.included.ai_call_minutes, smsSegments: p.included.sms_segments },
        overageCents: { aiCallMinute: p.overage_cents.ai_call_minute, smsSegment: p.overage_cents.sms_segment },
      }));
      return {
        status: facts.status,
        planKey: facts.planKey,
        planName: plan?.name ?? null,
        trialEndsAt: facts.trialEndsAt ? facts.trialEndsAt.toISOString() : null,
        hasPaymentMethod: hasPaymentMethod({ stripeSubscriptionId: facts.stripeSubscriptionId, status: facts.status }),
        canOpenPortal: facts.stripeCustomerId !== null,
        periodStart: periodStart.toISOString(),
        usage: [
          { meter: 'ai_call_minute', used: totals.ai_call_minute, included: plan?.included.ai_call_minutes ?? null },
          { meter: 'sms_segment', used: totals.sms_segment, included: plan?.included.sms_segments ?? null },
        ],
        plans,
      };
    });
    res.json(view);
  });

  router.post('/checkout', requireCapability('billing'), requireVerifiedEmail, async (req, res) => {
    const ctx = req.ctx;
    const planKey = planFromBody(deps, req.body);
    const facts = await withTenant(deps.pools, ctx, (tx) => billingFacts(tx, ctx));
    if (facts.stripeSubscriptionId !== null) throw new AppError(409, ALREADY_SUBSCRIBED);
    requireConfigured(deps);

    const ensured = await guarded(() =>
      deps.billing.ensureCustomer({
        companyId: ctx.companyId,
        name: facts.name,
        email: facts.email,
        existingCustomerId: facts.stripeCustomerId,
      }),
    );
    // Two checkouts at once may both have created a customer; the first one stored wins.
    const customerId = await setStripeCustomerIfMissing(deps.pools.system, ctx.companyId, ensured.customerId);

    const now = deps.clock.now();
    const trialEnd =
      facts.trialEndsAt && facts.trialEndsAt.getTime() - now.getTime() >= TRIAL_KEEP_MS ? facts.trialEndsAt : null;
    const keys = priceLookupKeys(planKey);
    const origin = deps.config.APP_ORIGIN;
    const checkout = await guarded(() =>
      deps.billing.createCheckout({
        customerId,
        companyId: ctx.companyId,
        planKey,
        priceLookupKeys: [keys.monthly, keys.ai_call_minute, keys.sms_segment],
        trialEnd,
        successUrl: `${origin}/settings/billing?checkout=done`,
        cancelUrl: `${origin}/settings/billing`,
      }),
    );

    await withTenant(deps.pools, ctx, (tx) =>
      audit(tx, ctx, {
        action: 'billing.checkout_started',
        targetType: 'company',
        targetId: ctx.companyId,
        after: { planKey },
        ip: req.ip ?? null,
        at: now,
      }),
    );
    res.json({ url: checkout.url });
  });

  router.post('/portal', requireCapability('billing'), async (req, res) => {
    const ctx = req.ctx;
    const facts = await withTenant(deps.pools, ctx, (tx) => billingFacts(tx, ctx));
    const customerId = facts.stripeCustomerId;
    if (customerId === null) throw new AppError(409, NO_CARD_YET);
    requireConfigured(deps);
    const portal = await guarded(() =>
      deps.billing.createPortal({ customerId, returnUrl: `${deps.config.APP_ORIGIN}/settings/billing` }),
    );
    res.json({ url: portal.url });
  });

  router.post('/plan', requireCapability('billing'), async (req, res) => {
    const ctx = req.ctx;
    const planKey = planFromBody(deps, req.body);
    const facts = await withTenant(deps.pools, ctx, (tx) => billingFacts(tx, ctx));
    const subscriptionId = facts.stripeSubscriptionId;
    if (subscriptionId === null) throw new AppError(409, NO_SUBSCRIPTION);
    requireConfigured(deps);
    const keys = priceLookupKeys(planKey);
    await guarded(() =>
      deps.billing.changePlan({
        subscriptionId,
        planKey,
        priceLookupKeys: [keys.monthly, keys.ai_call_minute, keys.sms_segment],
      }),
    );
    await withTenant(deps.pools, ctx, (tx) =>
      audit(tx, ctx, {
        action: 'billing.plan_change_requested',
        targetType: 'company',
        targetId: ctx.companyId,
        after: { planKey },
        ip: req.ip ?? null,
        at: deps.clock.now(),
      }),
    );
    res.json({ ok: true });
  });

  return router;
}
