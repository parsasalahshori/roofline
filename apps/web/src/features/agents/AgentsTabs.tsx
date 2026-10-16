import { Tabs } from '@roofline/ui';
import { agents } from '../../copy/agents.ts';
import styles from './AgentsTabs.module.css';

export type AgentsTabKey = 'overview' | 'feed' | 'waiting';

const TABS = [
  { key: 'overview', href: '/agents' },
  { key: 'feed', href: '/agents/feed' },
  { key: 'waiting', href: '/agents/waiting' },
] as const;

/** The tab row shared by the three Agents pages: each tab is a page with its own address. */
export function AgentsTabs({ current }: { current: AgentsTabKey }) {
  return (
    <div className={styles.tabs}>
      <Tabs
        label={agents.tabsLabel}
        items={TABS.map((tab) => ({ key: tab.key, label: agents.tabs[tab.key], href: tab.href, current: tab.key === current }))}
      />
    </div>
  );
}
