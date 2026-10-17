import type { BoardView } from '@roofline/shared';
import type { TaskView } from '../../api/types.ts';
import { home } from '../../copy/home.ts';
import { liftFeed } from '../../copy/liftFeed.ts';
import type { StormSummary } from '../storm/types.ts';

/*
 * What the Home page works out from the answers it reads, kept apart from the markup so it can be tested on its own.
 * Nothing here makes a number up: every figure is read from a field the server sent.
 */

const DAY_MS = 86_400_000;

/** Whole days from the storm's day to today, both YYYY-MM-DD (zone-free, so a plain subtraction is right). */
export function daysBetween(day: string, today: string): number {
  return Math.round((Date.parse(today) - Date.parse(day)) / DAY_MS);
}

const shortDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** When a storm was, in words: today, yesterday, a weekday inside the last week, else "Oct 9". */
export function stormWhen(day: string, today: string): { kind: 'today' | 'yesterday' | 'day'; label: string } {
  const age = daysBetween(day, today);
  if (age <= 0) return { kind: 'today', label: liftFeed.today };
  if (age === 1) return { kind: 'yesterday', label: home.yesterday };
  if (age < 7) return { kind: 'day', label: liftFeed.dayLong(day) };
  return { kind: 'day', label: shortDay.format(new Date(`${day}T12:00:00Z`)) };
}

/** Morning before noon, afternoon before five, evening after, all in the company's time zone (the browser's until it loads). */
export function partOfDay(now: Date, timeZone: string | undefined): 'morning' | 'afternoon' | 'evening' {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now));
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
}

/** The plans waiting for a yes, newest first. The list is sorted here so a new plan always leads. */
export function newestFirst(tasks: TaskView[]): TaskView[] {
  return [...tasks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** The newest storm: the one Home tells. `day` is YYYY-MM-DD, so a text compare orders them. */
export function latestStorm(storms: StormSummary[] | undefined): StormSummary | undefined {
  return storms?.reduce<StormSummary | undefined>((best, s) => (best === undefined || s.day > best.day ? s : best), undefined);
}

/** The jobs that are open (every stage before Installed) and how many of them are at Proposal. */
export function pipelineCounts(board: BoardView | undefined): { openJobs: number; atProposal: number } | null {
  if (board === undefined) return null;
  let openJobs = 0;
  let atProposal = 0;
  for (const column of board.columns) {
    if (column.stage === 'installed') continue;
    openJobs += column.count;
    if (column.stage === 'proposal') atProposal = column.count;
  }
  return { openJobs, atProposal };
}
