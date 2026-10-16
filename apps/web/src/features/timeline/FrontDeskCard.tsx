import { CONVERSATION_OUTCOMES, type ConversationOutcome, type TimelineItem } from '@roofline/shared';
import { Tag, UiLink } from '@roofline/ui';
import { timeline } from '../../copy/timeline.ts';
import { actorLabel, TimeStamp } from './Timeline.tsx';
import styles from './FrontDeskCard.module.css';

export interface FrontDeskActivity {
  summary: string;
  outcome: ConversationOutcome | null;
  conversationId: string;
}

function isOutcome(value: unknown): value is ConversationOutcome {
  return typeof value === 'string' && (CONVERSATION_OUTCOMES as readonly string[]).includes(value);
}

/** The Front Desk data of a call or text conversation activity, or null for anything else (or when data is missing). */
export function frontDeskActivity(item: TimelineItem): FrontDeskActivity | null {
  if (item.kind !== 'call' && item.kind !== 'text_conversation') return null;
  // GET /api/timeline does not return activities.data yet (C1 TimelineItem has no data field); until it does, this returns null and the row falls back to ActivityRow.
  const data = (item as TimelineItem & { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const { summary, conversationId, outcome } = data as Record<string, unknown>;
  if (typeof summary !== 'string' || typeof conversationId !== 'string') return null;
  return { summary, conversationId, outcome: isOutcome(outcome) ? outcome : null };
}

/** A call or text the Front Desk handled: what happened, how it ended, and the way to the conversation. */
export function FrontDeskCard({ item, data }: { item: TimelineItem; data: FrontDeskActivity }) {
  const label = item.kind === 'call' ? timeline.frontDesk.callLabel : timeline.frontDesk.textLabel;
  return (
    <li className={styles.item} data-type="front-desk">
      <span className={styles.dot} data-kind="front-desk" aria-hidden="true" />
      <div className={styles.card}>
        <div className={styles.head}>
          <span className={styles.label}>{label}</span>
          {data.outcome !== null ? <Tag>{timeline.frontDesk.outcome[data.outcome]}</Tag> : null}
        </div>
        <p className={styles.summary}>{data.summary}</p>
        <p className={styles.meta}>
          <span>{timeline.by(actorLabel(item))}</span> <TimeStamp at={item.at} />
        </p>
        <UiLink className={styles.link} href={`/front-desk/${encodeURIComponent(data.conversationId)}`}>
          {timeline.frontDesk.open}
        </UiLink>
      </div>
    </li>
  );
}
