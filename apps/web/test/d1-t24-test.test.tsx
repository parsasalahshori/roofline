import type { ForwardingTestView } from '@roofline/shared';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { forwarding } from '../src/copy/forwarding.ts';
import { ForwardingTest } from '../src/features/front-desk/settings/ForwardingTest.tsx';
import { stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

const START = 'POST /api/front-desk/forwarding-test';
const POLL_T1 = 'GET /api/front-desk/forwarding-test/t1';
const POLL_T2 = 'GET /api/front-desk/forwarding-test/t2';
const copy = forwarding.test;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

function view(id: string, status: ForwardingTestView['status'], finishedAt: string | null = null): ForwardingTestView {
  return { id, status, startedAt: '2026-10-12T12:00:00.000Z', finishedAt };
}

/** Answers with each status in turn, then keeps answering the last one. */
function sequence(id: string, statuses: ForwardingTestView['status'][]) {
  let answered = 0;
  return () => {
    const status = statuses[Math.min(answered, statuses.length - 1)] ?? 'calling';
    answered += 1;
    return { body: view(id, status, status === 'calling' ? null : '2026-10-12T12:00:04.000Z') };
  };
}

function renderTest(routes: Parameters<typeof stubApi>[0]) {
  api = stubApi(routes);
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  render(
    <Providers client={queryClient}>
      <ForwardingTest />
    </Providers>,
  );
  return { user: userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) }) };
}

const startButton = () => screen.findByRole('button', { name: copy.start });

describe('Forwarding test: one click', () => {
  it('shows calling, then verified after the poll, and posts once', async () => {
    const { user } = renderTest({
      [START]: () => ({ body: { id: 't1' } }),
      [POLL_T1]: sequence('t1', ['calling', 'verified']),
    });

    await user.click(await startButton());
    expect(await screen.findByText(copy.calling)).toBeInTheDocument();
    expect(await startButton()).toBeDisabled();

    expect(await screen.findByText(copy.verified, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(api.count(START)).toBe(1);
  });
});

describe('Forwarding test: not received', () => {
  it('shows the not-received message and a retry label, and posting again starts a new test', async () => {
    const { user } = renderTest({
      [START]: () => ({ body: { id: 't1' } }),
      [POLL_T1]: sequence('t1', ['calling', 'not_received']),
    });

    await user.click(await startButton());
    expect(await screen.findByText(copy.notReceived, {}, { timeout: 5000 })).toBeInTheDocument();

    const retry = await screen.findByRole('button', { name: copy.retry });
    expect(retry).toBeEnabled();

    api.routes[START] = () => ({ body: { id: 't2' } });
    api.routes[POLL_T2] = sequence('t2', ['calling']);
    await user.click(retry);

    await waitFor(() => expect(api.count(START)).toBe(2));
    expect(await screen.findByText(copy.calling)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: copy.start })).toBeDisabled();
  });
});

describe('Forwarding test: failed', () => {
  it('shows the failed message when the test reports failed', async () => {
    const { user } = renderTest({
      [START]: () => ({ body: { id: 't1' } }),
      [POLL_T1]: sequence('t1', ['failed']),
    });

    await user.click(await startButton());
    expect(await screen.findByText(copy.failed, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: copy.retry })).toBeEnabled();
  });
});

describe('Forwarding test: polling stops', () => {
  it('stops polling once the status is verified', async () => {
    const { user } = renderTest({
      [START]: () => ({ body: { id: 't1' } }),
      [POLL_T1]: sequence('t1', ['calling', 'verified']),
    });

    await user.click(await startButton());
    expect(await screen.findByText(copy.verified, {}, { timeout: 5000 })).toBeInTheDocument();

    const before = api.count(POLL_T1);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.count(POLL_T1)).toBe(before);
  });
});

describe('Forwarding test: start errors', () => {
  it('shows the failed message when the start request fails', async () => {
    const { user } = renderTest({
      [START]: () => ({ status: 500, body: { error: 'Something went wrong.' } }),
    });

    await user.click(await startButton());
    expect(await screen.findByText(copy.failed)).toBeInTheDocument();
    expect(api.count(START)).toBe(1);
    expect(api.count(POLL_T1)).toBe(0);
    expect(await screen.findByRole('button', { name: copy.retry })).toBeEnabled();
  });
});
