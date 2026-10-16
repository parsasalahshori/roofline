import type { BoardView } from '@roofline/shared';
import { jobs } from '../../copy/jobs.ts';
import { formatDollars } from './format.ts';
import { useProposalsWaiting, type BoardFilterParams } from './api.ts';
import { isNarrowed } from './filter.ts';

/**
 * The line under the Jobs title, built from real numbers only: the open jobs, the money in play (for people who may see
 * money) and the proposals waiting on a signature. A part with nothing behind it is left out. Null until the board has loaded.
 */
export function useJobsSubtitle(board: BoardView | undefined, filter: BoardFilterParams): string | null {
  // The company-wide proposal count says nothing about a filtered board, so it is asked for the whole pipeline only
  const waiting = useProposalsWaiting(board !== undefined && filter.archived !== true && !isNarrowed(filter));
  if (board === undefined) return null;

  const open = board.columns.reduce((sum, column) => sum + column.count, 0);
  if (filter.archived === true) return jobs.subtitle.archived(open);

  const parts = [jobs.subtitle.open(open)];
  const totals = board.columns.map((column) => column.totalCents).filter((total): total is number => total !== null);
  const inPlay = totals.reduce((sum, total) => sum + total, 0);
  if (totals.length > 0 && inPlay > 0) parts.push(jobs.subtitle.inPlay(formatDollars(inPlay)));
  if (waiting !== undefined && waiting > 0) parts.push(jobs.subtitle.waiting(waiting));
  return parts.join(jobs.subtitle.join);
}
