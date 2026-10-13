import { TopBar } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { DemoBadge } from '../../features/demo/DemoBadge.tsx';
import { useIsPhone } from '../useIsPhone.ts';
import { AgentsWorking } from './AgentsWorking.tsx';
import { Clock } from './Clock.tsx';
import { OkPill } from './OkPill.tsx';
import { SearchDialog } from './SearchDialog.tsx';
import styles from './ShellTopBar.module.css';
import { UserMenu } from './UserMenu.tsx';
import { WeatherChip } from './WeatherChip.tsx';
import { LogoMark } from './topbarIcons.tsx';

/**
 * The thin bar across the top of the shell: the mark and the company on the left, what needs the person
 * in the middle, then the agents pill, the weather, search, the date and time and the account's initials.
 * On a phone the bar is compact: the logo, the OK pill, search and the initials. The agents pill,
 * the weather, the clock and the company name are not rendered there, so they make no requests. In demo mode a Demo badge
 * sits after the company (features/demo), opening the presenter's Simulate panel.
 */
export function ShellTopBar() {
  const me = useMe();
  const phone = useIsPhone();

  if (phone) {
    return (
      <TopBar
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
          <LogoMark className={styles.logo} />
          <span className={styles.company}>{me.data?.company.name}</span>
          <DemoBadge />
        </>
      }
      middle={<OkPill />}
      end={
        <>
          <AgentsWorking />
          <WeatherChip />
          <SearchDialog />
          <Clock />
          <UserMenu />
        </>
      }
    />
  );
}
