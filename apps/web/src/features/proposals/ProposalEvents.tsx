import type { ProposalView } from '@roofline/shared';
import { Icon, type IconName } from '@roofline/ui';
import { proposals } from '../../copy/proposals.ts';
import { formatLastOpened, formatWhen } from './format.ts';
import styles from './ProposalEvents.module.css';

export type ProposalEventLine = { key: string; icon: IconName; text: string };

/** What has happened to the proposal, from the facts the server keeps: sent, opened, signed or declined. */
export function proposalEventLines(proposal: ProposalView, now: Date, timeZone: string | undefined): ProposalEventLine[] {
  const lines: ProposalEventLine[] = [];
  if (proposal.sentAt !== null) lines.push({ key: 'sent', icon: 'arrow', text: proposals.sentOn(formatWhen(proposal.sentAt, now, timeZone)) });
  if (proposal.views.count > 0 && proposal.views.last !== null) {
    lines.push({ key: 'opened', icon: 'doc', text: proposals.eventsLine(proposal.views.count, formatLastOpened(proposal.views.last, now, timeZone)) });
  } else if (proposal.sentAt !== null && proposal.signed === null && proposal.declined === null) {
    // Not once a customer has signed or declined: that took opening it, whatever the count of views says
    lines.push({ key: 'unopened', icon: 'clock', text: proposals.eventsNone });
  }
  if (proposal.signed !== null) {
    lines.push({ key: 'signed', icon: 'check', text: proposals.signedLine(proposal.signed.name, formatWhen(proposal.signed.at, now, timeZone)) });
  }
  if (proposal.declined !== null) {
    lines.push({ key: 'declined', icon: 'x', text: proposals.declinedLine(formatWhen(proposal.declined.at, now, timeZone)) });
    if (proposal.declined.reason !== null && proposal.declined.reason !== '') {
      lines.push({ key: 'reason', icon: 'msg', text: proposals.declinedReason(proposal.declined.reason) });
    }
  }
  return lines;
}

/** The lines as a short list, each with its glyph. Draws nothing when nothing has happened. */
export function ProposalEvents({ lines }: { lines: ReadonlyArray<ProposalEventLine> }) {
  if (lines.length === 0) return null;
  return (
    <ul className={styles.events}>
      {lines.map((line) => (
        <li key={line.key}>
          <Icon name={line.icon} size={16} />
          <span>{line.text}</span>
        </li>
      ))}
    </ul>
  );
}
