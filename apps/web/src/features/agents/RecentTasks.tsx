import { Panel, Tag, UiLink } from '@roofline/ui';
import { hoursLabel, type RecentTask, type TaskStatus } from '@roofline/shared';
import { agentPage, agentsCommon } from '../../copy/agents.ts';
import { TASK_KIND_LABEL, TASK_STATUS_LABEL } from '../../copy/status.ts';
import { TASK_TAG } from '../approvals/taskStatus.ts';
import { useCompany } from '../settings/api.ts';
import { agentTimeLabel } from './time.ts';
import styles from './AgentLists.module.css';

function plain(value: string): string {
  return value.replace(/_/g, ' ');
}

function statusWords(status: string): string {
  return Object.hasOwn(TASK_STATUS_LABEL, status) ? TASK_STATUS_LABEL[status as keyof typeof TASK_STATUS_LABEL] : plain(status);
}

/** A status this screen does not know is drawn plain, with its words. */
function statusTag(status: string): (typeof TASK_TAG)[TaskStatus] {
  return Object.hasOwn(TASK_TAG, status) ? TASK_TAG[status as TaskStatus] : { tone: 'neutral', icon: 'clock' };
}

function kindWords(kind: string): string {
  return Object.hasOwn(TASK_KIND_LABEL, kind) ? TASK_KIND_LABEL[kind]! : plain(kind);
}

/** The latest work this agent did; each row opens that task in the review screen. */
export function RecentTasks({ tasks }: { tasks: RecentTask[] }) {
  const zone = useCompany().data?.timezone;
  return (
    <Panel title={agentPage.recentTitle} padded={tasks.length === 0}>
      {tasks.length === 0 ? (
        <p className={styles.empty}>{agentPage.recentEmpty}</p>
      ) : (
        <ul className={styles.list}>
          {tasks.map((task) => {
            const tag = statusTag(task.status);
            const content = (
              <>
                <span className={styles.kind}>{kindWords(task.kind)}</span>
                <Tag tone={tag.tone} icon={tag.icon}>
                  {statusWords(task.status)}
                </Tag>
                <span className={styles.meta}>{agentTimeLabel(task.createdAt, zone)}</span>
                {task.minutesSaved !== null ? <span className={styles.saved}>{`${hoursLabel(task.minutesSaved)} ${agentsCommon.estimate}`}</span> : null}
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
    </Panel>
  );
}
