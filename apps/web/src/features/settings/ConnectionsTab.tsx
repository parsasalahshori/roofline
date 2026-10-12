import { EmptyState } from '@roofline/ui';
import { connections } from '../../copy/connections.ts';
import { AdConnections } from './AdConnections.tsx';
import { CalendarConnection } from './CalendarConnection.tsx';

/** The Connections settings tab: the person's calendar, the one line about connections, then the ad accounts slot. */
export function ConnectionsTab() {
  return (
    <>
      <CalendarConnection />
      <EmptyState title={connections.later} />
      <AdConnections />
    </>
  );
}
