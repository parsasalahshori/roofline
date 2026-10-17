import { Button } from '@roofline/ui';
import type { TaskView } from '../../api/types.ts';
import { home } from '../../copy/home.ts';
import { TaskApprovalCard } from '../approvals/TaskApprovalCard.tsx';
import styles from './HomeApproval.module.css';
import { useNow } from './useNow.ts';

export type HomeApprovalProps = {
  /** The newest plan waiting for a yes. */
  task: TaskView;
  /** How many more are waiting after it: a line under the card points at them. */
  more: number;
  /** Where the plan's own screen is: its review screen under /approvals by default. The Storm page opens the storm's own review. */
  href?: string;
  /** Where the line under the card sends the rest. */
  seeAllHref?: string;
};

/**
 * The plan at the top of the approvals, as the same card the Need your OK page shows (who drafted it and when, its
 * title and what it does, a few facts, then Approve or Review, Edit and Not now), with one quiet line under it that
 * points at the rest. The card does all the deciding; this only places it and counts what is left.
 */
export function HomeApproval({ task, more, href, seeAllHref = '/approvals' }: HomeApprovalProps) {
  const now = useNow();
  return (
    <div className={styles.wrap}>
      <TaskApprovalCard task={task} now={now} {...(href !== undefined && { href })} />
      {more > 0 ? (
        <p className={styles.more}>
          <span>{home.moreWaiting(more)}</span>
          <Button size="sm" variant="ghost" href={seeAllHref}>
            {home.seeAll}
          </Button>
        </p>
      ) : null}
    </div>
  );
}
