import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import type { JobView } from '@roofline/shared';
import { Button, Panel, Skeleton } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { job } from '../../copy/job.ts';
import { WINDOW_COPY } from '../../copy/rail.ts';
import { type Recent, useRecordRecent } from '../../shell/recents.ts';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { DetailPage } from '../jobs/DetailPage.tsx';
import { MoveJobMenu } from '../jobs/MoveJobMenu.tsx';
import { EmptyPanel, LoadError } from '../jobs/states.tsx';
import { Timeline } from '../timeline/Timeline.tsx';
import { useJobView } from './api.ts';
import { ClaimSection } from './ClaimSection.tsx';
import { EditJobSheet } from './EditJobSheet.tsx';
import { JobDetails } from './JobDetails.tsx';
import { ContactTiles, JobActions, JobSubtitle } from './JobHeader.tsx';
import { NextStepCard } from './NextStepCard.tsx';
import { ProposalsPanel, RoofPanel } from './JobProposals.tsx';
import { AppointmentsPanel, QuotesPanel, TasksPanel } from './JobSections.tsx';
import { StageStepper, StageStepperSkeleton } from './StageStepper.tsx';
import styles from './JobWindow.module.css';

const JOBS_CRUMB = { label: WINDOW_COPY.jobs.title, href: '/jobs' } as const;

/** The panels' shape while the job loads: a main column and a side column of panels. */
function JobSkeleton() {
  return (
    <div role="status" aria-label={job.loading} aria-busy="true" className={styles.grid}>
      <div className={styles.main}>
        {[0, 1, 2].map((panel) => (
          <div key={panel} className={styles.skeletonPanel}>
            <Skeleton lines={3} height="40px" />
          </div>
        ))}
      </div>
      <div className={styles.side}>
        {[0, 1].map((panel) => (
          <div key={panel} className={styles.skeletonPanel}>
            <Skeleton lines={4} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** One job's page: its head, stage steps and panels once the job has loaded (or why it has not). */
export function JobWindow() {
  const { jobId = '' } = useParams();
  const { data, error, isError, isFetching, refetch } = useJobView(jobId);

  if (data !== undefined) return <LoadedJob key={data.job.id} view={data} />;

  const crumbs = [JOBS_CRUMB, { label: job.crumbJob }];
  if (isError) {
    return (
      <DetailPage app="jobs" crumbs={crumbs}>
        {error instanceof ApiError && error.status === 404 ? (
          <EmptyPanel
            title={job.notFoundTitle}
            body={job.notFoundBody}
            action={
              <Button href="/jobs" variant="default">
                {job.backToJobs}
              </Button>
            }
          />
        ) : (
          <LoadError tag={job.errorTag} title={job.loadFailed} retry={job.retry} busy={isFetching} onRetry={() => void refetch()} />
        )}
      </DetailPage>
    );
  }

  return (
    <DetailPage app="jobs" crumbs={crumbs} stats={<StageStepperSkeleton />}>
      <JobSkeleton />
    </DetailPage>
  );
}

/** The job once it is loaded. Keyed by job, so a change of job starts fresh (and records its own recent). */
function LoadedJob({ view }: { view: JobView }) {
  const [editing, setEditing] = useState(false);
  const phone = useIsPhone();
  const { job: current, customer, can } = view;
  const recent = useMemo<Recent>(() => ({ kind: 'job', id: current.id, label: customer.displayName }), [current.id, customer.displayName]);
  useRecordRecent(recent);
  const edit = () => setEditing(true);

  return (
    <DetailPage
      app="jobs"
      title={customer.displayName}
      crumbs={[JOBS_CRUMB, { label: customer.displayName }]}
      subtitle={<JobSubtitle view={view} phone={phone} />}
      actions={phone ? undefined : <JobActions view={view} />}
      barActions={phone && can.edit ? <MoveJobMenu job={current} archived={current.archived} /> : undefined}
      stats={<StageStepper job={current} canEdit={can.edit} />}
    >
      <div className={styles.content}>
        {phone ? <ContactTiles view={view} /> : null}
        <div className={styles.grid}>
          <div className={styles.main}>
            <ProposalsPanel view={view} className={styles.proposals} />
            <RoofPanel jobId={current.id} className={styles.roof} />
            <AppointmentsPanel view={view} className={styles.appointments} />
            <QuotesPanel view={view} className={styles.quotes} />
            <Panel title={job.timelineTitle} className={styles.timeline}>
              <Timeline jobId={current.id} />
            </Panel>
          </div>
          <div className={styles.side}>
            <NextStepCard view={view} onEdit={edit} className={styles.next} />
            <JobDetails view={view} onEdit={edit} className={styles.details} />
            <ClaimSection jobId={current.id} className={styles.claim} />
            <TasksPanel view={view} className={styles.tasks} />
          </div>
        </div>
      </div>
      {editing ? <EditJobSheet view={view} onClose={() => setEditing(false)} /> : null}
    </DetailPage>
  );
}
