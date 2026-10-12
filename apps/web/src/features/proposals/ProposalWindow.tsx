import { EmptyState } from '@roofline/ui';
import { proposals } from '../../copy/proposals.ts';

/** The proposal window skeleton: a line until proposals are built. */
export function ProposalWindow() {
  return <EmptyState title={proposals.comingSoon} />;
}
