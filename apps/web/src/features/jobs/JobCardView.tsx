import type { JobCard } from '@roofline/shared';
import { Avatar, UiLink } from '@roofline/ui';
import { jobs } from '../../copy/jobs.ts';
import { MoveJobMenu } from './MoveJobMenu.tsx';
import styles from './JobCardView.module.css';

const dollarFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const shortDateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Whole dollars from cents: 123456 is $1,235. */
export function formatDollars(cents: number): string {
  return dollarFormat.format(cents / 100);
}

/** A calendar day (YYYY-MM-DD) as "Oct 14". The day is a date, not an instant, so it is read in UTC. */
function formatShortDay(ymd: string): string | null {
  const instant = Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(instant) ? null : shortDateFormat.format(new Date(instant));
}

export type JobCardViewProps = { job: JobCard; onDragStart?: (job: JobCard) => void };

/** One job on the board: a link to the job, draggable, with the Move-to menu beside it (not inside the link). */
export function JobCardView({ job, onDragStart }: JobCardViewProps) {
  const nextDay = job.nextStepOn === null ? null : formatShortDay(job.nextStepOn);

  return (
    <div className={styles.card} data-stage={job.stage} data-stuck={job.stuck ? 'true' : 'false'}>
      <UiLink
        href={`/jobs/${job.id}`}
        className={styles.link}
        draggable={true}
        onDragStart={(event) => {
          if (event.dataTransfer) {
            event.dataTransfer.setData('text/plain', job.id);
            event.dataTransfer.effectAllowed = 'move';
          }
          onDragStart?.(job);
        }}
      >
        <span className={styles.top}>
          <strong className={styles.name}>{job.customerName}</strong>
          {job.valueCents !== null ? <span className={styles.value}>{jobs.value(formatDollars(job.valueCents))}</span> : null}
        </span>
        <span className={styles.address}>{job.addressLine}</span>
        <span className={styles.details}>
          <span className={styles.rep}>
            {job.assigned !== null ? (
              <>
                <Avatar name={job.assigned.name} size={24} />
                <span>{job.assigned.name}</span>
              </>
            ) : (
              <span className={styles.unassigned}>{jobs.unassigned}</span>
            )}
          </span>
          <span className={styles.meta}>{jobs.daysInStage(job.daysInStage)}</span>
        </span>
        {job.stuck ? <span className={styles.stuck}>{jobs.stuck(job.daysInStage)}</span> : null}
        {job.nextStep !== null ? <span className={styles.next}>{jobs.nextStep(job.nextStep, nextDay)}</span> : null}
      </UiLink>
      <MoveJobMenu job={job} compact />
    </div>
  );
}
