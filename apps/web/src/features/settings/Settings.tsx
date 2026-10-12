import { Button } from '@roofline/ui';
import type { ReactNode } from 'react';
import { Navigate, useParams } from 'react-router';
import { settings } from '../../copy/settings.ts';
import { BillingTab } from '../billing/BillingTab.tsx';
import { SetupTab } from '../setup/SetupTab.tsx';
import { CompanyTab } from './CompanyTab.tsx';
import { LaterTab } from './LaterTab.tsx';
import styles from './Settings.module.css';
import { isSettingsTab, SETTINGS_TABS } from './tabs.ts';
import { TeamTab } from './TeamTab.tsx';

/**
 * The Settings window: a row of tab links, and the one tab the address names. An unknown tab goes to
 * Company. A `subpage` (a screen under Setup, such as the import wizard) takes the Setup tab's place in the panel.
 * The window itself (title, close button) is drawn by the router's AppWindow.
 */
export function Settings({ subpage }: { subpage?: ReactNode } = {}) {
  const { tab: routeTab } = useParams();
  const tab = subpage ? 'setup' : routeTab;
  if (!isSettingsTab(tab)) return <Navigate to="/settings/company" replace />;

  return (
    <>
      <nav aria-label={settings.tabsLabel} className={styles.tabs}>
        {SETTINGS_TABS.map((key) => (
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
        {renderPanel(tab, subpage)}
      </div>
    </>
  );
}

/** The panel for the tab: its screen, or the subpage in place of the Setup tab. */
function renderPanel(tab: 'company' | 'team' | 'connections' | 'billing' | 'setup', subpage: ReactNode) {
  switch (tab) {
    case 'company':
      return <CompanyTab />;
    case 'team':
      return <TeamTab />;
    case 'billing':
      return <BillingTab />;
    case 'setup':
      return subpage ?? <SetupTab />;
    case 'connections':
      return <LaterTab tab={tab} />;
  }
}
