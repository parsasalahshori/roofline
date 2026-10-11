import { describe, expect, it } from 'vitest';
import type { StepView, TaskView } from '../src/api/types.ts';
import { POLL_AFTER_APPROVE_MS, POLL_EVERY_MS, pollInterval } from '../src/features/approvals/polling.ts';
import { makeTask } from './helpers.tsx';

function withSteps(statuses: StepView['status'][]): TaskView {
  const steps = statuses.map((status, index) => ({
    id: `s${index}`,
    position: index + 1,
    type: 'demo_noop' as const,
    approvalClass: 'internal' as const,
    enabled: true,
    version: 1,
    status,
    preview: { title: 'Step', lines: [] },
    canApprove: true,
    attempts: 0,
    result: null,
    errorPlain: null,
  }));
  return makeTask({ id: 't1', status: 'running', steps });
}

describe('how often a plan is asked for again', () => {
  it('is never, with no plan and no approval in flight', () => {
    expect(pollInterval(undefined, 0, 1000)).toBe(false);
  });

  it('is every two seconds while a step is queued', () => {
    expect(pollInterval(withSteps(['queued']), 0, 1000)).toBe(POLL_EVERY_MS);
    expect(POLL_EVERY_MS).toBe(2000);
  });

  it('is every two seconds while a step is running', () => {
    expect(pollInterval(withSteps(['done', 'running']), 0, 1000)).toBe(2000);
  });

  it('is never when every step is finished or turned off', () => {
    expect(pollInterval(withSteps(['done', 'skipped']), 0, 1000)).toBe(false);
  });

  it('keeps asking for ten seconds after an approval, whatever the steps say', () => {
    expect(POLL_AFTER_APPROVE_MS).toBe(10_000);
    expect(pollInterval(withSteps(['done']), 5000, 1000)).toBe(2000);
  });

  it('stops asking once the approval window has passed', () => {
    expect(pollInterval(withSteps(['done']), 5000, 6000)).toBe(false);
  });
});
