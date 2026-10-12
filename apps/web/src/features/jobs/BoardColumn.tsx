import type { BoardColumn as BoardColumnData, BoardStage } from '@roofline/shared';
import { Button } from '@roofline/ui';
import type { DragEvent } from 'react';
import { jobs } from '../../copy/jobs.ts';
import { useColumnPages, type BoardFilterParams } from './api.ts';
import { JobCardView, formatDollars } from './JobCardView.tsx';
import styles from './BoardColumn.module.css';

export type BoardColumnProps = {
  column: BoardColumnData;
  filter: BoardFilterParams;
  onDropJob: (jobId: string, to: BoardStage) => void;
};

/** One stage of the board: its header and total, its cards, and a drop target for dragged cards. */
export function BoardColumn({ column, filter, onDropJob }: BoardColumnProps) {
  const { visible, remaining, busy, more } = useColumnPages(column, filter);

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
  };
  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const jobId = event.dataTransfer.getData('text/plain');
    if (jobId !== '') onDropJob(jobId, column.stage);
  };

  return (
    <section
      className={styles.column}
      data-stage={column.stage}
      aria-label={jobs.stage[column.stage]}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <header className={styles.header}>
        <h2 className={styles.title}>{jobs.columnHeader(jobs.stage[column.stage], column.count)}</h2>
        {column.totalCents !== null ? (
          <span className={styles.total}>{jobs.total(formatDollars(column.totalCents))}</span>
        ) : null}
      </header>
      <div className={styles.cards}>
        {visible.length === 0 ? <p className={styles.empty}>{jobs.columnEmpty}</p> : null}
        {visible.map((job) => (
          <JobCardView key={job.id} job={job} />
        ))}
        {remaining > 0 ? (
          <Button variant="ghost" busy={busy} onClick={more}>
            {jobs.showMore(remaining)}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
