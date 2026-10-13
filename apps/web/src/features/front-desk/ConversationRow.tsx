import type { ConversationListItem } from '@roofline/shared';
import { Badge, UiLink } from '@roofline/ui';
import { frontDeskInbox } from '../../copy/front-desk-inbox.ts';
import { durationLabel, initialsOf, outcomeChip, relativeTime } from './lift/format.ts';
import { OutcomeChipView } from './lift/OutcomeChipView.tsx';
import styles from './ConversationRow.module.css';

const AVATAR_ICONS = {
  // a shield with a slash for an unknown (blocked) caller, a speech bubble for a text thread
  shield: 'M8 1.8l5 1.8v4c0 3-2.1 5-5 6.4C5.1 12.6 3 10.6 3 7.6v-4zM6 6l4 4M10 6l-4 4',
  text: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2zM5 6.2h6M5 8.2h4',
} as const;

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
          {item.name === null || item.channel === 'sms' ? (
            <svg className={styles.avatarIcon} viewBox="0 0 16 16" focusable="false">
              <path d={item.name === null ? AVATAR_ICONS.shield : AVATAR_ICONS.text} />
            </svg>
          ) : (
            initialsOf(item.name)
          )}
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
              <OutcomeChipView chip={chip} />
              {item.urgent ? <span className={styles.urgent}>{frontDeskInbox.urgent}</span> : null}
              {/* Needs-attention and team-handled are read out, not drawn: the unread count already marks the row */}
              {item.needsAttention ? <span className={styles.sr}>{frontDeskInbox.needsAttention}</span> : null}
              {item.handledBy === 'team' ? <span className={styles.sr}>{frontDeskInbox.handledByTeam}</span> : null}
            </span>
            <span className={styles.duration}>{durationLabel(item)}</span>
          </span>
        </span>
      </UiLink>
    </li>
  );
}
