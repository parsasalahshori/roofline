import type { Config } from '../config.ts';
import { FakeBillingProvider } from './fakes/billing.ts';
import { stripeFor } from './stripe.ts';

export interface BillingProvider { readonly configured: boolean;
  ensureCustomer(i: { companyId: string; name: string; email: string | null; existingCustomerId: string | null }): Promise<{ customerId: string }>;
  createCheckout(i: { customerId: string; companyId: string; planKey: string; priceLookupKeys: string[]; trialEnd: Date | null;
    successUrl: string; cancelUrl: string }): Promise<{ url: string }>;
  createPortal(i: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  changePlan(i: { subscriptionId: string; planKey: string; priceLookupKeys: string[] }): Promise<void>;
  reportMeterEvent(i: { eventName: string; customerId: string; value: number; identifier: string; timestamp: Date }): Promise<void>;
  createInvoiceItem(i: { customerId: string; amountCents: number; description: string; idempotencyKey: string }): Promise<{ invoiceItemId: string }> }
export class BillingUnavailableError extends Error {}

/** Used when no real billing provider is configured: every call fails with a setup message. */
export class UnconfiguredBillingProvider implements BillingProvider {
  readonly configured = false;
  async ensureCustomer(): Promise<{ customerId: string }> {
    throw new BillingUnavailableError("Billing isn't set up.");
  }
  async createCheckout(): Promise<{ url: string }> {
    throw new BillingUnavailableError("Billing isn't set up.");
  }
  async createPortal(): Promise<{ url: string }> {
    throw new BillingUnavailableError("Billing isn't set up.");
  }
  async changePlan(): Promise<void> {
    throw new BillingUnavailableError("Billing isn't set up.");
  }
  async reportMeterEvent(): Promise<void> {
    throw new BillingUnavailableError("Billing isn't set up.");
  }
  async createInvoiceItem(): Promise<{ invoiceItemId: string }> {
    throw new BillingUnavailableError("Billing isn't set up.");
  }
}

/** The billing provider the app uses: the fake under FAKE_PROVIDERS, else Stripe when configured. */
export function createBillingProvider(config: Config): BillingProvider {
  if (config.FAKE_PROVIDERS) return new FakeBillingProvider();
  return stripeFor(config) ?? new UnconfiguredBillingProvider();
}
