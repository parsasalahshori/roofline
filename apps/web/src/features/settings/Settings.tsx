import type { BreadcrumbItem } from '@roofline/ui';
import type { ReactNode } from 'react';
import { Navigate, useParams } from 'react-router';
import { useMe } from '../../api/hooks.ts';
import { WINDOW_COPY } from '../../copy/rail.ts';
import { settings } from '../../copy/settings.ts';
import { AppPage } from '../../shell/AppPage.tsx';
import { BillingTab } from '../billing/BillingTab.tsx';
import { FrontDeskTab } from '../front-desk/settings/FrontDeskTab.tsx';
import { ProfileTab } from '../front-desk/settings/ProfileTab.tsx';
import { SetupTab } from '../setup/SetupTab.tsx';
import { AgentsTab } from './AgentsTab.tsx';
import { CompanyTab } from './CompanyTab.tsx';
import { ConnectionsTab } from './ConnectionsTab.tsx';
import { PricesTab } from './PricesTab.tsx';
import { ScheduleTab } from './ScheduleTab.tsx';
import styles from './Settings.module.css';
import { SettingsTabs } from './SettingsTabs.tsx';
import { isSettingsTab, type SettingsTab } from './tabs.ts';
import { StormTab } from './StormTab.tsx';
import { TeamTab } from './TeamTab.tsx';

/** The screens that open under the Setup tab, by the name the router gives them. */
export type SettingsSubpage = 'import' | 'texting';

type SettingsProps = {
  /** A screen under Setup (the import wizard, texting registration): it takes the Setup tab's place in the page. */
  subpage?: ReactNode;
  /** Which screen `subpage` is, for the way back above it. */
  subpageKey?: SettingsSubpage;
};

/**
 * The Settings page: its title and the row of tabs, and the one tab the address names. An unknown tab goes to
 * Company, and so do Prices, Storm, Front Desk and Agents for a field rep. A `subpage` opens with its own way back:
 * "Settings / Setup / Import customers" on a desktop, "Setup" above the title on a phone.
 */
export function Settings({ subpage, subpageKey }: SettingsProps = {}) {
  const { tab: routeTab } = useParams();
  const me = useMe();
  const role = me.data?.role;
  const tab = subpage ? 'setup' : routeTab;
  if (!isSettingsTab(tab)) return <Navigate to="/settings/company" replace />;
  if ((tab === 'prices' || tab === 'storm') && role === 'rep') return <Navigate to="/settings/company" replace />;
  if (tab === 'front-desk' && role === 'rep') return <Navigate to="/settings/company" replace />;
  if (tab === 'agents' && role === 'rep') return <Navigate to="/settings/company" replace />;

  const crumbs: BreadcrumbItem[] | undefined =
    subpage && subpageKey
      ? [
          { label: WINDOW_COPY.settings.title, href: '/settings/company' },
          { label: settings.tabs.setup, href: '/settings/setup' },
          { label: settings.subpages[subpageKey] },
        ]
      : undefined;

  return (
    <AppPage app="settings" tabs={<SettingsTabs current={tab} role={role} />} crumbs={crumbs}>
      {/* The key resets a tab's own state (what was typed, what was saved) when another tab opens */}
      <div key={tab} className={styles.panel}>
        {renderPanel(tab, subpage, role !== undefined)}
      </div>
    </AppPage>
  );
}

/**
 * The panels for the tab: its screens, or the subpage in place of the Setup tab. The Prices panel waits
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
    case 'storm':
      return roleKnown ? <StormTab /> : null;
    case 'billing':
      return <BillingTab />;
    case 'setup':
      return subpage ?? <SetupTab />;
    case 'front-desk':
      return roleKnown ? <FrontDeskTab /> : null;
    case 'profile':
      return <ProfileTab />;
    case 'agents':
      return roleKnown ? <AgentsTab /> : null;
  }
}
