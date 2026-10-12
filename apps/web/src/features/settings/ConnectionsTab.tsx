import { EmptyState } from '@roofline/ui';
import { connections } from '../../copy/connections.ts';
import { AdConnections } from './AdConnections.tsx';

/** The Connections settings tab. Shows the one line about connections, then the ad accounts slot. */
export function ConnectionsTab() {
  return (
    <>
      <EmptyState title={connections.later} />
      <AdConnections />
    </>
  );
}
