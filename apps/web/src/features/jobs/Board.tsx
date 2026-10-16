import { BOARD_STAGES, type BoardColumn as BoardColumnData, type BoardStage, type BoardView, type JobCard, type JobStage } from '@roofline/shared';
import { Button, EmptyState, Skeleton } from '@roofline/ui';
import { useId, useState, type DragEvent } from 'react';
import { jobs } from '../../copy/jobs.ts';
import { useQueryClient } from '@tanstack/react-query';
import { findCachedColumnJob, useBoard, useMoveJob } from './api.ts';
import { BoardColumn } from './BoardColumn.tsx';
import { useBoardFilter } from './BoardFilters.tsx';
import { MoveJobSheet } from './MoveJobSheet.tsx';
import styles from './Board.module.css';

type SheetState = { job: JobCard; to: 'lost' | 'won' };

function findJob(board: BoardView, jobId: string): JobCard | undefined {
  for (const column of board.columns) {
    const job = column.jobs.find((candidate) => candidate.id === jobId);
    if (job !== undefined) return job;
  }
  return undefined;
}

/** Nothing for a stage the board did not send: the column is simply empty. */
function columnFor(board: BoardView, stage: BoardStage): BoardColumnData {
  return board.columns.find((column) => column.stage === stage) ?? { stage, count: 0, totalCents: null, jobs: [] };
}

/** The pipeline: one column per stage, cards you drag between them, and the Lost drawer. */
export function Board() {
  const filter = useBoardFilter();
  const board = useBoard(filter);
  const move = useMoveJob();
  const queryClient = useQueryClient();
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [lostOpen, setLostOpen] = useState(false);
  const lostId = useId();

  /** A drop or a Move-to choice: lost always asks for a reason; won asks for a value when there is none. */
  const requestMove = (jobId: string, to: JobStage) => {
    const data = board.data;
    if (data === undefined) return;
    const job = findJob(data, jobId) ?? findCachedColumnJob(queryClient, jobId);
    if (job === undefined || job.stage === to) return;
    if (to === 'lost') {
      setSheet({ job, to });
      return;
    }
    if (to === 'won' && (job.valueCents === null || job.valueCents === 0)) {
      setSheet({ job, to });
      return;
    }
    move.mutate({ jobId, to, undo: { name: job.customerName, from: job.stage } });
  };

  if (board.isPending) {
    return (
      <div role="region" aria-label={jobs.boardLabel} className={styles.board}>
        <p className={styles.visuallyHidden}>{jobs.loading}</p>
        <Skeleton lines={4} />
      </div>
    );
  }

  if (board.data === undefined) {
    return (
      <EmptyState
        title={jobs.loadFailed}
        action={
          <Button variant="primary" onClick={() => void board.refetch()}>
            {jobs.retry}
          </Button>
        }
      />
    );
  }

  const data = board.data;
  const filterKey = JSON.stringify(filter);
  const everyCount = data.lost.count + data.columns.reduce((sum, column) => sum + column.count, 0);

  return (
    <div role="region" aria-label={jobs.boardLabel} className={styles.board}>
      {everyCount === 0 ? <p className={styles.hint}>{jobs.emptyBoard}</p> : null}
      <div className={styles.scroller}>
        <div className={styles.columns}>
          {BOARD_STAGES.map((stage) => (
            <BoardColumn
              key={`${stage}:${filterKey}`}
              column={columnFor(data, stage)}
              filter={filter}
              onDropJob={requestMove}
            />
          ))}
        </div>
      </div>

      <div className={styles.lost}>
        <Button
          variant="ghost"
          aria-expanded={lostOpen}
          aria-controls={lostId}
          onClick={() => setLostOpen((open) => !open)}
        >
          {jobs.lostDrawer(data.lost.count)}
        </Button>
        {lostOpen ? (
          <div
            id={lostId}
            className={styles.lostDrop}
            onDragOver={(event: DragEvent<HTMLDivElement>) => {
              event.preventDefault();
            }}
            onDrop={(event: DragEvent<HTMLDivElement>) => {
              event.preventDefault();
              const jobId = event.dataTransfer.getData('text/plain');
              if (jobId !== '') requestMove(jobId, 'lost');
            }}
          >
            {data.lost.count === 0 ? <p className={styles.hint}>{jobs.lostDrawerEmpty}</p> : null}
          </div>
        ) : null}
      </div>

      {sheet !== null ? (
        <MoveJobSheet
          key={`${sheet.job.id}:${sheet.to}`}
          job={sheet.job}
          to={sheet.to}
          onDone={() => setSheet(null)}
        />
      ) : null}
    </div>
  );
}
