import type { ProposalStatus, ProposalView } from '@roofline/shared';
import { Tag, type IconName, type TagTone } from '@roofline/ui';
import { job } from '../../copy/job.ts';
import { proposals } from '../../copy/proposals.ts';

/** The status tag: its tone, and the glyph that goes with the word so the status is never only a colour. */
const STATUS_TAG: Record<ProposalStatus, { tone: TagTone; icon: IconName }> = {
  draft: { tone: 'neutral', icon: 'pen' },
  ready: { tone: 'tape', icon: 'clock' },
  sent: { tone: 'info', icon: 'arrow' },
  viewed: { tone: 'info', icon: 'doc' },
  signed: { tone: 'ok', icon: 'check' },
  declined: { tone: 'warn', icon: 'x' },
  expired: { tone: 'warn', icon: 'alert' },
  replaced: { tone: 'neutral', icon: 'refresh' },
};

/** "Sent", or "Opened 2×" once the customer has looked: the word, a glyph and a tone. */
export function StatusTag({ proposal }: { proposal: Pick<ProposalView, 'status' | 'views'> }) {
  const { tone, icon } = STATUS_TAG[proposal.status];
  const opened = proposal.status === 'viewed' && proposal.views.count > 0;
  return (
    <Tag tone={tone} icon={icon}>
      {opened ? job.openedTag(proposal.views.count) : proposals.statusLabelFor(proposal.status)}
    </Tag>
  );
}
