import { EmptyState } from '@roofline/ui';
import { doors } from '../../../copy/doors.ts';

/** The routes list: a line until door-knocking routes are built. */
export function RoutesWindow() {
  return <EmptyState title={doors.routesComingSoon} />;
}
