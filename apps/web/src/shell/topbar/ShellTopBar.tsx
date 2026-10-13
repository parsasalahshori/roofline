import { TopBar } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { useIsPhone } from '../useIsPhone.ts';
import { AgentsWorking } from './AgentsWorking.tsx';
import { OkPill } from './OkPill.tsx';
import { SearchDialog } from './SearchDialog.tsx';
import styles from './ShellTopBar.module.css';
import { UserMenu } from './UserMenu.tsx';
import { WeatherChip } from './WeatherChip.tsx';
import { LogoMark } from './topbarIcons.tsx';

/**
 * The bar across the top of the shell: the company on the left, what needs the person and what
 * the agents are doing in the middle, the weather, search and the account on the right.
 * On a phone the bar is compact: the logo, the OK pill, search and the account (initials only; the pill
 * shrinks rather than overlap them). The agents line,
 * the weather and the company name are not rendered there, so they make no requests.
 */
export function ShellTopBar() {
  const me = useMe();
  const phone = useIsPhone();

  if (phone) {
    return (
      <TopBar
        compact
        start={<LogoMark className={styles.logo} />}
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
        </>
      }
      middle={
        <>
          <OkPill />
          <AgentsWorking />
        </>
      }
      end={
        <>
          <WeatherChip />
          <SearchDialog />
          <UserMenu />
        </>
      }
    />
  );
}
