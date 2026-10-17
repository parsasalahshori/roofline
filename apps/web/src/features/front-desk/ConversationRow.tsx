import type { ConversationListItem } from '@roofline/shared';
import { Avatar, Badge, Icon, Tag, UiLink } from '@roofline/ui';
import { frontDeskInbox } from '../../copy/front-desk-inbox.ts';
import { durationLabel, outcomeChip, relativeTime } from './format.ts';
import styles from './ConversationRow.module.css';

const copy = frontDeskInbox;

export type ConversationRowProps = {
  item: ConversationListItem;
  /** The row the detail on the right is showing. */
  selected?: boolean;
  /** The time the row's "14 min ago" is counted from, in milliseconds since the epoch. */
  now: number;
};

/**
 * One line of "Latest calls": a link to the conversation. A person's initials (or a phone or speech glyph for a number
 * nobody knows), the name, an unread count, how long ago, the outcome as a tag with its glyph and word, and how long it ran.
 */
export function ConversationRow({ item, selected = false, now }: ConversationRowProps) {
  const live = item.liveCall !== null;
  const unread = item.unreadCount > 0;
  const chip = outcomeChip(item);
  const text = item.channel === 'sms';
  return (
    <li className={styles.item}>
      <UiLink
        href={`/front-desk/${item.id}`}
        className={styles.link}
        data-live={live ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        aria-current={selected ? 'true' : undefined}
      >
        {item.name === null ? (
          <span className={styles.glyph} aria-hidden="true">
            <Icon name={text ? 'msg' : 'phone'} size={18} />
          </span>
        ) : (
          <Avatar name={item.name} size={40} />
        )}
        <span className={styles.body}>
          <span className={styles.titleRow}>
            <span className={styles.name} data-unread={unread ? 'true' : undefined}>
              {item.name ?? copy.unknownCaller}
            </span>
            <Badge count={item.unreadCount} label={copy.unread(item.unreadCount)} />
            <time className={styles.time} dateTime={item.lastMessageAt}>
              {relativeTime(item.lastMessageAt, now)}
            </time>
          </span>
          <span className={styles.meta}>
            <span className={styles.tags}>
              {live ? (
                <Tag tone="ok">
                  <span className={styles.liveDot} aria-hidden="true" />
                  {copy.live}
                </Tag>
              ) : null}
              <Tag tone={chip.tone} icon={chip.icon}>
                {chip.label}
              </Tag>
              {item.urgent ? (
                <Tag tone="bad" icon="alert">
                  {copy.urgent}
                </Tag>
              ) : null}
              {item.handledBy === 'team' ? (
                <Tag icon="users">{copy.handledByTeam}</Tag>
              ) : null}
              {/* Needs-attention is read out, not drawn: the unread count and the tags already mark the row */}
              {item.needsAttention ? <span className={styles.sr}>{copy.needsAttention}</span> : null}
            </span>
            <span className={styles.duration}>
              <Icon name={text ? 'msg' : 'phone'} size={16} />
              {durationLabel(item)}
            </span>
          </span>
        </span>
      </UiLink>
    </li>
  );
}
