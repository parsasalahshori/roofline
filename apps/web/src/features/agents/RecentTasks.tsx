import { UiLink } from '@roofline/ui';
import { hoursLabel, type RecentTask } from '@roofline/shared';
import { agentPage, agentsCommon } from '../../copy/agents.ts';
import { TASK_KIND_LABEL, TASK_STATUS_LABEL } from '../../copy/status.ts';
import { useCompany } from '../settings/api.ts';
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

function kindWords(kind: string): string {
  return Object.hasOwn(TASK_KIND_LABEL, kind) ? TASK_KIND_LABEL[kind]! : plain(kind);
}

/** The latest work this agent did; each row opens that task in the review screen. */
export function RecentTasks({ tasks }: { tasks: RecentTask[] }) {
  const zone = useCompany().data?.timezone;
  return (
    <section className={styles.section}>
      <h3 className={styles.title}>{agentPage.recentTitle}</h3>
      {tasks.length === 0 ? (
        <p className={styles.empty}>{agentPage.recentEmpty}</p>
      ) : (
        <ul className={styles.list}>
          {tasks.map((task) => {
            const content = (
              <>
                <span className={styles.kind}>{kindWords(task.kind)}</span>
                <span className={styles.meta}>{statusWords(task.status)}</span>
                <span className={styles.meta}>{agentTimeLabel(task.createdAt, zone)}</span>
                {task.minutesSaved !== null ? (
                  <span className={styles.meta}>
                    {`${hoursLabel(task.minutesSaved)} ${agentsCommon.estimate}`}
                  </span>
                ) : null}
              </>
            );
            return (
              <li key={task.id} className={styles.row}>
                {task.href === null ? (
                  <div className={styles.link}>{content}</div>
                ) : (
                  <UiLink href={task.href} className={styles.link}>
                    {content}
                  </UiLink>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
