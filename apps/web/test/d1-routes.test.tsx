import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConversationDetail } from '@roofline/shared';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { dock, WINDOW_COPY } from '../src/copy/dock.ts';
import { frontDesk } from '../src/copy/front-desk.ts';
import { ACCOUNT, type Routes, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

// The real map loads maplibre-gl, which these tests never need. The stand-in has two pins that open a job and a customer.
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return {
    MapView: (props: { onOpen: (target: { kind: 'customer' | 'job'; id: string }) => void }) =>
      createElement(
        'div',
        { 'data-map-mock': true },
        createElement('button', { type: 'button', onClick: () => props.onOpen({ kind: 'job', id: 'j9' }) }, 'job pin'),
        createElement('button', { type: 'button', onClick: () => props.onOpen({ kind: 'customer', id: 'c9' }) }, 'customer pin'),
      ),
  };
});

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A signed-in person whose shell reads answer "nothing", unless a test gives its own answers. */
function signedInApi(account = ACCOUNT, overrides: Routes = {}) {
  api = stubApi({ ...SHELL_ROUTES, 'GET /api/auth/me': () => ({ body: account }), ...overrides });
  return api;
}

function renderApp(path: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: [path] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, queryClient, user: userEvent.setup() };
}

/** A dock link by its label. Its name also holds the "Coming soon" note and any badge, so only the start of the name is matched. */
function dockLink(dockNav: HTMLElement, label: string) {
  return within(dockNav).getByRole('link', { name: new RegExp('^' + label) });
}

const CONVERSATION_ABC = {
  id: 'abc',
  channel: 'sms',
  status: 'active',
  customer: { id: 'c1', name: 'Pat Lee' },
  phoneE164: '+15551230000',
  outcome: null,
  summary: null,
  followUps: [],
  identity: 'matched',
  handledBy: 'assistant',
  teamUntil: null,
  calls: [],
  turns: [],
  links: { jobIds: [], appointmentIds: [], claimIntakeIds: [] },
  canReply: false,
} satisfies ConversationDetail;

describe('D1 Front Desk routes', () => {
  it('/front-desk shows the empty window', async () => {
    signedInApi();
    renderApp('/front-desk');
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY['front-desk'].title });
    expect(await within(dialog).findByText(frontDesk.windowEmpty)).toBeInTheDocument();
  });

  it('/front-desk/abc shows the conversation', async () => {
    signedInApi(ACCOUNT, {
      'GET /api/conversations/abc': () => ({ body: CONVERSATION_ABC }),
      'POST /api/conversations/abc/read': () => ({ body: {} }),
    });
    renderApp('/front-desk/abc');
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY['front-desk'].title });
    expect(await within(dialog).findByRole('heading', { name: 'Pat Lee' })).toBeInTheDocument();
  });

  it('the dock link has no Coming soon note and opens Front Desk', async () => {
    signedInApi();
    const { router, user } = renderApp('/');
    const dockNav = await screen.findByRole('navigation', { name: dock.label });
    const link = dockLink(dockNav, WINDOW_COPY['front-desk'].title);
    expect(link.textContent ?? '').not.toContain(dock.comingSoon);
    await user.click(link);
    await waitFor(() => expect(where(router)).toBe('/front-desk'));
  });

  it('keeps the Coming soon note on Storm', async () => {
    signedInApi();
    renderApp('/');
    const dockNav = await screen.findByRole('navigation', { name: dock.label });
    expect(dockLink(dockNav, WINDOW_COPY.storm.title).textContent ?? '').toContain(dock.comingSoon);
  });

  it('words the badge', () => {
    expect(dock.frontDeskBadge(1)).toBe('1 conversation waiting');
    expect(dock.frontDeskBadge(2)).toBe('2 conversations waiting');
  });
});
