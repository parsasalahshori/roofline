import { EmptyState } from '@roofline/ui';
import { create } from '../../copy/create.ts';

/** The New job screen. Task 18 skeleton: one line until the form lands. */
export function NewJob() {
  return <EmptyState title={create.newJob.comingSoon} />;
}
