import { type SQL, eq, sql } from 'drizzle-orm';
import type { CompanyStatus } from '@roofline/shared';
import type { Db } from '../pools.ts';
import { companies, webhookEvents } from '../schema/index.ts';

/*
 * Stripe's billing events, on the app_system pool: which company a Stripe customer belongs to, and
 * the one transaction that records a delivery and applies its change to the company. Only
 * apps/api/src/hooks/** imports this module.
 */

/**
 * What one Stripe event asks us to change on a company. The API's billing/stripe-events.ts builds
 * the same shape from a Stripe event; the two are kept structurally identical (packages cannot
 * import from apps).
 */
export type BillingUpdate = {
  /** The Stripe customer the event is about (`cus_...`). */
  customerId: string;
  /** Stripe's id for the event (`evt_...`), the key the delivery is deduplicated on. */
  eventId: string;
  /** When Stripe says the event happened. Older events never overwrite newer ones. */
  eventCreated: Date;
  /** The columns to set. Only the fields that are present are changed. */
  set: {
    status?: CompanyStatus;
    stripeSubscriptionId?: string;
    planKey?: string;
    billingPeriodStart?: Date;
  };
  /** Apply only when the company is past due (a paid invoice clears past due and nothing else). */
  onlyIfPastDue?: boolean;
};

const NOTHING = { applied: false, before: null, after: null } as const;

/** The company whose Stripe customer id is `customerId`, or null when no company has it. */
export async function companyIdForStripeCustomer(system: Db, customerId: string): Promise<string | null> {
  const [row] = await system
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.stripeCustomerId, customerId))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Records one Stripe delivery and applies its change to the company, in ONE app_system transaction.
 *
 * Steps: (1) claim the delivery in `webhook_events` (provider `stripe`, event id): a repeat claims
 * nothing and changes nothing; (2) a null company (an unknown customer) stops here, the claim
 * stays so the event is acknowledged once; (3) lock the company row; (4) an event older than the
 * company's `billing_event_at` is stale and ignored; (5) `onlyIfPastDue` on a company that is not
 * past due only moves `billing_event_at`; (6) otherwise set the given columns and
 * `billing_event_at`, stamping `past_due_at` on entering past due and clearing it on leaving.
 *
 * The claim and the company update commit or roll back together: if the update fails, the claim
 * is rolled back too, so Stripe's retry is handled instead of being mistaken for a repeat.
 *
 * The claim is written here rather than through `claimWebhookEvent` (system/routing.ts): that
 * function takes a `Db`, and a transaction handle is not one. Its insert is repeated verbatim so the
 * claim can share this transaction. routing.ts is left untouched.
 */
export async function applyBillingEvent(
  system: Db,
  companyId: string | null,
  u: BillingUpdate,
): Promise<{ applied: boolean; before: CompanyStatus | null; after: CompanyStatus | null }> {
  return system.transaction(async (tx) => {
    const claimed = await tx
      .insert(webhookEvents)
      .values({ provider: 'stripe', eventId: u.eventId })
      .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.eventId] })
      .returning({ id: webhookEvents.id });
    if (claimed.length === 0) return NOTHING;

    if (companyId === null) return NOTHING;

    const [company] = await tx
      .select({ id: companies.id, status: companies.status, billingEventAt: companies.billingEventAt })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1)
      .for('update');
    if (!company) return NOTHING;

    const before = company.status;
    if (company.billingEventAt !== null && u.eventCreated < company.billingEventAt) {
      return { applied: false, before, after: before };
    }

    if (u.onlyIfPastDue && before !== 'past_due') {
      await tx.update(companies).set({ billingEventAt: u.eventCreated }).where(eq(companies.id, companyId));
      return { applied: false, before, after: before };
    }

    const next = u.set.status;
    const after = next ?? before;
    const patch: {
      billingEventAt: Date;
      status?: CompanyStatus;
      stripeSubscriptionId?: string;
      planKey?: string;
      billingPeriodStart?: Date;
      pastDueAt?: SQL | null;
    } = { billingEventAt: u.eventCreated };
    if (next !== undefined) patch.status = next;
    if (u.set.stripeSubscriptionId !== undefined) patch.stripeSubscriptionId = u.set.stripeSubscriptionId;
    if (u.set.planKey !== undefined) patch.planKey = u.set.planKey;
    if (u.set.billingPeriodStart !== undefined) patch.billingPeriodStart = u.set.billingPeriodStart;
    if (next === 'past_due' && before !== 'past_due') patch.pastDueAt = sql`now()`;
    if (before === 'past_due' && next !== undefined && next !== 'past_due') patch.pastDueAt = null;

    await tx
      .update(companies)
      .set(patch)
      .where(eq(companies.id, companyId));
    return { applied: true, before, after };
  });
}
