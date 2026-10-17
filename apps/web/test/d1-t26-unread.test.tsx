import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { ConversationListItem } from '@roofline/shared';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { rail, WINDOW_COPY } from '../src/copy/rail.ts';
import { ACCOUNT, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NEEDS_ATTENTION = 'GET /api/conversations?filter=needs_attention';

function item(id: string, unreadCount: number, needsAttention: boolean): ConversationListItem {
  return {
    id,
    channel: 'sms',
    status: 'active',
    customerId: null,
    name: null,
    phoneE164: '+15551230001',
    outcome: null,
    summary: null,
    handledBy: 'assistant',
    unreadCount,
    needsAttention,
    urgent: false,
    lastMessageAt: '2026-10-12T10:00:00.000Z',
    liveCall: null,
  };
}

function renderShell(items: ConversationListItem[]) {
  const routes: Routes = {
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    [NEEDS_ATTENTION]: () => ({ body: { items, nextCursor: null } }),
  };
  api = stubApi(routes);
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: ['/'] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
}

async function frontDeskLink() {
  const nav = await screen.findByRole('navigation', { name: rail.label });
  return within(nav).getByRole('link', { name: new RegExp('^' + WINDOW_COPY['front-desk'].title) });
}

describe('Front Desk dock badge', () => {
  it('counts conversations with unread messages or needing attention', async () => {
    renderShell([item('a', 2, false), item('b', 0, true), item('c', 0, false)]);
    const link = await frontDeskLink();
    expect(await within(link).findByRole('img', { name: rail.frontDeskBadge(2) })).toBeInTheDocument();
    expect(api.calls.some((call) => call.url === '/api/conversations?filter=needs_attention')).toBe(true);
  });

  it('shows no badge when nothing waits', async () => {
    renderShell([]);
    const link = await frontDeskLink();
    await waitFor(() => expect(api.count(NEEDS_ATTENTION)).toBeGreaterThan(0));
    expect(within(link).queryByRole('img')).toBeNull();
  });
});
