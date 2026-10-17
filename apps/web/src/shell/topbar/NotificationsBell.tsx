import { Icon, UiLink } from '@roofline/ui';
import { useApprovals } from '../../api/hooks.ts';
import { shell } from '../../copy/shell.ts';
import { countedDrafts } from '../countedDrafts.ts';
import styles from './NotificationsBell.module.css';

/** The bell: a red dot while plans wait for a yes, and it opens that list. */
export function NotificationsBell() {
  const waiting = countedDrafts(useApprovals().data).length > 0;
  return (
    <UiLink href="/approvals" className={styles.bell} aria-label={shell.notificationsLabel} data-waiting={waiting ? 'true' : undefined}>
      <Icon name="bell" />
      {waiting ? <span className={styles.dot} aria-hidden="true" /> : null}
    </UiLink>
  );
}
