import { EmptyState } from '@roofline/ui';
import { tiers } from '../../copy/tiers.ts';

/** The Tiers section slot of the Prices tab: a line until it is built. */
export function TiersSection() {
  return <EmptyState title={tiers.tiersComingSoon} />;
}
