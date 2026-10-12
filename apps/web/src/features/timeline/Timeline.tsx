import type { Agent, TimelineItem } from '@roofline/shared';
import { Button, EmptyState, Skeleton } from '@roofline/ui';
import { AGENT_LABEL } from '../../copy/status.ts';
import { timeline } from '../../copy/timeline.ts';
import { NoteComposer } from './NoteComposer.tsx';
import { useTimeline, type TimelineSubject } from './api.ts';
import styles from './Timeline.module.css';

export type TimelineProps = TimelineSubject;

const absoluteFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/** "just now", "3 minutes ago", "2 hours ago", "1 day ago", relative to the moment it is drawn. */
export function relativeTime(at: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (seconds < 60) return timeline.justNow;
  if (seconds < 3600) return timeline.minutesAgo(Math.floor(seconds / 60));
  if (seconds < 86400) return timeline.hoursAgo(Math.floor(seconds / 3600));
  return timeline.daysAgo(Math.floor(seconds / 86400));
}

function isAgent(name: string): name is Agent {
  return Object.hasOwn(AGENT_LABEL, name);
}

/** Who did it: the agent's label, the person's name, or the Roofline name for the system. */
function actorLabel(item: TimelineItem): string {
  const { actor } = item;
  if (actor.type === 'system') return timeline.system;
  if (actor.name === null) return timeline.system;
  if (actor.type === 'agent' && isAgent(actor.name)) return AGENT_LABEL[actor.name];
  return actor.name;
}

function TimeStamp({ at }: { at: string }) {
  return (
    <time dateTime={at} title={absoluteFormat.format(new Date(at))} className={styles.time}>
      {relativeTime(at)}
    </time>
  );
}

function ActivityRow({ item }: { item: TimelineItem }) {
  return (
    <li className={styles.activity} data-type="activity">
      <p className={styles.summary}>{item.summary}</p>
      <p className={styles.meta}>
        <span>{timeline.by(actorLabel(item))}</span> <TimeStamp at={item.at} />
      </p>
    </li>
  );
}

function TextRow({ item, text }: { item: TimelineItem; text: NonNullable<TimelineItem['text']> }) {
  return (
    <li className={styles.text} data-type="text">
      <div className={styles.bubble} data-direction={text.direction} data-status={text.status}>
        <p className={styles.body}>{text.body}</p>
      </div>
      <p className={styles.meta}>
        <span>{timeline.messageStatus[text.status]}</span> <TimeStamp at={item.at} />
      </p>
    </li>
  );
}

/** The shared timeline of a job or a customer: the note box, then the items newest first. */
export function Timeline({ customerId, jobId }: TimelineProps) {
  const subject: TimelineSubject = jobId !== undefined ? { jobId } : { customerId };
  const query = useTimeline(subject);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  let body;
  if (query.isPending) {
    body = (
      <div className={styles.loading}>
        <p className={styles.visuallyHidden}>{timeline.loading}</p>
        <Skeleton lines={3} />
      </div>
    );
  } else if (query.data === undefined) {
    body = (
      <EmptyState
        title={timeline.loadFailed}
        action={
          <Button variant="primary" onClick={() => void query.refetch()}>
            {timeline.retry}
          </Button>
        }
      />
    );
  } else if (items.length === 0) {
    body = <p className={styles.empty}>{timeline.empty}</p>;
  } else {
    body = (
      <ol aria-label={timeline.label} className={styles.list}>
        {items.map((item) =>
          item.type === 'text' && item.text !== null ? (
            <TextRow key={item.id} item={item} text={item.text} />
          ) : (
            <ActivityRow key={item.id} item={item} />
          ),
        )}
      </ol>
    );
  }

  return (
    <section className={styles.timeline}>
      <NoteComposer subjectType={jobId !== undefined ? 'job' : 'customer'} subjectId={(jobId ?? customerId) ?? ''} />
      {body}
      {query.hasNextPage ? (
        <Button variant="ghost" busy={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          {timeline.showOlder}
        </Button>
      ) : null}
    </section>
  );
}
