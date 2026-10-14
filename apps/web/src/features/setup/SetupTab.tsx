import { Banner, ProgressBar, Skeleton } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { setup } from '../../copy/setup.ts';
import { useSetup } from './api.ts';
import { SetupRow } from './SetupRow.tsx';
import styles from './SetupTab.module.css';

/*
 * The Setup settings tab: the checklist for getting a company started, in the order the API gives.
 * Only the owner acts on it; everyone else reads the same list.
 */
export function SetupTab() {
  const query = useSetup();
  const me = useMe();
  const view = query.data;
  const isOwner = me.data?.role === 'owner';

  if (!view) {
    if (query.error) {
      return (
        <Banner tone="danger">{query.error instanceof ApiError ? query.error.message : setup.loadFailed}</Banner>
      );
    }
    return (
      <div aria-busy="true">
        <Skeleton lines={4} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.summary}>
        <p className={styles.progress}>{setup.progress(view.progress.done, view.progress.total)}</p>
        <p className={styles.note}>{setup.atYourPace}</p>
        <ProgressBar value={view.progress.done} max={view.progress.total} label={setup.listLabel} />
      </div>
      {isOwner ? null : <p className={styles.note}>{setup.ownerNote}</p>}
      <ol aria-label={setup.listLabel} className={styles.list}>
        {view.items.map((item) => (
          <SetupRow key={item.key} item={item} canAct={isOwner} />
        ))}
      </ol>
    </div>
  );
}
