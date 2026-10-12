import { UiLink } from '@roofline/ui';
import { hoursLabel, type RecentTask } from '@roofline/shared';
import { agentPage } from '../../copy/agents.ts';
import { TASK_KIND_LABEL, TASK_STATUS_LABEL } from '../../copy/status.ts';
import styles from './AgentLists.module.css';

function plain(value: string): string {
  return value.replace(/_/g, ' ');
}

function statusWords(status: string): string {
  return Object.hasOwn(TASK_STATUS_LABEL, status)
    ? TASK_STATUS_LABEL[status as keyof typeof TASK_STATUS_LABEL]
    : plain(status);
}

function kindWords(kind: string): string {
  return Object.hasOwn(TASK_KIND_LABEL, kind) ? TASK_KIND_LABEL[kind]! : plain(kind);
}

function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The latest work this agent did; each row opens that task in the review screen. */
export function RecentTasks({ tasks }: { tasks: RecentTask[] }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.title}>{agentPage.recentTitle}</h2>
      {tasks.length === 0 ? (
        <p className={styles.empty}>{agentPage.recentEmpty}</p>
      ) : (
        <ul className={styles.list}>
          {tasks.map((task) => (
            <li key={task.id} className={styles.row}>
              <UiLink
                href={'/approvals/' + encodeURIComponent(task.id)}
                className={styles.link}
                aria-label={`${agentPage.recentOpenLabel} ${kindWords(task.kind)}`}
              >
                <span className={styles.kind}>{kindWords(task.kind)}</span>
                <span className={styles.meta}>{statusWords(task.status)}</span>
                <span className={styles.meta}>{whenLabel(task.createdAt)}</span>
                {task.minutesSaved !== null ? (
                  <span className={styles.meta}>
                    {`${hoursLabel(task.minutesSaved)} ${agentPage.estimateSuffix}`}
                  </span>
                ) : null}
              </UiLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
