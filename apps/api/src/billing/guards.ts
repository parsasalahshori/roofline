import type { CompanyStatus } from '@roofline/shared';

/**
 * Whether a company has a payment method on file: it has a Stripe subscription, and its status is
 * `active` or `past_due` (a subscription that has ended or was never started does not count).
 */
export function hasPaymentMethod(f: { stripeSubscriptionId: string | null; status: CompanyStatus }): boolean {
  return f.stripeSubscriptionId !== null && (f.status === 'active' || f.status === 'past_due');
}
