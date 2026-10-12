import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../src/app/providers.tsx';
import { useDismissStorm, useRedraftStorm, useStorm, useStorms } from '../src/features/storm/api.ts';
import type { StormDetailView } from '../src/features/storm/types.ts';
import { stubApi } from './helpers.tsx';

const SUMMARY = {
  id: 's1',
  placeName: 'Plano',
  day: '2026-10-01',
  maxIn: 1.5,
  status: 'final' as const,
  customersHit: 3,
  homesHit: 9,
  planTaskId: null,
  planStatus: null,
};
const RESULTS = {
  textsSent: 0, textsDelivered: 0, replies: 0, yesReplies: 0, emailsSent: 0, unsubscribes: 0,
  doorsKnocked: 0, wantsCheck: 0, adSpendCents: 0, adMaxCents: 0, adClicks: 0, landingRequests: 0, inspectionsBooked: 0,
};
const detail = (status: string): StormDetailView => ({
  storm: SUMMARY,
  swath: { type: 'FeatureCollection', features: [] },
  results: RESULTS,
  plan: { taskId: 't1', status },
});

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = createQueryClient();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('storm hooks', () => {
  it('useStorms reads GET /api/storms', async () => {
    const api = stubApi({ 'GET /api/storms': () => ({ body: { storms: [SUMMARY] } }) });
    const { result } = renderHook(() => useStorms(), { wrapper });
    await waitFor(() => expect(result.current.data?.storms).toHaveLength(1));
    expect(api.count('GET /api/storms')).toBe(1);
  });

  it('useStorm reads GET /api/storms/s1 and waits for an id', async () => {
    const api = stubApi({ 'GET /api/storms/s1': () => ({ body: detail('draft') }) });
    const { result } = renderHook(() => useStorm('s1'), { wrapper });
    await waitFor(() => expect(result.current.data?.storm.id).toBe('s1'));
    renderHook(() => useStorm(''), { wrapper });
    expect(api.calls).toHaveLength(1);
  });

  it('refetches every 60 s while the plan runs', async () => {
    const api = stubApi({ 'GET /api/storms/s1': () => ({ body: detail('running') }) });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useStorm('s1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await waitFor(() => expect(api.count('GET /api/storms/s1')).toBe(2));
  });

  it('does not refetch when the plan is a draft', async () => {
    const api = stubApi({ 'GET /api/storms/s1': () => ({ body: detail('draft') }) });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useStorm('s1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(api.count('GET /api/storms/s1')).toBe(1);
  });

  it('useDismissStorm posts and makes the list stale', async () => {
    const api = stubApi({
      'GET /api/storms': () => ({ body: { storms: [SUMMARY] } }),
      'POST /api/storms/s1/dismiss': () => ({ body: { ok: true } }),
    });
    const { result } = renderHook(() => ({ list: useStorms(), dismiss: useDismissStorm() }), { wrapper });
    await waitFor(() => expect(result.current.list.data).toBeDefined());
    await act(async () => {
      await result.current.dismiss.mutateAsync('s1');
    });
    expect(api.count('POST /api/storms/s1/dismiss')).toBe(1);
    await waitFor(() => expect(api.count('GET /api/storms')).toBe(2));
  });

  it('useRedraftStorm posts and returns the task id', async () => {
    const api = stubApi({ 'POST /api/storms/s1/plan': () => ({ body: { taskId: 't9' } }) });
    const { result } = renderHook(() => useRedraftStorm(), { wrapper });
    let answer: { taskId: string } | undefined;
    await act(async () => {
      answer = await result.current.mutateAsync('s1');
    });
    expect(answer).toEqual({ taskId: 't9' });
    expect(api.count('POST /api/storms/s1/plan')).toBe(1);
  });
});
