// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  latestStorm,
  newestFirst,
  partOfDay,
  pipelineCounts,
  stormWhen,
} from '../src/features/today/homeFacts.ts';
import { makeTask } from './helpers.tsx';

describe('stormWhen', () => {
  it('says today, yesterday, the weekday inside the week, and the date after it', () => {
    expect(stormWhen('2026-10-16', '2026-10-16')).toEqual({ kind: 'today', label: 'Today' });
    expect(stormWhen('2026-10-15', '2026-10-16')).toEqual({ kind: 'yesterday', label: 'Yesterday' });
    expect(stormWhen('2026-10-13', '2026-10-16')).toEqual({ kind: 'day', label: 'Tuesday' });
    expect(stormWhen('2026-10-10', '2026-10-16')).toEqual({ kind: 'day', label: 'Saturday' });
    expect(stormWhen('2026-10-09', '2026-10-16')).toEqual({ kind: 'day', label: 'Oct 9' });
  });

  it('treats a storm dated after today (a zone a day ahead) as today', () => {
    expect(stormWhen('2026-10-17', '2026-10-16').kind).toBe('today');
  });

  it('counts whole days between two calendar days, across a month end', () => {
    expect(daysBetween('2026-09-29', '2026-10-02')).toBe(3);
  });
});

describe('latestStorm', () => {
  const storm = (id: string, day: string) => ({ id, day }) as never;
  it('is the one with the newest day, and undefined for none', () => {
    expect(latestStorm([storm('a', '2026-10-01'), storm('b', '2026-10-13'), storm('c', '2026-10-09')])?.id).toBe('b');
    expect(latestStorm([])).toBeUndefined();
    expect(latestStorm(undefined)).toBeUndefined();
  });
});

describe('pipelineCounts', () => {
  it('counts every stage before Installed as open, and Proposal on its own', () => {
    const column = (stage: string, count: number) => ({ stage, count, totalCents: null, jobs: [] });
    expect(
      pipelineCounts({
        columns: [column('lead', 8), column('inspection', 4), column('proposal', 5), column('won', 1), column('installed', 40)],
        lost: { count: 9 },
      } as never),
    ).toEqual({ openJobs: 18, atProposal: 5 });
  });

  it('is null until the board has loaded', () => {
    expect(pipelineCounts(undefined)).toBeNull();
  });
});

describe('partOfDay and newestFirst', () => {
  it('reads the hour in the company zone', () => {
    const at = new Date('2026-10-16T17:00:00Z'); // noon in Chicago, 18:00 in Paris
    expect(partOfDay(at, 'America/Chicago')).toBe('afternoon');
    expect(partOfDay(at, 'Europe/Paris')).toBe('evening');
    expect(partOfDay(new Date('2026-10-16T13:00:00Z'), 'America/Chicago')).toBe('morning');
  });

  it('puts the newest plan first without touching the list it was given', () => {
    const tasks = [makeTask({ id: 'a', createdAt: '2026-10-01T00:00:00Z' }), makeTask({ id: 'b', createdAt: '2026-10-03T00:00:00Z' })];
    expect(newestFirst(tasks).map((t) => t.id)).toEqual(['b', 'a']);
    expect(tasks.map((t) => t.id)).toEqual(['a', 'b']);
  });
});
