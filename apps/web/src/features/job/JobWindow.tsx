import { EmptyState } from '@roofline/ui';
import { job } from '../../copy/job.ts';

/** One job's window skeleton: a line until the job page is built. */
export function JobWindow() {
  return <EmptyState title={job.comingSoon} />;
}
