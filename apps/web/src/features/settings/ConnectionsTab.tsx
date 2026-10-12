import { EmptyState } from '@roofline/ui';
import { connections } from '../../copy/connections.ts';
import { CalendarConnection } from './CalendarConnection.tsx';

/** The Connections settings tab: the person's calendar, then the one line about ad accounts until those land. */
export function ConnectionsTab() {
  return (
    <>
      <CalendarConnection />
      <EmptyState title={connections.later} />
    </>
  );
}
