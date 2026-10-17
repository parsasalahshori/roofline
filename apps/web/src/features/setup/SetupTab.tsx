import { FOUNDATION_ITEMS, type SetupItemView } from '@roofline/shared';
import { Banner, Panel, ProgressRing, Skeleton } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { setup } from '../../copy/setup.ts';
import { useSetup } from './api.ts';
import { SetupRow } from './SetupRow.tsx';
import rowStyles from './SetupRow.module.css';
import styles from './SetupTab.module.css';

/** The step to do next: the first one still to do or started, for the person who can act on it. */
function nextStep(items: readonly SetupItemView[], isOwner: boolean): SetupItemView['key'] | null {
  const open = items.find(
    (item) => (item.status === 'todo' || item.status === 'in_progress') && (isOwner || item.key === 'connect_calendar'),
  );
  return open?.key ?? null;
}

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
      <Panel>
        <div aria-busy="true">
          <Skeleton lines={4} />
        </div>
      </Panel>
    );
  }

  const { done, total } = view.progress;
  const next = nextStep(view.items, isOwner);
  // The count above is over the five first steps; the rows after them are listed apart so the two never disagree
  const firstLater = view.items.findIndex((item) => !FOUNDATION_ITEMS.includes(item.key));
  return (
    <Panel title={setup.heading} padded={false}>
      <div className={styles.summary}>
        {/* The words beside the ring say the same, so the ring is left out of the reading order */}
        <span aria-hidden="true" className={styles.ring}>
          <ProgressRing done={done} total={total} label={setup.ringLabel(done, total)} size={32} />
        </span>
        <p className={styles.progress}>{setup.progress(done, total)}</p>
        {isOwner ? null : <p className={styles.note}>{setup.ownerNote}</p>}
      </div>
      <ol aria-label={setup.listLabel} className={styles.list}>
        {view.items.map((item, index) => (
          <SetupRow
            key={item.key}
            item={item}
            canAct={isOwner}
            next={item.key === next}
            {...(index === firstLater && {
              lead: (
                <>
                  <span>{setup.laterHeading}</span>
                  <span className={rowStyles.leadNote}>{setup.laterNote}</span>
                </>
              ),
            })}
          />
        ))}
      </ol>
    </Panel>
  );
}
