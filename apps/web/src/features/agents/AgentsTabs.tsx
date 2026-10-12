import { Button } from '@roofline/ui';
import { agents } from '../../copy/agents.ts';
import styles from './AgentsTabs.module.css';

export type AgentsTabKey = 'overview' | 'feed' | 'waiting' | 'agent';

const TABS = [
  { key: 'overview', href: '/agents' },
  { key: 'feed', href: '/agents/feed' },
  { key: 'waiting', href: '/agents/waiting' },
] as const;

/** The tab row shared by the Agents windows. On a single agent's page no tab is the current page. */
export function AgentsTabs({ current }: { current: AgentsTabKey }) {
  return (
    <nav aria-label={agents.tabsLabel} className={styles.tabs}>
      {TABS.map((tab) => (
        <Button
          key={tab.key}
          href={tab.href}
          variant={tab.key === current ? 'primary' : 'ghost'}
          aria-current={tab.key === current ? 'page' : undefined}
          className={styles.tab}
        >
          {agents.tabs[tab.key]}
        </Button>
      ))}
    </nav>
  );
}
