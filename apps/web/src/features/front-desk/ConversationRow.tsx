import { useId } from 'react';
import type { ConversationListItem } from '@roofline/shared';
import { Badge, UiLink } from '@roofline/ui';
import { frontDeskInbox } from '../../copy/front-desk-inbox.ts';
import { formatPhone } from '../../lib/phone.ts';
import styles from './ConversationRow.module.css';

/** Month, day and time in the company's time zone (the browser's when there is none, or it is not a time zone name). */
function whenFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat('en-US', options);
  }
}

export type ConversationRowProps = {
  item: ConversationListItem;
  /** The company's time zone (IANA name), from the company settings. */
  timeZone?: string;
  selected?: boolean;
  onOpen?: () => void;
};

/** One line of the Front Desk list: a link to the conversation, with its state and a live call's dot. */
export function ConversationRow({ item, timeZone, selected = false, onOpen }: ConversationRowProps) {
  const rowId = useId();
  const showSummary = item.summary !== null && !selected;
  const live = item.liveCall !== null;
  const unread = item.unreadCount > 0;
  return (
    <li className={styles.item}>
      <UiLink href={`/front-desk/${item.id}`} className={styles.link}
        aria-labelledby={`${rowId}-title ${rowId}-meta`}
        aria-describedby={showSummary ? `${rowId}-summary` : undefined}
        aria-current={selected ? 'page' : undefined}
        onClick={(event) => {
          if (!onOpen || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onOpen();
        }} data-live={live ? 'true' : undefined}>
        <span className={styles.avatar} aria-hidden="true">{item.name ? item.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('') : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" focusable="false">
              {item.channel === 'voice'
                ? <path d="M7 3H4a1 1 0 0 0-1 1c0 9.4 7.6 17 17 17a1 1 0 0 0 1-1v-3l-5-2-2 2a15 15 0 0 1-7-7l2-2-2-5Z" />
                : <path d="M4 4h16v12H9l-5 4V4Zm4 4h8M8 12h6" />}
            </svg>
          )}</span>
        <span className={styles.content}>
        <span id={`${rowId}-title`} className={styles.titleRow}>
          <span className={styles.name} data-unread={unread ? 'true' : undefined}>
            {item.name ?? frontDeskInbox.unknownCaller}
          </span>
          <Badge count={item.unreadCount} label={frontDeskInbox.unread(item.unreadCount)} />
          <time className={styles.time} dateTime={item.lastMessageAt}>
            {whenFormatter(timeZone).format(new Date(item.lastMessageAt))}
          </time>
        </span>
        <span id={`${rowId}-meta`} className={styles.meta}>
          {live ? (
            <span className={styles.live}>
              <span className={styles.dot} aria-hidden="true" />
              {frontDeskInbox.live}
            </span>
          ) : null}
          <span>{frontDeskInbox.channel[item.channel]}</span>
          <span>{formatPhone(item.phoneE164)}</span>
          {item.outcome !== null ? <span className={styles.tag} data-outcome={item.outcome}>{frontDeskInbox.outcomes[item.outcome]}</span> : null}
          {item.urgent ? <span className={styles.tag} data-tone="urgent">{frontDeskInbox.urgent}</span> : null}
          {item.needsAttention ? <span className={styles.tag}>{frontDeskInbox.needsAttention}</span> : null}
          {item.handledBy === 'team' ? <span className={styles.tag}>{frontDeskInbox.handledByTeam}</span> : null}
        </span>
        {showSummary ? <span id={`${rowId}-summary`} className={styles.summary}>{item.summary}</span> : null}
        </span>
      </UiLink>
    </li>
  );
}
