import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { StepView, TaskView } from '../src/api/types.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { approvals } from '../src/copy/approvals.ts';
import { errors } from '../src/copy/errors.ts';
import { WINDOW_COPY } from '../src/copy/rail.ts';
import { review } from '../src/copy/review.ts';
import { shell } from '../src/copy/shell.ts';
import { stepAds } from '../src/copy/stepAds.ts';
import { stepEmail } from '../src/copy/stepEmail.ts';
import { Review, ReviewRoute } from '../src/features/approvals/Review.tsx';
import type { StormDetailView } from '../src/features/storm/types.ts';
import { makeTask, renderAt, stubApi, where } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

const STORM = '0b6f3a52-1c7d-4e8f-9a2b-3c4d5e6f7a8b';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A step as the server sends it. It waits for a yes unless the overrides say otherwise. */
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
    payload: { label: title },
    ...overrides,
  };
}

/** Fixture ONE: a draft with a message and two internal steps. Nothing spends money. */
function planOne(): TaskView {
  return makeTask({
    id: 't1',
    status: 'draft',
    agent: 'storm_scout',
    steps: [
      step('s1', 1, 'Text 31 customers', {
        type: 'demo_message',
        approvalClass: 'message',
        preview: { title: 'Text 31 customers', lines: [], recipientCount: 31 },
      }),
      step('s2', 2, 'Door-knock routes for 4 reps'),
      step('s3', 3, 'Update the job board'),
    ],
  });
}

/** Fixture TWO: as fixture ONE, but the third step spends money on ads. */
function planTwo(spendCanApprove = true): TaskView {
  const plan = planOne();
  return {
    ...plan,
    steps: [
      ...plan.steps.slice(0, 2),
      step('s3', 3, 'Run ads on the swath', {
        type: 'demo_spend',
        approvalClass: 'spend',
        preview: { title: 'Run ads on the swath', lines: [], maxSpendCents: 27000 },
        canApprove: spendCanApprove,
      }),
    ],
  };
}

/** The plan with one step changed (its version, switch or payload, as the server would answer). */
function withStep(plan: TaskView, id: string, changes: Partial<StepView>): TaskView {
  return { ...plan, steps: plan.steps.map((item) => (item.id === id ? { ...item, ...changes } : item)) };
}

/** The step with this id; a test asks only for steps that exist. */
function stepOf(plan: TaskView, id: string): StepView {
  const found = plan.steps.find((item) => item.id === id);
  if (!found) throw new Error(`No step ${id} in the plan.`);
  return found;
}

describe('the review screen', () => {
  it('turning a step off leaves it out', async () => {
    let plan = planOne();
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: plan }),
      'PATCH /api/approvals/t1/steps/s2': () => {
        plan = withStep(plan, 's2', { enabled: false, version: 2 });
        return { body: stepOf(plan, 's2') };
      },
      'POST /api/approvals/t1/approve': () => {
        plan = {
          ...plan,
          status: 'running',
          steps: plan.steps.map((item) => ({ ...item, status: item.id === 's2' ? 'skipped' : 'queued' })),
        };
        return { body: plan };
      },
    });
    const { user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    await user.click(await screen.findByRole('switch', { name: 'Door-knock routes for 4 reps' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve 2 steps' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Approve 2 steps' }));

    await waitFor(() =>
      expect(api.sent('POST /api/approvals/t1/approve')).toEqual([
        { steps: [{ id: 's1', version: 1 }, { id: 's2', version: 2 }, { id: 's3', version: 1 }] },
      ]),
    );
    expect(api.sent('PATCH /api/approvals/t1/steps/s2')).toEqual([{ version: 1, enabled: false }]);
    expect(await screen.findAllByText('Starting soon')).not.toHaveLength(0);
  });

  it('Approve waits for a switch that is still on its way', async () => {
    let plan = planOne();
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: plan }),
      'PATCH /api/approvals/t1/steps/s2': () => {
        plan = withStep(plan, 's2', { enabled: false, version: 2 });
        return { body: stepOf(plan, 's2') };
      },
      'POST /api/approvals/t1/approve': () => {
        plan = {
          ...plan,
          status: 'running',
          steps: plan.steps.map((item) => ({ ...item, status: item.id === 's2' ? 'skipped' : 'queued' })),
        };
        return { body: plan };
      },
    });
    const { user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    // fireEvent, not user.click: both clicks land before the PATCH has even been sent
    fireEvent.click(await screen.findByRole('switch', { name: 'Door-knock routes for 4 reps' }));
    const approveNow = screen.getByRole('button', { name: /^Approve/ });
    expect(approveNow).toBeDisabled();
    fireEvent.click(approveNow);
    expect(api.count('POST /api/approvals/t1/approve')).toBe(0);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve 2 steps' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Approve 2 steps' }));
    await waitFor(() =>
      expect(api.sent('POST /api/approvals/t1/approve')).toEqual([
        { steps: [{ id: 's1', version: 1 }, { id: 's2', version: 2 }, { id: 's3', version: 1 }] },
      ]),
    );
  });

  it('a switch the server refuses goes back on and says why', async () => {
    const message = 'That step is locked right now.';
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: planOne() }),
      'PATCH /api/approvals/t1/steps/s2': () => ({ status: 400, body: { error: message } }),
    });
    const { user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    await user.click(await screen.findByRole('switch', { name: 'Door-knock routes for 4 reps' }));

    // The refusal stands under the step whose switch it was
    const refusal = await screen.findByText(message);
    expect(refusal.closest('li')).toBe(screen.getByRole('switch', { name: 'Door-knock routes for 4 reps' }).closest('li'));
    expect(refusal.closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByRole('switch', { name: 'Door-knock routes for 4 reps' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Approve 3 steps' })).toBeInTheDocument();
  });

  it('a 409 reloads the latest and says so', async () => {
    const message = "This changed while you were looking. Here's the latest.";
    const latest = withStep(planOne(), 's2', { enabled: false, version: 2 });
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: planOne() }),
      'POST /api/approvals/t1/approve': () => ({ status: 409, body: { error: message, latest } }),
    });
    const { user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    await user.click(await screen.findByRole('button', { name: 'Approve 3 steps' }));

    // A change under the screen is a notice over the decision, not a red error: the person did nothing wrong
    const notice = await screen.findByText(message);
    expect(notice.closest('[data-tone="notice"]')).not.toBeNull();
    expect(screen.getByRole('switch', { name: 'Door-knock routes for 4 reps' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: 'Approve 2 steps' })).toBeInTheDocument();
    expect(api.count('GET /api/approvals/t1')).toBe(1);
  });

  it('a double click approves once', async () => {
    let plan = planOne();
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: plan }),
      'POST /api/approvals/t1/approve': () => {
        plan = {
          ...plan,
          status: 'running',
          steps: plan.steps.map((item) => ({ ...item, status: 'queued' })),
        };
        return { body: plan };
      },
    });
    const { user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    await user.dblClick(await screen.findByRole('button', { name: 'Approve 3 steps' }));

    expect(await screen.findAllByText('Starting soon')).not.toHaveLength(0);
    expect(api.count('POST /api/approvals/t1/approve')).toBe(1);
  });

  it('Not now declines with a reason', async () => {
    let plan = planOne();
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: plan }),
      'GET /api/approvals': () => ({ body: { count: 0, tasks: [] } }),
      'POST /api/approvals/t1/decline': () => {
        plan = { ...plan, status: 'declined' };
        return { body: plan };
      },
    });
    const { router, user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    await user.click(await screen.findByRole('button', { name: review.notNow }));
    const sheet = await screen.findByRole('dialog', { name: review.notNowTitle });
    await user.type(within(sheet).getByRole('textbox', { name: review.reasonLabel }), 'Customer called to reschedule');
    await user.click(within(sheet).getByRole('button', { name: review.notNow }));

    expect(await screen.findByText(approvals.declined)).toBeInTheDocument();
    await waitFor(() => expect(where(router)).toBe('/'));
    expect(api.sent('POST /api/approvals/t1/decline')).toEqual([{ reason: 'Customer called to reschedule' }]);
  });

  it('Not now goes back to the list when more plans wait', async () => {
    let plan = planOne();
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: plan }),
      'GET /api/approvals': () => ({ body: { count: 1, tasks: [makeTask({ id: 't2' })] } }),
      'POST /api/approvals/t1/decline': () => {
        plan = { ...plan, status: 'declined' };
        return { body: plan };
      },
    });
    const { router, user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    await user.click(await screen.findByRole('button', { name: review.notNow }));
    const sheet = await screen.findByRole('dialog', { name: review.notNowTitle });
    await user.click(within(sheet).getByRole('button', { name: review.notNow }));

    await waitFor(() => expect(where(router)).toBe('/approvals'));
  });

  it('Not now without a reason sends no reason', async () => {
    let plan = planOne();
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: plan }),
      'GET /api/approvals': () => ({ body: { count: 0, tasks: [] } }),
      'POST /api/approvals/t1/decline': () => {
        plan = { ...plan, status: 'declined' };
        return { body: plan };
      },
    });
    const { router, user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    await user.click(await screen.findByRole('button', { name: review.notNow }));
    const sheet = await screen.findByRole('dialog', { name: review.notNowTitle });
    await user.click(within(sheet).getByRole('button', { name: review.notNow }));

    await waitFor(() => expect(where(router)).toBe('/'));
    expect(api.sent('POST /api/approvals/t1/decline')).toEqual([{}]);
  });

  it('an expired plan offers Run it again', async () => {
    api = stubApi({
      'GET /api/approvals/t1': () => ({
        body: makeTask({
          id: 't1',
          status: 'expired',
          expired: true,
          steps: [step('s1', 1, 'Text 31 customers')],
        }),
      }),
      'POST /api/approvals/t1/rerun': () => ({ status: 201, body: makeTask({ id: 'new-id' }) }),
    });
    const { router, user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    expect(await screen.findByText(review.expiredTitle)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: review.runAgain }));

    await waitFor(() => expect(where(router)).toBe('/approvals/new-id'));
    expect(api.count('POST /api/approvals/t1/rerun')).toBe(1);
  });

  it('an expired storm plan runs again under the storm plans address', async () => {
    api = stubApi({
      'GET /api/approvals/t1': () => ({
        body: makeTask({ id: 't1', status: 'expired', expired: true, steps: [step('s1', 1, 'Text 31 customers')] }),
      }),
      'POST /api/approvals/t1/rerun': () => ({ status: 201, body: makeTask({ id: 'new-id' }) }),
    });
    const { router, user } = renderAt(<Review taskId="t1" app="storm" />, '/storm/plans/t1');

    await user.click(await screen.findByRole('button', { name: review.runAgain }));

    await waitFor(() => expect(where(router)).toBe('/storm/plans/new-id'));
  });

  it('a missing plan shows the Not found state', async () => {
    api = stubApi({ 'GET /api/approvals/t1': () => ({ status: 404, body: { error: 'Not found' } }) });
    renderAt(<Review taskId="t1" />, '/approvals/t1');

    expect(await screen.findByText(shell.notFoundTitle)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: shell.backHome })).toHaveAttribute('href', '/');
  });

  it('the route shows the plan named in the address', async () => {
    api = stubApi({ 'GET /api/approvals/t1': () => ({ body: planOne() }) });
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    const router = createMemoryRouter(
      [{ path: '/approvals/:taskId', element: <ReviewRoute app="approvals" /> }],
      { initialEntries: ['/approvals/t1'] },
    );
    render(
      <Providers client={queryClient}>
        <RouterProvider router={router} />
      </Providers>,
    );

    expect(await screen.findByRole('button', { name: 'Approve 3 steps' })).toBeInTheDocument();
  });

  it('shows what the plan will cost', async () => {
    api = stubApi({ 'GET /api/approvals/t1': () => ({ body: planTwo() }) });
    renderAt(<Review taskId="t1" />, '/approvals/t1');

    expect(await screen.findByRole('button', { name: 'Approve 3 steps · up to $270' })).toBeInTheDocument();
  });

  it('an office user approves what they can, and the spend waits for the owner', async () => {
    let plan = planTwo(false);
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: plan }),
      'POST /api/approvals/t1/approve': () => {
        plan = {
          ...plan,
          status: 'awaiting_owner',
          steps: plan.steps.map((item) => ({
            ...item,
            status: item.id === 's3' ? 'awaiting_owner' : 'queued',
          })),
        };
        return { body: plan };
      },
    });
    const { user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    expect(await screen.findByText('Your owner approves spending')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Approve 2 steps · send ad to owner' }));

    expect(await screen.findAllByText('Waiting for owner')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(api.sent('POST /api/approvals/t1/approve')).toEqual([
      { steps: [{ id: 's1', version: 1 }, { id: 's2', version: 1 }, { id: 's3', version: 1 }] },
    ]);
  });

  it('office sees the owner-only notice on the ad step and cannot approve it', async () => {
    const plan = makeTask({
      id: 't1',
      status: 'draft',
      steps: [
        step('s1', 1, 'Door-knock routes for 4 reps'),
        step('s2', 2, 'Google ads on the hail area', {
          type: 'create_ad_campaign',
          approvalClass: 'spend',
          canApprove: false,
          preview: { title: 'Google ads on the hail area', lines: ['Circles cover the hail area', '$21.42 a day for 7 days'], maxSpendCents: 15000 },
          payload: {
            companyStormId: STORM,
            platform: 'google',
            maxSpendCents: 15000,
            days: 7,
            headline: 'Hail damage? Free roof check',
            description: 'Local roofers on your street.',
            keywords: ['roof repair'],
          },
        }),
      ],
    });
    const storm: StormDetailView = {
      storm: {
        id: STORM,
        placeName: 'Maple Ridge',
        day: '2026-10-11',
        maxIn: 1.75,
        status: 'final',
        customersHit: 0,
        homesHit: 0,
        planTaskId: 't1',
        planStatus: 'draft',
      },
      swath: { type: 'FeatureCollection', features: [] },
      results: {
        textsSent: 0,
        textsDelivered: 0,
        replies: 0,
        yesReplies: 0,
        emailsSent: 0,
        unsubscribes: 0,
        doorsKnocked: 0,
        wantsCheck: 0,
        adSpendCents: 0,
        adMaxCents: 0,
        adClicks: 0,
        landingRequests: 0,
        inspectionsBooked: 0,
      },
      plan: { taskId: 't1', status: 'draft' },
    };
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: plan }),
      [`GET /api/storms/${STORM}`]: () => ({ body: storm }),
    });
    renderAt(<Review taskId="t1" />, '/approvals/t1');

    expect(await screen.findByText(stepAds.ownerOnly)).toBeInTheDocument();
    expect(screen.getByText('Your owner approves spending')).toBeInTheDocument();
    expect(screen.getAllByText('Up to $150').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$21.42 a day for 7 days').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /send ad to owner/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve \d+ steps? · up to/ })).toBeNull();
  });

  it('editing a storm email saves the whole payload', async () => {
    const original = {
      purpose: 'marketing',
      subject: 'Hail on your street',
      body: 'Hi from {company}. {company_address} {unsubscribe}',
      customerIds: ['5a1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b'],
    };
    let plan = makeTask({
      id: 't1',
      status: 'draft',
      steps: [
        step('s1', 1, 'Hail on your street', {
          type: 'send_email_batch',
          approvalClass: 'message',
          payload: original,
          preview: {
            title: 'Hail on your street',
            lines: ['Marketing email'],
            recipientCount: 1,
            messageSample: 'Hi from Summit Roofing. 12 Main St. (unsubscribe link)',
          },
        }),
      ],
    });
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: plan }),
      'GET /api/team': () => ({ body: { members: [], invites: [] } }),
      'PATCH /api/approvals/t1/steps/s1': () => {
        plan = withStep(plan, 's1', { version: 2, payload: { ...original, subject: 'New subject' } });
        return { body: stepOf(plan, 's1') };
      },
    });
    const { user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    expect(await screen.findByText(stepEmail.sampleLabel)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: review.edit }));
    const subject = await screen.findByRole('textbox', { name: stepEmail.subjectLabel });
    await user.clear(subject);
    await user.type(subject, 'New subject');
    await user.click(screen.getByRole('button', { name: review.save }));

    await waitFor(() =>
      expect(api.sent('PATCH /api/approvals/t1/steps/s1')).toEqual([{ version: 1, payload: { ...original, subject: 'New subject' } }]),
    );
    await waitFor(() => expect(screen.queryByRole('textbox', { name: stepEmail.subjectLabel })).toBeNull());
  });

  it('editing a message saves the new text', async () => {
    const original = { purpose: 'informational', body: 'Hello', customerIds: [] };
    const edited = { purpose: 'informational', body: 'New text', customerIds: [] };
    let plan = makeTask({
      id: 't1',
      status: 'draft',
      steps: [
        step('s1', 1, 'Text the owners', {
          type: 'send_sms_batch',
          approvalClass: 'message',
          payload: original,
          preview: { title: 'Text the owners', lines: [], messageSample: 'Hello' },
        }),
      ],
    });
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: plan }),
      'PATCH /api/approvals/t1/steps/s1': () => {
        plan = withStep(plan, 's1', { version: 2, payload: edited });
        return { body: stepOf(plan, 's1') };
      },
    });
    const { user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    await user.click(await screen.findByRole('button', { name: review.edit }));
    const field = await screen.findByRole('textbox', { name: review.messageLabel });
    await user.clear(field);
    await user.type(field, 'New text');
    await user.click(screen.getByRole('button', { name: review.save }));

    await waitFor(() => expect(api.sent('PATCH /api/approvals/t1/steps/s1')).toEqual([{ version: 1, payload: edited }]));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: review.messageLabel })).toBeNull());
  });

  it('a 400 on edit shows the error on the field', async () => {
    const plan = makeTask({
      id: 't1',
      status: 'draft',
      steps: [
        step('s1', 1, 'Text the owners', {
          type: 'send_sms_batch',
          approvalClass: 'message',
          payload: { purpose: 'informational', body: 'Hello', customerIds: [] },
        }),
      ],
    });
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: plan }),
      'PATCH /api/approvals/t1/steps/s1': () => ({
        status: 400,
        body: { error: 'Please write the message.', field: 'payload.body' },
      }),
    });
    const { user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    await user.click(await screen.findByRole('button', { name: review.edit }));
    const field = await screen.findByRole('textbox', { name: review.messageLabel });
    await user.clear(field);
    await user.click(screen.getByRole('button', { name: review.save }));

    expect(await screen.findByText('Please write the message.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: review.messageLabel })).toHaveAttribute('aria-invalid', 'true');
  });

  it('retrying a step that did not finish', async () => {
    let plan = makeTask({
      id: 't1',
      status: 'needs_attention',
      steps: [step('s1', 1, 'Text 31 customers', { status: 'failed', errorPlain: 'The text provider said no.' })],
    });
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: plan }),
      'POST /api/approvals/t1/steps/s1/retry': () => {
        plan = {
          ...plan,
          status: 'running',
          steps: plan.steps.map((item) => ({ ...item, status: 'queued', errorPlain: null })),
        };
        return { body: plan };
      },
    });
    const { user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    expect(await screen.findByText('The text provider said no.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: review.retry }));

    expect(await screen.findAllByText('Starting soon')).not.toHaveLength(0);
    expect(api.count('POST /api/approvals/t1/steps/s1/retry')).toBe(1);
  });

  it('the page is named by the plan, with its summary, its status and the way back', async () => {
    const plan = planOne();
    api = stubApi({ 'GET /api/approvals/t1': () => ({ body: plan }) });
    renderAt(<Review taskId="t1" />, '/approvals/t1');

    const page = await screen.findByRole('main', { name: plan.title });
    expect(within(page).getByRole('heading', { level: 1, name: plan.title })).toBeInTheDocument();
    expect(within(page).getByText(plan.summary!)).toBeInTheDocument();
    expect(within(page).getByText('Waiting for your OK')).toBeInTheDocument();
    // The trail: Need your OK, then the plan. The first is the way back on a phone
    const trail = within(page).getByRole('navigation', { name: shell.crumbsLabel });
    expect(within(trail).getByRole('link', { name: WINDOW_COPY.approvals.title })).toHaveAttribute('href', '/approvals');
    expect(within(trail).getByText(plan.title)).toHaveAttribute('aria-current', 'page');
  });

  it('a storm plan goes back to Storm', async () => {
    api = stubApi({ 'GET /api/approvals/t1': () => ({ body: planOne() }) });
    renderAt(<Review taskId="t1" app="storm" />, '/storm/plans/t1');

    const trail = await screen.findByRole('navigation', { name: shell.crumbsLabel });
    expect(within(trail).getByRole('link', { name: WINDOW_COPY.storm.title })).toHaveAttribute('href', '/storm');
  });

  it('says who drafted the plan, when, and when it ends, in a panel beside the steps', async () => {
    const plan = { ...planOne(), expiresAt: '2026-10-13T22:00:00.000Z' };
    api = stubApi({ 'GET /api/approvals/t1': () => ({ body: plan }) });
    renderAt(<Review taskId="t1" />, '/approvals/t1');

    const about = await screen.findByRole('region', { name: review.aboutTitle });
    expect(within(about).getByRole('link', { name: 'Storm Scout' })).toHaveAttribute('href', '/agents/storm-scout');
    expect(within(about).getByText(review.drafted(plan.createdAt))).toBeInTheDocument();
    expect(within(about).getByText(review.expiresAt(plan.expiresAt))).toBeInTheDocument();
    // The steps are in a panel of their own, with how many are on
    const steps = screen.getByRole('region', { name: review.stepsTitle });
    expect(within(steps).getByText(review.stepsOn(3, 3))).toBeInTheDocument();
  });

  it('counts the steps that are on as they are switched', async () => {
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: planOne() }),
      'PATCH /api/approvals/t1/steps/s2': () => ({ body: { ...stepOf(planOne(), 's2'), enabled: false, version: 2 } }),
    });
    const { user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    const steps = await screen.findByRole('region', { name: review.stepsTitle });
    await user.click(within(steps).getByRole('switch', { name: 'Door-knock routes for 4 reps' }));

    expect(await within(steps).findByText(review.stepsOn(2, 3))).toBeInTheDocument();
    // The step says so in words, with its glyph, as well as in the switch
    expect(within(steps).getByText('Turned off')).toBeInTheDocument();
  });

  it('keeps Approve in a bar of its own, with Not now', async () => {
    api = stubApi({ 'GET /api/approvals/t1': () => ({ body: planTwo() }) });
    renderAt(<Review taskId="t1" />, '/approvals/t1');

    const bar = await screen.findByRole('group', { name: review.barLabel });
    expect(within(bar).getByRole('button', { name: 'Approve 3 steps · up to $270' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: review.notNow })).toBeInTheDocument();
    expect(within(bar).getByText(review.footerNoteSpend)).toBeInTheDocument();
    // Not in the list of steps
    expect(within(screen.getByRole('region', { name: review.stepsTitle })).queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('a plan at work has no decision bar', async () => {
    api = stubApi({
      'GET /api/approvals/t1': () => ({
        body: makeTask({ id: 't1', status: 'running', steps: [step('s1', 1, 'Text 31 customers', { status: 'running' })] }),
      }),
    });
    renderAt(<Review taskId="t1" />, '/approvals/t1');

    // The plan says so over the steps, and the step says so in its row
    expect(await screen.findAllByText('Working on it')).toHaveLength(2);
    expect(screen.queryByRole('group', { name: review.barLabel })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('shows what each step looks like in its own panel, when a step has a preview', async () => {
    const plan = makeTask({
      id: 't1',
      status: 'draft',
      steps: [
        step('s1', 1, 'Google ads on the hail area', {
          type: 'create_ad_campaign',
          approvalClass: 'spend',
          preview: { title: 'Google ads on the hail area', lines: ['$21.42 a day for 7 days'], maxSpendCents: 15000 },
          payload: {
            companyStormId: STORM,
            platform: 'google',
            maxSpendCents: 15000,
            days: 7,
            headline: 'Hail damage? Free roof check',
            description: 'Local roofers on your street.',
            keywords: ['roof repair'],
          },
        }),
      ],
    });
    api = stubApi({
      'GET /api/approvals/t1': () => ({ body: plan }),
      [`GET /api/storms/${STORM}`]: () => ({ status: 404, body: { error: 'Not found' } }),
    });
    renderAt(<Review taskId="t1" />, '/approvals/t1');

    const details = await screen.findByRole('region', { name: review.detailsTitle });
    expect(within(details).getByText('Hail damage? Free roof check')).toBeInTheDocument();
  });

  it('a plan with nothing to preview has no panel for it', async () => {
    api = stubApi({ 'GET /api/approvals/t1': () => ({ body: planOne() }) });
    renderAt(<Review taskId="t1" />, '/approvals/t1');

    await screen.findByRole('region', { name: review.aboutTitle });
    expect(screen.queryByRole('region', { name: review.detailsTitle })).toBeNull();
  });

  it('shows a labelled loading state, and an error inline with Try again', async () => {
    api = stubApi({ 'GET /api/approvals/t1': () => ({ status: 500, body: { error: 'Something broke on our side.' } }) });
    const { user } = renderAt(<Review taskId="t1" />, '/approvals/t1');

    const message = await screen.findByText('Something broke on our side.');
    expect(message.closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: errors.tryAgain })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: errors.tryAgain }));
    await waitFor(() => expect(api.count('GET /api/approvals/t1')).toBe(2));
  });

  it('shows the results of a finished plan', async () => {
    api = stubApi({
      'GET /api/approvals/t1': () => ({
        body: makeTask({
          id: 't1',
          status: 'done',
          steps: [step('s1', 1, 'Text 31 customers', { status: 'done', result: { sent: 31, blocked: 2 } })],
        }),
      }),
    });
    renderAt(<Review taskId="t1" />, '/approvals/t1');

    expect(await screen.findByText('31 sent')).toBeInTheDocument();
    expect(screen.getByText('2 held back')).toBeInTheDocument();
    expect(screen.getAllByText('Done').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
  });
});
