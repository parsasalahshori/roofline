import { EmptyState } from '@roofline/ui';
import { tiers } from '../../copy/tiers.ts';

/** The Financing section slot of the Prices tab: a line until it is built. */
export function FinancingSection() {
  return <EmptyState title={tiers.financingComingSoon} />;
}
