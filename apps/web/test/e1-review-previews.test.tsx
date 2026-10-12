import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepView, TaskView } from '../src/api/types.ts';
import { review } from '../src/copy/review.ts';
import { Review } from '../src/features/approvals/Review.tsx';
import { toReviewStep } from '../src/features/approvals/toReviewStep.ts';
import { makeTask, renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const TOTALS_LINE = 'Good $11,900 · Better $14,250 · Best $17,600';
const ESTIMATE_LINE = 'Estimate based on the roof outline.';
const EXACT_LINE = 'Based on an exact roof report.';

function proposalStep(lines: string[], overrides: Partial<StepView> = {}): StepView {
  return {
    id: 'p1',
    position: 1,
    type: 'send_proposal',
    approvalClass: 'message',
    enabled: true,
    version: 1,
    status: 'pending',
    preview: {
      title: 'Text the proposal to Maria',
      lines,
      messageSample: 'Hi Maria, your roof proposal is ready.',
      recipientCount: 1,
    },
    canApprove: true,
    attempts: 0,
    result: null,
    errorPlain: null,
    payload: {},
    ...overrides,
  };
}

function reportStep(): StepView {
  return {
    id: 'r1',
    position: 2,
    type: 'order_exact_report',
    approvalClass: 'spend',
    enabled: true,
    version: 1,
    status: 'pending',
    preview: { title: 'Order an exact roof report', lines: ['12 Oak Lane, Plano TX'], maxSpendCents: 4500 },
    canApprove: true,
    attempts: 0,
    result: null,
    errorPlain: null,
    payload: {},
  };
}

function plan(steps: StepView[]): TaskView {
  return makeTask({ id: 't1', status: 'draft', agent: 'estimator', steps });
}

function show(steps: StepView[]): void {
  const task = plan(steps);
  api = stubApi({ 'GET /api/approvals/t1': () => ({ body: task }) });
  renderAt(<Review taskId="t1" />, '/approvals/t1');
}

describe('R2 previews for the estimator steps', () => {
  it('send_proposal step shows Text the proposal to Maria with the totals and the Estimate line', async () => {
    show([proposalStep([TOTALS_LINE, ESTIMATE_LINE])]);
    expect(await screen.findByText('Text the proposal to Maria')).toBeInTheDocument();
    expect(screen.getByText(TOTALS_LINE)).toBeInTheDocument();
    expect(screen.getByText(ESTIMATE_LINE)).toBeInTheDocument();
  });

  it('exact basis shows the exact line', async () => {
    show([proposalStep([TOTALS_LINE, EXACT_LINE])]);
    expect(await screen.findByText(EXACT_LINE)).toBeInTheDocument();
    expect(screen.queryByText(ESTIMATE_LINE)).not.toBeInTheDocument();
  });

  it('order_exact_report step shows the address and the max spend', async () => {
    show([reportStep()]);
    expect(await screen.findByText('12 Oak Lane, Plano TX')).toBeInTheDocument();
    expect(screen.getAllByText(review.spend(4500)).length).toBeGreaterThan(0);
  });

  it('a payload with new-style totals still renders', async () => {
    const lines = ['Line one', 'Line two', 'Line three'];
    show([
      proposalStep(lines, {
        payload: { totals: [{ tier: 'good', totalCents: 1190000 }] },
      }),
    ]);
    for (const line of lines) expect(await screen.findByText(line)).toBeInTheDocument();
  });

  it('toReviewStep keeps the preview and the approval class for both step types', () => {
    const task = plan([]);
    const message = proposalStep([TOTALS_LINE, ESTIMATE_LINE]);
    const spend = reportStep();
    const messageReview = toReviewStep(message, task);
    const spendReview = toReviewStep(spend, task);
    expect(messageReview.preview).toEqual(message.preview);
    expect(messageReview.approvalClass).toBe('message');
    expect(spendReview.preview).toEqual(spend.preview);
    expect(spendReview.approvalClass).toBe('spend');
  });
});
