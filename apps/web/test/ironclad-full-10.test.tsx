import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, setUnauthorizedHandler } from '../src/api/client.ts';
import { useSwitchCompany } from '../src/api/hooks.ts';
import { keys } from '../src/api/keys.ts';
import type { StepView, TaskView } from '../src/api/types.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { useEditStep, useTask } from '../src/features/approvals/api.ts';
import { Review } from '../src/features/approvals/Review.tsx';
import { useSendReply, useSetHandling } from '../src/features/front-desk/conversation-api.ts';
import { publicProposalKey, useSignProposal } from '../src/features/homeowner/api.ts';
import { useSimulate } from '../src/features/demo/api.ts';
import { ACCOUNT_TWO, flushRouterUpdates, makeTask, renderAt, stubApi } from './helpers.tsx';

// Exercise the production hooks and UI against a recording HTTP boundary, not mocked mutations.
let api: ReturnType<typeof stubApi> | undefined;
const clients: ReturnType<typeof createQueryClient>[] = [];

afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  setUnauthorizedHandler(() => {});
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
  api = undefined;
});

function harness() {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false }, mutations: { retry: false } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function step(id: string, overrides: Partial<StepView> = {}): StepView {
  return {
    id, position: id === 'message' ? 1 : 2, type: 'demo_noop', approvalClass: 'internal',
    enabled: true, version: 1, status: 'pending', preview: { title: id, lines: [] },
    canApprove: true, attempts: 0, result: null, errorPlain: null, ...overrides,
  };
}

describe('Ironclad cross-product contracts', () => {
  it('unmounts the old company detail before resetting queries and discards its cached plan', async () => {
    let switched = false;
    const readsAfterSwitch: string[] = [];
    api = stubApi({
      'GET /api/approvals/old-plan': () => {
        if (switched) {
          readsAfterSwitch.push('old-plan');
          return { status: 404, body: { error: 'This plan is not in your company.' } };
        }
        return { body: makeTask({ id: 'old-plan', title: 'Only company A may see this' }) };
      },
      'POST /api/auth/switch-company': () => {
        switched = true;
        return { body: { ...ACCOUNT_TWO, company: { id: 'c2', name: 'Ridge', slug: 'ridge', status: 'active' } } };
      },
    });
    const { client } = harness();
    client.setQueryData(keys.me, ACCOUNT_TWO);
    client.setQueryData(['quote', 'private-quote'], { totalCents: 456700 });
    const user = userEvent.setup();
    function Detail() {
      const task = useTask('old-plan');
      const change = useSwitchCompany();
      return <><p>{task.data?.title}</p><button onClick={() => change.mutate('c2')}>Switch company</button></>;
    }
    const router = createMemoryRouter([
      { path: '/approvals/old-plan', element: <Detail /> },
      { path: '/', element: <p>New company home</p> },
    ], { initialEntries: ['/approvals/old-plan'] });
    render(<Providers client={client}><RouterProvider router={router} flushSync={flushRouterUpdates} /></Providers>);
    await screen.findByText('Only company A may see this');
    await user.click(screen.getByRole('button', { name: 'Switch company' }));
    await screen.findByText('New company home');
    expect(screen.queryByText('Only company A may see this')).toBeNull();
    expect(client.getQueryData(keys.task('old-plan'))).toBeUndefined();
    expect(client.getQueryData(['quote', 'private-quote'])).toBeUndefined();
    expect(client.getQueryData(keys.me)).toMatchObject({ company: { id: 'c2' } });
    expect(api.sent('POST /api/auth/switch-company')).toEqual([{ companyId: 'c2' }]);
    expect(readsAfterSwitch).toEqual([]);
  });

  it('a failed overlapping edit rolls back only its step, keeping the neighboring saved version', async () => {
    const { client, wrapper } = harness();
    const initial = makeTask({ id: 'plan', steps: [step('message'), step('neighbor')] });
    client.setQueryData(keys.task('plan'), initial);
    const first = deferred<Response>();
    api = stubApi({
      'PATCH /api/approvals/plan/steps/neighbor': () => ({ body: step('neighbor', { enabled: false, version: 2 }) }),
    });
    const answer = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/steps/message') ? first.promise : answer(input, init)));
    const { result } = renderHook(() => useEditStep('plan'), { wrapper });
    let failed!: Promise<unknown>;
    act(() => {
      failed = result.current.mutateAsync({ stepId: 'message', enabled: false, version: 1 }).catch((error: unknown) => error);
    });
    await waitFor(() => expect(client.getQueryData<TaskView>(keys.task('plan'))?.steps[0]?.enabled).toBe(false));
    await act(async () => { await result.current.mutateAsync({ stepId: 'neighbor', enabled: false, version: 1 }); });
    await act(async () => {
      first.resolve(new Response(JSON.stringify({ error: 'Could not save this step.' }), { status: 503 }));
      expect(await failed).toBeInstanceOf(ApiError);
    });
    expect(client.getQueryData<TaskView>(keys.task('plan'))?.steps).toEqual([
      step('message'), step('neighbor', { enabled: false, version: 2 }),
    ]);
  });

  it('locks approval during an edit, then reconciles a 409 and resubmits every waiting version including owner-only spend', async () => {
    let plan = makeTask({ id: 'plan', steps: [
      step('message'), step('owner spend', { approvalClass: 'spend', canApprove: false, type: 'demo_spend' }), step('editable'),
    ] });
    const gate = deferred<void>();
    let approves = 0;
    api = stubApi({
      'GET /api/approvals/plan': () => ({ body: plan }),
      'PATCH /api/approvals/plan/steps/editable': () => {
        plan = { ...plan, steps: [plan.steps[0]!, plan.steps[1]!, { ...plan.steps[2]!, enabled: false, version: 2 }] };
        return { body: plan.steps[2] };
      },
      'POST /api/approvals/plan/approve': () => {
        approves += 1;
        if (approves === 1) {
          plan = { ...plan, steps: [{ ...plan.steps[0]!, version: 4 }, { ...plan.steps[1]!, version: 3 }, plan.steps[2]!] };
          return { status: 409, body: { error: 'This changed while you were looking. Here is the latest.', latest: plan } };
        }
        plan = { ...plan, status: 'awaiting_owner', steps: [
          { ...plan.steps[0]!, status: 'done' }, { ...plan.steps[1]!, status: 'awaiting_owner' }, { ...plan.steps[2]!, status: 'skipped' },
        ] };
        return { body: plan };
      },
    });
    const answer = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') await gate.promise;
      return answer(input, init);
    }));
    const { user, queryClient } = renderAt(<Review taskId="plan" />, '/approvals/plan');
    clients.push(queryClient);
    await user.click(await screen.findByRole('switch', { name: 'editable' }));
    expect(screen.getByRole('button', { name: /^Approve/ })).toBeDisabled();
    expect(api.count('POST /api/approvals/plan/approve')).toBe(0);
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Approve/ })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^Approve/ }));
    await screen.findByText('This changed while you were looking. Here is the latest.');
    await user.click(screen.getByRole('button', { name: /^Approve/ }));
    await waitFor(() => expect(api?.sent('POST /api/approvals/plan/approve')).toEqual([
      { steps: [{ id: 'message', version: 1 }, { id: 'owner spend', version: 1 }, { id: 'editable', version: 2 }] },
      { steps: [{ id: 'message', version: 4 }, { id: 'owner spend', version: 3 }, { id: 'editable', version: 2 }] },
    ]));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull());
    expect(queryClient.getQueryData<TaskView>(keys.task('plan'))?.steps[1]?.status).toBe('awaiting_owner');
  });

  it.each([401, 409, 410])('public signing keeps cookies out and exposes %s without staff redirect', async (status) => {
    const { client, wrapper } = harness();
    const token = 'link/with ?characters';
    const key = publicProposalKey(token);
    client.setQueryData(key, { status: 'open' });
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    api = stubApi({
      [`POST /api/public/proposals/${encodeURIComponent(token)}/sign`]: () => ({
        status, body: { error: 'This proposal is no longer available.', companyPhone: '+15555550100' },
      }),
    });
    const fetchSpy = vi.mocked(globalThis.fetch);
    const { result } = renderHook(() => useSignProposal(token), { wrapper });
    const body = { optionId: 'better', consent: true as const, signerName: 'Pat Test', typedSignature: 'Pat Test' };
    await act(async () => {
      await expect(result.current.mutateAsync(body)).rejects.toMatchObject({
        status, latest: { companyPhone: '+15555550100' },
      });
    });
    expect(fetchSpy).toHaveBeenCalledWith(`/api/public/proposals/${encodeURIComponent(token)}/sign`, expect.objectContaining({
      credentials: 'omit', method: 'POST', body: JSON.stringify(body),
    }));
    expect(unauthorized).not.toHaveBeenCalled();
    expect(client.getQueryState(key)?.isInvalidated).toBe(status !== 401);
  });

  it('a blocked staff reply remains an error; handing to the team is a separate mutation with selective refresh', async () => {
    const { client, wrapper } = harness();
    const refreshed = [
      ['front-desk', 'conversations'], ['front-desk', 'conversation', 'c1'],
      ['front-desk', 'stats'], ['front-desk', 'unread-count'],
    ];
    const untouched = [['front-desk', 'settings'], ['front-desk', 'voices']];
    [...refreshed, ...untouched].forEach((key) => client.setQueryData(key, { marker: 'before' }));
    api = stubApi({
      'POST /api/conversations/c1/reply': () => ({ status: 422, body: { error: 'This customer has opted out.' } }),
      'POST /api/conversations/c1/handling': () => ({ body: {} }),
    });
    const { result } = renderHook(() => ({ reply: useSendReply('c1'), handling: useSetHandling('c1') }), { wrapper });
    await act(async () => {
      await expect(result.current.reply.mutateAsync({ body: 'Synthetic test reply' })).rejects.toMatchObject({ status: 422 });
    });
    expect(api.count('POST /api/conversations/c1/handling')).toBe(0);
    refreshed.forEach((key) => expect(client.getQueryState(key)?.isInvalidated).toBe(false));
    await act(async () => { await result.current.handling.mutateAsync({ by: 'team' }); });
    refreshed.forEach((key) => expect(client.getQueryState(key)?.isInvalidated).toBe(true));
    untouched.forEach((key) => expect(client.getQueryState(key)?.isInvalidated).toBe(false));
    expect(api.sent('POST /api/conversations/c1/handling')).toEqual([{ by: 'team' }]);
  });

  it.each(['text', 'call', 'storm', 'sign'] as const)('demo %s refreshes real screen data only after server success', async (kind) => {
    const { client, wrapper } = harness();
    client.setQueryData(['demo'], true);
    client.setQueryData(['job', 'j1'], { stage: 'lead' });
    let succeed = false;
    api = stubApi({
      [`POST /api/demo/simulate/${kind}`]: () => succeed
        ? { body: { ok: true, message: 'Simulation completed.' } }
        : { status: 409, body: { error: 'Nothing available to simulate.' } },
    });
    const { result } = renderHook(() => useSimulate(), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync(kind)).rejects.toMatchObject({ status: 409 }); });
    expect(client.getQueryState(['job', 'j1'])?.isInvalidated).toBe(false);
    succeed = true;
    await act(async () => { await result.current.mutateAsync(kind); });
    expect(client.getQueryState(['job', 'j1'])?.isInvalidated).toBe(true);
    expect(client.getQueryData(['job', 'j1'])).toEqual({ stage: 'lead' });
    expect(client.getQueryState(['demo'])?.isInvalidated).toBe(false);
    expect(api.sent(`POST /api/demo/simulate/${kind}`)).toEqual([{}, {}]);
  });
});
