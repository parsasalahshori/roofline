import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMarkRead, useSendReply } from '../src/features/front-desk/conversation-api.ts';
import { stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi> | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
  api = undefined;
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const spy = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { spy, wrapper };
}

function keys(spy: ReturnType<typeof setup>['spy']): unknown[][] {
  return spy.mock.calls.map((args) => [...((args[0] as { queryKey: unknown[] }).queryKey)]);
}

describe('Front Desk invalidation', () => {
  it('a reply refreshes the conversation, the inbox lists, stats and the badge, never everything', async () => {
    api = stubApi({ 'POST /api/conversations/conv1/reply': () => ({ body: {} }) });
    const { spy, wrapper } = setup();
    const { result } = renderHook(() => useSendReply('conv1'), { wrapper });
    result.current.mutate({ body: 'On my way' });
    await waitFor(() => expect(spy).toHaveBeenCalled());

    const seen = keys(spy);
    expect(seen).toContainEqual(['front-desk', 'conversation', 'conv1']);
    expect(seen).toContainEqual(['front-desk', 'conversations']);
    expect(seen).toContainEqual(['front-desk', 'stats']);
    expect(seen).toContainEqual(['front-desk', 'unread-count']);
    expect(seen).not.toContainEqual(['front-desk']);
    expect(seen).not.toContainEqual(['front-desk', 'settings']);
  });

  it('marking read does not refetch everything either', async () => {
    api = stubApi({ 'POST /api/conversations/conv1/read': () => ({ body: {} }) });
    const { spy, wrapper } = setup();
    const { result } = renderHook(() => useMarkRead('conv1'), { wrapper });
    result.current.mutate();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(keys(spy)).not.toContainEqual(['front-desk']);
  });
});
