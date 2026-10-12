import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../src/app/providers.tsx';
import { useMyRoutes, useRecordOutcome, useRoute } from '../src/features/storm/routes/api.ts';
import type { DoorStop, RouteDetailView } from '../src/features/storm/routes/types.ts';
import { stubApi } from './helpers.tsx';

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = createQueryClient();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROUTE = { id: 'r1', name: 'Omaha · Route 1', status: 'ready' as const, stopCount: 1, doneCount: 0 };
const STOP: DoorStop = { id: 's1', position: 1, address: '101 Elm St', lat: 41.2, lng: -95.9, hailIn: 1.5, outcome: null };
const DETAIL: RouteDetailView = { route: ROUTE, stops: [STOP] };

describe('route hooks', () => {
  it('useMyRoutes reads GET /api/routes/mine', async () => {
    const api = stubApi({ 'GET /api/routes/mine': () => ({ body: { routes: [ROUTE] } }) });
    const { result } = renderHook(() => useMyRoutes(), { wrapper });

    await waitFor(() => expect(result.current.data?.routes).toEqual([ROUTE]));
    expect(api.calls.map((call) => call.key)).toEqual(['GET /api/routes/mine']);
    expect(api.unexpected).toEqual([]);
  });

  it('useRoute reads GET /api/routes/:id', async () => {
    const api = stubApi({ 'GET /api/routes/r1': () => ({ body: DETAIL }) });
    const { result } = renderHook(() => useRoute('r1'), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(DETAIL));
    expect(api.calls.map((call) => call.key)).toEqual(['GET /api/routes/r1']);
    expect(api.unexpected).toEqual([]);
  });
});

describe('useRecordOutcome', () => {
  it('POSTs the outcome to the exact URL with only the outcome when there is no lead', async () => {
    const api = stubApi({
      'POST /api/routes/r1/stops/s1/outcome': () => ({ body: { stop: { ...STOP, outcome: 'not_home' } } }),
    });
    const { result } = renderHook(() => useRecordOutcome(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ routeId: 'r1', stopId: 's1', outcome: 'not_home' });
    });

    expect(api.sent('POST /api/routes/r1/stops/s1/outcome')).toEqual([{ outcome: 'not_home' }]);
    expect(api.unexpected).toEqual([]);
  });

  it('sends the lead only when one is given', async () => {
    const lead = { name: 'Pat Lee', phoneE164: '+14025550114', okToText: false };
    const api = stubApi({
      'POST /api/routes/r1/stops/s1/outcome': () => ({ body: { stop: { ...STOP, outcome: 'wants_check' }, createdJobId: 'j1' } }),
    });
    const { result } = renderHook(() => useRecordOutcome(), { wrapper });

    await act(async () => {
      const answer = await result.current.mutateAsync({ routeId: 'r1', stopId: 's1', outcome: 'wants_check', lead });
      expect(answer.createdJobId).toBe('j1');
    });

    expect(api.sent('POST /api/routes/r1/stops/s1/outcome')).toEqual([{ outcome: 'wants_check', lead }]);
  });

  it('surfaces a 403 message as the mutation error', async () => {
    stubApi({
      'POST /api/routes/r1/stops/s1/outcome': () => ({
        status: 403,
        body: { error: 'This route belongs to someone else.' },
      }),
    });
    const { result } = renderHook(() => useRecordOutcome(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ routeId: 'r1', stopId: 's1', outcome: 'not_home' }).catch(() => undefined);
    });

    await waitFor(() => expect(result.current.error?.message).toBe('This route belongs to someone else.'));
  });
});
