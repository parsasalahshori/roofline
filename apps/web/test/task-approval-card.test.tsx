import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepView, TaskView } from '../src/api/types.ts';
import { approvals } from '../src/copy/approvals.ts';
import { reviewHref, TaskApprovalCard } from '../src/features/approvals/TaskApprovalCard.tsx';
import { makeTask, renderAt, type Routes, stubApi, where } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A step as the list carries it: no payload. It waits for a yes. */
function step(id: string, position: number, title: string, overrides: Partial<StepView> = {}): StepView {
  return {
    id,
    position,
    type: 'demo_noop',
    approvalClass: 'internal',
    enabled: true,
    version: 1,
    status: 'pending',
    preview: { title, lines: [] },
    canApprove: true,
    attempts: 0,
    result: null,
    errorPlain: null,
    ...overrides,
  };
}

/** A plan with one step to decide: the card's Approve is a yes right on the card. */
const onePlan = (id: string): TaskView => makeTask({ id, title: `Plan ${id}`, steps: [step(`${id}-s1`, 1, 'Plan the route')] });

/** A plan with three steps to decide: the card has a link to the review screen instead of a yes. */
const bigPlan = (id: string): TaskView =>
  makeTask({
    id,
    title: `Plan ${id}`,
    steps: [step(`${id}-s1`, 1, 'Text 31 customers'), step(`${id}-s2`, 2, 'Door-knock routes'), step(`${id}-s3`, 3, 'Run ads on the swath')],
  });

/** One card on a page of its own, the way Home, My day and Storm hold it. */
function renderCard(task: TaskView, href: string | undefined, routes: Routes = {}) {
  api = stubApi(routes);
  return renderAt(<TaskApprovalCard task={task} now={Date.now()} href={href} />, '/somewhere');
}

const card = (title: string): HTMLElement => screen.getByRole('article', { name: title });

describe('where a card sends the person to see its plan', () => {
  it('is the plan’s review screen under /approvals unless the page says otherwise', async () => {
    renderCard(bigPlan('big'), undefined);

    expect(within(card('Plan big')).getByRole('link', { name: approvals.reviewSteps(3) })).toHaveAttribute('href', '/approvals/big');
    // An id with characters a path cannot carry is encoded
    expect(reviewHref('a/b c')).toBe('/approvals/a%2Fb%20c');
  });

  it('a card with href set links Review to it', () => {
    renderCard(bigPlan('big'), '/storm/plans/big');

    expect(within(card('Plan big')).getByRole('link', { name: approvals.reviewSteps(3) })).toHaveAttribute('href', '/storm/plans/big');
    // The link is the only way on: the card does not also keep a yes of its own for a plan with several steps
    expect(within(card('Plan big')).queryByRole('button', { name: approvals.approve })).toBeNull();
  });

  it('the Review link of a plan this person cannot say yes to follows href too', () => {
    const plan = makeTask({
      id: 'one',
      title: 'Plan one',
      steps: [step('one-s1', 1, 'Run ads', { approvalClass: 'spend', canApprove: false })],
    });
    renderCard(plan, '/storm/plans/one');

    expect(within(card('Plan one')).getByRole('link', { name: approvals.reviewPlan })).toHaveAttribute('href', '/storm/plans/one');
  });

  it('Edit on a plan whose steps need choosing goes where href says', async () => {
    const { user, router } = renderCard(bigPlan('big'), '/storm/plans/big', { 'GET /api/approvals/big': () => ({ body: bigPlan('big') }) });

    await user.click(within(card('Plan big')).getByRole('button', { name: approvals.edit }));

    await waitFor(() => expect(where(router)).toBe('/storm/plans/big'));
  });

  it('“See progress” after a yes goes where href says', async () => {
    const APPROVE = 'POST /api/approvals/one/approve';
    const { user, router } = renderCard(onePlan('one'), '/storm/plans/one', {
      [APPROVE]: () => ({ body: { ...onePlan('one'), status: 'running' } }),
    });

    await user.click(within(card('Plan one')).getByRole('button', { name: approvals.approve }));
    await screen.findByText(approvals.approved('Plan one'));
    await user.click(screen.getByRole('button', { name: approvals.seeProgress }));

    await waitFor(() => expect(where(router)).toBe('/storm/plans/one'));
    expect(api.sent(APPROVE)).toEqual([{ steps: [{ id: 'one-s1', version: 1 }] }]);
  });

  it('without href, “See progress” and Edit go to /approvals/<id> as they always did', async () => {
    const APPROVE = 'POST /api/approvals/one/approve';
    const { user, router } = renderCard(onePlan('one'), undefined, { [APPROVE]: () => ({ body: { ...onePlan('one'), status: 'running' } }) });

    await user.click(within(card('Plan one')).getByRole('button', { name: approvals.approve }));
    await screen.findByText(approvals.approved('Plan one'));
    await user.click(screen.getByRole('button', { name: approvals.seeProgress }));

    await waitFor(() => expect(where(router)).toBe('/approvals/one'));
  });
});
