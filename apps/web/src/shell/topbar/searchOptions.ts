import type { SearchResult } from '../../api/types.ts';
import { search } from '../../copy/search.ts';

/** One line in the search results: where it leads, and the two lines of text that say what it is. */
export type SearchOption = {
  key: string;
  href: string;
  group: 'customers' | 'jobs' | 'addresses';
  primary: string;
  secondary: string;
};

/**
 * The search answer as one flat list, in the order the dialog shows it: customers, then jobs, then
 * addresses, each in the order the server sent them. Arrow keys walk this list.
 */
export function toOptions(result: SearchResult): SearchOption[] {
  return [
    ...result.customers.map(
      (customer): SearchOption => ({
        key: 'customer:' + customer.id,
        href: '/customers/' + encodeURIComponent(customer.id),
        group: 'customers',
        primary: customer.displayName,
        secondary: customer.phone ?? '',
      }),
    ),
    ...result.jobs.map(
      (job): SearchOption => ({
        key: 'job:' + job.id,
        href: '/jobs/' + encodeURIComponent(job.id),
        group: 'jobs',
        primary: job.customerName,
        secondary: search.join([job.stageLabel, job.addressLine]),
      }),
    ),
    ...result.addresses.map(
      (address): SearchOption => ({
        key: 'address:' + address.id,
        // An address leads to the customer it belongs to
        href: '/customers/' + encodeURIComponent(address.customerId),
        group: 'addresses',
        primary: address.addressLine,
        secondary: search.join([
          address.city,
          [address.state, address.zip].filter(Boolean).join(' '),
          address.customerName,
        ]),
      }),
    ),
  ];
}
