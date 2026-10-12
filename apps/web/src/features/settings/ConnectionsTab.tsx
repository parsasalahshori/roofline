import { EmptyState } from '@roofline/ui';
import { connections } from '../../copy/connections.ts';
import { AdConnections } from './AdConnections.tsx';
import { CalendarConnection } from './CalendarConnection.tsx';

/** The Connections settings tab: the person's calendar, the ad accounts, then the one line about connections still to come. */
export function ConnectionsTab() {
  return (
    <>
      <CalendarConnection />
      <AdConnections />
      <EmptyState title={connections.later} />
    </>
  );
}
