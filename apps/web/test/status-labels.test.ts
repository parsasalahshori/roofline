import { AGENTS, STEP_STATUSES, TASK_STATUSES } from '@roofline/shared';
import { describe, expect, it } from 'vitest';
import { AGENT_LABEL, STEP_STATUS_LABEL, TASK_STATUS_LABEL, stepStatusLabel, taskStatusLabel } from '../src/copy/status.ts';

describe('status labels', () => {
  it('has a label for every status and agent', () => {
    for (const s of TASK_STATUSES.filter((s) => s !== 'partly_done')) expect(TASK_STATUS_LABEL[s]).toMatch(/\S/);
    for (const s of STEP_STATUSES) expect(STEP_STATUS_LABEL[s]).toMatch(/\S/);
    for (const a of AGENTS) expect(AGENT_LABEL[a]).toMatch(/\S/);
  });

  it('says the same words the spec does', () => {
    expect(TASK_STATUS_LABEL).toEqual({
      draft: 'Waiting for your OK',
      awaiting_owner: 'Waiting for owner',
      approved: 'Approved',
      declined: 'Not now',
      expired: 'Expired',
      running: 'Working on it',
      done: 'Done',
      needs_attention: 'Needs attention',
    });
    expect(STEP_STATUS_LABEL).toEqual({
      pending: 'Ready',
      awaiting_owner: 'Waiting for owner',
      skipped: 'Turned off',
      queued: 'Starting soon',
      running: 'Working on it',
      done: 'Done',
      failed: "Didn't finish — we'll try again",
      needs_attention: 'Needs attention',
    });
    expect(AGENT_LABEL).toEqual({
      storm_scout: 'Storm Scout',
      estimator: 'Estimator',
      front_desk: 'Front Desk',
      claims: 'Claims',
      scheduler: 'Scheduler',
      follow_up: 'Follow-up',
      system: 'Roofline',
    });
  });

  it('labels a step from its status', () => {
    expect(stepStatusLabel('failed')).toBe("Didn't finish — we'll try again");
    expect(stepStatusLabel('pending')).toBe('Ready');
  });

  it('labels a task from its status', () => {
    expect(taskStatusLabel({ status: 'draft', steps: [] })).toBe('Waiting for your OK');
    expect(taskStatusLabel({ status: 'needs_attention', steps: [] })).toBe('Needs attention');
  });

  describe('a task that is partly done', () => {
    it('counts what the steps could not send', () => {
      expect(
        taskStatusLabel({ status: 'partly_done', steps: [{ status: 'done', result: { sent: 28, failed: 2, blocked: 1 } }] }),
      ).toBe("Mostly done — 3 couldn't send");
    });

    it('adds up the counts of every step', () => {
      expect(
        taskStatusLabel({
          status: 'partly_done',
          steps: [
            { status: 'done', result: { failed: 2 } },
            { status: 'done', result: { blocked: 4 } },
          ],
        }),
      ).toBe("Mostly done — 6 couldn't send");
    });

    it('counts the steps that did not finish when no step reports counts', () => {
      expect(
        taskStatusLabel({
          status: 'partly_done',
          steps: [
            { status: 'needs_attention', result: null },
            { status: 'done', result: null },
          ],
        }),
      ).toBe("Mostly done — 1 couldn't send");
      expect(
        taskStatusLabel({
          status: 'partly_done',
          steps: [
            { status: 'failed', result: null },
            { status: 'needs_attention', result: {} },
          ],
        }),
      ).toBe("Mostly done — 2 couldn't send");
    });

    it('leaves the count out when there is nothing to count', () => {
      expect(taskStatusLabel({ status: 'partly_done', steps: [{ status: 'done', result: { sent: 5 } }] })).toBe('Mostly done');
      expect(taskStatusLabel({ status: 'partly_done', steps: [] })).toBe('Mostly done');
    });

    it('ignores counts that are not plain numbers', () => {
      expect(
        taskStatusLabel({
          status: 'partly_done',
          steps: [{ status: 'done', result: { failed: { a: 5 }, blocked: 1 } }],
        }),
      ).toBe("Mostly done — 1 couldn't send");
      expect(taskStatusLabel({ status: 'partly_done', steps: [{ status: 'done', result: { failed: { a: 5 } } }] })).toBe(
        'Mostly done',
      );
    });
  });
});
