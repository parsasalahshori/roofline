import type { Config } from '../config.ts';
import type { BillingProvider } from './billing.ts';

// Stub: the real Stripe adapter lands in a later task. Until then no Stripe billing provider exists.
export function stripeFor(config: Config): BillingProvider | null {
  void config;
  return null;
}
