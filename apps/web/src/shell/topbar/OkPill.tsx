import { UiLink } from '@roofline/ui';
import { useApprovals } from '../../api/hooks.ts';
import { shell } from '../../copy/shell.ts';
import { countedDrafts } from '../countedDrafts.ts';
import styles from './OkPill.module.css';

/**
 * "N need your OK": a compact amber pill, shown while drafts wait for a yes. With one draft it opens
 * that draft; with several it opens the list. The number is the drafts that count, not the server's own count.
 */
export function OkPill() {
  const drafts = countedDrafts(useApprovals().data);
  if (drafts.length === 0) return null;
  const [only] = drafts;
  const href = drafts.length === 1 && only ? '/approvals/' + encodeURIComponent(only.id) : '/approvals';
  return (
    <UiLink href={href} className={styles.pill}>
      <span className={styles.dot} aria-hidden="true" />
      {shell.needYourOk(drafts.length)}
    </UiLink>
  );
}
