import type { SearchResult } from '../../api/types.ts';
import { search } from '../../copy/search.ts';
import type { Recent } from '../recents.ts';

/** One line in the search results: where it leads, and the two lines of text that say what it is. */
export type SearchOption = {
  key: string;
  href: string;
  group: 'actions' | 'recent' | 'customers' | 'jobs' | 'addresses';
  primary: string;
  secondary: string;
  /** True when the href is a file download, not a page of the app. */
  external?: boolean;
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

const ACTION_HREFS = {
  newJob: '/jobs/new',
  newCustomer: '/customers/new',
  bookInspection: '/calendar/new?kind=inspection',
  openCalendar: '/calendar',
  downloadCustomers: '/api/export/customers.csv',
} as const;

/** The actions whose words each start with the typed words. An empty query matches none. */
export function actionOptions(query: string, canDownload: boolean): SearchOption[] {
  const typed = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (typed.length === 0) return [];
  const names = Object.keys(ACTION_HREFS) as (keyof typeof ACTION_HREFS)[];
  return names
    .filter((name) => name !== 'downloadCustomers' || canDownload)
    .filter((name) => typed.every((word) => search.actionItems[name].words.some((candidate) => candidate.startsWith(word))))
    .map(
      (name): SearchOption => ({
        key: 'action:' + name,
        href: ACTION_HREFS[name],
        group: 'actions',
        primary: search.actionItems[name].label,
        secondary: '',
        ...(name === 'downloadCustomers' ? { external: true } : {}),
      }),
    );
}

/** The recent jobs and customers as options, in the order given. */
export function recentOptions(recents: Recent[]): SearchOption[] {
  return recents.map(
    (recent): SearchOption => ({
      key: `recent:${recent.kind}:${recent.id}`,
      href: (recent.kind === 'job' ? '/jobs/' : '/customers/') + encodeURIComponent(recent.id),
      group: 'recent',
      primary: recent.label,
      secondary: '',
    }),
  );
}
