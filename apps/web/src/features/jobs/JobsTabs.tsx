import { Tabs } from '@roofline/ui';
import { useLocation, useSearchParams } from 'react-router';
import { jobs } from '../../copy/jobs.ts';

/**
 * The underline tabs shared by the Jobs page and the Customers page: Pipeline (/jobs), Customers (/customers) and
 * Archived (the pipeline's archived filter, /jobs?archived=true).
 */
export function JobsTabs() {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const onCustomers = pathname.startsWith('/customers');
  const archived = !onCustomers && params.get('archived') === 'true';
  const current = onCustomers ? 'customers' : archived ? 'archived' : 'pipeline';

  return (
    <Tabs
      label={jobs.tabsLabel}
      items={[
        { key: 'pipeline', label: jobs.tabs.pipeline, href: '/jobs', current: current === 'pipeline' },
        { key: 'customers', label: jobs.tabs.customers, href: '/customers', current: current === 'customers' },
        { key: 'archived', label: jobs.tabs.archived, href: '/jobs?archived=true', current: current === 'archived' },
      ]}
    />
  );
}
