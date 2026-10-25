import type { ScanCorner, ScanMark } from '@roofline/shared';

/*
 * The reviewer's edits to a scan's marks, as pure functions: the draft is a plain list, one mark at most per
 * (frame, corner), and every change returns a new list. Positions are native image pixels, kept to a tenth.
 */

export const tenth = (v: number): number => Math.round(v * 10) / 10;

export const markOf = (marks: readonly ScanMark[], frameId: string, corner: ScanCorner): ScanMark | undefined => marks.find((m) => m.frameId === frameId && m.corner === corner);

export const marksOfFrame = (marks: readonly ScanMark[], frameId: string): ScanMark[] => marks.filter((m) => m.frameId === frameId);

/** The mark moved to (x, y): the reviewer's now (source 'user'). A corner with no mark on that frame is left alone. */
export function moveMark(marks: readonly ScanMark[], frameId: string, corner: ScanCorner, x: number, y: number): ScanMark[] {
  return marks.map((m) => (m.frameId === frameId && m.corner === corner ? { ...m, x: tenth(x), y: tenth(y), source: 'user' as const } : m));
}

/** A mark for the corner on the frame (it replaces the frame's mark for that corner, if any). */
export function placeMark(marks: readonly ScanMark[], frameId: string, corner: ScanCorner, x: number, y: number): ScanMark[] {
  return [...marks.filter((m) => !(m.frameId === frameId && m.corner === corner)), { frameId, corner, x: tenth(x), y: tenth(y), source: 'user' }];
}

export function removeMark(marks: readonly ScanMark[], frameId: string, corner: ScanCorner): ScanMark[] {
  return marks.filter((m) => !(m.frameId === frameId && m.corner === corner));
}

/** Two mark lists say the same thing (for "is there anything to save"). */
export function sameMarks(a: readonly ScanMark[], b: readonly ScanMark[]): boolean {
  if (a.length !== b.length) return false;
  const key = (m: ScanMark) => `${m.frameId}|${m.corner}|${m.x}|${m.y}`;
  const set = new Set(a.map(key));
  return b.every((m) => set.has(key(m)));
}

/** "3h 12m", "42m", "1d 3h": a span in seconds, rounded down to the minute; never negative. */
export function spanText(seconds: number): string {
  const total = Math.max(0, Math.floor(Math.abs(seconds) / 60));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(minutes, 1)}m`;
}

export type QueueFilter = 'todo' | 'senior' | 'done';
export const QUEUE_FILTERS: readonly QueueFilter[] = ['todo', 'senior', 'done'];
/** The `status` the queue call asks for. */
export const FILTER_STATUS: Record<QueueFilter, string> = { todo: 'needs_review,in_review', senior: 'junior_done', done: 'done' };
export const parseFilter = (raw: string | null): QueueFilter => (QUEUE_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as QueueFilter) : 'todo';
