import { EmptyState } from '@roofline/ui';
import { customers } from '../../copy/customers.ts';

/** One customer's window skeleton: a line until the customer page is built. */
export function CustomerWindow() {
  return <EmptyState title={customers.customerComingSoon} />;
}
