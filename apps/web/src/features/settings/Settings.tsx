import { Button } from '@roofline/ui';
import { Navigate, useParams } from 'react-router';
import { settings } from '../../copy/settings.ts';
import { CompanyTab } from './CompanyTab.tsx';
import { LaterTab } from './LaterTab.tsx';
import styles from './Settings.module.css';
import { isSettingsTab, SETTINGS_TABS } from './tabs.ts';
import { TeamTab } from './TeamTab.tsx';

/**
 * The Settings window: a row of tab links, and the one tab the address names. An unknown tab goes to
 * Company. The window itself (title, close button) is drawn by the router's AppWindow.
 */
export function Settings() {
  const { tab } = useParams();
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
        {tab === 'company' ? <CompanyTab /> : tab === 'team' ? <TeamTab /> : <LaterTab tab={tab} />}
      </div>
    </>
  );
}
