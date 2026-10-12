import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import type { JobView } from '@roofline/shared';
import { Button, EmptyState, Skeleton, StatCard } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { job } from '../../copy/job.ts';
import { jobs } from '../../copy/jobs.ts';
import { useRecordRecent } from '../../shell/recents.ts';
import { formatDollars } from '../jobs/JobCardView.tsx';
import { useJobView } from './api.ts';
import { EditJobSheet } from './EditJobSheet.tsx';
import { JobHeader } from './JobHeader.tsx';
import { JobSections } from './JobSections.tsx';
import styles from './JobWindow.module.css';

/** One job's window: its stat strip, header, sections and the edit sheet. AppWindow (in the router) wraps it. */
export function JobWindow() {
  const { jobId = '' } = useParams();
  const view = useJobView(jobId);

  if (view.isPending) {
    return (
      <div role="status" aria-label={job.loading} className={styles.loading}>
        <Skeleton lines={3} />
      </div>
    );
  }

  if (view.isError) {
    if (view.error instanceof ApiError && view.error.status === 404) {
      return (
        <EmptyState
          title={job.notFoundTitle}
          body={job.notFoundBody}
          action={
            <Button variant="ghost" href="/jobs">
              {job.backToJobs}
            </Button>
          }
        />
      );
    }
    return (
      <EmptyState
        title={job.loadFailed}
        action={
          <Button variant="ghost" busy={view.isFetching} onClick={() => void view.refetch()}>
            {job.retry}
          </Button>
        }
      />
    );
  }

  if (view.data === undefined) return null;
  return <LoadedJob key={view.data.job.id} view={view.data} />;
}

/** The job once it is loaded. Keyed by job, so a change of job starts fresh (and records its own recent). */
function LoadedJob({ view }: { view: JobView }) {
  const [editing, setEditing] = useState(false);
  const jobId = view.job.id;
  const customerName = view.customer.displayName;
  const recent = useMemo(() => ({ kind: 'job' as const, id: jobId, label: customerName }), [jobId, customerName]);
  useRecordRecent(recent);

  const showValue = view.can.seeValue && view.job.valueCents !== null;

  return (
    <div className={styles.window}>
      <div className={styles.stats}>
        <StatCard label={job.statStage} value={jobs.stage[view.job.stage]} />
        {showValue && view.job.valueCents !== null ? (
          <StatCard label={job.statValue} value={formatDollars(view.job.valueCents)} />
        ) : null}
        <StatCard label={job.statDays} value={job.daysInStage(view.job.daysInStage)} />
      </div>

      <JobHeader view={view} onEdit={() => setEditing(true)} />
      <JobSections view={view} />

      {editing ? <EditJobSheet view={view} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}
