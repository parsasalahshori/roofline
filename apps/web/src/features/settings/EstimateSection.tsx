import { EmptyState } from '@roofline/ui';
import { tiers } from '../../copy/tiers.ts';

/** The Estimate section slot of the Prices tab: a line until it is built. */
export function EstimateSection() {
  return <EmptyState title={tiers.estimateComingSoon} />;
}
