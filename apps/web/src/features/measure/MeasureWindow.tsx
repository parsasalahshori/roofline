import { EmptyState } from '@roofline/ui';
import { measure } from '../../copy/measure.ts';

/** The measuring window skeleton: a line until measuring is built. */
export function MeasureWindow() {
  return <EmptyState title={measure.comingSoon} />;
}
