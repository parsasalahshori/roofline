import { Button } from '@roofline/ui';
import { useLocation } from 'react-router';
import { jobs } from '../../copy/jobs.ts';
import styles from './JobsTabs.module.css';

/** The tab row shared by the Jobs window and the Customers window: Pipeline (/jobs) and Customers (/customers). */
export function JobsTabs() {
  const { pathname } = useLocation();
  const active = pathname.startsWith('/customers') ? 'customers' : 'pipeline';
  const tabs = [
    { key: 'pipeline', href: '/jobs' },
    { key: 'customers', href: '/customers' },
  ] as const;

  return (
    <nav aria-label={jobs.tabsLabel} className={styles.tabs}>
      {tabs.map((tab) => (
        <Button
          key={tab.key}
          href={tab.href}
          variant={tab.key === active ? 'primary' : 'ghost'}
          aria-current={tab.key === active ? 'page' : undefined}
          className={styles.tab}
        >
          {jobs.tabs[tab.key]}
        </Button>
      ))}
    </nav>
  );
}
