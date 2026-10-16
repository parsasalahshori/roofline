import { Button, EmptyState, Panel, Skeleton, Tag, UiLink } from '@roofline/ui';
import { useRef } from 'react';
import { ApiError } from '../../api/client.ts';
import { useApprovals, useMe } from '../../api/hooks.ts';
import type { TaskView } from '../../api/types.ts';
import { approvals } from '../../copy/approvals.ts';
import { errors } from '../../copy/errors.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { AgentGlyph } from '../agents/AgentGlyph.tsx';
import styles from './ApprovalsList.module.css';
import { InlineError } from './InlineError.tsx';
import { newestFirst } from './queue.ts';
import { reviewHref, TaskApprovalCard } from './TaskApprovalCard.tsx';
import { useQueueKeys } from './useQueueKeys.ts';

/** The cards a plan's shape: placeholders in the place and size the real ones will take, while they load. */
function QueueSkeleton() {
  return (
    <div className={styles.grid} role="status" aria-label={approvals.loading}>
      {[0, 1].map((index) => (
        <div key={index} className={styles.skeleton}>
          <div className={styles.skeletonHead}>
            <Skeleton width="22px" height="22px" />
            <Skeleton width="40%" height="0.875rem" />
          </div>
          <Skeleton width="70%" height="1.25rem" />
          <Skeleton lines={2} height="0.875rem" />
          <div className={styles.skeletonButtons}>
            <Skeleton width="96px" height="30px" />
            <Skeleton width="64px" height="30px" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Nothing waits: where the plans will appear, with the way to see what the agents have been doing. */
function QueueEmpty() {
  return (
    <Panel as="div" padded>
      <div className={styles.empty}>
        <EmptyState
          title={approvals.emptyTitle}
          body={approvals.emptyBody}
          action={
            <Button variant="primary" href={approvals.emptyHref}>
              {approvals.emptyAction}
            </Button>
          }
        />
        <div className={styles.ghosts} aria-hidden="true">
          <span className={styles.ghost} />
          <span className={styles.ghost} />
        </div>
      </div>
    </Panel>
  );
}

/** Plans that ran out of time before anyone answered: quiet rows that open the plan, where it can be run again. */
function ExpiredPlans({ tasks, now }: { tasks: TaskView[]; now: number }) {
  return (
    <Panel title={approvals.expiredTitle} tag={tasks.length} padded={false}>
      <ul aria-label={approvals.expiredListLabel} className={styles.expiredList}>
        {tasks.map((task) => (
          <li key={task.id}>
            <UiLink href={reviewHref(task.id)} className={styles.expiredRow}>
              <AgentGlyph agent={task.agent} />
              <span className={styles.expiredText}>
                <strong className={styles.expiredTitle}>{task.title}</strong>
                <span className={styles.expiredMeta}>{approvals.drafted(AGENT_LABEL[task.agent], approvals.ago(task.createdAt, now))}</span>
              </span>
              <Tag tone="warn" icon="clock">
                {approvals.expired}
              </Tag>
            </UiLink>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** The plans waiting for a yes, newest first, as the kit's approval cards, with the keys of a triage list. */
export function ApprovalsList() {
  const me = useMe();
  const approvalsQuery = useApprovals();
  const listRef = useRef<HTMLUListElement>(null);
  const tasks = approvalsQuery.data === undefined ? [] : newestFirst(approvalsQuery.data.tasks);
  const waiting = tasks.filter((task) => !task.expired);
  const expired = tasks.filter((task) => task.expired);
  useQueueKeys(listRef, waiting.map((task) => task.id));

  // Owners and office staff decide on plans; a rep is told so, whatever the list holds
  if (me.data?.role === 'rep') {
    return (
      <Panel as="div">
        <EmptyState
          title={approvals.repTitle}
          body={approvals.repBody}
          action={
            <Button variant="default" href={approvals.repHref}>
              {approvals.repAction}
            </Button>
          }
        />
      </Panel>
    );
  }
  // Nothing is shown until we know who is asking, so a rep never glimpses the plans
  if (me.isPending || approvalsQuery.isPending) return <QueueSkeleton />;
  if (approvalsQuery.data === undefined) {
    const message = approvalsQuery.error instanceof ApiError ? approvalsQuery.error.message : errors.generic;
    return <InlineError tag={approvals.errorTag} message={message} retryLabel={errors.tryAgain} onRetry={() => void approvalsQuery.refetch()} />;
  }
  if (tasks.length === 0) return <QueueEmpty />;

  // "3 days ago" reads off the moment the list was fetched, so a render is repeatable
  const now = approvalsQuery.dataUpdatedAt;

  return (
    <div className={styles.page}>
      {waiting.length > 0 ? (
        <>
          <ul aria-label={approvals.keysLabel} className={styles.keys}>
            {approvals.keys.map((item) => (
              <li key={item.label} className={styles.key}>
                {item.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
                <span>{item.label}</span>
              </li>
            ))}
          </ul>
          <ul ref={listRef} aria-label={approvals.listLabel} className={styles.grid}>
            {waiting.map((task) => (
              <li key={task.id} data-task-id={task.id} className={styles.item}>
                <TaskApprovalCard task={task} now={now} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {expired.length > 0 ? <ExpiredPlans tasks={expired} now={now} /> : null}
    </div>
  );
}
