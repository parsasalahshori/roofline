import { Panel, Tag, UiLink } from '@roofline/ui';
import { hoursLabel, type RecentTask, type ScreenAgent, type TaskStatus } from '@roofline/shared';
import { agentPage } from '../../copy/agents.ts';
import { TASK_STATUS_LABEL } from '../../copy/status.ts';
import { TASK_TAG } from '../approvals/taskStatus.ts';
import { useCompany } from '../settings/api.ts';
import { keepAddressTogether } from './addressText.ts';
import { agentTimeLabel } from './time.ts';
import styles from './AgentLists.module.css';

/** How many of the recent tasks the page lists; the rest are in the Feed, one tap away. */
export const RECENT_SHOWN = 10;

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

/**
 * The latest work this agent did, each row two lines of the same shape: what it was and its state, then when and what it
 * saved. A row opens that task. Past the tenth the Feed, filtered to this agent, has the rest.
 */
export function RecentTasks({ agent, tasks }: { agent: ScreenAgent; tasks: RecentTask[] }) {
  const zone = useCompany().data?.timezone;
  const shown = tasks.slice(0, RECENT_SHOWN);
  return (
    <Panel title={agentPage.recentTitle} padded={tasks.length === 0}>
      {tasks.length === 0 ? (
        <p className={styles.empty}>{agentPage.recentEmpty}</p>
      ) : (
        <>
          <ul className={styles.list}>
            {shown.map((task) => {
              const tag = statusTag(task.status);
              const content = (
                <>
                  <span className={styles.title}>{keepAddressTogether(task.title)}</span>
                  <Tag tone={tag.tone} icon={tag.icon} className={styles.status}>
                    {statusWords(task.status)}
                  </Tag>
                  <span className={styles.meta}>{agentTimeLabel(task.createdAt, zone)}</span>
                  {task.minutesSaved !== null ? <span className={styles.saved}>{hoursLabel(task.minutesSaved)}</span> : null}
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
          {tasks.length > RECENT_SHOWN ? (
            <p className={styles.more}>
              <UiLink href={`/agents/feed?agent=${agent}`} className={styles.moreLink}>
                {agentPage.recentSeeAll}
              </UiLink>
            </p>
          ) : null}
        </>
      )}
    </Panel>
  );
}
