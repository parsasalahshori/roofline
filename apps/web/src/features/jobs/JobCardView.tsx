import type { JobCard } from '@roofline/shared';
import { Avatar, Icon, Tag, UiLink, type TagProps } from '@roofline/ui';
import type { DragEvent } from 'react';
import { jobs } from '../../copy/jobs.ts';
import { formatDollars, formatShortDay } from './format.ts';
import { MoveJobMenu } from './MoveJobMenu.tsx';
import { useCompanyToday } from './useCompanyToday.ts';
import styles from './JobCardView.module.css';

/** After this many days in a stage the aging bar turns amber (a stuck job turns it amber at once). */
const HOT_AFTER_DAYS = 3;
/** The aging bar is full at a week. */
const FULL_BAR_DAYS = 7;

export type JobCardViewProps = {
  job: JobCard;
  /** The company's today (YYYY-MM-DD): a next step that is due today earns the card its one tag. Left out, it is read from the company. */
  today?: string;
  /** The card is being dragged: it fades where it stands. */
  dragging?: boolean;
  onDragStart?: (job: JobCard) => void;
  onDragEnd?: () => void;
};

type CardTag = { label: string; tone: NonNullable<TagProps['tone']>; icon: NonNullable<TagProps['icon']> };

/** The one tag a card may carry, from the job's own next-step date: due today, or past due. Nothing otherwise. */
function cardTag(job: JobCard, today: string): CardTag | null {
  if (job.nextStepOn === null) return null;
  const day = job.nextStepOn.slice(0, 10);
  if (day === today) return { label: jobs.tagToday, tone: 'ok', icon: 'clock' };
  if (day < today) return { label: jobs.tagOverdue, tone: 'warn', icon: 'alert' };
  return null;
}

/** "today" or "Oct 14", for the next-step line. */
function whenText(job: JobCard, today: string): string | null {
  if (job.nextStepOn === null) return null;
  return job.nextStepOn.slice(0, 10) === today ? jobs.today : formatShortDay(job.nextStepOn);
}

/** Days in the stage as a short bar and a mono "4d": amber after three days, or when the job is stuck. */
export function Aging({ days, stuck }: { days: number; stuck: boolean }) {
  const hot = stuck || days > HOT_AFTER_DAYS;
  const fill = Math.max(10, Math.round((Math.min(Math.max(days, 0), FULL_BAR_DAYS) / FULL_BAR_DAYS) * 100));
  return (
    <span className={styles.age} data-hot={hot ? 'true' : undefined}>
      <span className="visually-hidden">{stuck ? jobs.stuck(days) : jobs.daysInStage(days)}</span>
      <span className={styles.ageBar} aria-hidden="true">
        <span className={styles.ageFill} style={{ width: `${fill}%` }} />
      </span>
      <span aria-hidden="true">{jobs.daysShort(days)}</span>
    </span>
  );
}

/** Makes the picture that follows the pointer while a card is dragged: the card itself, tilted, lifted off the lane. */
function setTiltedDragImage(event: DragEvent<HTMLElement>): void {
  const card = event.currentTarget.closest<HTMLElement>('[data-card]');
  const transfer = event.dataTransfer;
  if (card === null || typeof transfer.setDragImage !== 'function') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const ghost = card.cloneNode(true) as HTMLElement;
  ghost.classList.add(styles.ghost);
  ghost.style.width = `${card.offsetWidth}px`;
  card.parentElement?.appendChild(ghost);
  transfer.setDragImage(ghost, 24, 24);
  window.setTimeout(() => ghost.remove(), 0);
}

/** One job on the board: a link to the job, draggable, with the split Move-to button beside it (not inside the link). */
export function JobCardView({ job, today: todayProp, dragging = false, onDragStart, onDragEnd }: JobCardViewProps) {
  const companyToday = useCompanyToday();
  const today = todayProp ?? companyToday;
  const tag = cardTag(job, today);
  const when = whenText(job, today);

  return (
    <div
      className={styles.card}
      data-card=""
      data-stage={job.stage}
      data-stuck={job.stuck ? 'true' : 'false'}
      data-dragging={dragging ? 'true' : undefined}
    >
      <UiLink
        href={`/jobs/${job.id}`}
        className={styles.link}
        draggable={true}
        onDragStart={(event) => {
          event.dataTransfer.setData('text/plain', job.id);
          event.dataTransfer.effectAllowed = 'move';
          setTiltedDragImage(event);
          onDragStart?.(job);
        }}
        onDragEnd={() => onDragEnd?.()}
      >
        <span className={styles.top}>
          <strong className={styles.name}>{job.customerName}</strong>
          {tag !== null ? (
            <Tag tone={tag.tone} icon={tag.icon} className={styles.tag}>
              {tag.label}
            </Tag>
          ) : null}
        </span>
        <span className={styles.address}>{job.addressLine}</span>
        {job.nextStep !== null ? (
          <span className={styles.next}>
            <Icon name="clock" size={16} className={styles.nextIcon} />
            <span className={styles.nextText}>{jobs.nextStepLine(job.nextStep, when)}</span>
          </span>
        ) : null}
        <span className={styles.footer}>
          {job.valueCents !== null ? <span className={styles.value}>{formatDollars(job.valueCents)}</span> : null}
          {job.assigned !== null ? (
            <span className={styles.rep}>
              <Avatar name={job.assigned.name} size={24} />
              <span className={job.valueCents === null ? styles.repName : 'visually-hidden'}>{job.assigned.name}</span>
            </span>
          ) : (
            <span className={styles.unassigned}>{jobs.unassigned}</span>
          )}
          <Aging days={job.daysInStage} stuck={job.stuck} />
        </span>
      </UiLink>
      <div className={styles.actions}>
        <MoveJobMenu job={job} split />
      </div>
    </div>
  );
}
