import { EmptyState } from '@roofline/ui';
import { storm } from '../../copy/storm.ts';

/** The Storm settings tab (owner and office). Shows one line until the storm settings land. */
export function StormTab() {
  return <EmptyState title={storm.settingsComingSoon} />;
}
