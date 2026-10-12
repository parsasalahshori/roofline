import { EmptyState } from '@roofline/ui';
import { doors } from '../../../copy/doors.ts';

/** One route: a line until the route page is built. */
export function RouteDetail() {
  return <EmptyState title={doors.routeComingSoon} />;
}
