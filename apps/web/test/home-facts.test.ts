// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { StepView } from '../src/api/types.ts';
import {
  approvalFacts,
  canQuickApprove,
  daysBetween,
  latestStorm,
  newestFirst,
  partOfDay,
  pipelineCounts,
  stormWhen,
} from '../src/features/today/homeFacts.ts';
import { makeTask } from './helpers.tsx';

const step = (over: Partial<StepView> = {}): StepView => ({
  id: 's1',
  position: 0,
  type: 'move_appointment',
  approvalClass: 'internal',
  enabled: true,
  version: 1,
  status: 'pending',
  preview: { title: 'A step', lines: [] },
  canApprove: true,
  attempts: 0,
  result: null,
  errorPlain: null,
  ...over,
});

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

describe('approvalFacts', () => {
  it('counts the steps waiting, adds up what the plan may spend, and says when it sends', () => {
    const task = makeTask({
      id: 't',
      steps: [
        step({ id: 'a', preview: { title: 'Text', lines: [], sendTime: 'today at 10:00 AM' } }),
        step({ id: 'b', preview: { title: 'Ads', lines: [], maxSpendCents: 14850 } }),
        step({ id: 'c', preview: { title: 'More ads', lines: [], maxSpendCents: 12150 } }),
        // Not asked about: switched off, or already done
        step({ id: 'd', enabled: false, preview: { title: 'Off', lines: [], maxSpendCents: 99900 } }),
        step({ id: 'e', status: 'done', preview: { title: 'Done', lines: [], maxSpendCents: 5000 } }),
      ],
    });
    expect(approvalFacts(task)).toEqual([
      { label: 'Steps', value: '3', mono: true },
      { label: 'Cost', value: 'Up to $270.00', mono: true },
      { label: 'Sends', value: 'today at 10:00 AM' },
    ]);
  });

  it('leaves out what the plan does not have, and everything for a plan with nothing waiting', () => {
    expect(approvalFacts(makeTask({ id: 't', steps: [step()] }))).toEqual([{ label: 'Steps', value: '1', mono: true }]);
    expect(approvalFacts(makeTask({ id: 't', steps: [] }))).toEqual([]);
  });
});

describe('canQuickApprove', () => {
  it('is for a plan with exactly one decision that the person may make', () => {
    expect(canQuickApprove(makeTask({ id: 't', steps: [step()] }))).toBe(true);
    expect(canQuickApprove(makeTask({ id: 't', steps: [step(), step({ id: 's2' })] }))).toBe(false);
    expect(canQuickApprove(makeTask({ id: 't', steps: [] }))).toBe(false);
    expect(canQuickApprove(makeTask({ id: 't', steps: [step({ canApprove: false })] }))).toBe(false);
  });

  it('is not for a plan that ran out of time, or a step already decided', () => {
    expect(canQuickApprove(makeTask({ id: 't', expired: true, steps: [step()] }))).toBe(false);
    expect(canQuickApprove(makeTask({ id: 't', steps: [step({ status: 'done' })] }))).toBe(false);
  });

  it('is for a plan waiting for the owner only when the person may approve its step', () => {
    const waiting = (canApprove: boolean) => makeTask({ id: 't', status: 'awaiting_owner', steps: [step({ status: 'awaiting_owner', canApprove })] });
    expect(canQuickApprove(waiting(true))).toBe(true);
    expect(canQuickApprove(waiting(false))).toBe(false);
  });
});
