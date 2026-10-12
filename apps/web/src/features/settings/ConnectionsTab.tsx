import { EmptyState } from '@roofline/ui';
import { connections } from '../../copy/connections.ts';

/** The Connections settings tab. Shows the one line about ad accounts until connections land. */
export function ConnectionsTab() {
  return <EmptyState title={connections.later} />;
}
