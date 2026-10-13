import { TopBar } from '@roofline/ui';
import { useLocation } from 'react-router';
import { useMe } from '../../api/hooks.ts';
import { WINDOW_COPY } from '../../copy/dock.ts';
import { DemoBadge } from '../../features/demo/DemoBadge.tsx';
import type { WindowKey } from '../apps.ts';
import { useIsPhone } from '../useIsPhone.ts';
import { AgentsWorking } from './AgentsWorking.tsx';
import { Clock } from './Clock.tsx';
import { NotificationsBell } from './NotificationsBell.tsx';
import { OkPill } from './OkPill.tsx';
import { SearchDialog } from './SearchDialog.tsx';
import styles from './ShellTopBar.module.css';
import { UserMenu } from './UserMenu.tsx';
import { WeatherChip } from './WeatherChip.tsx';
import { LogoMark } from './topbarIcons.tsx';

/** The name of the open app, from the first part of the address; nothing on the map home page or an unknown address. */
function currentAppName(pathname: string): string | undefined {
  const key = pathname.split('/')[1] as WindowKey | undefined;
  return key && Object.hasOwn(WINDOW_COPY, key) && key !== 'notFound' ? WINDOW_COPY[key].title : undefined;
}

/**
 * The thin bar across the top of the shell, as the reference draws it: the mark, the company and the open
 * app on the left; then the agents, search, the weather, the bell, the date and time and the account's
 * initials on the right. What needs the person (the OK pill) sits in the middle. On a phone the bar is
 * compact: the logo, the OK pill, search, the bell and the initials. The agents, the weather, the clock
 * and the company name are not rendered there, so they make no requests. In demo mode a Demo badge sits
 * after the company (features/demo), opening the presenter's Simulate panel.
 */
export function ShellTopBar() {
  const me = useMe();
  const phone = useIsPhone();
  const { pathname } = useLocation();
  const app = currentAppName(pathname);

  if (phone) {
    return (
      <TopBar
        compact
        start={
          <>
            <LogoMark className={styles.logo} />
            <DemoBadge />
          </>
        }
        middle={<OkPill />}
        end={
          <>
            <SearchDialog />
            <NotificationsBell />
            <UserMenu />
          </>
        }
      />
    );
  }

  return (
    <TopBar
      start={
        <>
          <span className={styles.brand}>
            <LogoMark className={styles.logo} />
            <span className={styles.company}>{me.data?.company.name}</span>
          </span>
          {app ? <span className={styles.app}>{app}</span> : null}
          <DemoBadge />
        </>
      }
      middle={<OkPill />}
      end={
        <>
          <AgentsWorking />
          <SearchDialog />
          <WeatherChip />
          <NotificationsBell />
          <Clock />
          <UserMenu />
        </>
      }
    />
  );
}
