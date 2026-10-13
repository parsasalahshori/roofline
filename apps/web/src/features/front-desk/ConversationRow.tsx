import type { ConversationListItem } from '@roofline/shared';
import { Badge, UiLink } from '@roofline/ui';
import { frontDeskInbox } from '../../copy/front-desk-inbox.ts';
import { durationLabel, initialsOf, outcomeChip, relativeTime } from './lift/format.ts';
import styles from './ConversationRow.module.css';

export type ConversationRowProps = {
  item: ConversationListItem;
  /** The row the detail on the right is showing. */
  selected?: boolean;
  /** The time the row's "14 min ago" is counted from, in milliseconds since the epoch. */
  now: number;
};

/** One line of "Latest calls": a link to the conversation, with an avatar, outcome chip, how long ago and how long it ran. */
export function ConversationRow({ item, selected = false, now }: ConversationRowProps) {
  const live = item.liveCall !== null;
  const unread = item.unreadCount > 0;
  const chip = outcomeChip(item);
  return (
    <li className={styles.item}>
      <UiLink
        href={`/front-desk/${item.id}`}
        className={styles.link}
        data-live={live ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        aria-current={selected ? 'true' : undefined}
      >
        <span className={styles.avatar} aria-hidden="true" data-unknown={item.name === null ? 'true' : undefined}>
          {initialsOf(item.name)}
        </span>
        <span className={styles.body}>
          <span className={styles.titleRow}>
            <span className={styles.name} data-unread={unread ? 'true' : undefined}>
              {item.name ?? frontDeskInbox.unknownCaller}
            </span>
            <Badge count={item.unreadCount} label={frontDeskInbox.unread(item.unreadCount)} />
            <time className={styles.time} dateTime={item.lastMessageAt}>
              {relativeTime(item.lastMessageAt, now)}
            </time>
          </span>
          <span className={styles.meta}>
            <span className={styles.chips}>
              {live ? (
                <span className={styles.live}>
                  <span className={styles.dot} aria-hidden="true" />
                  {frontDeskInbox.live}
                </span>
              ) : null}
              <span className={styles.chip} data-tone={chip.tone}>
                {chip.label}
              </span>
              {item.urgent ? <span className={styles.chip} data-tone="urgent">{frontDeskInbox.urgent}</span> : null}
              {item.needsAttention ? <span className={styles.chip}>{frontDeskInbox.needsAttention}</span> : null}
              {item.handledBy === 'team' ? <span className={styles.chip}>{frontDeskInbox.handledByTeam}</span> : null}
            </span>
            <span className={styles.duration}>{durationLabel(item)}</span>
          </span>
        </span>
      </UiLink>
    </li>
  );
}
