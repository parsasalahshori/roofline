import { BOARD_STAGES, type BoardColumn as BoardColumnData, type BoardStage, type BoardView, type JobCard, type JobStage } from '@roofline/shared';
import { Button, Icon, Skeleton } from '@roofline/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { jobs } from '../../copy/jobs.ts';
import { findCachedColumnJob, useBoard, useMoveJob } from './api.ts';
import { BoardColumn } from './BoardColumn.tsx';
import { useBoardFilter } from './filter.ts';
import { LostLane } from './LostLane.tsx';
import { MoveJobSheet } from './MoveJobSheet.tsx';
import { EmptyPanel, LoadError } from './states.tsx';
import { useCompanyToday } from './useCompanyToday.ts';
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

/** Each lane's part of the money in play, in whole percent; null for a lane whose total the API did not send. */
function shareOf(totalCents: number | null, allCents: number): number | null {
  if (totalCents === null) return null;
  return allCents > 0 ? Math.round((totalCents / allCents) * 100) : 0;
}

/** The lanes' shape while the board loads: a header and three cards each, in the sunken colour. */
function BoardSkeleton() {
  return (
    <div className={styles.columns} aria-hidden="true">
      {BOARD_STAGES.map((stage) => (
        <div key={stage} className={styles.skeletonLane}>
          <Skeleton width="60%" height="14px" />
          <Skeleton width="40%" height="12px" />
          {[0, 1, 2].map((card) => (
            <Skeleton key={card} height="84px" />
          ))}
        </div>
      ))}
      <div className={styles.skeletonLost} />
    </div>
  );
}

export type BoardProps = {
  /** An assignee, a source or a search is narrowing the board: an empty board then means "no match", not "no jobs". */
  narrowed: boolean;
};

/** The pipeline: one lane per stage, cards you drag between them, and the Lost lane at the right. */
export function Board({ narrowed }: BoardProps) {
  const filter = useBoardFilter();
  const board = useBoard(filter);
  const move = useMoveJob();
  const queryClient = useQueryClient();
  const today = useCompanyToday();
  const [, setParams] = useSearchParams();
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [dragging, setDragging] = useState<JobCard | null>(null);

  /** A drop or a Move-to choice: lost always asks for a reason; won asks for a value when there is none. */
  const requestMove = (jobId: string, to: JobStage) => {
    setDragging(null);
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

  const clearFilters = () =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const key of ['assigned', 'source', 'q']) next.delete(key);
        return next;
      },
      { replace: true },
    );

  if (board.isPending) {
    return (
      <div role="region" aria-label={jobs.boardLabel} className={styles.board}>
        <p className="visually-hidden">{jobs.loading}</p>
        <div className={styles.scroller}>
          <BoardSkeleton />
        </div>
      </div>
    );
  }

  if (board.data === undefined) {
    return (
      <LoadError
        tag={jobs.errorTag}
        title={jobs.loadFailed}
        retry={jobs.retry}
        busy={board.isFetching}
        onRetry={() => void board.refetch()}
      />
    );
  }

  const data = board.data;
  const filterKey = JSON.stringify(filter);
  const everyCount = data.lost.count + data.columns.reduce((sum, column) => sum + column.count, 0);
  const allCents = data.columns.reduce((sum, column) => sum + (column.totalCents ?? 0), 0);

  if (everyCount === 0) {
    const archivedView = filter.archived === true;
    return (
      <div role="region" aria-label={jobs.boardLabel} className={styles.board}>
        {narrowed ? (
          <EmptyPanel
            title={jobs.emptyFiltered}
            body={jobs.emptyFilteredBody}
            ghost="cards"
            action={
              <Button variant="default" onClick={clearFilters}>
                {jobs.clearFilters}
              </Button>
            }
          />
        ) : archivedView ? (
          <EmptyPanel title={jobs.emptyArchived} body={jobs.emptyArchivedBody} ghost="cards" />
        ) : (
          <EmptyPanel
            title={jobs.emptyBoard}
            body={jobs.emptyBoardBody}
            ghost="cards"
            action={
              <Button href="/jobs/new" variant="primary">
                <Icon name="plus" size={16} />
                {jobs.newJob}
              </Button>
            }
          />
        )}
      </div>
    );
  }

  return (
    <div role="region" aria-label={jobs.boardLabel} className={styles.board}>
      <div className={styles.scroller}>
        <div className={styles.columns}>
          {BOARD_STAGES.map((stage) => {
            const column = columnFor(data, stage);
            return (
              <BoardColumn
                key={`${stage}:${filterKey}`}
                column={column}
                filter={filter}
                today={today}
                share={shareOf(column.totalCents, allCents)}
                dragging={dragging}
                onDragStart={setDragging}
                onDragEnd={() => setDragging(null)}
                onDropJob={requestMove}
              />
            );
          })}
          <LostLane count={data.lost.count} dragging={dragging !== null} onDropJob={(jobId) => requestMove(jobId, 'lost')} />
        </div>
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
