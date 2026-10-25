import type { ScanMark } from '@roofline/shared';
import { describe, expect, it } from 'vitest';
import { FILTER_STATUS, markOf, marksOfFrame, moveMark, parseFilter, placeMark, removeMark, sameMarks, spanText } from '../src/features/scans/scanMarks.ts';

const marks: ScanMark[] = [
  { frameId: 'r1', corner: 0, x: 100, y: 100, source: 'ai' },
  { frameId: 'r1', corner: 1, x: 200, y: 100, source: 'ai' },
  { frameId: 'r2', corner: 0, x: 110, y: 90, source: 'ai' },
];

describe('the reviewer\'s mark edits', () => {
  it('moves a mark to a tenth of a pixel and makes it the reviewer\'s, leaving the others', () => {
    const next = moveMark(marks, 'r1', 1, 205.26, 98.04);
    expect(markOf(next, 'r1', 1)).toEqual({ frameId: 'r1', corner: 1, x: 205.3, y: 98, source: 'user' });
    expect(markOf(next, 'r1', 0)).toEqual(marks[0]);
    expect(marks[1]!.x).toBe(200);
  });

  it('places a mark for a corner that has none, and replaces one that has', () => {
    const added = placeMark(marks, 'r2', 2, 300, 310);
    expect(added).toHaveLength(4);
    expect(markOf(added, 'r2', 2)).toMatchObject({ x: 300, y: 310, source: 'user' });
    const replaced = placeMark(added, 'r2', 2, 1, 2);
    expect(replaced).toHaveLength(4);
    expect(markOf(replaced, 'r2', 2)).toMatchObject({ x: 1, y: 2 });
  });

  it('removes one mark and only that one; a corner with no mark is left alone', () => {
    expect(removeMark(marks, 'r1', 0)).toHaveLength(2);
    expect(marksOfFrame(removeMark(marks, 'r1', 0), 'r1').map((m) => m.corner)).toEqual([1]);
    expect(removeMark(marks, 'r2', 3)).toHaveLength(3);
    expect(moveMark(marks, 'r2', 3, 5, 5)).toEqual(marks);
  });

  it('knows whether a list says something new (order does not matter)', () => {
    expect(sameMarks(marks, [...marks].reverse())).toBe(true);
    expect(sameMarks(marks, moveMark(marks, 'r1', 0, 101, 100))).toBe(false);
    expect(sameMarks(marks, marks.slice(1))).toBe(false);
  });
});

describe('the queue', () => {
  it('writes a span as days, hours and minutes, never negative', () => {
    expect(spanText(90 * 60)).toBe('1h 30m');
    expect(spanText(-(3 * 3600 + 8 * 60 + 20))).toBe('3h 8m');
    expect(spanText(42 * 60 + 5)).toBe('42m');
    expect(spanText(20)).toBe('1m');
    expect(spanText(26 * 3600)).toBe('1d 2h');
  });

  it('asks the server for the statuses a filter means, and falls back to the first filter', () => {
    expect(FILTER_STATUS).toEqual({ todo: 'needs_review,in_review', senior: 'junior_done', done: 'done' });
    expect(parseFilter('senior')).toBe('senior');
    expect(parseFilter('nonsense')).toBe('todo');
    expect(parseFilter(null)).toBe('todo');
  });
});
