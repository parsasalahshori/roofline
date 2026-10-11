import { TopBar } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
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
 */
export function ShellTopBar() {
  const me = useMe();
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
