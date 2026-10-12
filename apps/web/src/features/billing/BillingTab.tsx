import { EmptyState } from '@roofline/ui';
import { billing } from '../../copy/billing.ts';

/** The Billing settings tab. A placeholder until the billing screens are built. */
export function BillingTab() {
  return <EmptyState title={billing.later} />;
}
