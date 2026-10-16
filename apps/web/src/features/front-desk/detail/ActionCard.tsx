import type { ToolActionCard } from '@roofline/shared';
import { Button, Icon, Tag, type IconName } from '@roofline/ui';
import { conversationCopy } from '../../../copy/front-desk-conversation.ts';
import styles from './ActionCard.module.css';

const copy = conversationCopy;

/** The record an action card opens, and the glyph that says what kind of record it is. Claim intake has no page yet, so it is plain text. */
function targetOf(card: ToolActionCard): { href: string; text: string; icon: IconName } | { href: null; icon: IconName } {
  const link = card.link;
  if (!link) return { href: null, icon: 'check2' };
  switch (link.kind) {
    case 'customer':
      return { href: `/customers/${link.id}`, text: copy.linkCustomer, icon: 'users' };
    case 'job':
      return { href: `/jobs/${link.id}`, text: copy.linkJob, icon: 'jobs' };
    case 'appointment':
      return { href: `/calendar/appointments/${link.id}`, text: copy.linkAppointment, icon: 'cal' };
    case 'claim_intake':
      return { href: null, icon: 'doc' };
  }
}

/**
 * Something the assistant did during the call ("Booked an inspection"), as a small card under the line that did it: what it did,
 * in the server's own sentence, and where to find the record. One that did not work says so in words, not only in colour.
 */
export function ActionCard({ card }: { card: ToolActionCard }) {
  const target = targetOf(card);
  return (
    <li className={styles.card} data-ok={card.ok ? 'true' : 'false'}>
      <span className={styles.mark} aria-hidden="true">
        <Icon name={card.ok ? target.icon : 'alert'} size={18} />
      </span>
      <span className={styles.text}>
        <span className={styles.label}>{card.label}</span>
        {card.ok ? null : (
          <Tag tone="bad" icon="alert">
            {copy.actionFailed}
          </Tag>
        )}
      </span>
      {target.href !== null ? (
        <Button href={target.href} variant="ghost" size="sm" className={styles.open}>
          {target.text}
          <Icon name="arrow" size={16} />
        </Button>
      ) : null}
    </li>
  );
}
