import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepView, TaskView } from '../src/api/types.ts';
import { approvals } from '../src/copy/approvals.ts';
import { errors } from '../src/copy/errors.ts';
import { review } from '../src/copy/review.ts';
import { ApprovalsList } from '../src/features/approvals/ApprovalsList.tsx';
import { ACCOUNT, makeTask, renderAt, type Routes, stubApi, where } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const DAY = 86_400_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number): string => new Date(Date.now() + ms).toISOString();

/** Signed in as an owner, with the given answer for the plans. */
function ownerApi(approvalsReply: Routes[string], more: Routes = {}) {
  api = stubApi({
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/approvals': approvalsReply,
    ...more,
  });
  return api;
}

/** A step as the list carries it: no payload. It waits for a yes unless the overrides say otherwise. */
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

/** A plan with one step to decide: Approve is a yes right on the queue. */
function onePlan(id: string, overrides: Partial<TaskView> = {}): TaskView {
  return makeTask({ id, title: `Plan ${id}`, steps: [step(`${id}-s1`, 1, 'Plan the route')], ...overrides });
}

/** A plan with a text, a route and an ad to decide on: it is decided on the review screen. */
function bigPlan(id: string, overrides: Partial<TaskView> = {}): TaskView {
  return makeTask({
    id,
    title: `Plan ${id}`,
    steps: [
      step(`${id}-s1`, 1, 'Text 31 customers', {
        type: 'send_sms_batch',
        approvalClass: 'message',
        preview: { title: 'Text 31 customers', lines: [], recipientCount: 31, sendTime: 'today at 10:00 AM' },
      }),
      step(`${id}-s2`, 2, 'Door-knock routes'),
      step(`${id}-s3`, 3, 'Run ads on the swath', {
        type: 'demo_spend',
        approvalClass: 'spend',
        preview: { title: 'Run ads on the swath', lines: [], maxSpendCents: 27000 },
      }),
    ],
    ...overrides,
  });
}

/** The card for one plan, found by its title. */
const card = (title: string): HTMLElement => screen.getByRole('article', { name: title });

describe('approvals queue', () => {
  it('lists the plans newest first as cards, each with who drafted it, what it does and the tag', async () => {
    ownerApi(() => ({
      body: {
        count: 2,
        tasks: [
          onePlan('old', { title: 'Older plan', createdAt: ago(3 * DAY) }),
          onePlan('new', {
            title: 'Newer plan',
            agent: 'estimator',
            summary: 'Proposals to send.',
            createdAt: ago(5 * 60_000),
          }),
        ],
      },
    }));
    renderAt(<ApprovalsList />, '/approvals');

    const list = await screen.findByRole('list', { name: approvals.listLabel });
    const cards = within(list).getAllByRole('article');
    expect(cards.map((c) => within(c).getByRole('heading', { level: 3 }).textContent)).toEqual(['Newer plan', 'Older plan']);
    expect(within(cards[0]!).getByText('Estimator drafted · 5 min ago')).toBeInTheDocument();
    expect(within(cards[0]!).getByText('Proposals to send.')).toBeInTheDocument();
    expect(within(cards[0]!).getByText(approvals.tagNeedsOk)).toBeInTheDocument();
    expect(within(cards[1]!).getByText('Storm Scout drafted · 3 days ago')).toBeInTheDocument();
  });

  it('a plan with one step to decide has Approve, Edit and Not now; one with several opens the review', async () => {
    ownerApi(() => ({ body: { count: 2, tasks: [onePlan('one', { createdAt: ago(60_000) }), bigPlan('big', { createdAt: ago(120_000) })] } }));
    renderAt(<ApprovalsList />, '/approvals');

    await screen.findByRole('list', { name: approvals.listLabel });
    const one = card('Plan one');
    expect(within(one).getByRole('button', { name: approvals.approve })).toHaveAttribute('data-key', '1');
    expect(within(one).getByRole('button', { name: approvals.edit })).toHaveAttribute('data-key', 'E');
    expect(within(one).getByRole('button', { name: approvals.later })).toHaveAttribute('data-key', 'H');

    const big = card('Plan big');
    const open = within(big).getByRole('link', { name: approvals.reviewSteps(3) });
    expect(open).toHaveAttribute('href', '/approvals/big');
    expect(within(big).queryByRole('button', { name: approvals.approve })).toBeNull();
  });

  it('shows what the plan reaches and what it costs, the locked ones with a named lock, and when it ends', async () => {
    ownerApi(() => ({ body: { count: 1, tasks: [bigPlan('big', { expiresAt: ahead(3 * DAY) })] } }));
    renderAt(<ApprovalsList />, '/approvals');

    await screen.findByRole('list', { name: approvals.listLabel });
    const big = card('Plan big');
    const facts = Array.from(big.querySelectorAll('dl > div')).map((fact) => fact.textContent);
    expect(facts).toEqual([
      expect.stringContaining(`${approvals.factSteps}3`),
      expect.stringContaining(`${approvals.factRecipients}31 texts`),
      expect.stringContaining(`${approvals.factSends}today at 10:00 AM`),
      expect.stringContaining(`${approvals.factCost}${review.spend(27000)}`),
    ]);
    // Who it reaches and what it costs cannot be changed here: each says so with a lock
    expect(within(big).getAllByRole('img', { name: approvals.locked })).toHaveLength(2);
    expect(within(big).getByText(review.spend(27000))).toHaveAttribute('data-mono', 'true');
    expect(within(big).getByText(/^Expires /)).toBeInTheDocument();
  });

  it('leaves out a fact the plan does not hold', async () => {
    ownerApi(() => ({ body: { count: 1, tasks: [onePlan('one', { expiresAt: null })] } }));
    renderAt(<ApprovalsList />, '/approvals');

    await screen.findByRole('list', { name: approvals.listLabel });
    const one = card('Plan one');
    expect(one.querySelector('dl')?.children).toHaveLength(0);
    expect(within(one).queryByText(/^Expires /)).toBeNull();
  });

  it('marks a plan waiting for the owner', async () => {
    ownerApi(() => ({ body: { count: 1, tasks: [onePlan('o1', { status: 'awaiting_owner', steps: [step('o1-s1', 1, 'Run ads', { status: 'awaiting_owner' })] })] } }));
    renderAt(<ApprovalsList />, '/approvals');

    await screen.findByRole('list', { name: approvals.listLabel });
    expect(within(card('Plan o1')).getByText(approvals.tagWaitingOwner)).toBeInTheDocument();
  });

  it('keeps an expired plan out of the cards, in a list of its own that opens it', async () => {
    ownerApi(() => ({ body: { count: 0, tasks: [onePlan('e1', { title: 'Too late', expired: true, status: 'expired' })] } }));
    renderAt(<ApprovalsList />, '/approvals');

    const list = await screen.findByRole('list', { name: approvals.expiredListLabel });
    const link = within(list).getByRole('link');
    expect(link).toHaveAttribute('href', '/approvals/e1');
    expect(link).toHaveTextContent('Too late');
    expect(link).toHaveTextContent(approvals.expired);
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByRole('list', { name: approvals.listLabel })).toBeNull();
  });

  it('says so when nothing needs a yes, and shows where to see what the agents did', async () => {
    ownerApi(() => ({ body: { count: 0, tasks: [] } }));
    renderAt(<ApprovalsList />, '/approvals');

    expect(await screen.findByText(approvals.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(approvals.emptyBody)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: approvals.emptyAction })).toHaveAttribute('href', approvals.emptyHref);
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('a rep sees the owners-only state, with a way to My day, whatever the list holds', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'rep' } }),
      'GET /api/approvals': () => ({ body: { count: 1, tasks: [onePlan('r1')] } }),
    });
    renderAt(<ApprovalsList />, '/approvals');

    expect(await screen.findByText(approvals.repTitle)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: approvals.repAction })).toHaveAttribute('href', approvals.repHref);
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('shows a labelled loading state shaped like the cards', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ownerApi(() => ({ body: { count: 1, tasks: [onePlan('one')] } }));
    const answer = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/approvals') await gate;
        return answer(input, init);
      }),
    );
    renderAt(<ApprovalsList />, '/approvals');

    expect(await screen.findByRole('status', { name: approvals.loading })).toBeInTheDocument();
    release();
    expect(await screen.findByRole('article', { name: 'Plan one' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: approvals.loading })).toBeNull();
  });

  it('shows the message the server gave when the list cannot load, inline, with a red tag', async () => {
    ownerApi(() => ({ status: 500, body: { error: 'Something broke on our side.' } }));
    renderAt(<ApprovalsList />, '/approvals');

    const alert = (await screen.findByText('Something broke on our side.')).closest<HTMLElement>('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(within(alert!).getByText(approvals.errorTag)).toBeInTheDocument();
    expect(within(alert!).getByRole('button', { name: errors.tryAgain })).toBeInTheDocument();
  });

  it('Try again asks for the plans once more', async () => {
    // The server is down for the first ask and back for the second
    let back = false;
    ownerApi(() =>
      back ? { body: { count: 1, tasks: [onePlan('r2', { title: 'Back again' })] } } : { status: 500, body: { error: 'Something broke on our side.' } },
    );
    const { user } = renderAt(<ApprovalsList />, '/approvals');

    await screen.findByText('Something broke on our side.');
    back = true;
    await user.click(screen.getByRole('button', { name: errors.tryAgain }));

    expect(await screen.findByRole('article', { name: 'Back again' })).toBeInTheDocument();
  });
});

describe('approving from the queue', () => {
  const APPROVE = 'POST /api/approvals/one/approve';

  it('Approve on a plan with one step sends the yes the review screen would, and says so', async () => {
    ownerApi(
      () => ({ body: { count: 1, tasks: [onePlan('one')] } }),
      { [APPROVE]: () => ({ body: onePlan('one', { status: 'running' }) }) },
    );
    const { user, router } = renderAt(<ApprovalsList />, '/approvals');

    await screen.findByRole('list', { name: approvals.listLabel });
    await user.click(within(card('Plan one')).getByRole('button', { name: approvals.approve }));

    await waitFor(() => expect(api.sent(APPROVE)).toEqual([{ steps: [{ id: 'one-s1', version: 1 }] }]));
    expect(await screen.findByText(approvals.approved('Plan one'))).toBeInTheDocument();
    // The toast's button opens the plan to watch it run
    await user.click(screen.getByRole('button', { name: approvals.seeProgress }));
    await waitFor(() => expect(where(router)).toBe('/approvals/one'));
  });

  it('a double click approves once, even while the list still holds the card', async () => {
    // The list is slow to take the plan away: the card is still there for the second click
    ownerApi(
      () => ({ body: { count: 1, tasks: [onePlan('one')] } }),
      { [APPROVE]: () => ({ body: onePlan('one', { status: 'running' }) }) },
    );
    const { user } = renderAt(<ApprovalsList />, '/approvals');

    await screen.findByRole('list', { name: approvals.listLabel });
    const button = within(card('Plan one')).getByRole('button', { name: approvals.approve });
    await user.dblClick(button);

    await screen.findByText(approvals.approved('Plan one'));
    expect(api.count(APPROVE)).toBe(1);
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('a refusal stands under the card it is about, and the card stays', async () => {
    ownerApi(
      () => ({ body: { count: 1, tasks: [onePlan('one')] } }),
      { [APPROVE]: () => ({ status: 409, body: { error: "This changed while you were looking. Here's the latest." } }) },
    );
    const { user } = renderAt(<ApprovalsList />, '/approvals');

    await screen.findByRole('list', { name: approvals.listLabel });
    await user.click(within(card('Plan one')).getByRole('button', { name: approvals.approve }));

    const refusal = await screen.findByText("This changed while you were looking. Here's the latest.");
    expect(refusal.closest('[role="alert"]')).not.toBeNull();
    expect(card('Plan one')).toBeInTheDocument();
    // The button is free again: the yes did not go through
    expect(within(card('Plan one')).getByRole('button', { name: approvals.approve })).toBeEnabled();
  });

  it('an office user whose only step is the owner’s gets the review, not a yes', async () => {
    const plan = onePlan('one', { steps: [step('one-s1', 1, 'Run ads', { approvalClass: 'spend', canApprove: false })] });
    ownerApi(() => ({ body: { count: 1, tasks: [plan] } }));
    renderAt(<ApprovalsList />, '/approvals');

    await screen.findByRole('list', { name: approvals.listLabel });
    expect(within(card('Plan one')).getByRole('link', { name: approvals.reviewPlan })).toHaveAttribute('href', '/approvals/one');
    expect(within(card('Plan one')).queryByRole('button', { name: approvals.approve })).toBeNull();
  });

  it('Not now asks for a reason, sets the plan aside and says so', async () => {
    const DECLINE = 'POST /api/approvals/one/decline';
    ownerApi(
      () => ({ body: { count: 1, tasks: [onePlan('one')] } }),
      { [DECLINE]: () => ({ body: onePlan('one', { status: 'declined' }) }) },
    );
    const { user } = renderAt(<ApprovalsList />, '/approvals');

    await screen.findByRole('list', { name: approvals.listLabel });
    await user.click(within(card('Plan one')).getByRole('button', { name: approvals.later }));
    const sheet = await screen.findByRole('dialog', { name: review.notNowTitle });
    await user.type(within(sheet).getByRole('textbox', { name: review.reasonLabel }), 'Customer called to reschedule');
    await user.click(within(sheet).getByRole('button', { name: review.notNow }));

    expect(await screen.findByText(approvals.declined)).toBeInTheDocument();
    expect(api.sent(DECLINE)).toEqual([{ reason: 'Customer called to reschedule' }]);
  });
});

describe('editing from the queue', () => {
  const DETAIL = 'GET /api/approvals/one';
  const PATCH = 'PATCH /api/approvals/one/steps/one-s1';
  const textPlan = (): TaskView =>
    onePlan('one', {
      steps: [
        step('one-s1', 1, 'Text the owners', {
          type: 'send_sms_batch',
          approvalClass: 'message',
          preview: { title: 'Text the owners', lines: [], messageSample: 'Hello' },
          payload: { purpose: 'informational', body: 'Hello', customerIds: [] },
        }),
      ],
    });

  it('Edit on a plan with one editable step opens that step’s sheet right there and saves', async () => {
    let detail = textPlan();
    ownerApi(
      () => ({ body: { count: 1, tasks: [onePlan('one', { steps: [step('one-s1', 1, 'Text the owners', { type: 'send_sms_batch', approvalClass: 'message' })] })] } }),
      {
        [DETAIL]: () => ({ body: detail }),
        [PATCH]: () => {
          detail = { ...detail, steps: detail.steps.map((s) => ({ ...s, version: 2, payload: { purpose: 'informational', body: 'New text', customerIds: [] } })) };
          return { body: detail.steps[0] };
        },
      },
    );
    const { user, router } = renderAt(<ApprovalsList />, '/approvals');

    await screen.findByRole('list', { name: approvals.listLabel });
    await user.click(within(card('Plan one')).getByRole('button', { name: approvals.edit }));
    const field = await screen.findByRole('textbox', { name: review.messageLabel });
    expect(field).toHaveValue('Hello');
    await user.clear(field);
    await user.type(field, 'New text');
    await user.click(screen.getByRole('button', { name: review.save }));

    await waitFor(() =>
      expect(api.sent(PATCH)).toEqual([{ version: 1, payload: { purpose: 'informational', body: 'New text', customerIds: [] } }]),
    );
    await waitFor(() => expect(screen.queryByRole('textbox', { name: review.messageLabel })).toBeNull());
    expect(where(router)).toBe('/approvals');
  });

  it('Edit on a plan whose steps need choosing opens the review', async () => {
    ownerApi(
      () => ({ body: { count: 1, tasks: [bigPlan('big')] } }),
      { 'GET /api/approvals/big': () => ({ body: bigPlan('big') }) },
    );
    const { user, router } = renderAt(<ApprovalsList />, '/approvals');

    await screen.findByRole('list', { name: approvals.listLabel });
    await user.click(within(card('Plan big')).getByRole('button', { name: approvals.edit }));

    await waitFor(() => expect(where(router)).toBe('/approvals/big'));
  });

  it('says so under the card when the plan cannot be fetched', async () => {
    ownerApi(
      () => ({ body: { count: 1, tasks: [onePlan('one')] } }),
      { [DETAIL]: () => ({ status: 500, body: { error: 'Something broke on our side.' } }) },
    );
    const { user } = renderAt(<ApprovalsList />, '/approvals');

    await screen.findByRole('list', { name: approvals.listLabel });
    await user.click(within(card('Plan one')).getByRole('button', { name: approvals.edit }));

    expect((await screen.findByText('Something broke on our side.')).closest('[role="alert"]')).not.toBeNull();
  });
});

describe('the keys of the queue', () => {
  function threePlans() {
    return {
      body: {
        count: 3,
        tasks: [
          onePlan('a', { title: 'Plan a', createdAt: ago(60_000) }),
          onePlan('b', { title: 'Plan b', createdAt: ago(120_000) }),
          bigPlan('c', { title: 'Plan c', createdAt: ago(180_000) }),
        ],
      },
    };
  }

  const approveOf = (title: string): HTMLElement => within(card(title)).getByRole('button', { name: approvals.approve });

  it('lists the keys in a strip over the cards', async () => {
    ownerApi(threePlans);
    renderAt(<ApprovalsList />, '/approvals');

    const keys = await screen.findByRole('list', { name: approvals.keysLabel });
    expect(within(keys).getAllByRole('listitem')).toHaveLength(approvals.keys.length);
    expect(within(keys).getByText('approve')).toBeInTheDocument();
  });

  it('J and K move the focus from card to card, and stop at the ends', async () => {
    ownerApi(threePlans);
    const { user } = renderAt(<ApprovalsList />, '/approvals');
    await screen.findByRole('list', { name: approvals.listLabel });

    await user.keyboard('j');
    expect(approveOf('Plan a')).toHaveFocus();
    await user.keyboard('j');
    expect(approveOf('Plan b')).toHaveFocus();
    await user.keyboard('k');
    expect(approveOf('Plan a')).toHaveFocus();
    await user.keyboard('k');
    expect(approveOf('Plan a')).toHaveFocus();
    await user.keyboard('jjj');
    // The last plan's main button is the link to its review
    expect(within(card('Plan c')).getByRole('link', { name: approvals.reviewSteps(3) })).toHaveFocus();
  });

  it('the arrow keys move between cards while a card holds the focus, and leave the page alone otherwise', async () => {
    ownerApi(threePlans);
    const { user } = renderAt(<ApprovalsList />, '/approvals');
    await screen.findByRole('list', { name: approvals.listLabel });

    await user.keyboard('{ArrowDown}');
    expect(document.body).toHaveFocus();
    await user.keyboard('j');
    await user.keyboard('{ArrowDown}');
    expect(approveOf('Plan b')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(approveOf('Plan a')).toHaveFocus();
  });

  it('1 approves the plan the focus is in', async () => {
    ownerApi(threePlans, { 'POST /api/approvals/b/approve': () => ({ body: onePlan('b', { status: 'running' }) }) });
    const { user } = renderAt(<ApprovalsList />, '/approvals');
    await screen.findByRole('list', { name: approvals.listLabel });

    await user.keyboard('jj1');

    await waitFor(() => expect(api.sent('POST /api/approvals/b/approve')).toEqual([{ steps: [{ id: 'b-s1', version: 1 }] }]));
    expect(api.count('POST /api/approvals/a/approve')).toBe(0);
  });

  it('1 on a plan with several steps opens its review', async () => {
    ownerApi(threePlans);
    const { user, router } = renderAt(<ApprovalsList />, '/approvals');
    await screen.findByRole('list', { name: approvals.listLabel });

    await user.keyboard('jjj1');

    await waitFor(() => expect(where(router)).toBe('/approvals/c'));
  });

  it('H opens Not now for that plan, and E fetches it to edit', async () => {
    ownerApi(threePlans, { 'GET /api/approvals/a': () => ({ body: onePlan('a') }) });
    const { user, router } = renderAt(<ApprovalsList />, '/approvals');
    await screen.findByRole('list', { name: approvals.listLabel });

    await user.keyboard('jh');
    expect(await screen.findByRole('dialog', { name: review.notNowTitle })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: review.cancel }));
    expect(screen.queryByRole('dialog', { name: review.notNowTitle })).toBeNull();

    // Nothing editable on this plan, so E takes it to the review
    await user.keyboard('e');
    await waitFor(() => expect(where(router)).toBe('/approvals/a'));
  });

  it('a key decides nothing while no card holds the focus', async () => {
    ownerApi(threePlans);
    const { user } = renderAt(<ApprovalsList />, '/approvals');
    await screen.findByRole('list', { name: approvals.listLabel });

    await user.keyboard('1eh');

    expect(api.calls.filter((call) => call.key.startsWith('POST'))).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keys do nothing while someone types, with a modifier held, or while a dialog is open', async () => {
    ownerApi(threePlans);
    const { user } = renderAt(<ApprovalsList />, '/approvals');
    await screen.findByRole('list', { name: approvals.listLabel });

    // A modifier: Ctrl+1 is the browser's, not ours
    await user.keyboard('j');
    await user.keyboard('{Control>}1{/Control}');
    expect(api.calls.filter((call) => call.key.startsWith('POST'))).toEqual([]);

    // A dialog is open: its own keys win
    await user.keyboard('h');
    const sheet = await screen.findByRole('dialog', { name: review.notNowTitle });
    const reason = within(sheet).getByRole('textbox', { name: review.reasonLabel });
    // Typing 1, e and h into the reason does not press anything on a card
    await user.type(reason, '1eh');
    expect(reason).toHaveValue('1eh');
    expect(api.calls.filter((call) => call.key.startsWith('POST'))).toEqual([]);
  });

  it('when the plan leaves the queue the focus moves to the plan that took its place', async () => {
    let plans = threePlans().body.tasks;
    ownerApi(() => ({ body: { count: plans.length, tasks: plans } }), {
      'POST /api/approvals/a/approve': () => {
        plans = plans.filter((plan) => plan.id !== 'a');
        return { body: onePlan('a', { status: 'running' }) };
      },
    });
    const { user } = renderAt(<ApprovalsList />, '/approvals');
    await screen.findByRole('list', { name: approvals.listLabel });

    await user.keyboard('j1');

    await waitFor(() => expect(screen.queryByRole('article', { name: 'Plan a' })).toBeNull());
    await waitFor(() => expect(approveOf('Plan b')).toHaveFocus());
  });
});
