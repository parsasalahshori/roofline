import { Button } from '@roofline/ui';
import type { ReactNode } from 'react';
import { Navigate, useParams } from 'react-router';
import { useMe } from '../../api/hooks.ts';
import { settings } from '../../copy/settings.ts';
import { BillingTab } from '../billing/BillingTab.tsx';
import { SetupTab } from '../setup/SetupTab.tsx';
import { CompanyTab } from './CompanyTab.tsx';
import { ConnectionsTab } from './ConnectionsTab.tsx';
import { PricesTab } from './PricesTab.tsx';
import { ScheduleTab } from './ScheduleTab.tsx';
import styles from './Settings.module.css';
import { isSettingsTab, type SettingsTab, visibleTabs } from './tabs.ts';
import { TeamTab } from './TeamTab.tsx';

/**
 * The Settings window: a row of tab links, and the one tab the address names. An unknown tab goes to
 * Company, and so does Prices for a field rep. A `subpage` (a screen under Setup, such as the import wizard)
 * takes the Setup tab's place in the panel.
 * The window itself (title, close button) is drawn by the router's AppWindow.
 */
export function Settings({ subpage }: { subpage?: ReactNode } = {}) {
  const { tab: routeTab } = useParams();
  const me = useMe();
  const role = me.data?.role;
  const tab = subpage ? 'setup' : routeTab;
  if (!isSettingsTab(tab)) return <Navigate to="/settings/company" replace />;
  if (tab === 'prices' && role === 'rep') return <Navigate to="/settings/company" replace />;

  return (
    <>
      <nav aria-label={settings.tabsLabel} className={styles.tabs}>
        {visibleTabs(role).map((key) => (
          <Button
            key={key}
            href={'/settings/' + key}
            variant={key === tab ? 'primary' : 'ghost'}
            aria-current={key === tab ? 'page' : undefined}
            className={styles.tab}
          >
            {settings.tabs[key]}
          </Button>
        ))}
      </nav>
      {/* The key resets a tab's own state (what was typed, what was saved) when another tab opens */}
      <div key={tab} className={styles.panel}>
        {renderPanel(tab, subpage, role !== undefined)}
      </div>
    </>
  );
}

/**
 * The panel for the tab: its screen, or the subpage in place of the Setup tab. The Prices panel waits
 * until the role is known, so a field rep never sees it.
 */
function renderPanel(tab: SettingsTab, subpage: ReactNode, roleKnown: boolean) {
  switch (tab) {
    case 'company':
      return <CompanyTab />;
    case 'team':
      return <TeamTab />;
    case 'prices':
      return roleKnown ? <PricesTab /> : null;
    case 'schedule':
      return <ScheduleTab />;
    case 'connections':
      return <ConnectionsTab />;
    case 'billing':
      return <BillingTab />;
    case 'setup':
      return subpage ?? <SetupTab />;
  }
}
