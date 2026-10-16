import { NotificationsBell } from '../topbar/NotificationsBell.tsx';
import { SearchDialog } from '../topbar/SearchDialog.tsx';
import { UserMenu } from '../topbar/UserMenu.tsx';
import styles from './PhoneChrome.module.css';

/**
 * What a phone has instead of a top bar: search, the bell and the person, drawn by every top-level page beside its
 * title (Page puts them there). The "need your OK" count is on the Today tab and in the More sheet.
 */
export function PhoneChrome() {
  return (
    <div className={styles.chrome}>
      <SearchDialog />
      <NotificationsBell />
      <UserMenu />
    </div>
  );
}
