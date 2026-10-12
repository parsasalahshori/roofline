import { EmptyState } from '@roofline/ui';
import { customers } from '../../copy/customers.ts';
import { JobsTabs } from '../jobs/JobsTabs.tsx';

/** The Customers window skeleton: the shared tab row, and a line until the customer list is built. */
export function CustomersWindow() {
  return (
    <>
      <JobsTabs />
      <EmptyState title={customers.comingSoon} />
    </>
  );
}
