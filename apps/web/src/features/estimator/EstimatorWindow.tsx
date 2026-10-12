import { EmptyState } from '@roofline/ui';
import { estimator } from '../../copy/estimator.ts';

/** The Estimator window skeleton: a line until the Estimator is built. */
export function EstimatorWindow() {
  return <EmptyState title={estimator.comingSoon} />;
}
