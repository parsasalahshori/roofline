import { describe, expect, it } from 'vitest';
import type { StepView, TaskView } from '../src/api/types.ts';
import { editableText } from '../src/features/approvals/editable.ts';
import { isOpen, reviewMode, seenSteps, toReviewStep } from '../src/features/approvals/toReviewStep.ts';
import { makeTask } from './helpers.tsx';

function step(overrides: Partial<StepView> = {}): StepView {
  return {
    id: 's1',
    position: 1,
    type: 'demo_message',
    approvalClass: 'message',
    enabled: true,
    version: 1,
    status: 'pending',
    preview: { title: 'Text 31 customers', lines: [] },
    canApprove: true,
    attempts: 0,
    result: null,
    errorPlain: null,
    payload: { label: 'Text 31 customers' },
    ...overrides,
  };
}

/** A task with the given steps, in the given status (a draft unless told otherwise). */
function task(steps: StepView[], overrides: Partial<TaskView> = {}): TaskView {
  return makeTask({ id: 't1', steps, ...overrides });
}

describe('which steps are open for the caller', () => {
  it('opens a pending step on a draft', () => {
    expect(isOpen(step({ status: 'pending' }), task([], { status: 'draft' }))).toBe(true);
  });

  it('does not open a finished or queued step on a draft', () => {
    const draft = task([], { status: 'draft' });
    expect(isOpen(step({ status: 'done' }), draft)).toBe(false);
    expect(isOpen(step({ status: 'queued' }), draft)).toBe(false);
  });

  it('opens a waiting step the caller can approve on a plan waiting for the owner', () => {
    const waiting = task([], { status: 'awaiting_owner' });
    expect(isOpen(step({ status: 'awaiting_owner', canApprove: true }), waiting)).toBe(true);
  });

  it('does not open a waiting step the caller cannot approve, the owner decides it', () => {
    const waiting = task([], { status: 'awaiting_owner' });
    expect(isOpen(step({ status: 'awaiting_owner', canApprove: false }), waiting)).toBe(false);
  });

  it('does not open a finished step on a plan waiting for the owner', () => {
    expect(isOpen(step({ status: 'done' }), task([], { status: 'awaiting_owner' }))).toBe(false);
  });

  it('opens nothing once the plan is past its decision', () => {
    for (const status of ['done', 'running', 'declined', 'approved', 'expired', 'needs_attention'] as const) {
      expect(isOpen(step({ status: 'pending' }), task([], { status })), status).toBe(false);
    }
  });
});

describe('the review step the kit draws', () => {
  it('takes its title, switches and words from the step', () => {
    const current = task([], { status: 'draft' });
    const review = toReviewStep(
      step({
        approvalClass: 'spend',
        enabled: false,
        canApprove: false,
        status: 'pending',
        result: { sent: 2 },
        errorPlain: 'Something went wrong.',
        preview: { title: 'Text 31 customers', lines: ['A line'], maxSpendCents: 9000 },
      }),
      current,
    );
    expect(review).toEqual({
      id: 's1',
      title: 'Text 31 customers',
      approvalClass: 'spend',
      status: 'pending',
      enabled: false,
      canApprove: false,
      open: true,
      preview: { title: 'Text 31 customers', lines: ['A line'], maxSpendCents: 9000 },
      result: { sent: 2 },
      errorPlain: 'Something went wrong.',
      editable: false,
    });
  });

  it('is editable when the step has text a person may rewrite', () => {
    const current = task([], { status: 'draft' });
    const editable = toReviewStep(step({ payload: { label: 'Text 31 customers', sample: 'Hi {first_name}' } }), current);
    expect(editable.editable).toBe(true);
  });

  it('is not editable when the step has no text to rewrite', () => {
    const current = task([], { status: 'draft' });
    expect(toReviewStep(step({ payload: { label: 'Text 31 customers' } }), current).editable).toBe(false);
    expect(toReviewStep(step({ payload: undefined }), current).editable).toBe(false);
  });
});

describe('editable text', () => {
  it('is the sample of a demo message', () => {
    expect(editableText(step({ payload: { label: 'Text', sample: 'Hi' } }))).toEqual({ key: 'sample', value: 'Hi' });
  });

  it('is the body of an SMS batch', () => {
    expect(editableText(step({ type: 'send_sms_batch', payload: { body: 'Hello' } }))).toEqual({ key: 'body', value: 'Hello' });
  });

  it('is nothing for a step type that has no text', () => {
    expect(editableText(step({ type: 'demo_noop', payload: { sample: 'Hi' } }))).toBeNull();
  });

  it('is nothing when the text is not a string', () => {
    expect(editableText(step({ payload: { label: 'Text', sample: 5 } }))).toBeNull();
  });
});

describe('review mode', () => {
  it('reviews a live draft with a step to decide', () => {
    expect(reviewMode(task([step({ status: 'pending' })], { status: 'draft' }))).toBe('review');
  });

  it('shows progress once the draft has expired', () => {
    expect(reviewMode(task([step({ status: 'pending' })], { status: 'draft', expired: true }))).toBe('progress');
  });

  it('shows progress for a draft whose steps are all turned off', () => {
    expect(reviewMode(task([step({ status: 'skipped', enabled: false })], { status: 'draft' }))).toBe('progress');
  });

  it('reviews a plan waiting for the owner when the caller can approve a waiting step', () => {
    expect(reviewMode(task([step({ status: 'awaiting_owner', canApprove: true })], { status: 'awaiting_owner' }))).toBe('review');
  });

  it('shows progress for a plan waiting for the owner that the caller cannot decide', () => {
    expect(reviewMode(task([step({ status: 'awaiting_owner', canApprove: false })], { status: 'awaiting_owner' }))).toBe('progress');
  });

  it('shows progress for a plan that is running, or done', () => {
    expect(reviewMode(task([step({ status: 'queued' })], { status: 'running' }))).toBe('progress');
    expect(reviewMode(task([step({ status: 'done' })], { status: 'done' }))).toBe('progress');
  });
});

describe('the steps an approval must list', () => {
  it('lists every step still waiting for a yes, at its version, in the task order', () => {
    const current = task(
      [
        step({ id: 'a', status: 'pending', version: 1 }),
        step({ id: 'b', status: 'pending', version: 3, enabled: false }),
        step({ id: 'c', status: 'done', version: 2 }),
      ],
      { status: 'draft' },
    );
    expect(seenSteps(current)).toEqual([
      { id: 'a', version: 1 },
      { id: 'b', version: 3 },
    ]);
  });

  it('lists only the waiting steps of a plan waiting for the owner', () => {
    const current = task(
      [
        step({ id: 'a', status: 'done', version: 2 }),
        step({ id: 'b', status: 'awaiting_owner', version: 4, canApprove: false }),
      ],
      { status: 'awaiting_owner' },
    );
    expect(seenSteps(current)).toEqual([{ id: 'b', version: 4 }]);
  });
});
