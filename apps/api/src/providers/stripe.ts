import Stripe from 'stripe';
import type { Config } from '../config.ts';
import { BillingRefusedError, BillingUnavailableError, type BillingProvider } from './billing.ts';

/** The three price kinds a plan has, told apart by the suffix of the lookup key. */
const KIND_SUFFIXES = ['_monthly', '_ai_call_minute', '_sms_segment'] as const;

export const STRIPE_UNAVAILABLE = "Stripe didn't answer.";
export const STRIPE_REFUSED = 'Stripe refused the request.';

/**
 * Maps a thrown value from the Stripe SDK. A connection failure, a 5xx, a 429 or a 409 (an
 * idempotency key still in use by a concurrent request, so a retry succeeds) is unavailable; any
 * other Stripe error is refused. Stripe's own message is never read. Non-Stripe errors come back
 * unchanged, so real bugs are not hidden.
 */
export function stripeFailure(err: unknown): unknown {
  if (err instanceof Stripe.errors.StripeConnectionError) return new BillingUnavailableError(STRIPE_UNAVAILABLE);
  if (!(err instanceof Stripe.errors.StripeError)) return err;
  const status = err.statusCode;
  if (status !== undefined && (status >= 500 || status === 429 || status === 409)) {
    return new BillingUnavailableError(STRIPE_UNAVAILABLE);
  }
  return new BillingRefusedError(STRIPE_REFUSED);
}

/** Stripe through its SDK, with a fetch we can record in tests. No provider message is kept. */
export class StripeBillingProvider implements BillingProvider {
  readonly configured = true;
  private readonly stripe: Stripe;
  private readonly prices = new Map<string, string>();

  constructor(o: { secretKey: string; fetch?: typeof fetch; maxNetworkRetries?: number }) {
    this.stripe = new Stripe(o.secretKey, {
      httpClient: Stripe.createFetchHttpClient((...args) => (o.fetch ?? fetch)(...args)),
      maxNetworkRetries: o.maxNetworkRetries ?? 2,
    });
  }

  async ensureCustomer(i: {
    companyId: string;
    name: string;
    email: string | null;
    existingCustomerId: string | null;
  }): Promise<{ customerId: string }> {
    if (i.existingCustomerId) return { customerId: i.existingCustomerId };
    const customer = await this.call(() =>
      this.stripe.customers.create(
        {
          name: i.name,
          email: i.email ?? undefined,
          metadata: { company_id: i.companyId },
        },
        { idempotencyKey: 'customer:' + i.companyId },
      ),
    );
    return { customerId: customer.id };
  }

  async createCheckout(i: {
    customerId: string;
    companyId: string;
    planKey: string;
    priceLookupKeys: string[];
    trialEnd: Date | null;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }> {
    const [monthly, ai, sms] = await this.priceIds(i.priceLookupKeys);
    const session = await this.call(() =>
      this.stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: i.customerId,
        client_reference_id: i.companyId,
        payment_method_collection: 'always',
        line_items: [{ price: monthly, quantity: 1 }, { price: ai }, { price: sms }],
        subscription_data: {
          metadata: { company_id: i.companyId, plan_key: i.planKey },
          ...(i.trialEnd ? { trial_end: Math.floor(i.trialEnd.getTime() / 1000) } : {}),
        },
        metadata: { company_id: i.companyId, plan_key: i.planKey },
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
      }),
    );
    if (!session.url) throw new BillingRefusedError(STRIPE_REFUSED);
    return { url: session.url };
  }

  async createPortal(i: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    const session = await this.call(() =>
      this.stripe.billingPortal.sessions.create({ customer: i.customerId, return_url: i.returnUrl }),
    );
    return { url: session.url };
  }

  async changePlan(i: { subscriptionId: string; planKey: string; priceLookupKeys: string[] }): Promise<void> {
    const subscription = await this.call(() => this.stripe.subscriptions.retrieve(i.subscriptionId));
    const newIds = await this.priceIds(i.priceLookupKeys);
    const items: { id: string; price: string }[] = [];
    for (const item of subscription.items.data) {
      const currentKey = item.price.lookup_key ?? '';
      const suffix = KIND_SUFFIXES.find((s) => currentKey.endsWith(s));
      if (!suffix) continue;
      const index = i.priceLookupKeys.findIndex((k) => k.endsWith(suffix));
      if (index < 0) continue;
      items.push({ id: item.id, price: newIds[index] });
    }
    // One item per kind, or nothing: never send empty or partial items to Stripe.
    if (items.length !== KIND_SUFFIXES.length) {
      throw new BillingRefusedError(
        "This subscription's prices are out of date; run sync:stripe-plans, then change the plan in the Stripe portal.",
      );
    }
    await this.call(() =>
      this.stripe.subscriptions.update(i.subscriptionId, {
        items,
        proration_behavior: 'create_prorations',
        metadata: { plan_key: i.planKey },
      }),
    );
  }

  async reportMeterEvent(i: {
    eventName: string;
    customerId: string;
    value: number;
    identifier: string;
    timestamp: Date;
  }): Promise<void> {
    await this.call(() =>
      this.stripe.billing.meterEvents.create({
        event_name: i.eventName,
        payload: { stripe_customer_id: i.customerId, value: String(i.value) },
        identifier: i.identifier,
        timestamp: Math.floor(i.timestamp.getTime() / 1000),
      }),
    );
  }

  async createInvoiceItem(i: {
    customerId: string;
    amountCents: number;
    description: string;
    idempotencyKey: string;
  }): Promise<{ invoiceItemId: string }> {
    const item = await this.call(() =>
      this.stripe.invoiceItems.create(
        { customer: i.customerId, amount: i.amountCents, currency: 'usd', description: i.description },
        { idempotencyKey: i.idempotencyKey },
      ),
    );
    return { invoiceItemId: item.id };
  }

  /** Price ids for lookup keys, in the order given. Only keys not yet cached are fetched. */
  private async priceIds(keys: string[]): Promise<string[]> {
    const missing = keys.filter((k) => !this.prices.has(k));
    if (missing.length > 0) {
      const found = await this.call(() => this.stripe.prices.list({ lookup_keys: missing, active: true }));
      for (const price of found.data) {
        if (price.lookup_key) this.prices.set(price.lookup_key, price.id);
      }
    }
    const ids: string[] = [];
    for (const key of keys) {
      const id = this.prices.get(key);
      if (!id) throw new BillingRefusedError('A Stripe price is missing; run sync:stripe-plans.');
      ids.push(id);
    }
    return ids;
  }

  /** Runs one SDK call, with its Stripe failure mapped by `stripeFailure`. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw stripeFailure(err);
    }
  }
}

/** The Stripe provider when a secret key is configured; null otherwise (no Stripe call is made). */
export function stripeFor(config: Config): BillingProvider | null {
  if (!config.STRIPE_SECRET_KEY) return null;
  return new StripeBillingProvider({ secretKey: config.STRIPE_SECRET_KEY });
}
