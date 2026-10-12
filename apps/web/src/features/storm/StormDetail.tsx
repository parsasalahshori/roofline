import { EmptyState } from '@roofline/ui';
import { storm } from '../../copy/storm.ts';

/** One storm page: a line until the storm detail is built. */
export function StormDetail() {
  return <EmptyState title={storm.detailComingSoon} />;
}
