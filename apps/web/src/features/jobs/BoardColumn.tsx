import type { BoardColumn as BoardColumnData, BoardStage, JobCard } from '@roofline/shared';
import { Button, Icon, IconButton } from '@roofline/ui';
import { useRef, useState, type DragEvent } from 'react';
import { jobs } from '../../copy/jobs.ts';
import { useColumnPages, type BoardFilterParams } from './api.ts';
import { formatDollars } from './format.ts';
import { JobCardView } from './JobCardView.tsx';
import styles from './BoardColumn.module.css';

/** A job can be added straight into these lanes. Won needs a value and Installed only follows Won, so they are not offered. */
const ADDABLE: readonly BoardStage[] = ['lead', 'inspection', 'proposal'];

export type BoardColumnProps = {
  column: BoardColumnData;
  filter: BoardFilterParams;
  /** The company's today (YYYY-MM-DD), for the cards' tags. */
  today: string;
  /** This lane's part of the money in play, 0 to 100; null when the lane has no total to share. */
  share: number | null;
  /** The card being dragged, if any: its own lane does not light up as a place to drop. */
  dragging: JobCard | null;
  onDragStart: (job: JobCard) => void;
  onDragEnd: () => void;
  onDropJob: (jobId: string, to: BoardStage) => void;
};

/** One stage of the board: its header (dot, name, count, money, share), its cards, and a drop target for dragged cards. */
export function BoardColumn({ column, filter, today, share, dragging, onDragStart, onDragEnd, onDropJob }: BoardColumnProps) {
  const { visible, remaining, busy, more } = useColumnPages(column, filter);
  const label = jobs.stage[column.stage];
  // dragenter and dragleave fire for every child the pointer crosses; the depth tells when it has truly left the lane
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  const accepts = dragging !== null && dragging.stage !== column.stage;

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
  };
  const handleDragEnter = () => {
    depth.current += 1;
    setOver(true);
  };
  const handleDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  };
  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    depth.current = 0;
    setOver(false);
    const jobId = event.dataTransfer.getData('text/plain');
    if (jobId !== '') onDropJob(jobId, column.stage);
  };

  return (
    <section
      className={styles.lane}
      data-stage={column.stage}
      data-over={over && accepts ? 'true' : undefined}
      data-drop-label={jobs.dropHere(label)}
      aria-label={label}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <span className={styles.dot} aria-hidden="true" />
          <h2 className={styles.title} aria-label={jobs.columnHeader(label, column.count)}>
            <span>{label}</span>
            <span className={styles.count} data-part="count">
              {column.count}
            </span>
          </h2>
          {ADDABLE.includes(column.stage) ? (
            <IconButton
              label={jobs.addToStage(label)}
              icon={<Icon name="plus" size={16} />}
              href={`/jobs/new?stage=${column.stage}`}
              className={styles.add}
            />
          ) : null}
        </div>
        {column.totalCents !== null ? (
          <>
            <p className={styles.total} data-part="lane-total" data-empty={column.totalCents === 0 ? 'true' : undefined}>
              {column.totalCents === 0 ? (
                jobs.noValueYet
              ) : (
                <>
                  {formatDollars(column.totalCents)}
                  <span className="visually-hidden"> {jobs.totalWord}</span>
                </>
              )}
            </p>
            <div className={styles.meter} aria-hidden="true">
              <span className={styles.meterFill} style={{ width: `${share ?? 0}%` }} />
            </div>
          </>
        ) : null}
      </header>
      <div className={styles.cards}>
        {visible.length === 0 ? <p className={styles.empty}>{jobs.columnEmpty}</p> : null}
        {visible.map((job) => (
          <JobCardView
            key={job.id}
            job={job}
            today={today}
            dragging={dragging?.id === job.id}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
        {remaining > 0 ? (
          <Button variant="ghost" size="sm" busy={busy} onClick={more} className={styles.more}>
            {jobs.showMore(remaining)}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
