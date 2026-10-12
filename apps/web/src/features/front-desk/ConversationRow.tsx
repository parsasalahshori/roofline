import type { ConversationListItem } from '@roofline/shared';
import { Badge, UiLink } from '@roofline/ui';
import { frontDeskInbox } from '../../copy/front-desk-inbox.ts';
import styles from './ConversationRow.module.css';

/** A US number as (555) 123-0001, the country code dropped; any other number is shown as it was given. */
export function formatPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) return e164;
  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
}

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
};

/** One line of the Front Desk list: a link to the conversation, with its state and a live call's dot. */
export function ConversationRow({ item, timeZone }: ConversationRowProps) {
  const live = item.liveCall !== null;
  const unread = item.unreadCount > 0;
  return (
    <li className={styles.item}>
      <UiLink href={`/front-desk/${item.id}`} className={styles.link} data-live={live ? 'true' : undefined}>
        <span className={styles.titleRow}>
          <span className={styles.name} data-unread={unread ? 'true' : undefined}>
            {item.name ?? frontDeskInbox.unknownCaller}
          </span>
          <Badge count={item.unreadCount} label={frontDeskInbox.unread(item.unreadCount)} />
          <time className={styles.time} dateTime={item.lastMessageAt}>
            {whenFormatter(timeZone).format(new Date(item.lastMessageAt))}
          </time>
        </span>
        <span className={styles.meta}>
          {live ? (
            <span className={styles.live}>
              <span className={styles.dot} aria-hidden="true" />
              {frontDeskInbox.live}
            </span>
          ) : null}
          <span>{frontDeskInbox.channel[item.channel]}</span>
          <span>{formatPhone(item.phoneE164)}</span>
          {item.outcome !== null ? <span className={styles.tag}>{frontDeskInbox.outcomes[item.outcome]}</span> : null}
          {item.urgent ? <span className={styles.tag} data-tone="urgent">{frontDeskInbox.urgent}</span> : null}
          {item.needsAttention ? <span className={styles.tag}>{frontDeskInbox.needsAttention}</span> : null}
          {item.handledBy === 'team' ? <span className={styles.tag}>{frontDeskInbox.handledByTeam}</span> : null}
        </span>
        {item.summary !== null ? <span className={styles.summary}>{item.summary}</span> : null}
      </UiLink>
    </li>
  );
}
