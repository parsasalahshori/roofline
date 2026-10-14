import { Button, Card, EmptyState, Skeleton, UiLink } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { useApprovals, useMe } from '../../api/hooks.ts';
import type { TaskView } from '../../api/types.ts';
import { approvals } from '../../copy/approvals.ts';
import { errors } from '../../copy/errors.ts';
import { AGENT_LABEL, taskStatusLabel } from '../../copy/status.ts';
import styles from './ApprovalsList.module.css';

/** The plans, newest first. The server sends them that way already; the copy is sorted anyway, so a new plan never sinks. */
function newestFirst(tasks: TaskView[]): TaskView[] {
  return [...tasks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** The plans waiting for a yes, newest first, as cards that open the review screen. */
export function ApprovalsList() {
  const me = useMe();
  const approvalsQuery = useApprovals();

  // Owners and office staff decide on plans; a rep is told so, whatever the list holds
  if (me.data?.role === 'rep') return <EmptyState title={approvals.repTitle} />;
  // Nothing is shown until we know who is asking, so a rep never glimpses the plans
  if (me.isPending || approvalsQuery.isPending) return <Skeleton lines={3} />;
  if (approvalsQuery.data === undefined) {
    const message = approvalsQuery.error instanceof ApiError ? approvalsQuery.error.message : errors.generic;
    return (
      <EmptyState
        title={message}
        action={
          <Button variant="primary" onClick={() => void approvalsQuery.refetch()}>
            {errors.tryAgain}
          </Button>
        }
      />
    );
  }

  const tasks = newestFirst(approvalsQuery.data.tasks);
  if (tasks.length === 0) return <EmptyState title={approvals.emptyTitle} />;

  return (
    <div className={styles.page}>
      <p className={styles.help}>{approvals.listHelp}</p>
      <ul aria-label={approvals.listLabel} className={styles.list}>
        {tasks.map((task) => (
          <li key={task.id}>
            <UiLink href={'/approvals/' + encodeURIComponent(task.id)} className={styles.link}>
              <Card className={styles.card}>
                <span className={styles.agent}>{AGENT_LABEL[task.agent]}</span>
                <strong className={styles.title}>{task.title}</strong>
                {task.summary !== null ? <span className={styles.summary}>{task.summary}</span> : null}
                <span className={styles.status} data-status={task.status}>
                  {task.expired ? approvals.expired : taskStatusLabel(task)}
                </span>
                <span className={styles.open}>{approvals.reviewPlan}<span aria-hidden="true">→</span></span>
              </Card>
            </UiLink>
          </li>
        ))}
      </ul>
    </div>
  );
}
