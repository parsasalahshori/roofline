import { UiLink } from '@roofline/ui';
import { hoursLabel, type RecentTask } from '@roofline/shared';
import { agentPage, agentsCommon } from '../../copy/agents.ts';
import { TASK_STATUS_LABEL } from '../../copy/status.ts';
import { agentTimeLabel } from './time.ts';
import styles from './AgentLists.module.css';

function plain(value: string): string {
  return value.replace(/_/g, ' ');
}

function statusWords(status: string): string {
  return Object.hasOwn(TASK_STATUS_LABEL, status)
    ? TASK_STATUS_LABEL[status as keyof typeof TASK_STATUS_LABEL]
    : plain(status);
}

/** The latest work this agent did; each row opens that task in the review screen. */
export function RecentTasks({ tasks }: { tasks: RecentTask[] }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.title}>{agentPage.recentTitle}</h3>
      {tasks.length === 0 ? (
        <p className={styles.empty}>{agentPage.recentEmpty}</p>
      ) : (
        <ul className={styles.list}>
          {tasks.map((task) => (
            <li key={task.id} className={styles.row}>
              <UiLink
                href={'/approvals/' + encodeURIComponent(task.id)}
                className={styles.link}
                aria-label={`${agentPage.recentOpenLabel} ${plain(task.kind)}`}
              >
                <span className={styles.kind}>{plain(task.kind)}</span>
                <span className={styles.meta}>{statusWords(task.status)}</span>
                <span className={styles.meta}>{agentTimeLabel(task.createdAt)}</span>
                {task.minutesSaved !== null ? (
                  <span className={styles.meta}>
                    {`${hoursLabel(task.minutesSaved)} ${agentsCommon.estimate}`}
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
