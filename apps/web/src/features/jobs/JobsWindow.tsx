import { EmptyState } from '@roofline/ui';
import { jobs } from '../../copy/jobs.ts';
import { JobsTabs } from './JobsTabs.tsx';

/** The Jobs window skeleton: the tab row, and a line until the pipeline is built. */
export function JobsWindow() {
  return (
    <>
      <JobsTabs />
      <EmptyState title={jobs.comingSoon} />
    </>
  );
}
