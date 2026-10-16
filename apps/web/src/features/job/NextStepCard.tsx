import { useId } from 'react';
import type { JobView } from '@roofline/shared';
import { Button, Icon, Tag } from '@roofline/ui';
import { job } from '../../copy/job.ts';
import { formatShortDay } from '../jobs/format.ts';
import { useCompanyToday } from '../jobs/useCompanyToday.ts';
import styles from './NextStepCard.module.css';

/** A calendar day (YYYY-MM-DD) some days on from another. */
function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days)).toISOString().slice(0, 10);
}

/** "Today", "Tomorrow" or "Oct 17": the next step's day, as a person would say it. */
function whenText(on: string, today: string): string {
  const day = on.slice(0, 10);
  if (day === today) return job.today;
  if (day === addDays(today, 1)) return job.tomorrow;
  return formatShortDay(day) ?? day;
}

export type NextStepCardProps = { view: JobView; onEdit: () => void; className?: string };

/**
 * What happens next on this job and when: the step in Archivo, its day and the rep under it. A step whose day has gone
 * by says Overdue in words and in the card's warm tint. With no step, the card offers to add one.
 */
export function NextStepCard({ view, onEdit, className }: NextStepCardProps) {
  const { job: current, can } = view;
  const today = useCompanyToday();
  const headingId = useId();
  const step = current.nextStep;
  const on = current.nextStepOn;
  const overdue = step !== null && on !== null && on.slice(0, 10) < today;
  const meta = [on !== null ? whenText(on, today) : null, current.assigned?.name ?? null].filter((part): part is string => part !== null);

  return (
    <section aria-labelledby={headingId} className={[styles.card, className].filter(Boolean).join(' ')} data-overdue={overdue ? 'true' : undefined}>
      <span className={styles.icon} aria-hidden="true">
        <Icon name="clock" size={22} />
      </span>
      <div className={styles.text}>
        <p id={headingId} className={styles.eyebrow}>
          {job.nextStepLabel}
        </p>
        {step !== null ? <p className={styles.step}>{step}</p> : <p className={styles.none}>{job.nextStepNone}</p>}
        {step === null ? <p className={styles.body}>{job.nextStepEmptyBody}</p> : null}
        {step !== null && (meta.length > 0 || overdue) ? (
          <p className={styles.meta}>
            {meta.length > 0 ? <span>{job.nextStepMeta(meta)}</span> : null}
            {overdue ? (
              <Tag tone="warn" icon="alert">
                {job.overdue}
              </Tag>
            ) : null}
          </p>
        ) : null}
        {step === null && can.edit ? (
          <div className={styles.action}>
            <Button variant="default" size="sm" onClick={onEdit}>
              <Icon name="plus" size={16} />
              {job.nextStepAdd}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
